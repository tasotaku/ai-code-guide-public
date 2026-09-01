import * as path from "node:path";
import type { AgentShowResult } from "./projectDiagramBridge";

type StandardView = NonNullable<AgentShowResult["standard"]>;

// AI_NOTE: 会話ごとの限定表示は保存済み解析・展開を変更せず、公開用スナップショットだけを切り詰める。
export function focusStandardView(
    standard: StandardView,
    scopeLine?: number,
    visibleExpandLines?: number[],
): StandardView {
    if (scopeLine === undefined && visibleExpandLines === undefined) return standard;
    const scope = scopeLine === undefined
        ? undefined
        : standard.items
            .filter((item) => scopeLine >= item.line && scopeLine <= item.lineEnd)
            .sort((left, right) => (left.lineEnd - left.line) - (right.lineEnd - right.line))[0];
    if (scopeLine !== undefined && !scope) throw new Error(`Standard scope not found at line ${scopeLine}`);

    const itemsById = new Map(standard.items.map((item) => [item.id, item]));
    const isInScope = (item: StandardView["items"][number]): boolean => {
        if (!scope) return true;
        let current: StandardView["items"][number] | undefined = item;
        while (current) {
            if (current.id === scope.id) return true;
            current = current.parent ? itemsById.get(current.parent) : undefined;
        }
        return false;
    };
    const visible = visibleExpandLines === undefined ? undefined : new Set(visibleExpandLines);
    const items = standard.items.filter(isInScope).map((item) => {
        if (visible === undefined || visible.has(item.line)) return item;
        const { expanded: _expanded, expansion: _expansion, ...collapsed } = item;
        return collapsed;
    });
    if (!scope) return { ...standard, items };

    return {
        ...standard,
        title: `${scope.label.replace(/^class\s+/, "")} · ${path.basename(standard.file)}`,
        role: `L${scope.line}–${scope.lineEnd} の定義だけを表示`,
        source: standard.source.filter((entry) => entry.line >= scope.line && entry.line <= scope.lineEnd),
        items,
    };
}
