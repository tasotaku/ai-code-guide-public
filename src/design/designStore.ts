import * as fs from "node:fs";
import * as path from "node:path";
import { parseDesignFile, DesignFile, DesignIssue, Provenance } from "./designParser";
import { DesignScope, designRelPathForScope } from "./designPrompt";

// AI_NOTE: 更新モード判定用。scopeに対応する設計mdをタグを剥がさず生のまま返す(更新プロンプトに
// そのまま埋め込むため。表示用のstripTagsAndAggregateとは目的が違う)。無ければnull(無くて当然)。
export function readExistingDesignMd(workspaceRoot: string, scope: DesignScope): string | null {
    const designPath = path.join(workspaceRoot, designRelPathForScope(scope));
    if (!fs.existsSync(designPath)) return null;
    try {
        return fs.readFileSync(designPath, "utf8");
    } catch {
        return null;
    }
}

export interface DesignLookup {
    file: DesignFile;
    issues: DesignIssue[];
}

export interface FreeformDesign {
    text: string;
    provenance: Provenance;
}

const TAG_RE = /<!--\s*@(confirmed|inferred)(?:\s+[\d-]+)?\s*-->/g;

// AI_NOTE: _repo.md/_dir.mdはfrontmatter・関数セクションなしの自由記述md(designParserの対象外)。
// 出所タグを剥がした本文をそのまま段落表示できる形で返す。セクション単位の出所は追わず、
// 出現したタグの最弱値(untagged>inferred>confirmed)を全体のprovenanceとして返す(1つでも未確認/推測があれば警告寄りに倒す判断)。
function stripTagsAndAggregate(markdown: string): FreeformDesign {
    let sawUntagged = false;
    let sawInferred = false;
    let sawConfirmed = false;
    const lines = markdown.split("\n").map((line) => {
        const isHeading = /^#{1,6}\s/.test(line);
        const hasTag = /<!--\s*@(confirmed|inferred)/.test(line);
        const stripped = line.replace(TAG_RE, "").replace(/\s+$/, "");
        if (!isHeading && stripped.trim() !== "") {
            if (hasTag) {
                if (/@confirmed/.test(line)) sawConfirmed = true;
                else sawInferred = true;
            } else {
                sawUntagged = true;
            }
        }
        return stripped;
    });
    const text = lines.join("\n").trim();
    const provenance: Provenance = sawUntagged ? "untagged" : sawInferred ? "inferred" : sawConfirmed ? "confirmed" : "untagged";
    return { text, provenance };
}

// AI_NOTE: リポ全体設計(.ai-code-guide/design/_repo.md)。読み込み失敗/未作成はnull(無くて当然)。
export function loadRepoDesign(workspaceRoot: string): FreeformDesign | null {
    const designPath = path.join(workspaceRoot, ".ai-code-guide", "design", "_repo.md");
    if (!fs.existsSync(designPath)) return null;
    try {
        return stripTagsAndAggregate(fs.readFileSync(designPath, "utf8"));
    } catch {
        return null;
    }
}

// AI_NOTE: ディレクトリ単位設計(.ai-code-guide/design/<relDir>/_dir.md)。relDirは"."(ワークスペース直下)も許容。
export function loadDirDesign(workspaceRoot: string, relDir: string): FreeformDesign | null {
    const designPath = path.join(workspaceRoot, ".ai-code-guide", "design", relDir, "_dir.md");
    if (!fs.existsSync(designPath)) return null;
    try {
        return stripTagsAndAggregate(fs.readFileSync(designPath, "utf8"));
    } catch {
        return null;
    }
}

// AI_NOTE: プロジェクトタブのファイルカード用「設計あり」バッジ判定。中身を読まず存在確認のみ(件数が多いカード一覧を軽く保つ)。
export function designFileExists(workspaceRoot: string, sourceRelPath: string): boolean {
    const designPath = path.join(workspaceRoot, ".ai-code-guide", "design", `${sourceRelPath}.md`);
    return fs.existsSync(designPath);
}

// AI_NOTE: ソース絶対パス+workspaceRootから設計md(.ai-code-guide/design/<相対パス>.md)を引いて読む。
// 存在しない/相対パスがworkspace外(rel."..")ならnull。読み込み失敗も握りつぶしてnull(設計ファイルは無くて当然の状態が多数派なため)。
export function loadDesignForSource(workspaceRoot: string, sourceAbsPath: string): DesignLookup | null {
    const rel = path.relative(workspaceRoot, sourceAbsPath);
    if (rel.startsWith("..")) return null;
    const designPath = path.join(workspaceRoot, ".ai-code-guide", "design", `${rel}.md`);
    if (!fs.existsSync(designPath)) return null;
    try {
        const md = fs.readFileSync(designPath, "utf8");
        const sourceText = fs.readFileSync(sourceAbsPath, "utf8");
        const { file, issues } = parseDesignFile(md, sourceText);
        return { file, issues };
    } catch {
        return null;
    }
}
