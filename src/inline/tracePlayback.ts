import type { TraceAssertion, TraceResult, TraceValue } from "./traceRunner";

export interface TracePlayback {
    loops: Array<{ id: number; headerLine: number; bodyEnd: number; parent: number | null }>;
    counts: Record<string, Record<string, number>>;
    samples: Array<{ line: number; path: [number, number][]; text: string }>;
    staticValues: Array<{ line: number; text: string }>;
}

export interface TraceProjection {
    values: Array<{ line: number; text: string }>;
    loops: Array<{ id: number; headerLine: number; parent: number | null; iteration: number; total: number }>;
}

// AI_NOTE: This function is also embedded in the browser with toString(); all
// dependencies must stay inside it. Selection reads a snapshot, never executes Python.
export function projectTracePlayback(playback: TracePlayback, selections: Record<string, number>): TraceProjection {
    const byId = new Map(playback.loops.map((loop) => [loop.id, loop]));
    const ancestors = (id: number): number[] => {
        const chain: number[] = [];
        const visited = new Set<number>([id]);
        let parent = byId.get(id)?.parent;
        while (parent !== null && parent !== undefined && !visited.has(parent)) {
            visited.add(parent);
            chain.unshift(parent);
            parent = byId.get(parent)?.parent;
        }
        return chain;
    };
    const resolved = new Map<number, { iteration: number; total: number }>();
    const ordered = [...playback.loops].sort((a, b) => ancestors(a.id).length - ancestors(b.id).length);
    const loops = ordered.map((loop) => {
        const chain = ancestors(loop.id);
        const key = chain.map((id) => `${id}:${resolved.get(id)?.iteration ?? 0}`).join(",");
        const count = playback.counts[String(loop.id)]?.[key] ?? 0;
        const total = chain.some((id) => !resolved.get(id)?.total) || !Number.isFinite(count)
            ? 0 : Math.max(0, Math.floor(count));
        const want = selections[String(loop.id)];
        const iteration = total ? Math.min(total, Math.max(1, Number.isFinite(want) ? Math.floor(want) : 1)) : 0;
        resolved.set(loop.id, { iteration, total });
        return { id: loop.id, headerLine: loop.headerLine, parent: loop.parent, iteration, total };
    }).sort((a, b) => a.headerLine - b.headerLine);
    const values = new Map(playback.staticValues.map((value) => [value.line, value.text]));
    for (const sample of playback.samples) {
        if (!sample.path.every(([id, iteration]) => resolved.get(id)?.iteration === iteration)) continue;
        const previous = values.get(sample.line);
        values.set(sample.line, previous ? `${previous}, ${sample.text}` : sample.text);
    }
    return {
        values: [...values].map(([line, text]) => ({ line, text })).sort((a, b) => a.line - b.line),
        loops,
    };
}

function assertionText(assertion: TraceAssertion): string {
    // AI_NOTE: Keep assertion outcomes attached to their recorded path, not the final invocation.
    const args = assertion.arguments ?? [];
    const details: string[] = [];
    if (/^assert(?:Not)?Equal/.test(assertion.method)) {
        if (args[0]) details.push(`実際=${args[0].short}`);
        if (args[1]) details.push(`期待=${args[1].short}`);
    } else if (/^assert(?:True|False)$/.test(assertion.method)) {
        if (args[0]) details.push(`条件=${args[0].short}`);
    } else if (/^assertRaises/.test(assertion.method)) {
        if (args[0]) details.push(`期待例外=${args[0].short}`);
        if (assertion.exception) details.push(`実際=${assertion.exception.type}`);
    } else if (/^assert(?:Not)?In$/.test(assertion.method)) {
        if (args[0]) details.push(`対象=${args[0].short}`);
        if (args[1]) details.push(`容器=${args[1].short}`);
    } else {
        args.forEach((value, index) => details.push(`引数${index + 1}=${value.short}`));
    }
    if (!assertion.outcome && assertion.exception?.message) {
        details.push(`${assertion.exception.type}: ${assertion.exception.message}`);
    }
    return `${assertion.outcome ? "✓" : "✗"} ${assertion.method}: ${assertion.outcome ? "成功" : "失敗"}${details.length ? ` · ${details.join(" · ")}` : ""}`;
}

export function buildTracePlayback(trace: TraceResult): TracePlayback {
    // AI_NOTE: Store only observed line/path samples, not a Cartesian product of
    // independent loop selections. Old caches lack unchanged line visits; omit
    // those unknown values instead of borrowing a line from a different parent.
    const steps = trace.line_steps ?? trace.steps;
    const names = new Map<number, Set<string>>();
    for (const step of steps) {
        const lineNames = names.get(step.line) ?? new Set<string>();
        Object.keys(step.changed).forEach((name) => lineNames.add(name));
        names.set(step.line, lineNames);
    }
    const samples = new Map<string, { line: number; path: [number, number][]; text: string }>();
    const staticValues = new Map<number, string>();
    const add = (line: number, path: [number, number][], text: string, append = false): void => {
        if (!text) return;
        if (!path.length) {
            const previous = append ? staticValues.get(line) : undefined;
            staticValues.set(line, previous ? `${previous}, ${text}` : text);
            return;
        }
        const key = JSON.stringify([line, path]);
        const previous = append ? samples.get(key)?.text : undefined;
        samples.set(key, { line, path: path.map(([id, iteration]) => [id, iteration]), text: previous ? `${previous}, ${text}` : text });
    };
    const locals: Record<string, TraceValue> = Object.create(null);
    for (const step of steps) {
        Object.assign(locals, step.changed);
        const text = [...(names.get(step.line) ?? [])]
            .filter((name) => locals[name] !== undefined)
            .map((name) => `${name}=${locals[name].short}`).join(", ");
        add(step.line, step.iter_path, text && step.line === trace.func_line_start ? `◀ 入力例: ${text}` : text);
    }
    for (const event of trace.path_events ?? []) add(event.line, event.iter_path, `条件: ${event.outcome}`, true);
    for (const assertion of trace.assertions ?? []) add(assertion.line, assertion.iter_path, assertionText(assertion), true);
    if (trace.return_value) {
        // A function can end with an unexecuted loop body. Do not display the
        // invocation result as if that body line ran; keep it on the def instead.
        const line = trace.loops.some((loop) => trace.func_line_end >= loop.header_line && trace.func_line_end <= loop.body_end)
            ? trace.func_line_start : trace.func_line_end;
        add(line, [], `▶ 戻り値: ${trace.return_value.short}`, true);
    }
    return {
        loops: trace.loops.map((loop) => ({ id: loop.id, headerLine: loop.header_line, bodyEnd: loop.body_end, parent: loop.parent })),
        counts: Object.fromEntries(Object.entries(trace.iter_counts).map(([id, counts]) => [id, { ...counts }])),
        samples: [...samples.values()],
        staticValues: [...staticValues].map(([line, text]) => ({ line, text })),
    };
}
