import type { SymbolOccurrence } from "../flowchart/astParser";
import { createHash } from "crypto";

export interface CachedSymbolDescription {
    symbolKey?: string;
    symbolFingerprint?: string;
    explanation: string;
}

export interface SymbolDescriptionReusePlan {
    fingerprints: Map<string, string>;
    reusedDescriptions: Map<string, string>;
    missingKeys: Set<string>;
}

export const SYMBOL_DICTIONARY_CACHE_VERSION = "scope-evidence-python-v3";

const PYTHON_BUILTINS = new Set([
    "abs", "all", "any", "bool", "bytes", "callable", "chr", "dict", "divmod", "enumerate", "filter", "float",
    "format", "frozenset", "getattr", "hasattr", "hash", "hex", "id", "int", "isinstance", "issubclass", "iter",
    "len", "list", "map", "max", "min", "next", "object", "open", "ord", "pow", "print", "range", "repr",
    "reversed", "round", "set", "slice", "sorted", "str", "sum", "super", "tuple", "type", "zip",
]);
const STANDARD_METHODS: Record<string, string> = {
    strip: "strの場合は前後の空白等を除いた文字列を返す",
    lstrip: "strの場合は先頭の空白等を除いた文字列を返す",
    rstrip: "strの場合は末尾の空白等を除いた文字列を返す",
    lower: "strの場合は小文字化した文字列を返す",
    upper: "strの場合は大文字化した文字列を返す",
    title: "strの場合は各単語をタイトルケース化した文字列を返す",
    split: "strの場合は区切って文字列のリストを返す",
    join: "strの場合は文字列の列をその区切り文字で連結する",
    replace: "strの場合は指定部分を置換した文字列を返す",
    startswith: "strの場合は指定の先頭部分に一致するか返す",
    endswith: "strの場合は指定の末尾部分に一致するか返す",
    fromkeys: "dictのclassmethodの場合は要素をキーとする辞書を作る。値省略時はNone",
    get: "dictの場合はキーに対応する値を返し、キーがなければ既定値を返す",
    keys: "dictの場合はキーのビューを返す",
    values: "dictの場合は値のビューを返す",
    items: "dictの場合はキーと値の組のビューを返す",
    append: "listの場合は末尾へ要素を加え、Noneを返す",
    extend: "listの場合は反復可能な値の要素を末尾へ加え、Noneを返す",
    sort: "listの場合はリスト自身を並べ替え、Noneを返す",
};

export function buildSymbolDictionaryCacheIdentity(args: {
    model: string;
    globalContext: string;
    providerAvailable: boolean;
}): string {
    return JSON.stringify({ version: SYMBOL_DICTIONARY_CACHE_VERSION, ...args });
}

function statementEnd(lines: string[], item: SymbolOccurrence): number {
    if (/^\s*(async\s+)?def\b/.test(lines[item.line] ?? "")) return item.line;
    if (Number.isInteger(item.statement_end) && item.statement_end! >= item.line && item.statement_end! < lines.length) {
        return item.statement_end!;
    }
    let end = item.line;
    const indent = (lines[item.line] ?? "").search(/\S/);
    while (end + 1 <= item.scope_end) {
        const next = lines[end + 1];
        if (next.trim() && next.search(/\S/) <= indent && !lines[end].trimEnd().endsWith("\\")) break;
        end++;
    }
    // 空行を追加しただけでmodule変数を失効させない。
    while (end > item.line && !lines[end].trim()) end--;
    return end;
}

function statementStart(lines: string[], item: SymbolOccurrence): number {
    if (/^\s*(async\s+)?def\b/.test(lines[item.line] ?? "")) return item.line;
    return Number.isInteger(item.statement_start) && item.statement_start! >= 0 && item.statement_start! <= item.line
        ? item.statement_start! : item.line;
}

function evidenceForOccurrence(lines: string[], occurrence: SymbolOccurrence): string {
    if (occurrence.scope === "<module>" && occurrence.kind === "variable") {
        return lines.slice(statementStart(lines, occurrence), statementEnd(lines, occurrence) + 1).join("\n");
    }
    const start = occurrence.scope_start;
    const end = occurrence.scope_end;
    if (Number.isInteger(start) && Number.isInteger(end)
        && start >= 0 && end >= start && end < lines.length) {
        return lines.slice(start, end + 1).join("\n");
    }
    return occurrence.context;
}

export interface SymbolGenerationEvidence {
    key: string;
    kind: SymbolOccurrence["kind"];
    name: string;
    scope: string;
    code: string[];
    definitions: Array<{ key: string; code: string[] }>;
    uncertainty: string[];
    knownPython: { version: "python-core-v1"; builtins: string[]; conditionalMethods: Array<{ name: string; meaning: string }> };
}

// AI_NOTE: fingerprintとプロンプトが同じ証拠オブジェクトを使う。対象外の全文・絶対行番号は混ぜない。
// 既知の同一ファイル参照だけ追跡し、動的/外部参照は不明と記録する（全件再生成しない）。
export function buildSymbolGenerationEvidence(
    code: string,
    occurrences: SymbolOccurrence[],
): Map<string, SymbolGenerationEvidence> {
    const lines = code.replace(/\r\n/g, "\n").split("\n");
    const grouped = new Map<string, SymbolOccurrence[]>();
    for (const item of occurrences) grouped.set(item.key, [...(grouped.get(item.key) ?? []), item]);
    const definitions = new Map([...grouped].map(([key, values]) => [key, values.filter(item => item.is_definition)]));
    const resolve = (reference: SymbolOccurrence): SymbolOccurrence[] => {
        const exact = definitions.get(reference.key) ?? [];
        if (exact.length) return exact;
        // AI_NOTE: ASTの利用側keyは利用scopeなので、同じ名称の最も近い字句定義へ解決する。
        // receiverの型が不明な属性を、同名というだけで別classの定義へ結び付けない。
        const identity = reference.key.split("|").slice(2).join("|");
        if (identity.includes(".") && !/^(self|cls)\./.test(identity)) return [];
        const candidates = [...definitions.values()].flat().filter(item => item.name === reference.name
            && (item.scope === "<module>" || reference.scope === item.scope || reference.scope.startsWith(`${item.scope}.`)));
        const depth = Math.max(-1, ...candidates.map(item => item.scope === "<module>" ? 0 : item.scope.split(".").length));
        const nearest = candidates.filter(item => (item.scope === "<module>" ? 0 : item.scope.split(".").length) === depth);
        return new Set(nearest.map(item => item.key)).size === 1 ? nearest : [];
    };
    const knownBuiltin = (reference: SymbolOccurrence): boolean => PYTHON_BUILTINS.has(reference.name)
        && !reference.key.split("|")[2].includes(".") && !reference.import_shadowed
        && !resolve(reference).length;
    const conditionalMethod = (reference: SymbolOccurrence): boolean => reference.kind === "method"
        && !!STANDARD_METHODS[reference.name] && !resolve(reference).length;
    const result = new Map<string, SymbolGenerationEvidence>();
    for (const [key, values] of grouped) {
        const ownDefinitions = definitions.get(key)!;
        const roots = ownDefinitions.length ? ownDefinitions : values;
        const ownCode = [...new Set(roots.map(item => evidenceForOccurrence(lines, item)))].sort();
        // AI_NOTE: 同じscopeに含まれる既知のPython仕様を共通入力にする。定義不足と組込仕様を区別する。
        const scopeReferences = occurrences.filter(candidate => roots.some(item => {
            const start = item.scope === "<module>" && item.kind === "variable" ? statementStart(lines, item) : item.scope_start;
            const end = item.scope === "<module>" && item.kind === "variable" ? statementEnd(lines, item) : item.scope_end;
            return candidate.line >= start && candidate.line <= end;
        }));
        const knownPython: SymbolGenerationEvidence["knownPython"] = {
            version: "python-core-v1",
            builtins: [...new Set(scopeReferences.filter(knownBuiltin).map(item => item.name))].sort(),
            conditionalMethods: [...new Set(scopeReferences.filter(conditionalMethod).map(item => item.name))].sort()
                .map(name => ({ name, meaning: STANDARD_METHODS[name] })),
        };
        const related = new Map<string, string[]>();
        const uncertainty = new Set<string>();
        const visited = new Set<string>([key]);
        const visit = (items: SymbolOccurrence[], wholeScope: boolean): void => {
            const ranges = items.map(item => {
                if (wholeScope) return [item.scope_start, item.scope_end];
                // AI_NOTE: 改行した代入式の参照も根拠へ含める。次の同段文は無関係なので含めない。
                return [statementStart(lines, item), statementEnd(lines, item)];
            });
            const references = occurrences.filter(candidate => !candidate.is_definition && ranges.some(([start, end]) =>
                candidate.line >= start && candidate.line <= end));
            for (const reference of references) {
                if (reference.uncertain_call) uncertainty.add(reference.display);
                if (visited.has(reference.key)) continue;
                visited.add(reference.key);
                const resolved = resolve(reference);
                if (reference.kind === "function" && resolved.length && resolved.every(item => item.kind === "variable")) {
                    uncertainty.add(reference.display);
                }
                if (!resolved.length) {
                    // 属性/呼出しの先はASTの名称だけで断定できない。値の一般名称は不足扱いにしない。
                    if (!knownBuiltin(reference) && !conditionalMethod(reference)
                        && (reference.kind === "method" || reference.context.includes(`${reference.name}(`))) {
                        uncertainty.add(reference.display);
                    }
                    continue;
                }
                const definitionCode = [...new Set(resolved.map(item => evidenceForOccurrence(lines, item)))].sort();
                if (!definitionCode.every(text => ownCode.includes(text))) related.set(resolved[0].key, definitionCode);
                visit(resolved, reference.kind !== "variable");
            }
        };
        visit(roots, values[0].kind !== "variable");
        if (!ownDefinitions.length) {
            const resolved = resolve(values[0]);
            if (resolved.length) {
                if (values[0].kind === "function" && resolved.every(item => item.kind === "variable")) {
                    uncertainty.add(values[0].display);
                }
                const definitionCode = [...new Set(resolved.map(item => evidenceForOccurrence(lines, item)))].sort();
                if (!definitionCode.every(text => ownCode.includes(text))) related.set(resolved[0].key, definitionCode);
                visit(resolved, values[0].kind !== "variable");
            } else if (!knownBuiltin(values[0]) && !conditionalMethod(values[0])
                && (values[0].kind === "method" || values[0].context.includes(`${values[0].name}(`))) {
                uncertainty.add(values[0].display);
            }
        }
        result.set(key, {
            key, kind: values[0].kind, name: values[0].display, scope: values[0].scope,
            code: ownCode,
            definitions: [...related].sort(([a], [b]) => a.localeCompare(b)).map(([key, code]) => ({ key, code })),
            uncertainty: [...uncertainty].sort(),
            knownPython,
        });
    }
    return result;
}

export interface SymbolGenerationBatch {
    code: string[];
    definitions: SymbolGenerationEvidence["definitions"];
    uncertainty: string[];
    knownPython: SymbolGenerationEvidence["knownPython"];
    targets: Array<Pick<SymbolGenerationEvidence, "key" | "kind" | "name" | "scope">>;
}

// AI_NOTE: 同じ証拠を共有する名称は一括生成する。targetsは不足keyだけに縮めず入力とfingerprintを固定する。
export function buildSymbolGenerationBatches(code: string, occurrences: SymbolOccurrence[]): SymbolGenerationBatch[] {
    const batches = new Map<string, SymbolGenerationBatch>();
    for (const evidence of buildSymbolGenerationEvidence(code, occurrences).values()) {
        const { key, kind, name, scope, ...context } = evidence;
        const identity = JSON.stringify(context);
        const batch = batches.get(identity) ?? { ...context, targets: [] };
        batch.targets.push({ key, kind, name, scope });
        batches.set(identity, batch);
    }
    for (const batch of batches.values()) batch.targets.sort((a, b) => a.key.localeCompare(b.key));
    return [...batches.values()];
}

// AI_NOTE: 説明が依存する最小単位を最内側の関数/class sourceに固定する。
// 同じkeyに定義位置があれば定義scopeを正とし、module末尾など無関係な編集で失効させない。
export function buildSymbolFingerprints(
    code: string,
    occurrences: SymbolOccurrence[],
): Map<string, string> {
    const result = new Map<string, string>();
    for (const batch of buildSymbolGenerationBatches(code, occurrences)) {
        const fingerprint = createHash("sha256").update(JSON.stringify(batch)).digest("hex");
        for (const target of batch.targets) result.set(target.key, fingerprint);
    }
    return result;
}

// AI_NOTE: force時、fingerprint欠落時、または意味scopeが変わったkeyだけをmissingへ送る。
// 説明本文だけを再利用するので、出現座標は常に現在のAST結果から作り直される。
export function planSymbolDescriptionReuse(
    code: string,
    occurrences: SymbolOccurrence[],
    cached: CachedSymbolDescription[],
    force = false,
): SymbolDescriptionReusePlan {
    const fingerprints = buildSymbolFingerprints(code, occurrences);
    const reusedDescriptions = new Map<string, string>();
    if (!force) {
        for (const item of cached) {
            if (!item.symbolKey || !item.symbolFingerprint || !item.explanation) continue;
            if (fingerprints.get(item.symbolKey) === item.symbolFingerprint) {
                reusedDescriptions.set(item.symbolKey, item.explanation);
            }
        }
    }
    const missingKeys = new Set(
        [...fingerprints.keys()].filter((key) => !reusedDescriptions.has(key)),
    );
    return { fingerprints, reusedDescriptions, missingKeys };
}
