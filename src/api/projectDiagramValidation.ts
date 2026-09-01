import type { ProjectDiagram, ProjectDiagramEdge, ProjectDiagramNode } from "./claudeClient";

export interface ProjectDiagramConnectivity {
    connected: boolean;
    disconnectedNodeIds: string[];
}

// AI_NOTE: flow の未接続ノードを描画側へ渡すと、レンダラーの末尾補完によって
// 「直前の処理から続く直列ノード」に見えてしまう。矢印の向きは問わず、全ノードが
// 一つの関係グラフに属していることだけをここで検証する（分岐・合流はそのまま許可）。
export function projectDiagramConnectivity(
    nodes: Pick<ProjectDiagramNode, "id">[],
    edges: Pick<ProjectDiagramEdge, "from" | "to">[],
): ProjectDiagramConnectivity {
    if (nodes.length <= 1) return { connected: true, disconnectedNodeIds: [] };

    const ids = new Set(nodes.map((node) => node.id));
    const neighbors = new Map<string, Set<string>>(
        nodes.map((node) => [node.id, new Set<string>()]),
    );
    for (const edge of edges) {
        if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
        neighbors.get(edge.from)!.add(edge.to);
        neighbors.get(edge.to)!.add(edge.from);
    }

    const visited = new Set<string>();
    const queue = [nodes[0].id];
    while (queue.length > 0) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        for (const next of neighbors.get(id) ?? []) {
            if (!visited.has(next)) queue.push(next);
        }
    }
    const disconnectedNodeIds = nodes.map((node) => node.id).filter((id) => !visited.has(id));
    return { connected: disconnectedNodeIds.length === 0, disconnectedNodeIds };
}

export function isConnectedProjectDiagram(diagram: Pick<ProjectDiagram, "nodes" | "edges">): boolean {
    return projectDiagramConnectivity(diagram.nodes, diagram.edges).connected;
}

export function missingRequestedProjectDiagramSymbols(
    nodes: Pick<ProjectDiagramNode, "symbol">[],
    requestedSymbols: Iterable<string>,
): string[] {
    const included = new Set(nodes.map((node) => node.symbol));
    return [...requestedSymbols].filter((symbol) => !included.has(symbol));
}

// 同じ関数を開始・例外処理・再送出など複数の意味で示すことはflow図では正当。
// コード位置だけではなく表示上の役割まで同じnodeだけを重複として扱う。
export function projectDiagramStepKey(
    node: Pick<ProjectDiagramNode, "file" | "symbol" | "label" | "description">,
): string {
    return [node.file, node.symbol, node.label.trim(), node.description?.trim() ?? ""].join("::");
}

// AI_NOTE: 架空地点や意味まで同じ重複nodeを実在照合で落としても、その前後のedgeまで
// 単純に落とすと処理が孤立する。消えたnodeだけを経路から縮約し、実在確認済みnode同士の
// 関係へ戻す。同じ関数内の意味が異なる複数ステップは projectDiagramStepKey により保持する。
export function collapseProjectDiagramEdges(
    edges: ProjectDiagramEdge[],
    validNodeIds: Set<string>,
): ProjectDiagramEdge[] {
    const outgoing = new Map<string, ProjectDiagramEdge[]>();
    for (const edge of edges) {
        const list = outgoing.get(edge.from) ?? [];
        list.push(edge);
        outgoing.set(edge.from, list);
    }

    const collapsed: ProjectDiagramEdge[] = [];
    const seen = new Set<string>();
    const walk = (origin: string, current: string, label: string, path: Set<string>): void => {
        if (path.has(current)) return;
        if (validNodeIds.has(current)) {
            if (current === origin) return;
            const key = `${origin}->${current}`;
            if (!seen.has(key)) {
                seen.add(key);
                collapsed.push({ from: origin, to: current, label });
            }
            return;
        }
        const nextPath = new Set(path);
        nextPath.add(current);
        for (const edge of outgoing.get(current) ?? []) {
            walk(origin, edge.to, label || edge.label, nextPath);
        }
    };

    for (const origin of validNodeIds) {
        for (const edge of outgoing.get(origin) ?? []) {
            walk(origin, edge.to, edge.label, new Set([origin]));
        }
    }
    return collapsed;
}
