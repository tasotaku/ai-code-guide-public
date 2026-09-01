export type TraceSafetyDecision = "safe" | "known-unsafe" | "safety-unknown";

const DYNAMIC_EXECUTION = /\b(?:globals|locals)\s*\(\s*\)\s*\[|\b(?:eval|exec)\s*\(|\bgetattr\s*\(|\b__import__\s*\(/;
const ISOLATED_FILE_IO = /\b(?:open|TemporaryDirectory|NamedTemporaryFile|mkdtemp)\s*\(|\.(?:write|write_text|write_bytes|unlink|remove|rename|replace|mkdir|rmdir)\s*\(|\b(?:tempfile|shutil)\b|\bos\.(?:remove|unlink|rename|replace|mkdir|rmdir)\s*\(/;
const OUTSIDE_PROCESS = /\b(?:subprocess|socket|requests|httpx|ftplib|smtplib|ctypes|multiprocessing)\b|\burllib\.request\b|\bos\.(?:system|popen|spawn\w*|exec\w*)\s*\(/;

function functionBody(source: string, qualifiedName: string): string {
    const name = qualifiedName.split(".").pop() ?? qualifiedName;
    const lines = source.split(/\r?\n/);
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const definition = new RegExp(`^(\\s*)(?:async\\s+)?def\\s+${escaped}\\s*\\(`);
    const start = lines.findIndex((line) => definition.test(line));
    if (start < 0) return "";
    const indent = definition.exec(lines[start])?.[1].length ?? 0;
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
        const line = lines[index];
        if (!line.trim()) continue;
        const currentIndent = line.match(/^\s*/)?.[0].length ?? 0;
        if (currentIndent <= indent) {
            end = index;
            break;
        }
    }
    return lines.slice(start, end).join("\n");
}
/**
 * Keep the execution boundary deterministic even when the LLM safety preflight is vague.
 * Dynamic dispatch is unknown. Filesystem I/O is allowed because every trace runs
 * in a disposable copy guarded against writes outside it; network/process escape stays unsafe.
 */
export function classifyTraceSafety(
    source: string,
    funcName: string,
    proposed: TraceSafetyDecision,
): TraceSafetyDecision {
    const body = functionBody(source, funcName);
    if (DYNAMIC_EXECUTION.test(body)) return "safety-unknown";
    if (OUTSIDE_PROCESS.test(body)) return "known-unsafe";
    if (ISOLATED_FILE_IO.test(body)) return "safe";
    return proposed;
}

export function safetyRetryGuidance(decision: Exclude<TraceSafetyDecision, "safe">, funcName: string): string {
    const reason = decision === "known-unsafe"
        ? "the function has a known external side effect"
        : "the dynamic target cannot be proven side-effect-free";
    return `Do not execute ${funcName} because ${reason}. Keep this trace entry open and preserve this exact rejected target and its arguments in the receipt. For a later recovery attempt, use only the reviewed side-effect-free target and exact arguments explicitly requested by the user; never silently substitute one.`;
}
