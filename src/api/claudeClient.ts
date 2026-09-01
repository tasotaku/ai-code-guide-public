import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { SemanticAnnotation, RawAnnotation, buildSymbolAnnotation, dedupAnnotations, resolveAnnotations } from "./annotationResolver";
import type { SymbolOccurrence } from "../flowchart/astParser";
import { createMessage, hasKeyForModel, LlmEffort } from "./llmProvider";
import { missingRequestedProjectDiagramSymbols, projectDiagramConnectivity } from "./projectDiagramValidation";

// AI_NOTE: SemanticAnnotation の定義は annotationResolver に移した（vscode非依存にして単体テスト可能にするため）。
// 既存の import 元（blockExplanationProvider 等）を壊さないようここで再エクスポートする。
export { SemanticAnnotation } from "./annotationResolver";

export const DEFAULT_MODEL = "gpt-5.6-sol";

function getModel(): string {
    return vscode.workspace
        .getConfiguration("aiCodeGuide")
        .get<string>("model", DEFAULT_MODEL);
}

// AI_NOTE: インライン解説専用モデル。フローチャート用 getModel() とは独立して設定できる
function getInlineAnnotationModel(): string {
    return vscode.workspace
        .getConfiguration("aiCodeGuide")
        .get<string>("inlineAnnotationModel", "gpt-5.6-sol");
}

// AI_NOTE: #4 会話・説明系(チャット/ファイル説明/追問/採点)専用モデル。
// 構造系(getModel: フローチャート/AI説明/概要/分解)は軽量でよいが、こちらは品質重視で独立設定にする。
function getChatModel(): string {
    return vscode.workspace
        .getConfiguration("aiCodeGuide")
        .get<string>("chatModel", "gpt-5.6-sol");
}

// AI_NOTE: チャットの思考の深さ（プロバイダ差は llmProvider が吸収）。既定 low は従来通り速い。チャットだけが渡す。
function getChatEffort(): LlmEffort {
    const v = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("chatEffort", "low");
    return v === "medium" || v === "high" ? v : "low";
}

// AI_NOTE: 密度は件数ではなく「どこまで自明寄りの知識も補うか」の選定基準にする。
// project固有シンボル等の必須対象は全密度共通で、maxはJSON切り詰め防止だけに使う。
function getAnnotationCriteria(): { density: string; criteria: string; max: number } {
    const density = vscode.workspace
        .getConfiguration("aiCodeGuide")
        .get<string>("inlineAnnotationDensity", "normal");
    if (density === "minimal") return {
        density,
        criteria: "必須対象と、理解を止める重大な非自明箇所・高確信warningだけを説明する",
        max: 4096,
    };
    if (density === "normal") return {
        density,
        criteria: "必須対象に加え、役割を忘れやすい変数、馴染みの薄いPython/API、意味のある制御ブロックを説明する",
        max: 8192,
    };
    if (density === "dense") return {
        density,
        criteria: "標準の対象に加え、中間変数、比較的よく使うAPI、二次的な設計判断まで積極的に説明する",
        max: 12288,
    };
    return {
        density,
        criteria: "完全な構文ノイズ以外は、初学者が調べず読めるよう細部まで網羅して説明する",
        max: 16384,
    };
}

export type RequiredAnnotationKind = "import" | "constructor" | "assert" | "with";
export interface RequiredAnnotationTarget {
    kind: RequiredAnnotationKind;
    line: number;
    token?: string;
    description: string;
}

// AI_NOTE: 利用者が1回「生成」した時に欠けてはいけない理解対象。件数を固定するのではなく、
// コード中に実在するproject/API境界を列挙し、生成後に実座標でカバレッジを検証する。
export function requiredAnnotationTargets(code: string): RequiredAnnotationTarget[] {
    const lines = code.replace(/\r\n/g, "\n").split("\n");
    const targets: RequiredAnnotationTarget[] = [];
    const seenAssertions = new Set<string>();

    const importedNames = (spec: string): string[] => spec
        .replace(/[()]/g, "")
        .split(",")
        .map((part) => part.trim().match(/^([A-Za-z_]\w*)(?:\s+as\s+[A-Za-z_]\w*)?$/)?.[1] ?? "")
        .filter(Boolean);

    for (let line = 0; line < lines.length; line++) {
        const source = lines[line];
        const fromImport = source.match(/^\s*from\s+\S+\s+import\s+(.+?)(?:\s+#.*)?$/);
        const plainImport = source.match(/^\s*import\s+(.+?)(?:\s+#.*)?$/);
        const names = fromImport
            ? importedNames(fromImport[1])
            : plainImport
                ? plainImport[1].split(",").map((part) => part.trim().split(/\s+as\s+/)[0].split(".")[0]).filter(Boolean)
                : [];
        for (const token of names) {
            targets.push({ kind: "import", line, token, description: `${token}がこのコードで担う役割` });
        }

        const constructor = source.match(/^\s*([A-Za-z_]\w*)\s*=\s*([A-Z]\w*)\s*\(/);
        if (constructor) {
            targets.push({
                kind: "constructor", line, token: constructor[1],
                description: `${constructor[1]}が保持する役割と${constructor[2]}の意味`,
            });
        }

        const assertion = source.match(/\bself\.(assert[A-Z]\w*)\s*\(/);
        if (assertion && !seenAssertions.has(assertion[1])) {
            seenAssertions.add(assertion[1]);
            targets.push({
                kind: "assert", line, token: assertion[1],
                description: `${assertion[1]}が検証する条件と失敗時の意味`,
            });
        }
        if (/^\s*with\b.+:\s*$/.test(source)) {
            targets.push({ kind: "with", line, description: "withが管理する範囲と終了時の挙動" });
        }
    }
    return targets;
}

function targetCovered(target: RequiredAnnotationTarget, annotation: SemanticAnnotation, codeLines: string[]): boolean {
    if (target.kind === "with") return annotation.kind === "block" && annotation.startLine === target.line;
    if (target.kind === "assert") {
        if (annotation.kind === "block" && annotation.startLine === target.line) return true;
        return annotation.kind === "symbol" && annotation.startLine === target.line
            && !!target.token && annotation.anchorToken?.includes(target.token) === true;
    }
    if (target.kind === "constructor") {
        return annotation.kind === "symbol" && annotation.startLine === target.line;
    }
    if (annotation.kind !== "symbol" || annotation.startLine !== target.line || !target.token) return false;
    const source = codeLines[target.line] ?? "";
    const tokenStart = source.indexOf(target.token);
    return tokenStart >= 0 && annotation.startCol !== null && annotation.endCol !== null
        && annotation.startCol <= tokenStart && annotation.endCol >= tokenStart + target.token.length;
}

export function missingRequiredAnnotationTargets(
    code: string,
    annotations: SemanticAnnotation[],
): RequiredAnnotationTarget[] {
    const lines = code.replace(/\r\n/g, "\n").split("\n");
    return requiredAnnotationTargets(code).filter((target) =>
        !annotations.some((annotation) => targetCovered(target, annotation, lines)));
}

// AI_NOTE: モデルがファイル全体の流れだけを優先して識別子説明を落とさないよう、
// import・生成オブジェクト・assertXxx・with・生成済みオブジェクトのmethod呼出を候補として明示する。
export function annotationTargetHints(code: string): string[] {
    const lines = code.replace(/\r\n/g, "\n").split("\n");
    const constructed = new Set<string>();
    const seenAssertions = new Set<string>();
    const seenMethods = new Set<string>();
    const reasons = new Map<number, Set<string>>();
    const add = (line: number, reason: string) => {
        const lineReasons = reasons.get(line) ?? new Set<string>();
        lineReasons.add(reason);
        reasons.set(line, lineReasons);
    };

    for (let line = 0; line < lines.length; line++) {
        const source = lines[line];
        if (/^\s*(?:from\s+\S+\s+import\s+.+|import\s+.+)$/.test(source)) add(line, "importした名前の役割");

        const constructor = source.match(/^\s*([A-Za-z_]\w*)\s*=\s*([A-Z]\w*)\s*\(/);
        if (constructor) {
            constructed.add(constructor[1]);
            add(line, `${constructor[1]}が保持する役割と${constructor[2]}の意味`);
        }

        const assertion = source.match(/\bself\.(assert[A-Z]\w*)\s*\(/);
        if (assertion && !seenAssertions.has(assertion[1])) {
            seenAssertions.add(assertion[1]);
            add(line, `${assertion[1]}が検証する条件と失敗時の意味`);
        }
        if (/^\s*with\b.+:\s*$/.test(source)) add(line, "withが管理する範囲と終了時の挙動");
    }

    for (let line = 0; line < lines.length; line++) {
        for (const variable of constructed) {
            const method = new RegExp(`\\b${variable}\\.([A-Za-z_]\\w*)\\s*\\(`);
            const match = lines[line].match(method);
            const key = match ? `${variable}.${match[1]}` : "";
            if (key && !seenMethods.has(key)) {
                seenMethods.add(key);
                add(line, `${key}のproject固有methodの役割`);
            }
        }
    }
    return [...reasons.entries()]
        .sort(([left], [right]) => left - right)
        .map(([line, values]) => `${line}|${lines[line]} [${[...values].join(" / ")}]`);
}

// AI_NOTE: 早期returnガード用。引数モデルを呼ぶプロバイダのキーが設定済みかを判定する(llmProviderへ委譲)。
function hasApiKey(model: string): boolean {
    return hasKeyForModel(model);
}

let _sessionInTokens = 0;
let _sessionOutTokens = 0;

export interface TokenLogEntry {
    operation: string;
    model: string;
    input: number;
    output: number;
    timestamp: Date;
}

const TOKEN_LOG_MAX = 50;
const _tokenLog: TokenLogEntry[] = [];

let _onTokenUpdate: (() => void) | null = null;

// AI_NOTE: 概算コスト用の単価(USD / 100万トークン)。正確な課金額ではなく目安。モデルは family で判定する。
// find() は先頭一致を返すため、より限定的な名前(例: gpt-5-mini)を一般名(gpt-5)より前に置く。
const PRICE_PER_MTOK: { match: string; in: number; out: number }[] = [
    { match: "opus", in: 5, out: 25 },
    { match: "sonnet", in: 3, out: 15 },
    { match: "haiku", in: 1, out: 5 },
    { match: "gpt-5.6-sol", in: 5, out: 30 },
    { match: "gpt-5.6-terra", in: 2.5, out: 15 },
    { match: "gpt-5.6-luna", in: 1, out: 6 },
    { match: "gpt-5-mini", in: 0.25, out: 2 },
    { match: "gpt-5", in: 1.25, out: 10 },
    { match: "gpt-4o-mini", in: 0.15, out: 0.6 },
    { match: "gpt-4o", in: 2.5, out: 10 },
    { match: "gpt", in: 2.5, out: 15 },
    { match: "gemini-3.6-flash", in: 1.5, out: 7.5 },
    { match: "gemini-3.5-flash-lite", in: 0.3, out: 2.5 },
    { match: "gemini-3.5-flash", in: 1.5, out: 9 },
    { match: "gemini-2.5-pro", in: 1.25, out: 10 },
    { match: "gemini-2.5-flash", in: 0.3, out: 2.5 },
    { match: "gemini", in: 1.5, out: 7.5 },
];
// AI_NOTE: 概算用の固定レート。厳密な為替ではない。表示側(extension.ts のモデル別内訳)でも同率を使うため export し、
// 150 を2箇所に書いてズレるのを防ぐ。
export const JPY_PER_USD = 150;

function priceFor(model: string): { in: number; out: number } {
    // AI_NOTE: 未知モデルは sonnet 相当に倒す（過小評価で驚かせないよう中間に寄せる）
    return PRICE_PER_MTOK.find((p) => model.includes(p.match)) ?? { match: "", in: 3, out: 15 };
}
function costUsd(model: string, inTok: number, outTok: number): number {
    const p = priceFor(model);
    return (inTok * p.in + outTok * p.out) / 1_000_000;
}

// AI_NOTE: 永続記録。1コール=1行のJSONLに追記し、起動時に読み戻して全期間累計を復元する。
// 生ログ(jsonl)を正とし、メモリ累計は高速表示用のキャッシュ（ホットパスでファイルを毎回読まない）。
interface UsageRecord { ts: string; op: string; model: string; in: number; out: number }
let _logFilePath: string | null = null;
let _allTimeIn = 0;
let _allTimeOut = 0;
let _allTimeCostUsd = 0;

// AI_NOTE: [レビュー] "jsonl が無限成長し、起動・統計表示で全行を舐める" → 生ログは直近のみ保持し、古い分は
// 機種別ロールアップ(token-usage-rollup.json)へ集約する。costUsd はトークン線形なので「機種ごとの合計」だけ
// 持てば全期間コストを誤差なく復元できる(レコード単位の総和＝機種別合計の総和)。
// 全期間累計 = ロールアップ + 生ログ。生ログを RAW_MAX 超で RAW_KEEP まで剪定し、追われた分をロールアップへ畳む。
interface RollupData { in: number; out: number; byModel: Record<string, { in: number; out: number }> }
let _rollupFilePath: string | null = null;
const _rollupByModel = new Map<string, { in: number; out: number }>();
let _rollupIn = 0;
let _rollupOut = 0;
const RAW_MAX_LINES = 24000; // この行数を超えたら剪定する(毎追記で書き直さないよう KEEP と差を持たせる)
const RAW_KEEP_LINES = 20000; // 剪定後に残す直近行数。日別(14日)・期間別は生ログから出すので余裕を持って大きめ

function loadRollup(): void {
    if (!_rollupFilePath) return;
    try {
        const data = JSON.parse(fs.readFileSync(_rollupFilePath, "utf8")) as RollupData;
        _rollupIn = data.in ?? 0;
        _rollupOut = data.out ?? 0;
        for (const [m, v] of Object.entries(data.byModel ?? {})) _rollupByModel.set(m, { in: v.in, out: v.out });
    } catch {
        // ファイルなし=初回。ロールアップ0で開始。
    }
}

function saveRollup(): void {
    if (!_rollupFilePath) return;
    const byModel: Record<string, { in: number; out: number }> = {};
    for (const [m, v] of _rollupByModel) byModel[m] = v;
    try {
        fs.writeFileSync(_rollupFilePath, JSON.stringify({ in: _rollupIn, out: _rollupOut, byModel } satisfies RollupData));
    } catch (e) {
        console.error("[AI Code Guide] token rollup save failed:", e);
    }
}

// AI_NOTE: 生ログが上限超なら古い行をロールアップへ畳んで剪定する。_allTime はロールアップ+生ログの合計なので
// 「生→ロールアップ」への移動では総量が変わらず累計は不変。失敗は握り潰さずログのみ(記録は落ちても本体は止めない)。
function trimRawLog(lines: string[]): void {
    if (!_logFilePath || lines.length <= RAW_MAX_LINES) return;
    const evicted = lines.slice(0, lines.length - RAW_KEEP_LINES);
    for (const line of evicted) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line) as UsageRecord;
            _rollupIn += r.in;
            _rollupOut += r.out;
            const m = _rollupByModel.get(r.model) ?? { in: 0, out: 0 };
            m.in += r.in;
            m.out += r.out;
            _rollupByModel.set(r.model, m);
        } catch {
            // 壊れた行は捨てる(集計から除外されるだけ)
        }
    }
    try {
        fs.writeFileSync(_logFilePath, lines.slice(lines.length - RAW_KEEP_LINES).join("\n") + "\n");
        saveRollup();
    } catch (e) {
        console.error("[AI Code Guide] token log trim failed:", e);
    }
}

export function initTokenLog(storageDir: string): void {
    // AI_NOTE: I/O境界。globalStorage が未作成でも追記できるよう dir を作る。読み込み失敗は累計0で開始。
    try {
        fs.mkdirSync(storageDir, { recursive: true });
    } catch (e) {
        console.error("[AI Code Guide] token log dir create failed:", e);
    }
    _logFilePath = path.join(storageDir, "token-usage.jsonl");
    _rollupFilePath = path.join(storageDir, "token-usage-rollup.json");
    loadRollup();
    // AI_NOTE: 全期間累計はロールアップを起点に、生ログを足し込む。
    _allTimeIn = _rollupIn;
    _allTimeOut = _rollupOut;
    _allTimeCostUsd = 0;
    for (const [m, v] of _rollupByModel) _allTimeCostUsd += costUsd(m, v.in, v.out);
    try {
        const raw = fs.readFileSync(_logFilePath, "utf8");
        const lines = raw.split("\n");
        for (const line of lines) {
            if (!line.trim()) continue;
            const r = JSON.parse(line) as UsageRecord;
            _allTimeIn += r.in;
            _allTimeOut += r.out;
            _allTimeCostUsd += costUsd(r.model, r.in, r.out);
        }
        trimRawLog(lines.filter((l) => l.trim()));
    } catch {
        // ファイルなし=初回。生ログ分は0で開始。
    }
}

export function setTokenUpdateCallback(cb: () => void): void {
    _onTokenUpdate = cb;
}

export function getTokenUsage(): { input: number; output: number } {
    return { input: _sessionInTokens, output: _sessionOutTokens };
}

// AI_NOTE: 起動を跨いだ全期間累計（メモリキャッシュ）。ステータスバー/ツールチップ用にファイルを読まず即返す。
export function getAllTimeUsage(): { input: number; output: number; costUsd: number; costJpy: number } {
    return { input: _allTimeIn, output: _allTimeOut, costUsd: _allTimeCostUsd, costJpy: _allTimeCostUsd * JPY_PER_USD };
}

export function getTokenLog(): TokenLogEntry[] {
    return [..._tokenLog];
}

export function resetTokenUsage(): void {
    _sessionInTokens = 0;
    _sessionOutTokens = 0;
    _tokenLog.length = 0;
    _onTokenUpdate?.();
}

// AI_NOTE: 永続記録ファイルごと全期間累計を消す。生ログ(jsonl)を削除し、メモリキャッシュも0に戻す。
export function resetAllTimeUsage(): void {
    // AI_NOTE: 生ログとロールアップ(古い分の集約)の両方を消す。片方だけ残すと累計が復活してしまう。
    for (const p of [_logFilePath, _rollupFilePath]) {
        if (!p) continue;
        try {
            fs.rmSync(p, { force: true });
        } catch (e) {
            console.error("[AI Code Guide] token log delete failed:", e);
        }
    }
    _rollupByModel.clear();
    _rollupIn = 0;
    _rollupOut = 0;
    _allTimeIn = 0;
    _allTimeOut = 0;
    _allTimeCostUsd = 0;
    _onTokenUpdate?.();
}

export interface UsageStats {
    today: { in: number; out: number };
    week: { in: number; out: number };
    all: { in: number; out: number };
    byModel: { model: string; in: number; out: number; usd: number }[];
    costUsd: number;
    costJpy: number;
}

// AI_NOTE: QuickPick 用。生ログ(jsonl)を読んで 今日/直近7日/全期間 とモデル別コストを集計する。
// クリック時にだけ呼ぶのでファイル全読みでよい（ホットパスではない）。
export function getUsageStats(): UsageStats {
    const today0 = new Date();
    today0.setHours(0, 0, 0, 0);
    const week0 = new Date(today0);
    week0.setDate(week0.getDate() - 6); // AI_NOTE: 今日を含む7日間
    // AI_NOTE: 全期間(all)と機種別はロールアップを起点に、生ログを足す。today/week は直近なので生ログのみで足りる。
    const acc = { today: { in: 0, out: 0 }, week: { in: 0, out: 0 }, all: { in: _rollupIn, out: _rollupOut } };
    const byModelMap = new Map<string, { in: number; out: number }>();
    for (const [m, v] of _rollupByModel) byModelMap.set(m, { in: v.in, out: v.out });
    let totalUsd = 0;
    for (const [m, v] of _rollupByModel) totalUsd += costUsd(m, v.in, v.out);
    if (_logFilePath) {
        try {
            const raw = fs.readFileSync(_logFilePath, "utf8");
            for (const line of raw.split("\n")) {
                if (!line.trim()) continue;
                const r = JSON.parse(line) as UsageRecord;
                const t = new Date(r.ts);
                acc.all.in += r.in;
                acc.all.out += r.out;
                if (t >= week0) { acc.week.in += r.in; acc.week.out += r.out; }
                if (t >= today0) { acc.today.in += r.in; acc.today.out += r.out; }
                const m = byModelMap.get(r.model) ?? { in: 0, out: 0 };
                m.in += r.in;
                m.out += r.out;
                byModelMap.set(r.model, m);
                totalUsd += costUsd(r.model, r.in, r.out);
            }
        } catch {
            // ファイルなし=空集計
        }
    }
    const byModel = [...byModelMap]
        .map(([model, v]) => ({ model, in: v.in, out: v.out, usd: costUsd(model, v.in, v.out) }))
        .sort((a, b) => b.usd - a.usd);
    return { today: acc.today, week: acc.week, all: acc.all, byModel, costUsd: totalUsd, costJpy: totalUsd * JPY_PER_USD };
}

export interface DailyUsage { date: string; in: number; out: number; usd: number; jpy: number }

// AI_NOTE: 使用量タブのグラフ用。直近 days 日を日付昇順で返す（活動の無い日も0で埋め、棒グラフの連続性を保つ）。
// 日付はローカル時刻の YYYY-MM-DD で束ねる。
export function getDailyUsage(days = 14): DailyUsage[] {
    const byDate = new Map<string, { in: number; out: number; usd: number }>();
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    if (_logFilePath) {
        try {
            const raw = fs.readFileSync(_logFilePath, "utf8");
            for (const line of raw.split("\n")) {
                if (!line.trim()) continue;
                const r = JSON.parse(line) as UsageRecord;
                const k = key(new Date(r.ts));
                const cur = byDate.get(k) ?? { in: 0, out: 0, usd: 0 };
                cur.in += r.in;
                cur.out += r.out;
                cur.usd += costUsd(r.model, r.in, r.out);
                byDate.set(k, cur);
            }
        } catch {
            // ファイルなし=空
        }
    }
    // AI_NOTE: 今日から遡って days 日分の枠を作り、無い日は0で埋める
    const out: DailyUsage[] = [];
    const base = new Date();
    base.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(base);
        d.setDate(d.getDate() - i);
        const k = key(d);
        const v = byDate.get(k) ?? { in: 0, out: 0, usd: 0 };
        out.push({ date: k, in: v.in, out: v.out, usd: v.usd, jpy: v.usd * JPY_PER_USD });
    }
    return out;
}

function trackUsage(usage: { input_tokens: number; output_tokens: number }, operation: string, model: string): void {
    _sessionInTokens += usage.input_tokens;
    _sessionOutTokens += usage.output_tokens;
    _allTimeIn += usage.input_tokens;
    _allTimeOut += usage.output_tokens;
    _allTimeCostUsd += costUsd(model, usage.input_tokens, usage.output_tokens);
    _tokenLog.push({ operation, model, input: usage.input_tokens, output: usage.output_tokens, timestamp: new Date() });
    if (_tokenLog.length > TOKEN_LOG_MAX) _tokenLog.shift();
    // AI_NOTE: I/O境界。1コール=1行のJSONLを追記。失敗は握り潰さずログのみ（記録は落としても本体は止めない）。
    if (_logFilePath) {
        const rec: UsageRecord = { ts: new Date().toISOString(), op: operation, model, in: usage.input_tokens, out: usage.output_tokens };
        try {
            fs.appendFileSync(_logFilePath, JSON.stringify(rec) + "\n");
        } catch (e) {
            console.error("[AI Code Guide] token log append failed:", e);
        }
    }
    _onTokenUpdate?.();
}

function getGlobalContext(): string {
    return vscode.workspace
        .getConfiguration("aiCodeGuide")
        .get<string>("globalContext", "");
}

// LLM レスポンスから JSON 文字列を抽出する。arrayMode=true のとき最外の [...] を切り出す
// AI_NOTE: モデル出力からJSON本体を切り出す。Haiku等は「各ノードを説明します。```json {...} ```」と
// JSONの前後にプローズやフェンスを付けることがある。以前はオブジェクトモードでフェンス除去+trimのみで
// 先頭プローズを外せず JSON.parse が落ちて空になっていた。配列同様、最初の括弧〜最後の括弧を抜き出す。
function extractJsonStr(text: string, arrayMode = false): string {
    const cleaned = text.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    const [open, close, empty] = arrayMode ? ["[", "]", "[]"] : ["{", "}", "{}"];
    const start = cleaned.indexOf(open);
    const end = cleaned.lastIndexOf(close);
    return start !== -1 && end > start ? cleaned.slice(start, end + 1) : empty;
}

// AI_NOTE: 出力が途中で切れた等でJSON配列全体が壊れた時の救済。波括弧の深さを数え、
// 閉じ切っている {...} だけを個別にパースして返す（末尾の未完要素だけを捨てる）。
// 文字列中の { } / エスケープを踏まないよう、状態を持って走査する。
function salvageJsonObjects(text: string): unknown[] {
    const items: unknown[] = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === "\\") esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') inStr = true;
        else if (c === "{") { if (depth === 0) start = i; depth++; }
        else if (c === "}" && depth > 0 && --depth === 0) {
            try { items.push(JSON.parse(text.slice(start, i + 1))); } catch { /* 壊れた1件は捨てる */ }
        }
    }
    return items;
}

// AI_NOTE: モデル生出力の保管先。失敗時だけ開く（常時ログは出さない）。
let _rawLogChannel: vscode.OutputChannel | null = null;

// AI_NOTE: JSON破損の原因は生出力を見ないと分からないため、失敗時だけ全文を出力パネルに残す。
// 通知は呼び出し側が出す（ここでは黙って記録するだけ）。
function logRawFailure(operation: string, text: string, salvaged: number): void {
    _rawLogChannel ??= vscode.window.createOutputChannel("AI Code Guide");
    _rawLogChannel.appendLine(
        `[${new Date().toISOString()}] ${operation}: JSONとして読めませんでした（生出力 ${text.length} 文字 / 救済 ${salvaged} 件）`,
    );
    _rawLogChannel.appendLine(text);
    _rawLogChannel.appendLine("");
}

export interface FlowchartNode {
    id: string;
    kind: string;
    label: string;
    lineStart: number;
    lineEnd: number;
    children: string[];
}

export interface FlowchartEdge {
    from: string;
    to: string;
    label: string;
}

// AI_NOTE: 単一関数フローチャートのノード文言を、コード断片から自然な日本語へ一括で言い換える。
// 「コードが読めなくても流れが追える」が目的なので、実装の逐語訳でなく意味の言い換えを指示する。
// 関数ソース全体を文脈として渡す(断片ラベルだけでは変数の意味が取れないため)。回答はid→文言のJSONのみ。
export async function generateNodeLabels(
    funcName: string,
    funcSource: string,
    nodes: Array<{ id: string; kind: string; label: string }>
): Promise<Map<string, string>> {
    if (nodes.length === 0) return new Map();
    if (!hasApiKey(getModel())) return new Map();

    const globalCtx = getGlobalContext();

    const systemPrompt = [
        "Pythonフローチャートの各ノードの文言(コード断片)を、コードを読めない人でも処理の流れが追える短い日本語に言い換えてください。",
        "ルール:",
        "- 逐語訳でなく意味を言い換える。変数名・関数名はどうしても必要な時だけ残す。",
        "- (condition): 「〜か?」の疑問形。例: 'リストが空か?', '残高が足りるか?'",
        "- (loop): 何を順に処理するか。例: '各行を順に処理', '収束するまで繰り返す'",
        "- (return)/(raise): 何を返す/どう失敗するか。例: '合計を返す', '不正な入力ならエラー'",
        "- (block): 動詞句で何をするか。例: '設定を読み込む', '結果を集計する'",
        "- 20文字以内を目安にする。",
        '回答はJSONのみ: {"nodeId": "文言", ...}',
        globalCtx ? `文脈: ${globalCtx}` : "",
    ]
        .filter(Boolean)
        .join("\n");

    const nodeList = nodes
        .map((n) => `[${n.id}] (${n.kind}) ${n.label}`)
        .join("\n");

    const userPrompt = `対象関数 ${funcName} のソース:\n\`\`\`python\n${funcSource}\n\`\`\`\n\nノード一覧:\n${nodeList}\n\nJSONのみで回答してください。`;

    const message = await createMessage({
        model: getModel(),
        // AI_NOTE: generateBlockDescriptions と同じ根拠でノード数に応じて確保(1024固定だと後半が切れる)
        max_tokens: Math.min(8192, Math.max(1024, nodes.length * 60)),
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
    });
    trackUsage(message.usage, "generateNodeLabels", message.model);

    const text =
        message.content[0].type === "text" ? message.content[0].text : "{}";

    try {
        const parsed = JSON.parse(extractJsonStr(text)) as Record<string, string>;
        return new Map(Object.entries(parsed));
    } catch {
        return new Map();
    }
}

export async function generateBlockDescriptions(
    blocks: Array<{ id: string; code: string; kind?: string }>,
    funcName = ""
): Promise<Map<string, string>> {
    if (blocks.length === 0) return new Map();
    if (!hasApiKey(getModel())) return new Map();

    const globalCtx = getGlobalContext();

    const blockList = blocks
        .map((b) => `[${b.id}] (${b.kind ?? "block"})\n${b.code}`)
        .join("\n\n---\n\n");

    const systemPrompt = [
        "Pythonコードの各ノードに対して日本語の1行説明を生成してください。",
        "ノード種別ごとのルール:",
        "- (function): この関数の役割を「〇〇関数」の形で一言で表現する。コードの実装方法ではなく関数の名前・役割を答える。",
        "  例: 'クイックソート関数', 'ユーザー認証チェック', 'ナップサック問題DP解法'",
        "- (class): このクラスが何を表す/担うものかを名詞句で一言で表現する。class定義とdocstringから判断する。",
        "  例: '容量上限つきLRUキャッシュ', 'ユーザー情報を表すデータモデル', 'HTTPリクエストの送信役'",
        "- (block): このコードが何をしているかを動詞句で表現する。",
        "  例: '各アルゴリズムのテスト実行', '設定ファイルを読み込んでバリデート'",
        "30文字以内を目安にする。",
        '回答はJSONのみ: {"nodeId": "説明", ...}',
        funcName ? `対象関数: ${funcName}` : "",
        globalCtx ? `文脈: ${globalCtx}` : "",
    ]
        .filter(Boolean)
        .join("\n");

    const message = await createMessage({
        model: getModel(),
        // AI_NOTE: ノード数が多いと1024ではJSONが途中で切れ、後半(クラス等)の説明が落ちる。件数に応じて確保する
        max_tokens: Math.min(8192, Math.max(1024, blocks.length * 60)),
        system: systemPrompt,
        messages: [{ role: "user", content: `以下のノードを説明してください:\n\n${blockList}` }],
    });
    trackUsage(message.usage, "generateBlockDescriptions", message.model);

    const text = message.content[0].type === "text" ? message.content[0].text : "{}";

    try {
        const parsed = JSON.parse(extractJsonStr(text)) as Record<string, string>;
        return new Map(Object.entries(parsed));
    } catch {
        return new Map();
    }
}

export async function generateDirDescriptions(
    dirs: Array<{ name: string; functions: string[] }>
): Promise<Map<string, string>> {
    if (dirs.length === 0) return new Map();
    if (!hasApiKey(getChatModel())) return new Map();

    const globalCtx = getGlobalContext();

    const dirList = dirs
        .map((d) => `[${d.name}]\n関数・クラス: ${d.functions.join(", ") || "なし"}`)
        .join("\n\n");

    const systemPrompt = [
        "Pythonプロジェクトの各ディレクトリの役割を日本語で説明してください。",
        "各ディレクトリについて20文字以内の1行説明を返してください。",
        '回答はJSONのみ: {"dirName": "説明", ...}',
        globalCtx ? `文脈: ${globalCtx}` : "",
    ]
        .filter(Boolean)
        .join("\n");

    const maxTokensDirs = Math.max(512, Math.min(2048, dirs.length * 60));
    const message = await createMessage({
        model: getChatModel(),
        max_tokens: maxTokensDirs,
        system: systemPrompt,
        messages: [{ role: "user", content: `以下のディレクトリを説明してください:\n\n${dirList}` }],
    });
    trackUsage(message.usage, "generateDirDescriptions", message.model);

    const text = message.content[0].type === "text" ? message.content[0].text : "{}";

    try {
        const parsed = JSON.parse(extractJsonStr(text)) as Record<string, string>;
        return new Map(Object.entries(parsed));
    } catch {
        return new Map();
    }
}

export async function generateFileDescriptions(
    files: Array<{ id: string; name: string; functions: string[] }>
): Promise<Map<string, string>> {
    if (files.length === 0) return new Map();
    if (!hasApiKey(getChatModel())) return new Map();

    const globalCtx = getGlobalContext();

    const fileList = files
        .map(f => `[${f.id}]\n${f.name}\n関数: ${f.functions.join(", ") || "なし"}`)
        .join("\n\n");

    const systemPrompt = [
        "Pythonファイルの役割を日本語で説明してください。",
        "各ファイルについて30文字以内の1行説明を返してください。",
        "ファイル名と関数名から「このファイルが何をするか・どんな責務を持つか」を端的に表現する。",
        "例: 「ユーザー認証・ログイン処理」「商品・在庫データモデル定義」「APIエンドポイント（認証系）」",
        "JSONのキーは入力の各ブロック先頭の [] 内の文字列をそのまま使うこと。",
        '回答はJSONのみ: {"<[]内のID>": "説明", ...}',
        globalCtx ? `文脈: ${globalCtx}` : "",
    ].filter(Boolean).join("\n");

    // ファイル数×80トークン程度必要。512だとファイルが多いとJSONが途中で切れてparse失敗する
    const maxTokens = Math.max(1024, Math.min(4096, files.length * 80));
    const message = await createMessage({
        model: getChatModel(),
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: `以下のファイルを説明してください:\n\n${fileList}` }],
    });
    trackUsage(message.usage, "generateFileDescriptions", message.model);

    const text = message.content[0].type === "text" ? message.content[0].text : "{}";
    try {
        const parsed = JSON.parse(extractJsonStr(text)) as Record<string, string>;
        return new Map(Object.entries(parsed));
    } catch {
        return new Map();
    }
}

// AI_NOTE: 質問に答える図の材料。LLMには実在候補だけを渡し、必要な地点と関係を選ばせる。
// 呼び出し側で file/symbol/anchor を再照合するため、モデルが補完したコード地点は図に出ない。
export interface ProjectDiagramNode {
    id: string;
    file: string;
    symbol: string;
    anchor: string;
    label: string;
    // AI_NOTE: flowの空間表現を表示文言の推測へ依存させず、判断・開始・終了を明示する。
    role?: "start" | "process" | "decision" | "merge" | "end";
    // そのコード地点が行うこと。旧履歴には無いため optional。
    description?: string;
    // AIが質問の文脈上必要と判断した時だけ付ける意味ベースの強調。具体的な色は表示側が決める。
    emphasis?: "important" | "warning" | "success" | "note";
    // 強調した判断をコード上の事実と結び付ける短い一文。emphasis がある時だけ生成・表示する。
    emphasisReason?: string;
    // 旧版で読解・依存理由をノードへ持たせていた時の互換用。新規生成・表示では使わない。
    reason?: string;
}

export interface ProjectDiagramEdge {
    from: string;
    to: string;
    label: string;
}

export type ProjectDiagramKind = "flow" | "reading" | "dependency";

export interface ProjectDiagram {
    kind: ProjectDiagramKind;
    title: string;
    // 図全体の流れ・構造・読解順の考え方。旧履歴には無いため optional。
    summary?: string;
    nodes: ProjectDiagramNode[];
    edges: ProjectDiagramEdge[];
}

export async function generateProjectDiagram(
    question: string,
    files: Array<{ path: string; symbols: string[]; anchors: string[]; imports: string[]; source: string }>,
): Promise<ProjectDiagram | null> {
    if (!question.trim() || files.length === 0) return null;
    if (!hasApiKey(getChatModel())) {
        throw new Error("図生成用LLMが未設定です。AI Code Guideの設定でAPIキーまたはサブスク利用を有効にしてください");
    }

    const requestedSymbols = new Set(files.flatMap((file) => file.symbols.filter((symbol) => {
        const name = symbol.split(".").pop() ?? symbol;
        return question.includes(symbol) || question.includes(`${name}(`) || question.includes(`${name}()`);
    })));
    const requestedLimit = Math.min(16, Math.max(8, requestedSymbols.size));

    const manifest = files.map((f) =>
        `- ${f.path}\n  imports in this project: ${f.imports.join(", ") || "(none)"}\n  symbols: ${f.symbols.join(", ") || "(module level)"}\n  definition anchors: ${f.anchors.join(" | ") || "(module level)"}\n  source excerpt:\n${f.source || "(empty file)"}`
    ).join("\n");
    const systemPrompt = [
        "Pythonプロジェクトについて、利用者の質問に直接答える単純な図を設計してください。",
        `質問に必要なコード地点だけを3〜${requestedLimit}個選び、関係を矢印で結んでください。質問で実在symbol（関数・class・method）が明示された場合は${requestedLimit}個の上限内ですべて含めてください。`,
        "kindは必ず次の3種類から選んでください: 実際の処理順・呼び出し順はflow、推奨するコードの読解順はreading、機能や処理の依存関係はdependency。",
        "flowのedgeは実際に実行される方向、readingのedgeは読む順番、dependencyのedgeは対象から依存先への方向にしてください。",
        "flowの各nodeにはroleを必ず付けてください。start=開始、process=処理、decision=条件判断、merge=コード上に実在する合流処理、end=return/raiseなどの終了です。reading/dependencyではroleを省略してください。",
        "単一の関数またはmethodのflowを求められた場合は、その対象のentry、対象本体にある全条件分岐と各outcome、全return/raise、最後のexitを省略しないでください。正常系の値を質問されても、対象本体の例外側を消してはいけません。",
        "単一関数flowでは、呼び出し先helperの内部nodeへ展開するよう明示された場合を除き、helper内部の分岐・return・raiseを混ぜないでください。呼び出し元のcall地点を1nodeとして残します。",
        "処理順・分岐・依存関係は、source excerpt内のimport、呼び出し順、呼び出し先を根拠にしてください。名前の印象だけで線を作らないでください。",
        "別ファイルの地点を線で結ぶのは、imports in this projectとsource excerptから同じ呼び出し連鎖だと確認できる場合だけです。同名関数があっても、別ディレクトリの独立した実装を混ぜないでください。",
        "readingは利用者が読む順番・読解順を明示的に求めた場合だけ使ってください。それ以外の図に読解順や番号を持ち込まないでください。",
        "summaryは図全体が何を表すかを80字以内の完結した日本語で書いてください。flowでは関数名の言い換えだけにせず、何を受け取り、何を判断・処理し、最終的にどうなる流れかを説明してください。readingではなぜこの読解順なのかという並べ方の方針、dependencyでは起点が依存する機能群の全体像を説明してください。",
        "node.descriptionは、そのコード地点が何をするかを30字以内の完結した日本語で書いてください。「〜するため」のような目的句で終わらせず、「〜を検査する」「〜を生成する」「〜を返す」のように動作を言い切ってください。",
        "node.emphasisは質問へ答えるうえで特に意味がある地点だけに任意で付けてください。important=重要な判断や中心処理、warning=失敗・危険・要注意、success=コードを読んだAIが問題なさそうと推定した完了経路（実行・テスト済みを意味しない）、note=補足として注目すべき地点です。開始点という理由だけでは付けず、不要なら省略し、図の大半を強調しないでください。",
        "node.emphasisを付ける場合はnode.emphasisReasonも必須です。なぜその強調にしたかを、source excerptで確認できるコード上の事実と、その意味または影響を含む45字以内の完結した一文で書いてください。「重要だから」「注意が必要」のようにラベルを言い換えるだけの説明は禁止です。emphasisを付けない場合はemphasisReasonも省略してください。",
        "すべてを一直線につながず、分岐や合流が質問の理解に必要な場合だけ表現してください。",
        "選んだ全nodeを必ずedgeで一つの関係グラフへ接続してください。未接続のnodeを残してはいけません。flowの成功・失敗などの分岐は、分岐元から各経路の最初のnodeへ別々のedgeを張ってください。",
        "質問で複数の例外classが明示された場合、共通の基底例外で同じexceptへ入る実装でも、各例外classをnodeとして含め、どの共通処理へ合流するかをedgeで示してください。共通ハンドラを一方の例外だけの処理のように命名してはいけません。",
        "titleは図だけを見て対象が分かる30字以内、node.labelはその地点の役割が分かる18字以内の日本語にしてください。",
        "edge.labelは原則空文字です。成功/失敗など、文言がないと線の意味を取り違える場合だけ8字以内で入れてください。",
        "file と symbol は入力にある文字列を一字一句そのまま使うこと。symbolが無いファイルは空文字にしてください。",
        "anchor はnodeが表す処理そのものの実コード行を、選んだsymbolの定義内から一字一句そのまま抜き出してください。分岐ならif行、returnならreturn行、呼び出しならその呼び出し行を選び、symbol定義行へ一律に戻さないでください。",
        "node.idはn1,n2のように図内で一意にし、edge.from/toはそのidだけを使ってください。",
        "推測で存在しない名前を作らず、質問と関係ないコード地点や補足説明は入れないでください。",
        'JSONのみを返す: {"kind":"flow","title":"...","summary":"...","nodes":[{"id":"n1","file":"relative/path.py","symbol":"Class.method","anchor":"if total >= 200:","label":"...","role":"decision","description":"...","emphasis":"important","emphasisReason":"永続データを書き換え、失敗時は注文が保存されない。"}],"edges":[{"from":"n1","to":"n2","label":""}]}',
        getGlobalContext() ? `読者のコンテキスト: ${getGlobalContext()}` : "",
    ].filter(Boolean).join("\n");
    const parseResponse = (text: string): ProjectDiagram | null => {
        try {
            const parsed = JSON.parse(extractJsonStr(text)) as Partial<ProjectDiagram>;
            const nodes = Array.isArray(parsed.nodes) ? parsed.nodes.filter((node) =>
                typeof node?.id === "string" && typeof node?.file === "string" && typeof node?.symbol === "string"
                && typeof node?.anchor === "string" && typeof node?.label === "string"
            ).map((node) => ({
                ...node,
                role: node.role === "start" || node.role === "process" || node.role === "decision" || node.role === "merge" || node.role === "end"
                    ? node.role
                    : undefined,
                description: typeof node.description === "string" ? node.description : "",
                emphasis: node.emphasis === "important" || node.emphasis === "warning" || node.emphasis === "success" || node.emphasis === "note"
                    ? node.emphasis
                    : undefined,
                emphasisReason: typeof node.emphasisReason === "string" ? node.emphasisReason : "",
            })) : [];
            const edges = Array.isArray(parsed.edges) ? parsed.edges.filter((edge) =>
                typeof edge?.from === "string" && typeof edge?.to === "string" && typeof edge?.label === "string"
            ) : [];
            const inferredKind: ProjectDiagramKind = /読解順|読む順|読み順|読.*順|順.*読/.test(question)
                ? "reading"
                : /依存|依存関係/.test(question)
                    ? "dependency"
                    : "flow";
            const kind = parsed.kind === "flow" || parsed.kind === "reading" || parsed.kind === "dependency"
                ? parsed.kind
                : inferredKind;
            const diagram = typeof parsed.title === "string" && nodes.length > 0
                ? { kind, title: parsed.title, summary: typeof parsed.summary === "string" ? parsed.summary : "", nodes, edges }
                : null;
            return diagram;
        } catch {
            return null;
        }
    };

    const request = async (userContent: string): Promise<{ diagram: ProjectDiagram | null; raw: string }> => {
        const message = await createMessage({
            model: getChatModel(),
            max_tokens: Math.max(1800, requestedLimit * 280),
            system: systemPrompt,
            messages: [{ role: "user", content: userContent }],
        });
        trackUsage(message.usage, "generateProjectDiagram", message.model);
        const raw = message.content[0].type === "text" ? message.content[0].text : "{}";
        return { diagram: parseResponse(raw), raw };
    };

    const initial = await request(`理解したいこと: ${question}\n\nコード一覧:\n${manifest}`);
    if (!initial.diagram) return null;
    const initialConnectivity = projectDiagramConnectivity(initial.diagram.nodes, initial.diagram.edges);
    const initialMissingSymbols = missingRequestedProjectDiagramSymbols(initial.diagram.nodes, requestedSymbols);
    if (initialConnectivity.connected && initialMissingSymbols.length === 0) return initial.diagram;

    // AI_NOTE: LLMが例外経路のnodeだけ返しedgeを落とすことがある。表示順で補完すると
    // 実行順を捏造するため、壊れたJSONを明示して1回だけ修正させる。再失敗時はnullにして
    // 誤解を招く図よりエラー表示を優先する。
    const retry = await request([
        `理解したいこと: ${question}`,
        initialConnectivity.connected
            ? "前の出力のnode接続は有効です。"
            : `前の出力では未接続node (${initialConnectivity.disconnectedNodeIds.join(", ")}) があり、処理順を誤って見せます。`,
        initialMissingSymbols.length === 0
            ? "質問で明示されたsymbolは含まれています。"
            : `質問で明示された実在symbol (${initialMissingSymbols.join(", ")}) が欠落しています。各symbolをnodeとして必ず含めてください。`,
        "source excerptの事実に基づき、全nodeが一つの関係グラフになるようedgeを補い、JSON全体を返し直してください。複数の例外が共通exceptへ入る場合も各例外から共通処理への合流を描いてください。",
        `前の出力:\n${initial.raw}`,
        `コード一覧:\n${manifest}`,
    ].join("\n\n"));
    if (!retry.diagram) return null;
    const retryConnected = projectDiagramConnectivity(retry.diagram.nodes, retry.diagram.edges).connected;
    const retryMissingSymbols = missingRequestedProjectDiagramSymbols(retry.diagram.nodes, requestedSymbols);
    return retryConnected && retryMissingSymbols.length === 0 ? retry.diagram : null;
}

export async function generateSingleFileDescription(
    filename: string,
    functions: string[]
): Promise<string> {
    const result = await generateFileDescriptions([{ id: "__single__", name: filename, functions }]);
    return result.get("__single__") ?? "";
}

// AI_NOTE: ファイル全体の「型」と一言の役割を返す。標準/概要タブ上部のヘッダー用。
// kindはトップレベル要素の性格判定で6種類に分類する(下記)。表示文言・色は描画側(buildFileHeader)が持つ。
export type FileKind = "definitions" | "flow" | "entrypoint" | "model" | "config" | "test";
export interface FileOverview {
    kind: FileKind;
    role: string;
}

// AI_NOTE: 不正なkindを弾くための許可セット。LLMが範囲外を返したらdefinitionsへ丸める。
const FILE_KINDS: readonly FileKind[] = ["definitions", "flow", "entrypoint", "model", "config", "test"];

export async function generateFileOverview(
    filename: string,
    nodes: Array<{ label: string; kind: string }>
): Promise<FileOverview | null> {
    if (!hasApiKey(getChatModel())) return null;

    const globalCtx = getGlobalContext();

    // AI_NOTE: 判定材料はトップレベル要素の「種類: ラベル」一覧。LLMに型と役割を一括で出させる。
    const structure = nodes.map((n) => `- ${n.kind}: ${n.label}`).join("\n") || "(要素なし)";

    const systemPrompt = [
        "Pythonファイル全体の性格を1つの型に分類してください。",
        "判断材料はファイル名とトップレベル要素(種類+ラベル)の一覧です。",
        "次の型から最もよく当てはまる1つを選ぶ:",
        "- definitions: クラス・関数の定義が並ぶ(部品ライブラリ)",
        "- flow: 上から順に実行される手続き/スクリプト",
        "- entrypoint: プログラムの実行起点(main・CLI引数解析・if __name__=='__main__'が主役)",
        "- model: dataclassや型・スキーマ・定数などデータ構造の定義が中心(振る舞いは薄い)",
        "- config: 設定値・定数が並ぶ(settings, constants など)",
        "- test: テストコード(test_*, pytest, unittest など)",
        "迷ったら definitions か flow に倒す。",
        "role: このファイルが何をするかの30文字以内の日本語1行。",
        '回答はJSONのみ: {"kind":"<上記のいずれか>","role":"説明"}',
        globalCtx ? `文脈: ${globalCtx}` : "",
    ].filter(Boolean).join("\n");

    const message = await createMessage({
        model: getChatModel(),
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: "user", content: `ファイル名: ${filename}\nトップレベル要素:\n${structure}` }],
    });
    trackUsage(message.usage, "generateFileOverview", message.model);

    const text = message.content[0].type === "text" ? message.content[0].text : "{}";
    try {
        const parsed = JSON.parse(extractJsonStr(text)) as { kind?: string; role?: string };
        if (!parsed.role) return null;
        // AI_NOTE: 範囲外kindは定義集約に丸める(色・文言の未定義を防ぐ安全弁)。
        const kind = FILE_KINDS.includes(parsed.kind as FileKind) ? (parsed.kind as FileKind) : "definitions";
        return { kind, role: parsed.role };
    } catch {
        return null;
    }
}

export interface ModuleGroup {
    label: string;
    nodeIds: string[];
}

// 「コード順に並んだ連続する関数だけをまとめる」制約により、チャート順とコード順が一致する
export async function generateModuleGroups(
    nodes: Array<{ id: string; label: string; kind: string; lineStart: number; lineEnd: number }>
): Promise<ModuleGroup[]> {
    if (!hasApiKey(getModel())) return [];


    // コード順で渡すことで「連続する要素をまとめて」という指示が LLM に正確に機能する
    const sortedNodes = [...nodes].sort((a, b) => a.lineStart - b.lineStart);

    const nodeList = sortedNodes
        .map(n => {
            const kindDisplay = n.label.startsWith("class ") ? "class" : n.kind;
            return `${n.id} [${kindDisplay}] L${n.lineStart}-${n.lineEnd}: ${n.label}`;
        })
        .join("\n");

    const systemPrompt = [
        "以下はPythonファイルのトップレベル要素（関数・クラス・名前付き定数）一覧です（コード上の行順に並んでいます）。",
        "コード上で連続して並んでいる要素をまとめて、意味的なグループを作ってください。",
        "ルール:",
        "  - コード上で連続している要素だけを同じグループにまとめること（順序を入れ替えたり飛び越えてまとめたりしない）",
        "  - グループ数はコードの内容に応じて決める（1グループあたり1〜5要素を目安）",
        "  - 全要素をいずれかのグループに含めること",
        "  - グループラベルは日本語・15文字以内",
        '回答はJSONのみ: [{"label": "グループ名", "nodeIds": ["id1", "id2"]}, ...]',
    ].join("\n");

    // 日本語ラベルはトークンを多く消費するため乗数を大きく取る (50ノード×40≈2000)
    const maxTokens = Math.max(2048, nodes.length * 40);
    const message = await createMessage({
        model: getModel(),
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: nodeList }],
    });
    trackUsage(message.usage, "generateModuleGroups", message.model);

    const text = message.content[0].type === "text" ? message.content[0].text : "";

    try {
        const parsed = JSON.parse(extractJsonStr(text, true)) as ModuleGroup[];
        if (!Array.isArray(parsed)) return [];

        const validIds = new Set(sortedNodes.map(n => n.id));
        // sortedNodes 上の位置インデックスで連続性を判定する
        const posMap = new Map(sortedNodes.map((n, i) => [n.id, i]));

        // LLM が連続ルールを守らなかった場合に連続する部分ごとに自動分割する
        const resultGroups: ModuleGroup[] = [];
        for (const g of parsed) {
            if (!Array.isArray(g.nodeIds)) continue;
            const positions = g.nodeIds
                .filter(id => validIds.has(id))
                .map(id => posMap.get(id)!)
                .sort((a, b) => a - b);
            if (positions.length === 0) continue;

            let runStart = 0;
            for (let i = 1; i <= positions.length; i++) {
                if (i === positions.length || positions[i] !== positions[i - 1] + 1) {
                    resultGroups.push({
                        label: g.label,
                        nodeIds: positions.slice(runStart, i).map(p => sortedNodes[p].id),
                    });
                    runStart = i;
                }
            }
        }

        return resultGroups.length >= 2 ? resultGroups : [];
    } catch {
        return [];
    }
}

export interface SubBlock {
    label: string;
    lineStart: number;  // 0-indexed, file-absolute
    lineEnd: number;
    description: string;
}

// AI_NOTE: サブカード展開の先頭に出す関数レベルの要約。目的/入力/出力は必須、noteは非自明な前提がある時だけ
export interface BlockOverview {
    purpose: string;
    input: string;
    output: string;
    state?: string;
    behavior?: string;
    note?: string;
}

// AI_NOTE: generateBlockBreakdown の戻り値。overviewはサブカード群より前に表示し、blocksは従来のサブカード分解
export interface BlockExpansion {
    overview: BlockOverview | null;
    blocks: SubBlock[];
}

export async function generateBlockBreakdown(
    blockName: string,
    blockLines: string[],
    lineOffset: number,
    blockKind: "function" | "class" | "block" = "block",
): Promise<BlockExpansion> {
    if (blockLines.length === 0) return { overview: null, blocks: [] };
    if (!hasApiKey(getModel())) return { overview: null, blocks: [] };

    const globalCtx = getGlobalContext();

    // 空行・コメント行のインデックス（相対0-indexed）を候補として渡す。LLMの行番号精度を補助する
    const candidates = blockLines
        .map((l, i) => ({ i, blank: l.trim() === "", comment: l.trim().startsWith("#") }))
        .filter(x => x.blank || x.comment)
        .map(x => x.i);

    const numberedSource = blockLines.map((l, i) => `${i}: ${l}`).join("\n");

    // AI_NOTE: クラスは関数の入力/出力に当てはめると意味が薄くなるため、同じ概要欄を役割・状態・機能へ読み替える。
    const classOverviewRules = [
        "overviewのルール（クラス）:",
        "  - purpose: このクラスがシステム内で担う役割。利用側の文脈を含めて1〜2文",
        "  - state: インスタンスが保持する主な状態・依存先・設定値。無ければ「保持しない」と1文",
        "  - behavior: 外部に提供する主な機能と、それを使う側が得られること。1〜2文",
        "  - note: 継承・ライフサイクル・不変条件など、読者が知らないと迷う前提があれば1文。無ければ省略",
    ];
    const callableOverviewRules = [
        "overviewのルール:",
        "  - purpose: この処理が何のためにあるか。呼び出し側の文脈・背景を含めて1〜2文（コードの逐語でなく「なぜ」を書く）",
        "  - input: 何を受け取るか（引数の意味と前提。型名の羅列でなく意味）1文",
        "  - output: 何を返すか・どんな副作用があるか（DB書き込み・ファイル出力等）1文",
        "  - note: 読み手が知らないと迷う前提・非自明な設計判断があれば1文。無ければ省略",
        "  - 例: 既存レコードを削除して作り直す方式なら「先に既知IDを取得している」のように行の意図が読める背景をnoteに書く",
    ];
    const overviewFormat = blockKind === "class"
        ? '{"overview":{"purpose":"...","state":"...","behavior":"...","note":"..."},"blocks":[{"label":"...","lineStart":0,"lineEnd":3,"description":"..."}, ...]}'
        : '{"overview":{"purpose":"...","input":"...","output":"...","note":"..."},"blocks":[{"label":"...","lineStart":0,"lineEnd":3,"description":"..."}, ...]}';
    const systemPrompt = [
        "Pythonコードのブロックについて、概要(overview)と意味のある処理単位への分解(blocks)を行ってください。",
        ...(blockKind === "class" ? classOverviewRules : callableOverviewRules),
        "blocksのルール:",
        "  - 関数・メソッドは、定義を含めて6行以上なら必ず2〜6個の単位に分ける。代入準備、loop、条件分岐、例外処理、returnなど役割が変わる地点を境界にする",
        "  - 1つにしてよいのは、定義を含めて5行以下で役割の切替がないコードだけ",
        "  - ブロック全体をカバーすること（行0から最終行まで連続して隙間なく）",
        "  - lineStart/lineEnd は0始まりの相対行番号で返すこと",
        "  - 空行・コメント行は分割の目安にしてよいが、機械的に従わず意味を優先する",
        "  - ラベルはブロック内の処理全体を表すこと（一部の処理だけを名乗らない）",
        "  - ラベル: 15文字以内の日本語",
        "  - 説明: 1〜2文の日本語",
        `JSONオブジェクトのみで回答: ${overviewFormat}`,
        globalCtx ? `文脈: ${globalCtx}` : "",
    ].filter(Boolean).join("\n");

    const userPrompt = [
        `ブロック: ${blockName}`,
        `空行・コメント行（分割の参考）: [${candidates.join(", ")}]`,
        "",
        "コード（0始まり相対行番号）:",
        numberedSource,
    ].join("\n");

    const message = await createMessage({
        model: getModel(),
        max_tokens: Math.max(1024, blockLines.length * 30),
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
    });
    trackUsage(message.usage, "generateBlockBreakdown", message.model);

    const text = message.content[0].type === "text" ? message.content[0].text : "{}";

    type RawBlock = { label: string; lineStart: number; lineEnd: number; description: string };
    const toBlocks = (raw: RawBlock[]): SubBlock[] => raw.map(b => ({
        label: b.label ?? "",
        lineStart: (b.lineStart ?? 0) + lineOffset,
        lineEnd: (b.lineEnd ?? 0) + lineOffset,
        description: b.description ?? "",
    }));

    try {
        const parsed = JSON.parse(extractJsonStr(text)) as
            | RawBlock[]
            | { overview?: Partial<BlockOverview> | null; blocks?: RawBlock[] };
        // AI_NOTE: 後方互換。モデルが旧形式(配列のみ)で返した場合はblocksとして扱いoverviewは無し
        if (Array.isArray(parsed)) return { overview: null, blocks: toBlocks(parsed) };
        const blocks = Array.isArray(parsed.blocks) ? toBlocks(parsed.blocks) : [];
        const ov = parsed.overview;
        const overviewFields = blockKind === "class"
            ? [ov?.purpose, ov?.state, ov?.behavior]
            : [ov?.purpose, ov?.input, ov?.output];
        const hasOverview = !!ov && overviewFields.some(v => typeof v === "string" && v.trim() !== "");
        const overview = hasOverview
            ? {
                purpose: ov!.purpose ?? "",
                input: ov!.input ?? "",
                output: ov!.output ?? "",
                ...(ov!.state ? { state: ov!.state } : {}),
                ...(ov!.behavior ? { behavior: ov!.behavior } : {}),
                ...(ov!.note ? { note: ov!.note } : {}),
            }
            : null;
        return { overview, blocks };
    } catch {
        return { overview: null, blocks: [] };
    }
}

export async function parseGranularityInstruction(
    instruction: string
): Promise<{ granularity: "coarse" | "normal" | "detail"; targetFunc: string }> {

    const systemPrompt = `You are a code assistant. Parse a user's flowchart granularity instruction.
Reply ONLY with JSON: {"granularity": "coarse"|"normal"|"detail", "targetFunc": "<function name or empty string>"}
- "coarse": overview, rough, big picture → coarse
- "detail": detailed, fine-grained, branches → detail
- "normal": default
- targetFunc: if the user mentions a specific function name, extract it; otherwise empty string`;

    const message = await createMessage({
        model: getModel(),
        max_tokens: 128,
        system: systemPrompt,
        messages: [{ role: "user", content: instruction }],
    });
    trackUsage(message.usage, "parseGranularityInstruction", message.model);

    const text =
        message.content[0].type === "text" ? message.content[0].text : "{}";

    try {
        const parsed = JSON.parse(extractJsonStr(text)) as {
            granularity: "coarse" | "normal" | "detail";
            targetFunc: string;
        };
        return {
            granularity: parsed.granularity ?? "normal",
            targetFunc: parsed.targetFunc ?? "",
        };
    } catch {
        return { granularity: "normal", targetFunc: "" };
    }
}

// AI_NOTE: 意味的なコード解説の単位。symbol=行内の特定トークン、block=複数行まとまり
// startCol/endCol は symbol のときのみ設定。block のときは null（行全体を指す）
// AI_NOTE: LLMにコードの意味的な区分けを判断させてアノテーションを返す。
// 設計変更: モデルには行・列番号ではなく「注釈する実テキスト」を返させ、位置の特定は
// resolveAnnotations（決定的な文字列探索）に任せる。モデルの数え間違いに依存しない。
// パース失敗は [] を返してサイレントに処理（API境界の最小例外処理）
export async function generateSemanticAnnotations(code: string): Promise<SemanticAnnotation[]> {
    const { criteria, max: maxTokens } = getAnnotationCriteria();
    if (!hasApiKey(getInlineAnnotationModel())) return [];

    const globalCtx = getGlobalContext();

    // AI_NOTE: 各行頭に「N|」で行番号を埋め込む。モデルは数えず見える番号をそのまま書くだけにする。
    const sourceLines = code.replace(/\r\n/g, "\n").split("\n");
    const numbered = sourceLines.map((l, i) => `${i}|${l}`).join("\n");

    // AI_NOTE: 出力契約を「テキストを丸コピー」中心に変更。
    // 番号はヒント、lineText/token/startLineText/endLineText が位置の正（resolver が探索して確定）。
    // AI_NOTE: warning は赤表示になるため、正常なアルゴリズム説明ではなく「問題点・発生条件・影響」が言える時だけ許可する。
    const systemPrompt = [
        "あなたは熟練エンジニアで、AIが生成したPythonコードの読解を補助します。",
        "読者は標準的な開発者です。コード理解には2段階あります: step1=流れの把握（これは何か・このまとまりが何をするか）、step2=設計判断の理解（なぜこう書いたか）。",
        `選定基準: ${criteria}。件数を先に決めず、この基準に該当する対象を過不足なく選んでください。`,
        "各箇所に2つ書きます: label（ホバー不要で常時表示する=step1）と explanation（ホバーで出す=step2）。",
        "step2 が浅い箇所でも、step1 として役立つなら選んでよい（explanation は短くてよい）。",
        "",
        "## symbol と block の使い分け（バランス重視・重要）",
        "- block（複数行）= 意味のあるまとまり。ループ本体・条件分岐・アルゴリズムの一段階・初期化セット・try/except などは block で「全体が何をするか」を説明する",
        "- symbol（行内トークン）= その1箇所だけが非自明なとき。特定のメソッド呼び出し・式・変数の意味に限定",
        "- 変数・引数・属性は「その値が何を表すか（役割・単位・概念）」が名前や型だけから即座に分からないなら step1 として symbol で拾う（例: capacity=「キャッシュが保持できる最大件数」、ttl_seconds=「各項目の有効秒数」、self._expiry=「キーごとの失効時刻」）。ただしループ変数 i や自明な一時変数は拾わない",
        "- 変数は直前の単純な代入だけで意味が完全に分かる場合を除き、後で『何用だったか』を思い出す必要があるなら拾う。生成オブジェクトを保持する変数は、変数の役割と生成クラスの役割を一緒に説明する",
        "- project内で定義されたimport対象・クラス・関数・メソッドは読者が知っていると仮定しない。import文と最初の意味ある利用箇所を必ず拾い、このprojectでの役割を説明する",
        "- `from x import A, B, C` はA/B/Cをまとめて1件にせず、各import名をtokenにした独立symbolを必ず返す。それぞれが何を表す型・例外・サービスか説明する",
        "- `name = ProjectClass(...)` はnameをtokenにしたsymbolを必ず返し、その変数が後続処理で何を保持するかとProjectClassの役割を一緒に説明する",
        "- Python組み込み・標準ライブラリ・外部ライブラリも、len/print/range等の非常に一般的なもの以外は拾う。迷ったら説明する側に倒す",
        "- unittestのassertRaises/assertEqual/assertIs等のassertXxxは、各種類の最初の利用箇所を拾い、何を検証し失敗時にどうなるかを説明する",
        "- with文は必ずblockで拾い、context managerが管理する範囲、終了時の処理、asで受け取る値をこのコードに即して説明する",
        "- `with self.assertRaises(...)` は1つのblockでwithとassertRaisesの両方を説明する。重複するsymbolは付けない",
        "- 偏りを避ける: symbol ばかりにしない。複数行で1つの処理を成すものは積極的に block にする。目安として解説の3〜5割は block にできるはず",
        "- 1行で完結する処理を無理に block にしない。逆に、数行にまたがる処理を symbol で部分的に指すより block でまとめる方がよい",
        "- block が if/for/while/try/with/match を含む場合、block は必ずその制御文ヘッダ行から始める。制御文より前の代入・検査を同じblockへ巻き込まない",
        "- 制御文直前に、別々の入力を検査・変換する call 代入が複数並ぶ場合、それぞれのcallを独立したsymbolにする。2入力の検査を1件へまとめない",
        "- blockの範囲は同じ制御構造と、その結果を確定する直後のreturnまでに限定する。前処理と後続の別処理を大きなblockへ一括しない",
        "- 1つの意味段階には原則1件だけ付ける。同じ段階をblockと、その内部の代入・演算・callのsymbolへ細分化して重複説明しない",
        "- ループのblockはfor/whileヘッダから、そのループにインデントされた最後のbody行まで。ループ後の関数returnや次の文を含めない",
        "- 連続する直線的な計算・変換・集約が1つの結果を組み立てる場合、各代入をsymbolへ分割せず、最初の計算から結果returnまでを1つのblockとして説明する",
        "- 空list・0・False等の初期化でも、属性や変数が何を記録する入れ物かが名前だけで明白でなければ拾う。役割が即座に分かる一時変数だけを省く",
        "- 関数名とdocstringが役割を明示し、本体も単純なif→raise→returnだけの短いguard helperは選ばない。呼び出し側でそのguardを使う非自明な地点を優先する",
        "- module末尾のSAMPLE/EXAMPLE/DEMO用途の単純なliteral定数・引数辞書は原則省く。ただしproject固有クラス・メソッドの使い方を示す箇所は必須対象として拾う",
        "- 非自明な関数内で、入力の検査・変換に続くifが例外を送出し、その後に正常returnがある場合、そのifから正常returnまでを1つのblockとして必ず優先する",
        "- JSONを書く前に候補を意味段階で整理する。必須の識別子説明 → 危険操作warning → 例外制御 → 分岐/loop → 複数段の計算・集約 → 入力検査symbol の順で確認する",
        "- 最終自己検査: 同じ関数の連続計算が複数symbolや部分blockに分かれていたら、最初の計算から結果returnまでの1blockへ統合してからJSONを返す",
        "",
        "## 同じ行に複数付けてよい（条件あり）",
        "- 1行に独立した注目点が複数あれば、それぞれ別の symbol として付けてよい（例: メソッド呼び出しと変数を別々に解説）",
        "- ただし範囲が重なる・入れ子になるトークンは選ばない（例: `arr[1:]` と それを含む `[x for x in arr[1:] ...]` の両方はダメ。どちらか一方）",
        "- 1行に詰め込みすぎない。本当に別個に説明する価値があるものだけ",
        "",
        "## label（step1）と explanation（step2）の書き分け（最重要）",
        "- label = step1（常時表示・流れ）: 「これが何か・このまとまりが何をするか」を、その関数/メソッド/ループを初見の人が一読で掴める粒度で書く。調べる手間を省くのが仕事。",
        "  - symbol の label: 20〜30文字。「このトークン/メソッドが何か」（例: 「先頭をO(1)で取り出す両端キュー」「pivotを除いた残りの要素」）",
        "  - block の label: 40〜50文字。「この複数行が全体で何をするか」を流れが追える粒度で要約（縦に長い欄に流すので短すぎると間延びする）",
        "  - label では「メソッドの役割を名指す」「ループを要約する」をむしろ積極的にやる（下の step2 禁止事項は label には適用しない）",
        "  - 不可: 話題だけのタグ（「DP遷移の核心」等）。何をするかを言い切る",
        "- explanation = step2（ホバーで出す本文）: 読者が下線に触れて初めて読む唯一の文なので、**単体で読んで完結する**こと。",
        "  - symbol の explanation: 60〜120文字。1文目で「これが何か」を言い切り、2文目以降で「なぜこう書くか・非自明な点」を足す。label を読んでいない前提で書く（labelは別の場所に出る短い見出しで、ホバー本文には出ない）",
        "  - block の explanation: 30〜60文字。block は label が枠の右に常時見えているので、その一段深い理解だけを足す（label の言い換えにしない）",
        "",
        "## explanation（step2）の中身",
        "explanation の「なぜ」の部分は次のどれかを答えること:",
        "- 非自明な振る舞い: 計算量・落とし穴・境界条件・なぜこの書き方を選ぶか（例: list.pop(0)はO(n)だがdequeなら両端O(1)）",
        "- 設計判断: なぜこのデータ構造/書き方を選び、他の選択肢を捨てたか",
        "- データの意味: 配列やフラグが表す概念（例: dp[i][w]=i個目まで・容量wでの最大価値）",
        "",
        "## explanation（step2）でやってはいけない（貧弱な step2 の典型）",
        "- 構文名の言い換えで終わる: 「内包表記でフィルタ」「両端キュー」「nonlocalキーワード」← 何かを言っただけで、なぜに踏み込んでいない",
        "- コードの逐語訳: 「arr[1:]で2番目以降を取得」「iに1を足す」← 読めばわかる",
        "- symbol で「これが何か」だけで終える／block で label と同内容を繰り返す",
        "- 選定の禁止: docstring/コメントの言い換え、`return x`/`pass`等の自明行は そもそも選ばない",
        "- ただし「変数/引数/属性が何を表すか」が非自明なら自明行ではない。値の意味づけ(step1)は構文が単純でも積極的に拾う（例: `self.capacity = capacity` の capacity）",
        "- `__main__`/デモ実行部も対象にしてよい: 「このクラスをどう使うか・各ステップが何を示すか」を step1 で説明する（例: 「容量3に対し4件目を入れて最古が消えることを示す」）。ただし既存コメントの逐語言い換えはしない",
        "",
        "## バグ・問題の指摘（severity:\"warning\"、任意）",
        "- warning は赤枠で表示される。読者が一目で「何が危ないのか」分かる内容に限る",
        "- 明らかなバグ・論理矛盾・セキュリティ上危険な実装に限り severity を \"warning\" にして指摘してよい",
        "- 高確信のものだけ。少しでも推測が混じるなら出さない（誤検知は信頼を致命的に損なう）",
        "- warning にするには「問題点」「発生条件」「悪い結果」を具体的に説明できること。どれか1つでも曖昧なら info にする",
        "- 正常なアルゴリズムの性質・実装意図・計算量上の工夫・一般的な注意点は warning にしない。重要でも info にする",
        "- warning の label は必ず「問題: 」で始め、何が壊れる/危険かを書く（例: 「問題: 空入力でIndexErrorになる」）",
        "- warning の explanation も単体で完結させる。「問題: ...。条件: ...。影響: ...。」の形で、何が問題か・発生条件・悪い結果の3つを書く（labelを読んでいない前提）",
        "- ファイル書込み・ネットワーク・subprocess・動的dispatchなど、実行すると外部状態を変えるか安全性を証明できない操作の warning は、explanation の末尾に必ず『この操作は実行しない。』と明記する。単なる例外や純粋計算のwarningには付けない",
        "- 通常の解説は severity を \"info\"（省略可。未指定は info 扱い）",
        "",
        "## label（step1）/ explanation（step2）の対比",
        "- `deque`（symbol）",
        "  label: 「先頭をO(1)で取り出せる両端キュー」（これが何か・常時表示の短い見出し）",
        "  explanation: 「両端への追加と取り出しがO(1)でできるキュー。listのpop(0)は要素を全部ずらすのでO(n)かかるが、BFSは先頭取り出しを繰り返すのでここが効いてくる」（単体で完結: 何か→なぜ）",
        "- `[x for x in arr[1:] if x <= pivot]`（symbol）",
        "  label: 「pivot未満の要素を集めて左の部分配列にする」（何をするか）",
        "  explanation: 「pivot以下の要素だけを集めて左半分を作る式。pivotをarr[0]に固定したので走査対象をarr[1:]にしており、これでpivot自身が両側に二重計上されるのを防いでいる」（単体で完結）",
        "- warning は別物: 正常な性質（「FIFOで最短候補から処理する」等）は info。「何が壊れるか」言える時だけ warning にする。",
        "",
        "## 入力形式",
        "各行は「N|コード」の形式。N は0始まりの行番号。",
        "",
        "## few-shot 例",
        "入力:",
        "0|def quicksort(arr: list[int]) -> list[int]:",
        "1|    if len(arr) <= 1:",
        "2|        return arr",
        "3|    pivot = arr[0]",
        "4|    less = [x for x in arr[1:] if x <= pivot]",
        "5|    greater = [x for x in arr[1:] if x > pivot]",
        "6|    return quicksort(less) + [pivot] + quicksort(greater)",
        "出力（block と symbol を両方使う例。複数行のまとまりは block、行内の1点は symbol）:",
        '[{"kind":"block","severity":"info","startLine":3,"endLine":6,"startLineText":"    pivot = arr[0]","endLineText":"    return quicksort(less) + [pivot] + quicksort(greater)","label":"pivot未満と超過に振り分け、各々を再帰整列してpivotを挟んで連結する","explanation":"平均O(n log n)。ただしpivot=arr[0]はソート済み入力でO(n²)に劣化する"},',
        ' {"kind":"symbol","severity":"info","line":4,"lineText":"    less = [x for x in arr[1:] if x <= pivot]","token":"arr[1:]","label":"pivotを除いた残りの要素","explanation":"pivotに使ったarr[0]を除いた2番目以降の要素。ここをarrのままにするとpivot自身が比較され、左右どちらにも入って要素が二重に数えられてしまう"}]',
        "（warning の例: {\"kind\":\"symbol\",\"severity\":\"warning\",...,\"label\":\"問題: 空入力でIndexErrorになる\",\"explanation\":\"問題: 空リストを渡すと例外で落ちる。条件: arrが空の時。影響: arr[0]の参照でIndexErrorになり処理が止まる。\"}）",
        "注意: `return arr`(line2) や `pivot = arr[0]`(line3) 単独は自明なので選ばない。1行に独立した注目点が複数あれば別々に付けてよいが、範囲が重なるトークンは選ばない。",
        "",
        "## 返却形式（JSONのみ、マークダウン不可）",
        '- 行内の式: {"kind":"symbol","severity":"info"|"warning","line":N,"lineText":"その行を丸コピー","token":"下線を引く部分文字列","label":"短い見出し","explanation":"詳しい説明"}',
        '- 複数行: {"kind":"block","severity":"info"|"warning","startLine":N,"endLine":M,"startLineText":"先頭行を丸コピー","endLineText":"末尾行を丸コピー","label":"短い見出し","explanation":"詳しい説明"}',
        "",
        "## ルール（厳守）",
        "- lineText / startLineText / endLineText は対象行を一字一句そのままコピーする（先頭の `N|` は含めない）",
        "- token は lineText の中に必ず含まれる部分文字列にする",
        "- line / startLine / endLine は対象行の N をそのまま書く（数え直さない）",
        "- label は step1（常時表示・流れ・symbol 20〜30字 / block 40〜50字）。explanation は step2（ホバー本文・symbol 60〜120字で単体完結 / block 30〜60字でlabelの一段深く）",
        "- warning の label/explanation は上の warning ルールを優先し、長さより問題点の明確さを優先する",
        "- 同じ行に複数付けてよいが、範囲が重なる/入れ子のトークンは選ばない（独立したトークンのみ）",
        "- blockに制御文を含めるならstartLineTextは必ずそのif/for/while/try/with/match行。直前のcall代入はblock外のsymbolとして返す",
        "- 固定件数や件数上限はない。選定基準に該当する対象は省かず、該当しない自明な箇所で件数を水増ししない",
        globalCtx ? `読者のコンテキスト: ${globalCtx}` : "",
    ]
        .filter(Boolean)
        .join("\n");

    const targetHints = annotationTargetHints(code);
    const userPrompt = [
        '以下のPythonコード（各行頭の "N|" は行番号）に解説をつけてください:',
        "```",
        numbered,
        "```",
        targetHints.length ? "\n識別子説明の見落とし防止候補です。選定基準に従い、project固有対象・assertXxx・withは必ず含めてください:" : "",
        ...targetHints.map((hint) => `- ${hint}`),
    ].filter(Boolean).join("\n");

    const requestAnnotations = async (
        requestSystem: string,
        requestUser: string,
        operation: string,
        outputTokens: number,
    ): Promise<SemanticAnnotation[]> => {
        const message = await createMessage({
            model: getInlineAnnotationModel(),
            max_tokens: outputTokens,
            system: requestSystem,
            messages: [{ role: "user", content: requestUser }],
        });
        trackUsage(message.usage, operation, message.model);
        const text = message.content[0].type === "text" ? message.content[0].text : "[]";
        let raw: RawAnnotation[];
        try {
            raw = JSON.parse(extractJsonStr(text, true)) as RawAnnotation[];
        } catch {
            raw = salvageJsonObjects(text) as RawAnnotation[];
            logRawFailure(operation, text, raw.length);
        }
        return resolveAnnotations(raw, code);
    };

    let annotations = await requestAnnotations(
        systemPrompt,
        userPrompt,
        "generateSemanticAnnotations",
        maxTokens,
    );

    // AI_NOTE: 「生成」操作は1回のまま、モデルが必須対象を落とした時だけ内部で不足分を補完する。
    // 固定件数への水増しではなく、実コードから導いたimport/constructor/assert/withだけを検査する。
    for (let attempt = 1; attempt <= 2; attempt++) {
        const missing = missingRequiredAnnotationTargets(code, annotations);
        if (missing.length === 0) return annotations;
        const repairSystem = [
            systemPrompt,
            "",
            "## 必須カバレッジ補完",
            "次の依頼では、列挙された不足対象だけを1対象1件で返してください。既にある対象や別の箇所は返しません。",
            "importは指定tokenを下線にするsymbol、constructor代入は変数名を下線にするsymbol、withはそのwith行から始まるblockにします。",
            "with self.assertRaises(...)はassert symbolを重ねず、with行から始まる1つのblockで両方を説明します。",
        ].join("\n");
        const repairUser = [
            "以下のコードに対し、不足対象をすべて補うJSON配列だけを返してください:",
            "```",
            numbered,
            "```",
            ...missing.map((target) => {
                const token = target.token ? ` / token=${JSON.stringify(target.token)}` : "";
                return `- kind=${target.kind} / line=${target.line}${token} / code=${JSON.stringify(sourceLines[target.line] ?? "")} / 必須説明=${target.description}`;
            }),
        ].join("\n");
        const repaired = await requestAnnotations(
            repairSystem,
            repairUser,
            `generateSemanticAnnotationsRepair${attempt}`,
            Math.min(maxTokens, Math.max(2048, missing.length * 512)),
        );
        annotations = dedupAnnotations([...annotations, ...repaired]);
    }

    const missing = missingRequiredAnnotationTargets(code, annotations);
    if (missing.length > 0) {
        const summary = missing.map((target) => `${target.line + 1}:${target.token ?? target.kind}`).join(", ");
        throw new Error(`必須のインライン解説を生成できませんでした: ${summary}`);
    }
    return annotations;
}

function fallbackSymbolExplanation(item: SymbolOccurrence): string {
    if (item.kind === "variable") return `${item.display}が保持する値です。代入元と利用箇所から意味を確認できます。`;
    if (item.kind === "method") return `${item.display}が受け取る値、行う処理、返す値を定義から確認できます。`;
    if (item.kind === "function") return `${item.display}が受け取る値、行う処理、返す値を定義から確認できます。`;
    return `${item.display}が表すもの、または担当する役割を定義から確認できます。`;
}

// AI_NOTE: 対象選定はLLMへ任せずAST結果を全件使う。LLMは名称ごとの短い辞書文だけを作り、
// 欠落・JSON失敗時もfallbackで全出現位置を維持する。
export async function generateSymbolDictionaryAnnotations(
    code: string,
    occurrences: SymbolOccurrence[],
): Promise<SemanticAnnotation[]> {
    if (occurrences.length === 0) return [];
    const unique = [...new Map(occurrences.map((item) => [item.key, item])).values()];
    const descriptions = new Map(unique.map((item) => [item.key, fallbackSymbolExplanation(item)]));
    if (hasApiKey(getInlineAnnotationModel())) {
        const targets = unique.map((item) => ({
            key: item.key,
            kind: item.kind,
            name: item.display,
            scope: item.scope,
            examples: occurrences.filter((candidate) => candidate.key === item.key).slice(0, 3).map((candidate) => candidate.context),
        }));
        const system = [
            "Pythonコード中の名称を、知らない読者がその場で調べるための短い辞書文にしてください。",
            "重要性の判断、設計評価、複数行処理の要約はしません。入力された全keyへ1件ずつ返してください。",
            "variable: 何の値を保持するか。分かれば代入元も含める。",
            "function/method: 何を受け取り、何をして、何を返すか。コードで不明なら不明と書く。",
            "class: 何を表すか、または何を担当するか。",
            "40〜100文字の日本語1文。入力から確認できない内容を推測しない。",
            'JSONのみ: {"items":[{"key":"入力のkey","explanation":"短い説明"}]}',
            getGlobalContext() ? `読者のコンテキスト: ${getGlobalContext()}` : "",
        ].filter(Boolean).join("\n");
        try {
            const message = await createMessage({
                model: getInlineAnnotationModel(),
                max_tokens: Math.min(16384, Math.max(1024, unique.length * 120)),
                system,
                messages: [{ role: "user", content: `コード:\n\n${code}\n\n名称一覧:\n${JSON.stringify(targets)}` }],
            });
            trackUsage(message.usage, "generateSymbolDictionaryAnnotations", message.model);
            const text = message.content[0]?.type === "text" ? message.content[0].text : "{}";
            const parsed = JSON.parse(extractJsonStr(text)) as { items?: Array<{ key?: unknown; explanation?: unknown }> };
            for (const item of parsed.items ?? []) {
                if (typeof item.key === "string" && descriptions.has(item.key)
                    && typeof item.explanation === "string" && item.explanation.trim()) {
                    descriptions.set(item.key, item.explanation.trim().slice(0, 240));
                }
            }
        } catch (error) {
            console.warn("generateSymbolDictionaryAnnotations fallback:", error);
        }
    }
    return occurrences.flatMap((item) => {
        const annotation = buildSymbolAnnotation(code, item, descriptions.get(item.key) ?? fallbackSymbolExplanation(item));
        return annotation ? [annotation] : [];
    });
}

export async function refineSymbolDictionaryExplanation(args: {
    code: string;
    display: string;
    kind: "variable" | "function" | "method" | "class";
    current: string;
    question: string;
    history: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<{ answer: string; explanation: string }> {
    const system = [
        "Pythonコード中の1つの名称について、利用者の追加質問へ答えてください。",
        "answerは質問への直接回答。explanationは会話で判明した内容を反映した短い辞書文です。",
        "explanationの形式: variable=何の値か、function/method=何を受け取り何をして何を返すか、class=何を表すか・担当するか。",
        "重要でない補足を混ぜず、コードで確認できないことは推測せず不明と書いてください。",
        'JSONのみ: {"answer":"質問への回答","explanation":"更新後の40〜120文字の説明"}',
    ].join("\n");
    const message = await createMessage({
        model: getChatModel(),
        max_tokens: 800,
        system,
        messages: [{
            role: "user",
            content: [
                `対象: ${args.display} (${args.kind})`,
                `現在の説明: ${args.current}`,
                `これまでの会話: ${JSON.stringify(args.history.slice(-8))}`,
                `質問: ${args.question}`,
                `コード:\n${args.code}`,
            ].join("\n\n"),
        }],
    });
    trackUsage(message.usage, "refineSymbolDictionaryExplanation", message.model);
    const text = message.content[0]?.type === "text" ? message.content[0].text : "{}";
    const parsed = JSON.parse(extractJsonStr(text)) as { answer?: unknown; explanation?: unknown };
    if (typeof parsed.answer !== "string" || !parsed.answer.trim()
        || typeof parsed.explanation !== "string" || !parsed.explanation.trim()) {
        throw new Error("名称の説明を更新できませんでした。");
    }
    return {
        answer: parsed.answer.trim().slice(0, 1000),
        explanation: parsed.explanation.trim().slice(0, 240),
    };
}

// AI_NOTE: 特定のアノテーションに対する追加質問に答える。チャットパネルから呼ばれる
export async function answerAnnotationQuestion(
    question: string,
    codeSnippet: string,
    explanation: string,
    history: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
    if (!hasApiKey(getInlineAnnotationModel())) return "";
    const globalCtx = getGlobalContext();

    const systemPrompt = [
        "あなたはPythonコードの解説アシスタントです。",
        "ユーザーはコードの特定の箇所についての解説を見て、追加質問をしています。",
        "簡潔かつ正確に日本語で答えてください（2〜5文程度）。",
        globalCtx ? `読者のコンテキスト: ${globalCtx}` : "",
    ].filter(Boolean).join("\n");

    const contextMsg = `対象コード:\n\`\`\`python\n${codeSnippet}\n\`\`\`\n\n解説: ${explanation}`;
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [
        { role: "user", content: contextMsg },
        { role: "assistant", content: "わかりました。このコードについてご質問があればどうぞ。" },
        ...history,
        { role: "user", content: question },
    ];

    const message = await createMessage({
        model: getInlineAnnotationModel(),
        max_tokens: 512,
        system: systemPrompt,
        messages,
    });
    trackUsage(message.usage, "answerAnnotationQuestion", message.model);
    return message.content[0].type === "text" ? message.content[0].text : "";
}

export async function generateTokenExplanation(
    tokenText: string,
    tokenKind: string,
    fileContent: string,
    lineNumber: number
): Promise<string> {
    const globalCtx = getGlobalContext();

    const systemPrompt = [
        "You are a code documentation assistant. Explain a code token in 1-3 sentences.",
        "Be concise. Use Japanese if the user context suggests it.",
        "Focus on what it does, not how it's implemented.",
        globalCtx ? `User context: ${globalCtx}` : "",
    ]
        .filter(Boolean)
        .join("\n");

    const userPrompt = `Token: \`${tokenText}\` (${tokenKind}) at line ${lineNumber + 1}

File:
\`\`\`python
${fileContent}
\`\`\`

Explain this token.`;

    const message = await createMessage({
        model: getChatModel(),
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
    });
    trackUsage(message.usage, "generateTokenExplanation", message.model);

    return message.content[0].type === "text"
        ? message.content[0].text
        : "No explanation available.";
}

export async function answerFollowUpQuestion(
    question: string,
    tokenText: string,
    originalExplanation: string,
    fileContent: string
): Promise<string> {
    const globalCtx = getGlobalContext();

    const systemPrompt = [
        "You are a code documentation assistant. Answer a follow-up question about a code token.",
        "Be concise (2-4 sentences). Use Japanese if the user context suggests it.",
        globalCtx ? `User context: ${globalCtx}` : "",
    ]
        .filter(Boolean)
        .join("\n");

    const userPrompt = `Token: \`${tokenText}\`
Original explanation: ${originalExplanation}

File:
\`\`\`python
${fileContent}
\`\`\`

Follow-up question: ${question}`;

    const message = await createMessage({
        model: getChatModel(),
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
    });
    trackUsage(message.usage, "answerFollowUpQuestion", message.model);

    return message.content[0].type === "text"
        ? message.content[0].text
        : "No answer available.";
}

export async function chatAboutCode(
    history: Array<{ role: "user" | "assistant"; content: string; quotes?: Array<{ code: string; explanation?: string; fileName?: string; lineStart?: number; lineEnd?: number }> }>,
    fileContent: string,
    fileName: string,
    // AI_NOTE: 中断用。呼び出し側(mainViewProvider)の AbortController の signal を createMessage まで通す。
    signal?: AbortSignal
): Promise<string> {
    const globalCtx = getGlobalContext();
    const systemPrompt = [
        `You are a code assistant. The user is viewing a flowchart/module map of a Python file named "${fileName}".`,
        "Answer questions about the code concisely. Use Japanese.",
        // AI_NOTE: 引用はメッセージ添付型。本文中の「(引用N)」「引用N」はそのメッセージに添付されたN番目の引用を指す（UIがインラインチップに置換して表示する）。
        "Within a user message, the tokens (引用N) or 引用N refer to the Nth quoted code block attached to that same message (numbered starting at 1).",
        globalCtx ? `User context: ${globalCtx}` : "",
    ].filter(Boolean).join("\n");

    // AI_NOTE: 各 user メッセージに添付された引用を、その本文の前に番号付きで展開する（セッション先頭でなく発話単位）。
    // 行表記は単一行なら「12行目」、範囲なら「12-20行目」、場所情報が無い引用（解説由来）は場所句ごと省略する。
    const quoteBlock = (quotes: NonNullable<(typeof history)[number]["quotes"]>): string =>
        quotes
            .map((q, i) => {
                const lines = q.lineStart == null ? "" : q.lineStart === q.lineEnd ? `${q.lineStart}行目` : `${q.lineStart}-${q.lineEnd}行目`;
                const loc = lines ? `（${q.fileName ?? fileName} ${lines}）` : "";
                return `引用${i + 1}${loc}:\n\`\`\`python\n${q.code}\n\`\`\`${q.explanation ? `\n解説: ${q.explanation}` : ""}\n\n`;
            })
            .join("");

    // 最初のユーザーメッセージにファイル内容を埋め込む。各userメッセージは引用ブロック→本文の順
    const messages = history.map((m, i) => {
        if (m.role !== "user") return { role: m.role, content: m.content };
        const filePart = i === 0 ? `ファイル: ${fileName}\n\`\`\`python\n${fileContent}\n\`\`\`\n\n` : "";
        return { role: "user" as const, content: `${filePart}${m.quotes?.length ? quoteBlock(m.quotes) : ""}${m.content}` };
    });

    const message = await createMessage({
        model: getChatModel(),
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        // AI_NOTE: チャットだけ effort を渡す（注釈/FC等の構造系は速度優先で low 固定のまま）。
        effort: getChatEffort(),
        signal,
    });
    trackUsage(message.usage, "chatAboutCode", message.model);
    return message.content[0].type === "text" ? message.content[0].text : "";
}

// AI_NOTE: ヘルプタブの「ヘルプに質問」用。拡張の使い方を、渡されたヘルプ文書"だけ"を根拠に答える。
// 文書外を勝手に創作させないため system で出典を固定し、無ければ「設定タブ等を見て」と素直に誘導させる。
// 会話系モデル(getChatModel)を使い、使用量は他の生成と同じく trackUsage に集計する。
export async function answerHelpQuestion(question: string, helpDoc: string): Promise<string> {
    const globalCtx = getGlobalContext();
    const systemPrompt = [
        'You are the in-app help assistant for the VS Code extension "AI Code Guide".',
        "Answer the user's question about how to USE the extension, based ONLY on the help document provided below.",
        "Use Japanese. Be concise and practical (steps/keys when relevant).",
        "If the answer is not in the document, say so briefly and point them to the 設定タブ or the relevant section instead of inventing features.",
        globalCtx ? `User context: ${globalCtx}` : "",
    ].filter(Boolean).join("\n");
    const messages = [{ role: "user" as const, content: `# ヘルプ文書\n${helpDoc}\n\n# 質問\n${question}` }];
    const message = await createMessage({ model: getChatModel(), max_tokens: 1024, system: systemPrompt, messages });
    trackUsage(message.usage, "answerHelpQuestion", message.model);
    return message.content[0].type === "text" ? message.content[0].text : "";
}

// AI_NOTE: chatLink注釈の中身。結論は1つだが、下線(symbol)と枠(block)で入る欄の幅が違うので常時表示labelを2段の長さで持つ。
// symbolLabel=短い版(下線・CodeLens1行/通常symbol labelの20〜30字に整合)/blockLabel=濃い版(枠・複数行サイドノート/通常block labelの40〜50字に整合)。
// explanation=ホバー用の補足(1文)。呼び出し側が注釈のkindでsymbol/blockLabelを選ぶ。内容は同じ結論で長さ(詳しさ)だけ違う。
export interface ChatConclusion {
    symbolLabel: string;
    blockLabel: string;
    explanation: string;
    targets: RawAnnotation[];
}

// AI_NOTE: LLM境界の4行形式を純粋関数で検証する。壊れた/余分なJSON対象は捨てても、会話本文用の結論は維持する。
export function parseChatConclusion(text: string): ChatConclusion {
    const fallback: ChatConclusion = { symbolLabel: "会話メモ", blockLabel: "会話メモ", explanation: "", targets: [] };
    const lines = text.trim().split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
    const symbolLabel = normalizeLabelLine(lines[0] ?? "");
    const blockLabel = normalizeLabelLine(lines[1] ?? lines[0] ?? "");
    const explanation = capText(lines[2] || lines[1] || lines[0] || "", 120);
    let targets: RawAnnotation[] = [];
    try {
        const parsed = JSON.parse(extractJsonStr(lines.slice(3).join("\n"), true)) as unknown;
        if (Array.isArray(parsed)) {
            targets = parsed.filter((value): value is RawAnnotation => {
                if (!value || typeof value !== "object") return false;
                const item = value as Partial<RawAnnotation>;
                if (item.kind === "symbol") return typeof item.lineText === "string" && typeof item.token === "string";
                return item.kind === "block" && typeof item.startLineText === "string" && typeof item.endLineText === "string";
            }).slice(0, 3);
        }
    } catch {
        targets = [];
    }
    return (symbolLabel || blockLabel) ? { symbolLabel, blockLabel, explanation, targets } : fallback;
}

// AI_NOTE: 引用箇所についての会話「全体」から、その箇所の結論(=コードの解説)を要約する。会話が進むたびに呼び直して
// 最新の結論へ更新する想定(凍結しない)。まだ結論が出ていない途中でも、その時点の暫定的な要点を返す(「質問中」は返さない)。
// 4行(symbol短文/block長文/explanation/対象JSON)で受ける。品質モデル(getChatModel)を使い構造系(getModel)とは分ける。
// 失敗・未設定時は例外を投げず暫定fallbackを返す(注釈生成の失敗でチャット本体を壊さないため)。
export async function summarizeChatConclusion(transcript: string, code: string, signal?: AbortSignal): Promise<ChatConclusion> {
    const fallback: ChatConclusion = { symbolLabel: "会話メモ", blockLabel: "会話メモ", explanation: "", targets: [] };
    // AI_NOTE: 会話「理解」タスクなので品質モデル(getChatModel=既定Sonnet)を使う。構造系(getModel=Haiku)は書式を守らず
    // プロンプトの語をechoしたり「理解:」等の接頭辞を付けるため不適(実機で確認)。会話系は元々Sonnet相当で品質が出る。
    if (!hasApiKey(getChatModel())) return fallback;

    // AI_NOTE: 傍観者として指示し会話への応答を防ぐ。結論未確定でも暫定要点を出させる(「質問中」等の非情報は禁止)。
    // labelは常時表示され、label単体で意味が分かる必要があるので『〜の理由』等の話題見出しを明示禁止し結論の中身を平叙文で述べさせる。
    // 下線と枠で欄幅が違うため短い版(symbol)と濃い版(block)を1回で両方出させる。同じ結論を長さだけ変える。良い例/悪い例で誘導。
    // AI_NOTE: 4行目のJSONは、引用なしの質問でもコード本文へ安全に再照合できる位置情報。行番号ではなく実テキストを正とする。
    const systemPrompt = [
        "コードについての会話を読み、この箇所が何をしている/なぜこうなっているかの結論を要約する。会話には応答しない。",
        "まだ途中でもその時点の暫定的な要点を書く(「質問中」「回答待ち」等は書かない)。",
        "最重要: 各行は『話題の見出し』ではなく、それ単体を読んで意味が分かる『結論の中身そのもの』を事実の平叙文で書く。",
        "『〜の理由』『〜について』『〜とは』『〜の仕組み』のような話題名だけの見出しは禁止(それだけ読んでも何が結論か分からないため)。",
        "接頭辞(『見出し:』『理解:』『結論:』等)・記号・引用符は付けない。",
        "出力はちょうど4行。1〜3行目の字数は厳守し、超えそうなら条件の列挙や修飾を削って言い切る:",
        "1行目=短い版。この箇所が何をするかだけを端的に(全角25字以内)。理由・条件の列挙は入れない。",
        "2行目=詳しい版。同じ結論をなぜ/どうやってまで含めて1文で(全角50字以内)。",
        "3行目=ホバー用の補足(全角30〜60字)。1・2行目の丸写しにしない。",
        "4行目=最新の質問と回答が、表示中コードの具体的な箇所について再利用できる解説なら、その対象をJSON配列で最大3件。挨拶、一般的なPythonの質問、拡張の使い方、場所を特定できない質問は []。",
        'symbolは {"kind":"symbol","line":N,"lineText":"対象行をコードから丸コピー","token":"対象部分を丸コピー"}。blockは {"kind":"block","startLine":N,"endLine":M,"startLineText":"先頭行を丸コピー","endLineText":"末尾行を丸コピー"}。N/Mは入力の0始まり番号をそのまま使う。説明文はJSONへ入れない。',
        "会話全体ではなく、最新の質問とその回答で新しく説明された箇所だけを4行目へ入れる。質問でコードを引用していなくても、関数名・変数名・処理内容から一意に分かれば対象にする。",
        "良い例(無関係なコードの、1〜3行目の順。1行目がこの位短いことに注意):",
        "キー不在でもget(k,0)で既定値0を返す",
        "存在チェックのif分岐を書かず、未登録キーもget(k,0)の既定値0でそのまま加算できる。",
        "だからカウント集計などで初出キーの前処理が要らない。",
        "悪い例(1行目): 『辞書のgetの理由』…話題名だけで結論の中身がなく、label単体では意味が分からない。",
    ].join("\n");
    const numberedCode = code.replace(/\r\n/g, "\n").split("\n").map((line, index) => `${index}|${line}`).join("\n");
    const userPrompt = `コード（各行頭のN|は0始まりの行番号）:\n\`\`\`python\n${numberedCode}\n\`\`\`\n\n会話:\n${transcript}`;

    try {
        const message = await createMessage({
            model: getChatModel(),
            max_tokens: 320,
            system: systemPrompt,
            messages: [{ role: "user", content: userPrompt }],
            signal,
        });
        trackUsage(message.usage, "summarizeChatConclusion", message.model);
        const text = message.content[0]?.type === "text" ? message.content[0].text : "";
        return parseChatConclusion(text);
    } catch {
        return fallback;
    }
}

// AI_NOTE: 常時表示label用の整形。先頭1行だけ取り、前後の記号(箇条書き・引用符)とメタ接頭辞を落とすだけで、
// 長さは切らない。通常のsymbol/block labelは固定長カットを通さず返り値を全表示しており、chatlinkだけ「…」が付くと
// 不整合になるため揃える(…で切ると常時表示の情報が消える。memory inline-label-full-not-truncated)。多行の暴走は
// lines[0]抽出で既に防いでおり、長すぎる時はレイアウト側で収める(=他labelと同じ扱い)。
function normalizeLabelLine(text: string): string {
    const firstLine = text.trim().split(/\r?\n/)[0].replace(/\s+/g, " ").trim();
    // AI_NOTE: 弱いモデルが付けがちなメタ接頭辞(見出し:/結論:/理解:/要点:/ラベル:)を1つだけ剥がす。全/半角コロン対応。
    const deprefixed = firstLine.replace(/^(見出し|結論|理解|要点|ラベル)\s*[:：]\s*/, "");
    return deprefixed.replace(/^[-*・「『"'\s]+/, "").replace(/[」』"'\s]+$/, "");
}

// AI_NOTE: ホバー要点(explanation)用の整形。改行を畳んで前後の装飾記号を落とし、maxLenで切る(超過は…)。
// labelほど厳しく1行に潰さないが、暴走した長文がホバーを埋めないよう上限は掛ける。
function capText(text: string, maxLen: number): string {
    const oneLine = text.trim().replace(/\s+/g, " ").replace(/^[-*・「『"'\s]+/, "").replace(/[」』"'\s]+$/, "");
    return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
}

// AI_NOTE: 実行トレース機能のLLM出力。値そのものはLLMに作らせず、①副作用の事前判定 ②入力の具体例(準備コード)
// ③型ごとの短縮表示テンプレート、だけを1回で出させる。変数の値は trace_runner.py の実行結果が正。
export interface TraceExample {
    safetyDecision: "safe" | "known-unsafe" | "safety-unknown";
    sideEffects: boolean;
    sideEffectReason: string;
    setup: string;
    templates: Record<string, string>;
}

// AI_NOTE: priorError は実行失敗時のリトライ用(1回だけ)。前回の準備コードとエラーを渡して作り直させる。
export async function generateTraceExample(
    fileSource: string,
    funcName: string,
    priorError?: { setup: string; error: string },
    dependencyContext = "",
): Promise<TraceExample | null> {
    if (!hasApiKey(getInlineAnnotationModel())) return null;

    const globalCtx = getGlobalContext();
    const systemPrompt = [
        "Pythonの対象関数を「具体例で実際に実行して各行の変数の値を見せる」ためのお膳立てを作ってください。",
        "回答はJSONのみ:",
        '{"safety_decision": "safe|known-unsafe|safety-unknown", "side_effects": bool, "side_effect_reason": "...", "setup": "...", "templates": {"型名": "テンプレート"}}',
        "",
        "## side_effects（隔離環境で実行可能かの事前判定）",
        "- 実行時はworkspace全体の使い捨てcopyと専用temp directoryに隔離され、隔離外へのfile書込、network、subprocessはruntimeでも遮断される。",
        "- safety_decision は必須。fileの作成・更新・削除やTemporaryDirectoryだけなら隔離内で実行できるので safe。network・DB・subprocess・OS process・環境変更が確認できるなら known-unsafe。globals()/getattr()/eval等の動的呼出しで安全性を証明できないなら safety-unknown。",
        "- known-unsafe と safety-unknown はどちらも実行禁止だが、理由を混同しない。",
        "- side_effects は隔離しても外部へ影響し得る操作についてtrueにする。隔離内だけのfile操作はfalseにする。",
        "- workspace-local dependency sourceがある場合は、対象から実際に呼ばれる実装まで確認する。型名やProtocol名だけで副作用を推測しない。unit testが同じfile内のin-memory fakeを注入しているなら、そのfakeの実装とcalleeを根拠に判定する。",
        "- true のときは実行しないので setup は空文字でよい。side_effect_reason に何に触るかを1行で。",
        "",
        "## setup（準備コード）",
        "- 対象ファイルのモジュールを実行した名前空間で exec される。ファイル内のクラス・関数はそのまま使える(importを書かない)。",
        "- 必ず EXAMPLE_ARGS(位置引数のtuple。引数1個でも (x,) のtuple)を定義する。キーワード引数が必要なら EXAMPLE_KWARGS(dict)も。",
        "- 対象が通常のインスタンスメソッドなら、呼び出し先のインスタンスを EXAMPLE_INSTANCE = ClassName(...) で定義する。EXAMPLE_ARGS に self は含めない。",
        "- unittest.TestCase の test_* メソッドは実行側がインスタンスを作り setUp()/tearDown() を呼ぶため、EXAMPLE_INSTANCE は定義しない。通常 EXAMPLE_ARGS = () とする。",
        "- 例は最小構成にする: リストは2〜3要素・ループが2〜3周で終わる規模。ただし関数の面白い分岐(if/else両方)が通る値を選ぶ。",
        "- 値は現実的に(意味のある名前・値。foo/bar は避ける)。",
        "",
        "## templates（型の短縮表示・任意）",
        "- reprが長くなるクラスだけ、表示用テンプレートを与える。{属性名} が実行時の実値で埋まる。",
        '- 例: {"Circle": "C({day},{serial})", "User": "User({name})"}。関数の理解に効く属性だけ選ぶ。',
        "- 組み込み型(list/dict等)には不要。",
        globalCtx ? `文脈: ${globalCtx}` : "",
    ].filter(Boolean).join("\n");

    const userParts = [
        `対象関数: ${funcName}`,
        "対象ファイル:",
        "```python",
        fileSource,
        "```",
    ];
    if (dependencyContext) {
        userParts.push(
            "",
            "対象fileからimportされるworkspace-local dependency source:",
            "```python",
            dependencyContext,
            "```",
        );
    }
    if (priorError) {
        userParts.push(
            "",
            "前回の準備コードは実行に失敗しました。エラーを踏まえて作り直してください。",
            `前回のsetup:\n${priorError.setup}`,
            `エラー:\n${priorError.error}`,
        );
    }

    const message = await createMessage({
        model: getInlineAnnotationModel(),
        max_tokens: 2048,
        system: systemPrompt,
        messages: [{ role: "user", content: userParts.join("\n") }],
    });
    trackUsage(message.usage, "generateTraceExample", message.model);

    const text = message.content[0].type === "text" ? message.content[0].text : "{}";
    try {
        const parsed = JSON.parse(extractJsonStr(text)) as {
            safety_decision?: "safe" | "known-unsafe" | "safety-unknown";
            side_effects?: boolean; side_effect_reason?: string; setup?: string; templates?: Record<string, string>;
        };
        const declaredSafety = parsed.safety_decision === "safe"
            || parsed.safety_decision === "known-unsafe"
            || parsed.safety_decision === "safety-unknown"
            ? parsed.safety_decision
            : parsed.side_effects ? "safety-unknown" : "safe";
        const safetyDecision = declaredSafety === "safe" && parsed.side_effects ? "safety-unknown" : declaredSafety;
        return {
            safetyDecision,
            sideEffects: safetyDecision !== "safe" || (parsed.side_effects ?? false),
            sideEffectReason: parsed.side_effect_reason ?? "",
            setup: parsed.setup ?? "",
            templates: parsed.templates ?? {},
        };
    } catch {
        return null;
    }
}
