// AI_NOTE: 設計mdの文法サマリ（このファイルが実装上の正典。詳細は .claude/design-file-feature.md）。
// vscode に依存しない純関数（annotationResolver.ts と同じ流儀）。パース失敗は throw せず issues に積む。
//
//   ---
//   source_file: <ソースの相対パス>
//   ---
//   # ファイル: <名前>
//   ## 目的
//   <文>  <!-- @confirmed [YYYY-MM-DD] --> か <!-- @inferred -->（省略時 untagged）
//   ## 関数: <名前>   または   ## クラス: <名前>   ← ファイル内に複数繰り返せる
//   ### 目的
//   <文>
//   ### 要件・制約
//   - <箇条書き> <!-- @confirmed -->
//   ### 方針
//   <文>（捨てた代替などの補足行も同じ段落として扱う）
//   ### 構成
//   1. <ラベル> → anchor: "<コード断片（テキスト完全一致で検索）>"
//   2. ...
//
// 出所タグは目的/要件・制約/方針のセクション・箇条書き単位。構成ブロックのアンカーは
// sourceText が渡されたときだけ、コード中に完全一致で存在するかを検証する。

export type Provenance = "confirmed" | "inferred" | "untagged";

export interface TaggedText {
    text: string;
    provenance: Provenance;
    confirmedDate?: string;
}

export interface ConstructionBlock {
    order: number;
    label: string;
    anchor: string;
    line: number; // 1-based。アンカー不明時のissue位置に使う
}

export interface SymbolSections {
    purpose?: TaggedText;
    requirements: TaggedText[];
    policy?: TaggedText;
    construction: ConstructionBlock[];
}

export interface DesignSymbol {
    kind: "function" | "class";
    name: string;
    sections: SymbolSections;
}

export interface DesignFile {
    sourceFile?: string;
    filePurpose?: TaggedText;
    symbols: DesignSymbol[];
}

export interface DesignIssue {
    severity: "error" | "warning";
    message: string;
    line: number;
}

const HEADING_RE = /^#{1,6}\s/;
const CONFIRMED_RE = /<!--\s*@confirmed(?:\s+([\d-]+))?\s*-->/;
const INFERRED_RE = /<!--\s*@inferred\s*-->/;

// AI_NOTE: セクション本文/箇条書き1件から出所タグを剥がして本文とprovenanceに分離する。
// タグが無ければ untagged（空文の場合もuntaggedのまま返し、呼び出し側で警告要否を判断する）。
function extractTag(raw: string): TaggedText {
    const confirmed = raw.match(CONFIRMED_RE);
    if (confirmed) {
        return { text: raw.replace(CONFIRMED_RE, "").trim(), provenance: "confirmed", confirmedDate: confirmed[1] };
    }
    if (INFERRED_RE.test(raw)) {
        return { text: raw.replace(INFERRED_RE, "").trim(), provenance: "inferred" };
    }
    return { text: raw.trim(), provenance: "untagged" };
}

// AI_NOTE: 見出し(#で始まる行)またはEOFまでを1段落として集める（目的/方針セクション用）。
// 前後の空行は捨てる。endLineは次の見出し行のインデックス=呼び出し側のループ再開位置。
function collectParagraph(lines: string[], startIdx: number): { text: string; endLine: number } {
    const collected: string[] = [];
    let i = startIdx;
    while (i < lines.length && !HEADING_RE.test(lines[i])) {
        collected.push(lines[i]);
        i++;
    }
    while (collected.length > 0 && collected[collected.length - 1].trim() === "") collected.pop();
    while (collected.length > 0 && collected[0].trim() === "") collected.shift();
    return { text: collected.join("\n").trim(), endLine: i };
}

// AI_NOTE: `- ` 箇条書きを見出し/EOFまで集める。想定外の行（箇条書きでも空行でもない）に
// 出会ったらそこでセクション終了とみなす（構成セクションの数字リストと取り違えない）。
function collectBulletList(lines: string[], startIdx: number): { items: TaggedText[]; endLine: number } {
    const items: TaggedText[] = [];
    let i = startIdx;
    while (i < lines.length) {
        const line = lines[i];
        if (HEADING_RE.test(line)) break;
        const m = line.match(/^\s*-\s+(.+)$/);
        if (m) {
            items.push(extractTag(m[1]));
            i++;
            continue;
        }
        if (line.trim() === "") { i++; continue; }
        break;
    }
    return { items, endLine: i };
}

// AI_NOTE: `1. ラベル → anchor: "..."` の連番リストを集める。ラベル/アンカーの抽出は
// テキスト完全一致検索前提（annotationResolverのような曖昧マッチはこの段階では不要）。
function collectConstruction(lines: string[], startIdx: number): { blocks: ConstructionBlock[]; endLine: number } {
    const blocks: ConstructionBlock[] = [];
    const re = /^\s*(\d+)\.\s*(.+?)\s*→\s*anchor:\s*"(.*)"\s*$/;
    let i = startIdx;
    while (i < lines.length) {
        const line = lines[i];
        if (HEADING_RE.test(line)) break;
        const m = line.match(re);
        if (m) {
            blocks.push({ order: Number(m[1]), label: m[2].trim(), anchor: m[3], line: i + 1 });
            i++;
            continue;
        }
        if (line.trim() === "") { i++; continue; }
        break;
    }
    return { blocks, endLine: i };
}

// AI_NOTE: 先頭の `---\n source_file: ... \n---` を読む。frontmatter自体が無い/閉じていない/
// source_file欠けはすべてerror issue。本文開始行(bodyStartLine)は閉じの`---`の次の行。
function parseFrontmatter(lines: string[], issues: DesignIssue[]): { sourceFile?: string; bodyStartLine: number } {
    if ((lines[0] ?? "").trim() !== "---") {
        issues.push({ severity: "error", message: "frontmatterが見つかりません（source_fileが必要）", line: 1 });
        return { bodyStartLine: 0 };
    }
    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") { end = i; break; }
    }
    if (end === -1) {
        issues.push({ severity: "error", message: "frontmatterが閉じられていません", line: 1 });
        return { bodyStartLine: 0 };
    }
    let sourceFile: string | undefined;
    for (let i = 1; i < end; i++) {
        const m = lines[i].match(/^source_file:\s*(.+)$/);
        if (m) sourceFile = m[1].trim();
    }
    if (!sourceFile) {
        issues.push({ severity: "error", message: "frontmatterにsource_fileがありません", line: end + 1 });
    }
    return { sourceFile, bodyStartLine: end + 1 };
}

// AI_NOTE: 設計mdをDesignFileへ構造化するメイン関数。行を上から状態遷移でなめ、
// ##関数/##クラス見出しで現在のシンボルを切り替えながら###セクションを埋める。
// sourceTextが渡された時だけ構成ブロックのアンカーをコード中に完全一致検索する。
export function parseDesignFile(markdown: string, sourceText?: string): { file: DesignFile; issues: DesignIssue[] } {
    const issues: DesignIssue[] = [];
    const lines = markdown.split("\n");

    const { sourceFile, bodyStartLine } = parseFrontmatter(lines, issues);
    const file: DesignFile = { sourceFile, symbols: [] };

    let filePurposeHeadingLine = -1;
    let currentSymbol: DesignSymbol | null = null;
    let i = bodyStartLine;

    while (i < lines.length) {
        const line = lines[i];
        const lineNo = i + 1;

        const funcMatch = line.match(/^##\s*関数[:：]\s*(.+)$/);
        const clsMatch = !funcMatch ? line.match(/^##\s*クラス[:：]\s*(.+)$/) : null;
        if (funcMatch || clsMatch) {
            const m = (funcMatch ?? clsMatch) as RegExpMatchArray;
            currentSymbol = { kind: funcMatch ? "function" : "class", name: m[1].trim(), sections: { requirements: [], construction: [] } };
            file.symbols.push(currentSymbol);
            i++;
            continue;
        }

        if (!currentSymbol && /^##\s*目的\s*$/.test(line)) {
            filePurposeHeadingLine = lineNo;
            const { text, endLine } = collectParagraph(lines, i + 1);
            file.filePurpose = extractTag(text);
            if (text && file.filePurpose.provenance === "untagged") {
                issues.push({ severity: "warning", message: "出所タグなし: ファイルの「目的」", line: lineNo });
            }
            i = endLine;
            continue;
        }

        if (currentSymbol && /^###\s*目的\s*$/.test(line)) {
            const { text, endLine } = collectParagraph(lines, i + 1);
            currentSymbol.sections.purpose = extractTag(text);
            if (text && currentSymbol.sections.purpose.provenance === "untagged") {
                issues.push({ severity: "warning", message: `出所タグなし: ${currentSymbol.name} の「目的」`, line: lineNo });
            }
            i = endLine;
            continue;
        }

        if (currentSymbol && /^###\s*要件・制約\s*$/.test(line)) {
            const { items, endLine } = collectBulletList(lines, i + 1);
            currentSymbol.sections.requirements = items;
            if (items.length > 0 && items.every((it) => it.provenance === "untagged")) {
                issues.push({ severity: "warning", message: `出所タグなし: ${currentSymbol.name} の「要件・制約」`, line: lineNo });
            }
            i = endLine;
            continue;
        }

        if (currentSymbol && /^###\s*方針\s*$/.test(line)) {
            const { text, endLine } = collectParagraph(lines, i + 1);
            currentSymbol.sections.policy = extractTag(text);
            if (text && currentSymbol.sections.policy.provenance === "untagged") {
                issues.push({ severity: "warning", message: `出所タグなし: ${currentSymbol.name} の「方針」`, line: lineNo });
            }
            i = endLine;
            continue;
        }

        if (currentSymbol && /^###\s*構成\s*$/.test(line)) {
            const { blocks, endLine } = collectConstruction(lines, i + 1);
            currentSymbol.sections.construction = blocks;
            if (sourceText !== undefined) {
                for (const b of blocks) {
                    if (!sourceText.includes(b.anchor)) {
                        issues.push({
                            severity: "warning",
                            message: `アンカーがソース中に見つかりません: "${b.anchor}"（${currentSymbol.name} - ${b.label}）`,
                            line: b.line,
                        });
                    }
                }
            }
            i = endLine;
            continue;
        }

        i++;
    }

    if (!file.filePurpose) {
        issues.push({ severity: "warning", message: "必須セクション欠け: ファイルの「目的」", line: filePurposeHeadingLine >= 0 ? filePurposeHeadingLine : 1 });
    }
    for (const sym of file.symbols) {
        if (!sym.sections.purpose) {
            issues.push({ severity: "warning", message: `必須セクション欠け: ${sym.name} の「目的」`, line: 1 });
        }
    }

    return { file, issues };
}
