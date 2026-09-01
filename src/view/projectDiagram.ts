import * as path from "node:path";
import { ProjectDiagram, ProjectDiagramKind, ProjectDiagramNode } from "../api/claudeClient";
import type { ProjectDiagramBridgeLink } from "./projectDiagramBridge";

export type LocatedProjectDiagramNode = ProjectDiagramNode & { line: number };
export type LocatedProjectDiagram = Omit<ProjectDiagram, "nodes"> & { nodes: LocatedProjectDiagramNode[] };

type DiagramEdge = ProjectDiagram["edges"][number];
type NodeEntry = { node: LocatedProjectDiagramNode; domId: string };
export interface ProjectDiagramRenderOptions {
    selectableNodes?: boolean;
}

export const projectFlowchartCss = `
.pd-flowchart{display:flex;flex-direction:column;gap:12px;min-width:0}.pd-flow-scroll{width:100%;overflow-x:auto;overflow-y:hidden;scrollbar-gutter:stable}.pd-flow-canvas{display:block;width:auto;max-width:none;height:auto;margin-inline:auto;overflow:visible}.pd-flow-edge{fill:none;stroke:var(--pd-line);stroke-width:1.6;vector-effect:non-scaling-stroke}.pd-flow-edge-back{stroke-dasharray:5 3}.pd-flow-edge-label,.pd-flow-back-label{fill:var(--pd-edge-label,#ffe083);font:700 12px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;paint-order:stroke;stroke:var(--pd-edge-label-bg,#1f1f1f);stroke-width:6px;stroke-linejoin:round}.pd-flow-edge-label{text-anchor:middle}.pd-flow-back-label{text-anchor:start}.pd-flow-shape{cursor:pointer;outline:none}.pd-flow-shape .pd-shape-body{fill:var(--pd-node-bg,#252525);stroke:var(--pd-node-border,#8e8e8e);stroke-width:1.5;vector-effect:non-scaling-stroke;transition:fill .12s,stroke .12s,stroke-width .12s}.pd-flow-shape:hover .pd-shape-body,.pd-flow-shape:focus-visible .pd-shape-body{fill:var(--pd-node-hover,#173247);stroke:var(--pd-focus,#4fc1ff);stroke-width:2}.pd-flow-shape[aria-current="true"] .pd-shape-body{fill:var(--pd-node-selected,#173247);stroke:var(--pd-focus,#4fc1ff);stroke-width:2.5}.pd-flow-shape.emphasis-warning .pd-shape-body{stroke:#f48771}.pd-flow-shape.emphasis-important .pd-shape-body{stroke:#d7ba7d}.pd-flow-shape.emphasis-success .pd-shape-body{stroke:#4ec9b0}.pd-flow-shape.emphasis-note .pd-shape-body{stroke:#4fc1ff}.pd-shape-label{fill:var(--pd-node-text,currentColor);font:650 13px/1.25 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-anchor:middle;pointer-events:none}.pd-flow-details{min-height:112px;padding:11px 12px;border:1px solid var(--border,var(--vscode-panel-border,#383838));border-radius:9px;background:var(--pd-detail-bg,var(--panel,var(--vscode-sideBar-background,#1f1f1f)))}.pd-flow-detail-placeholder{margin:0;color:var(--muted,var(--vscode-descriptionForeground,#9d9d9d));font-size:12px;line-height:1.5;text-align:center}.pd-flow-detail[hidden]{display:none}.pd-flow-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.pd-flow-detail-title{font-size:14px;font-weight:700;line-height:1.35}.pd-flow-detail-badge{flex:none;padding:1px 5px;border:1px solid currentColor;border-radius:999px;font-size:11px;font-weight:700}.pd-flow-detail-location{margin-top:3px;color:var(--muted,var(--vscode-descriptionForeground,#9d9d9d));font:12px/1.4 var(--editor-font,var(--vscode-editor-font-family,ui-monospace,SFMono-Regular,Menlo,monospace));overflow-wrap:anywhere}.pd-flow-detail-description,.pd-flow-detail-reason{margin:7px 0 0;font-size:13px;line-height:1.5;overflow-wrap:anywhere}.pd-flow-detail-description{color:var(--text,var(--vscode-foreground,#d4d4d4))}.pd-flow-detail-reason{color:var(--muted,var(--vscode-descriptionForeground,#9d9d9d))}.pd-detail-jump{display:inline-flex;margin-top:9px;padding:6px 9px;border:1px solid var(--pd-focus,#4fc1ff);border-radius:5px;color:var(--pd-focus,#4fc1ff);background:transparent;font:600 12px/1.2 inherit;text-decoration:none;cursor:pointer}.pd-detail-jump:hover,.pd-detail-jump:focus-visible{background:var(--pd-node-hover,#173247);outline:none}@media(max-width:520px){.pd-flow-details{min-height:100px}}
`;

const EMPHASIS_LABELS = {
    important: "重要",
    warning: "注意",
    success: "問題なさそう",
    note: "補足",
} as const;

const SUCCESS_EXPLANATION = "AIがコード上の正常な完了経路と推定した箇所です。実行・テスト済みを意味しません。";

function htmlText(value: string, maxLength: number): string {
    return value.trim()
        .replace(/\s+/g, " ")
        .slice(0, maxLength)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function htmlAttribute(value: string): string {
    return htmlText(value, 300)
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function validKind(kind: ProjectDiagramKind | undefined): ProjectDiagramKind {
    return kind === "reading" || kind === "dependency" ? kind : "flow";
}

function normalizedEdges(diagram: LocatedProjectDiagram, nodesById: Map<string, NodeEntry>): DiagramEdge[] {
    const seen = new Set<string>();
    return diagram.edges.filter((edge) => {
        const key = `${edge.from}->${edge.to}`;
        if (!nodesById.has(edge.from) || !nodesById.has(edge.to) || edge.from === edge.to || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function stableTopologicalOrder(nodes: LocatedProjectDiagramNode[], edges: DiagramEdge[]): string[] {
    const index = new Map(nodes.map((node, i) => [node.id, i]));
    const indegree = new Map(nodes.map((node) => [node.id, 0]));
    const children = new Map<string, string[]>();
    for (const edge of edges) {
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
        const list = children.get(edge.from) ?? [];
        list.push(edge.to);
        children.set(edge.from, list);
    }
    const ready = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
    const ordered: string[] = [];
    while (ready.length > 0) {
        ready.sort((a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0));
        const id = ready.shift()!;
        ordered.push(id);
        for (const child of children.get(id) ?? []) {
            const next = (indegree.get(child) ?? 1) - 1;
            indegree.set(child, next);
            if (next === 0) ready.push(child);
        }
    }
    for (const node of nodes) if (!ordered.includes(node.id)) ordered.push(node.id);
    return ordered;
}

type FlowRole = "start" | "process" | "decision" | "merge" | "end";
type FlowLayoutNode = NodeEntry & { role: FlowRole; x: number; y: number; width: number; height: number };

function flowRole(node: LocatedProjectDiagramNode, indegree: number, outdegree: number): FlowRole {
    if (node.role === "start" || node.role === "process" || node.role === "decision" || node.role === "merge" || node.role === "end") return node.role;
    if (/^\s*(?:if|elif|match|case|while)\b/.test(node.anchor)) return "decision";
    if (/^\s*(?:return|raise)\b/.test(node.anchor)) return "end";
    if (outdegree > 1) return "decision";
    if (indegree === 0) return "start";
    if (outdegree === 0) return "end";
    return indegree > 1 ? "merge" : "process";
}

function svgLabel(label: string, x: number, y: number): string {
    const clean = label.trim().replace(/\s+/g, " ").slice(0, 20);
    const lines = clean.length > 10 ? [clean.slice(0, 10), clean.slice(10)] : [clean];
    const firstY = y - ((lines.length - 1) * 8);
    return `<text class="pd-shape-label" x="${x}" y="${firstY}">${lines.map((line, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : 16}">${htmlText(line, 14)}</tspan>`).join("")}</text>`;
}

// AI_NOTE: 小さなDAGを層ごとに置くことで、カード再帰では消えていた分岐と合流を同じ座標系へ戻す。
function buildFlowchartHtml(
    diagram: LocatedProjectDiagram,
    nodesById: Map<string, NodeEntry>,
    edges: DiagramEdge[],
    workspaceRoot?: string,
    bridge?: ProjectDiagramBridgeLink | null,
): string {
    const outgoing = new Map<string, DiagramEdge[]>();
    const indegree = new Map(diagram.nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
        const list = outgoing.get(edge.from) ?? [];
        list.push(edge);
        outgoing.set(edge.from, list);
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }
    const order = stableTopologicalOrder(diagram.nodes, edges);
    const orderIndex = new Map(order.map((id, index) => [id, index]));
    const backEdges = edges.filter((edge) => (orderIndex.get(edge.to) ?? -1) <= (orderIndex.get(edge.from) ?? -1));
    const backEdgeIndex = new Map(backEdges.map((edge, index) => [edge, index]));
    const rank = new Map(order.map((id) => [id, 0]));
    for (const id of order) {
        const current = rank.get(id) ?? 0;
        for (const edge of outgoing.get(id) ?? []) {
            if ((orderIndex.get(edge.to) ?? -1) > (orderIndex.get(id) ?? 0)) {
                rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, current + 1));
            }
        }
    }
    const layers = new Map<number, string[]>();
    for (const id of order) {
        const layer = rank.get(id) ?? 0;
        const ids = layers.get(layer) ?? [];
        ids.push(id);
        layers.set(layer, ids);
    }
    const maxAcross = Math.max(1, ...[...layers.values()].map((ids) => ids.length));
    const slotWidth = 144;
    const columnGap = 24;
    const canvasPadding = 16;
    const contentWidth = Math.max(280, maxAcross * slotWidth + (maxAcross - 1) * columnGap + canvasPadding);
    const backGutter = backEdges.length > 0 ? 64 + ((backEdges.length - 1) * 18) : 0;
    const canvasWidth = contentWidth + backGutter;
    const layerGap = 124;
    const layout = new Map<string, FlowLayoutNode>();
    for (const [layer, ids] of [...layers.entries()].sort((a, b) => a[0] - b[0])) {
        const rowWidth = ids.length * slotWidth + (ids.length - 1) * columnGap;
        const startX = backGutter + ((contentWidth - rowWidth) / 2);
        ids.forEach((id, index) => {
            const entry = nodesById.get(id)!;
            const role = flowRole(entry.node, indegree.get(id) ?? 0, (outgoing.get(id) ?? []).length);
            const width = role === "decision" ? 136 : slotWidth;
            const height = role === "decision" ? 82 : 58;
            layout.set(id, { ...entry, role, x: startX + index * (slotWidth + columnGap) + (slotWidth - width) / 2, y: 24 + layer * layerGap, width, height });
        });
    }
    const canvasHeight = Math.max(140, 24 + (Math.max(0, ...rank.values()) * layerGap) + 92);
    const markerId = `pd-arrow-${Math.abs(diagram.nodes.map((node) => node.id).join("").split("").reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) | 0, 7))}`;
    const edgeSvg = edges.map((edge) => {
        const from = layout.get(edge.from);
        const to = layout.get(edge.to);
        if (!from || !to) return "";
        const sx = from.x + from.width / 2;
        const sy = from.y + from.height;
        const tx = to.x + to.width / 2;
        const ty = to.y;
        const backIndex = backEdgeIndex.get(edge);
        if (backIndex !== undefined) {
            const laneX = 24 + (backIndex * 18);
            const bendY = sy + 22;
            const targetY = to.y + (to.height / 2);
            const targetX = to.x - 7;
            const label = edge.label.trim()
                ? `<text class="pd-flow-back-label" x="${laneX + 7}" y="${((sy + targetY) / 2) - 5}">${htmlText(edge.label, 12)}</text>`
                : "";
            return `<path class="pd-flow-edge pd-flow-edge-back" data-edge-from="${htmlAttribute(edge.from)}" data-edge-to="${htmlAttribute(edge.to)}" d="M ${sx} ${sy} C ${sx} ${bendY}, ${laneX} ${bendY}, ${laneX} ${sy} L ${laneX} ${targetY} C ${laneX} ${targetY}, ${targetX - 18} ${targetY}, ${targetX} ${targetY}" marker-end="url(#${markerId})"/>${label}`;
        }
        const midY = sy + Math.max(22, (ty - sy) / 2);
        const label = edge.label.trim()
            ? `<text class="pd-flow-edge-label" x="${(sx + tx) / 2}" y="${midY - 7}">${htmlText(edge.label, 12)}</text>`
            : "";
        return `<path class="pd-flow-edge" d="M ${sx} ${sy} C ${sx} ${midY}, ${tx} ${midY}, ${tx} ${ty - 7}" marker-end="url(#${markerId})"/>${label}`;
    }).join("");
    const nodeSvg = [...layout.values()].map((entry) => {
        const cx = entry.x + entry.width / 2;
        const cy = entry.y + entry.height / 2;
        const body = entry.role === "decision"
            ? `<polygon class="pd-shape-body" points="${cx},${entry.y} ${entry.x + entry.width},${cy} ${cx},${entry.y + entry.height} ${entry.x},${cy}"/>`
            : `<rect class="pd-shape-body" x="${entry.x}" y="${entry.y}" width="${entry.width}" height="${entry.height}" rx="${entry.role === "start" || entry.role === "end" ? entry.height / 2 : 12}"/>`;
        const emphasis = entry.node.emphasis ? ` emphasis-${entry.node.emphasis}` : "";
        return `<g class="pd-node pd-flow-shape role-${entry.role}${emphasis}" tabindex="0" role="button" aria-label="${htmlAttribute(entry.node.label)}" data-node-id="${entry.domId}" data-file="${htmlAttribute(entry.node.file)}" data-line="${entry.node.line + 1}">${body}${svgLabel(entry.node.label, cx, cy + 4)}</g>`;
    }).join("");
    const details = [...layout.values()].map((entry) => {
        const fileName = entry.node.file.split("/").pop() || entry.node.file;
        const location = entry.node.symbol ? `${entry.node.symbol} · ${fileName}:${entry.node.line + 1}` : `${fileName}:${entry.node.line + 1}`;
        const emphasis = entry.node.emphasis && entry.node.emphasis in EMPHASIS_LABELS ? entry.node.emphasis as keyof typeof EMPHASIS_LABELS : undefined;
        const badgeTitle = emphasis === "success" ? ` title="${htmlAttribute(SUCCESS_EXPLANATION)}"` : "";
        const badge = emphasis ? `<span class="pd-flow-detail-badge"${badgeTitle}>${EMPHASIS_LABELS[emphasis]}</span>` : "";
        const reasonLabel = emphasis === "success" ? "AIの見立て" : "判断理由";
        const reasonSuffix = emphasis === "success" ? "（実行・テスト未確認）" : "";
        const reason = emphasis && entry.node.emphasisReason?.trim() ? `<p class="pd-flow-detail-reason">${reasonLabel}: ${htmlText(entry.node.emphasisReason, 90)}${reasonSuffix}</p>` : "";
        const description = entry.node.description?.trim() ? `<p class="pd-flow-detail-description">${htmlText(entry.node.description, 80)}</p>` : "";
        let openUrl = "";
        if (workspaceRoot) {
            if (bridge) {
                const params = new URLSearchParams({ token: bridge.token, file: entry.node.file, line: String(entry.node.line + 1) });
                openUrl = `${bridge.baseUrl}/open?${params.toString()}`;
            } else {
                const absolutePath = path.resolve(workspaceRoot, entry.node.file).replace(/\\/g, "/");
                const urlPath = absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`;
                openUrl = `vscode://file${encodeURI(urlPath).replace(/#/g, "%23").replace(/\?/g, "%3F")}:${entry.node.line + 1}:1`;
            }
        }
        const jumpLabel = `コードへ移動: ${entry.node.label || entry.node.symbol || fileName}`;
        const action = openUrl
            ? `<a class="pd-detail-jump" href="${htmlAttribute(openUrl)}">コードへ</a>`
            : `<button class="pd-detail-jump" type="button" data-node-id="${entry.domId}" aria-label="${htmlAttribute(jumpLabel)}">コードへ</button>`;
        return `<article class="pd-flow-detail" data-detail-id="${entry.domId}" hidden><div class="pd-flow-detail-head"><div><div class="pd-flow-detail-title">${htmlText(entry.node.label, 36)}</div><div class="pd-flow-detail-location">${htmlText(location, 80)}</div></div>${badge}</div>${description}${reason}${action}</article>`;
    }).join("");
    return `<div class="pd-layout pd-layout-flow pd-flowchart" data-diagram-kind="flow"><div class="pd-flow-scroll" tabindex="0" aria-label="フローチャート。横に収まらない場合はスクロールできます"><svg class="pd-flow-canvas" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}" role="img" aria-label="${htmlAttribute(diagram.title || "処理フロー")}"><defs><marker id="${markerId}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--pd-line)"/></marker></defs>${edgeSvg}${nodeSvg}</svg></div><section class="pd-flow-details" aria-live="polite"><p class="pd-flow-detail-placeholder">図形を選ぶと説明とコード位置を表示します。</p>${details}</section></div>`;
}

export const projectFlowchartRuntime = `
const selectProjectDiagramShape=(shape)=>{const flow=shape?.closest?.(".pd-flowchart");if(!flow)return false;flow.querySelectorAll(".pd-flow-shape[aria-current]").forEach(item=>item.removeAttribute("aria-current"));shape.setAttribute("aria-current","true");const id=shape.dataset.nodeId;flow.querySelector(".pd-flow-detail-placeholder")?.setAttribute("hidden","");flow.querySelectorAll(".pd-flow-detail").forEach(detail=>{detail.hidden=detail.dataset.detailId!==id;});return true;};
requestAnimationFrame(()=>document.querySelectorAll(".pd-flow-scroll").forEach(scroll=>{scroll.scrollLeft=Math.max(0,(scroll.scrollWidth-scroll.clientWidth)/2);}));
`;

// AI_NOTE: LLMはコード地点・役割・関係だけを決める。flowの座標はSVG表示側、reading/dependencyの
// 折り返しはHTML表示側が決め、モデルへ表示座標を作らせない。
export function buildProjectDiagramHtml(
    diagram: LocatedProjectDiagram,
    workspaceRoot?: string,
    bridge?: ProjectDiagramBridgeLink | null,
    renderOptions?: ProjectDiagramRenderOptions,
): string {
    const kind = validKind(diagram.kind);
    const nodesById = new Map<string, NodeEntry>(
        diagram.nodes.map((node, index) => [node.id, { node, domId: `pd${index}` }]),
    );
    const edges = normalizedEdges(diagram, nodesById);
    const outgoing = new Map<string, DiagramEdge[]>();
    const indegree = new Map(diagram.nodes.map((node) => [node.id, 0]));
    for (const edge of edges) {
        const list = outgoing.get(edge.from) ?? [];
        list.push(edge);
        outgoing.set(edge.from, list);
        indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    }

    const nodeButton = (
        id: string,
        variant: "flow" | "reading" | "dependency",
        options?: { reference?: boolean },
    ): string => {
        const entry = nodesById.get(id);
        if (!entry) return "";
        const fileName = entry.node.file.split("/").pop() || entry.node.file;
        const location = entry.node.symbol
            ? `${entry.node.symbol} · ${fileName}`
            : fileName;
        const description = entry.node.description?.trim() ?? "";
        const emphasis = entry.node.emphasis && entry.node.emphasis in EMPHASIS_LABELS
            ? entry.node.emphasis as keyof typeof EMPHASIS_LABELS
            : undefined;
        const emphasisReason = emphasis ? entry.node.emphasisReason?.trim() ?? "" : "";
        const openUrl = workspaceRoot
            ? (() => {
                if (bridge) {
                    const params = new URLSearchParams({
                        token: bridge.token,
                        file: entry.node.file,
                        line: String(entry.node.line + 1),
                    });
                    return `${bridge.baseUrl}/open?${params.toString()}`;
                }
                const absolutePath = path.resolve(workspaceRoot, entry.node.file).replace(/\\/g, "/");
                const urlPath = absolutePath.startsWith("/") ? absolutePath : `/${absolutePath}`;
                const encodedPath = encodeURI(urlPath).replace(/#/g, "%23").replace(/\?/g, "%3F");
                return `vscode://file${encodedPath}:${entry.node.line + 1}:1`;
            })()
            : "";
        const reference = options?.reference ? `<span class="pd-reference-mark">↳</span>` : "";
        const badgeTitle = emphasis === "success" ? ` title="${htmlAttribute(SUCCESS_EXPLANATION)}"` : "";
        const badge = emphasis ? `<span class="pd-emphasis-badge"${badgeTitle}>${EMPHASIS_LABELS[emphasis]}</span>` : "";
        const main = `<span class="pd-node-main"><span class="pd-node-heading"><span class="pd-node-label">${htmlText(entry.node.label, 36)}</span>${badge}</span><span class="pd-node-symbol">${htmlText(location, 64)}</span></span>`;
        const reasonLabel = emphasis === "success" ? "AIの見立て" : "判断理由";
        const reasonSuffix = emphasis === "success" ? "（実行・テスト未確認）" : "";
        const note = description || emphasisReason
            ? `<span class="pd-node-copy">${description ? `<span class="pd-node-description">${htmlText(description, 60)}</span>` : ""}${emphasisReason ? `<span class="pd-emphasis-reason">${reasonLabel}: ${htmlText(emphasisReason, 90)}${reasonSuffix}</span>` : ""}</span>`
            : "";
        const selectable = renderOptions?.selectableNodes === true;
        const attributes = `class="pd-node pd-${variant}-node${emphasis ? ` emphasis-${emphasis}` : ""}${options?.reference ? " reference" : ""}${note ? "" : " no-description"}${selectable ? " selectable" : ""}" data-node-id="${entry.domId}" data-file="${htmlAttribute(entry.node.file)}" data-line="${entry.node.line + 1}"`;
        if (selectable) {
            const jumpLabel = `コードへ移動: ${entry.node.label || entry.node.symbol || fileName}`;
            return `<div ${attributes}>${reference}<span class="pd-node-content">${main}${note}</span><button class="pd-node-jump" type="button" aria-label="${htmlAttribute(jumpLabel)}">コードへ</button></div>`;
        }
        if (openUrl) {
            return `<a ${attributes} href="${htmlAttribute(openUrl)}">${reference}${main}${note}</a>`;
        }
        return `<button type="button" ${attributes}>${reference}${main}${note}</button>`;
    };
    const edgeLabel = (label: string): string =>
        label.trim() ? `<span class="pd-edge-label">${htmlText(label, 16)}</span>` : "";

    if (kind === "flow") {
        return buildFlowchartHtml(diagram, nodesById, edges, workspaceRoot, bridge);
    }

    if (kind === "reading") {
        const order = stableTopologicalOrder(diagram.nodes, edges);
        const rows = order.map((id, index) => {
            return `<div class="pd-reading-row"><span class="pd-reading-number">${index + 1}</span>${nodeButton(id, "reading")}</div>`;
        }).join("");
        return `<div class="pd-layout pd-layout-reading" data-diagram-kind="reading">${rows}</div>`;
    }

    const rendered = new Set<string>();
    const roots = diagram.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id);
    if (roots.length === 0 && diagram.nodes[0]) roots.push(diagram.nodes[0].id);

    if (kind === "dependency") {
        const renderDependency = (id: string, path: Set<string>): string => {
            if (path.has(id) || rendered.has(id)) return nodeButton(id, "dependency", { reference: true });
            rendered.add(id);
            const nextPath = new Set(path);
            nextPath.add(id);
            const children = outgoing.get(id) ?? [];
            const childHtml = children.map((edge) =>
                `<div class="pd-dependency-child">${edgeLabel(edge.label)}${renderDependency(edge.to, nextPath)}</div>`
            ).join("");
            return `<div class="pd-dependency-branch">${nodeButton(id, "dependency")}${childHtml ? `<div class="pd-dependency-children">${childHtml}</div>` : ""}</div>`;
        };
        let content = roots.map((id) => renderDependency(id, new Set())).join("");
        for (const node of diagram.nodes) if (!rendered.has(node.id)) content += renderDependency(node.id, new Set());
        return `<div class="pd-layout pd-layout-dependency" data-diagram-kind="dependency">${content}</div>`;
    }

    return "";
}

// AI_NOTE: Codex / Claude Code の会話へコード図を持ち出す試作。外部CDNやVS Code APIに依存せず、
// 1ファイルだけで表示・コード位置コピーまで完結させる。共有レンダラーを使い、サイドバーとの内容差を防ぐ。
export function buildStandaloneProjectDiagramHtml(
    question: string,
    diagram: LocatedProjectDiagram,
    workspaceRoot?: string,
    bridge?: ProjectDiagramBridgeLink | null,
): string {
    const kind = validKind(diagram.kind);
    const kindLabel = kind === "reading" ? "読解順" : kind === "dependency" ? "依存関係" : "処理順";
    const summary = diagram.summary?.trim()
        ? `<p class="preview-summary">${htmlText(diagram.summary, 240)}</p>`
        : "";
    const diagramHtml = buildProjectDiagramHtml(diagram, workspaceRoot, bridge);
    return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${htmlText(diagram.title || "AI Code Guide コード図", 120)}</title>
  <style>
    :root { color-scheme: light dark; --bg:#f4f6f8; --panel:#fff; --text:#18212b; --muted:#637083; --line:#d5a900; --soft:#fff8d8; --border:#d9dee5; --hover:#e8f1f5; }
    @media (prefers-color-scheme: dark) { :root { --bg:#17191c; --panel:#22262b; --text:#edf1f5; --muted:#a9b2bf; --line:#e2b93d; --soft:#342f1b; --border:#3b424b; --hover:#294b5c; } }
    * { box-sizing:border-box; }
    body { margin:0; padding:28px 16px 48px; color:var(--text); background:var(--bg); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .preview { width:min(760px,100%); margin:0 auto; }
    .preview-kicker { color:var(--muted); font-size:12px; letter-spacing:.08em; text-transform:uppercase; }
    h1 { margin:7px 0 8px; font-size:clamp(21px,4vw,30px); line-height:1.25; }
    .preview-question { margin:0 0 12px; color:var(--muted); font-size:13px; line-height:1.55; }
    .preview-kind { display:inline-block; margin-right:6px; padding:2px 8px; border:1px solid var(--border); border-radius:999px; color:var(--muted); font-size:11px; }
    .preview-summary { margin:16px 0; padding:10px 12px; border-left:3px solid var(--line); background:var(--soft); font-size:13px; line-height:1.65; }
    .diagram-card { margin-top:18px; padding:16px; border:1px solid var(--border); border-radius:12px; background:var(--panel); box-shadow:0 8px 28px rgb(0 0 0 / .08); overflow:hidden; }
    .preview-hint,.preview-status { margin:12px 2px 0; color:var(--muted); font-size:11px; text-align:center; }
    .preview-status { min-height:17px; color:var(--text); }
    .pd-layout { width:100%; display:flex; flex-direction:column; --pd-line:var(--line); }
    ${projectFlowchartCss}
    .pd-node { position:relative; z-index:1; width:100%; min-width:0; border:0; color:var(--text); background:transparent; font:inherit; text-align:left; text-decoration:none; cursor:pointer; }
    .pd-node:hover,.pd-node:focus-visible { background:var(--hover); outline:2px solid color-mix(in srgb,CanvasText 28%,transparent); outline-offset:-2px; }
    .pd-node.reference { opacity:.76; border-style:dashed; }
    .pd-node-main { display:flex; flex-direction:column; min-width:0; gap:1px; }
    .pd-node-heading { display:flex; align-items:center; gap:6px; min-width:0; }
    .pd-node-label { min-width:0; font-size:13px; font-weight:650; line-height:1.35; overflow-wrap:anywhere; }
    .pd-emphasis-badge { flex:none; padding:1px 5px; border:1px solid var(--pd-accent); border-radius:999px; color:var(--pd-accent); font-size:9px; font-weight:700; line-height:1.3; }
    .pd-node-symbol { min-width:0; color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:10px; line-height:1.35; overflow-wrap:anywhere; }
    .pd-node-copy { display:flex; flex-direction:column; gap:3px; min-width:0; }
    .pd-node-description { min-width:0; color:var(--muted); font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
    .pd-emphasis-reason { min-width:0; color:var(--pd-accent); font-size:11px; font-weight:600; line-height:1.4; overflow-wrap:anywhere; }
    .pd-edge-label { position:relative; z-index:2; display:inline-block; max-width:calc(100% - 12px); padding:1px 6px; border-radius:8px; color:var(--muted); background:var(--panel); font-size:10px; line-height:1.3; }
    .pd-layout-flow,.pd-layout-reading { gap:0; }
    .pd-flow-route-summary { margin:0 0 12px; padding:9px 10px; border:1px solid var(--border); border-radius:9px; background:color-mix(in srgb,var(--soft) 70%,var(--panel)); }
    .pd-flow-route-title { margin-bottom:5px; color:var(--muted); font-size:10px; font-weight:700; letter-spacing:.04em; }
    .pd-flow-route { display:grid; grid-template-columns:minmax(58px,auto) minmax(0,1fr); gap:7px; padding:3px 0; border-top:1px solid color-mix(in srgb,var(--border) 60%,transparent); font-size:10px; line-height:1.45; }
    .pd-flow-route:first-of-type { border-top:0; }
    .pd-flow-route-label { color:var(--text); font-weight:700; }
    .pd-flow-route-steps { color:var(--muted); overflow-wrap:anywhere; }
    .pd-flow-node,.pd-reading-node,.pd-dependency-node { --pd-accent:var(--pd-line); display:grid; grid-template-columns:minmax(130px,.85fr) minmax(150px,1.15fr); align-items:center; gap:12px; padding:9px 10px; border-left:2px solid var(--pd-accent); border-bottom:1px solid color-mix(in srgb,var(--pd-accent) 35%,transparent); }
    .pd-node.emphasis-important { --pd-accent:#c18b00; background:color-mix(in srgb,#d5a900 10%,transparent); }
    .pd-node.emphasis-warning { --pd-accent:#d94b4b; background:color-mix(in srgb,#d94b4b 10%,transparent); }
    .pd-node.emphasis-success { --pd-accent:#2f9d63; background:color-mix(in srgb,#2f9d63 10%,transparent); }
    .pd-node.emphasis-note { --pd-accent:#3986c7; background:color-mix(in srgb,#3986c7 10%,transparent); }
    .pd-flow-node.no-description,.pd-reading-node.no-description,.pd-dependency-node.no-description { grid-template-columns:minmax(0,1fr); }
    .pd-flow-node.no-description .pd-node-main,.pd-dependency-node.no-description .pd-node-main { display:grid; grid-template-columns:minmax(0,1fr) minmax(120px,42%); align-items:center; gap:8px; }
    .pd-flow-node.no-description .pd-node-symbol,.pd-dependency-node.no-description .pd-node-symbol { text-align:right; }
    .pd-flow-link { position:relative; height:20px; margin-left:8px; display:flex; align-items:center; padding-left:20px; }
    .pd-flow-link::before { content:""; position:absolute; left:6px; top:0; bottom:6px; width:1px; background:var(--pd-line); }
    .pd-flow-link::after { content:""; position:absolute; left:3px; bottom:0; border-left:4px solid transparent; border-right:4px solid transparent; border-top:6px solid var(--pd-line); }
    .pd-flow-branches { display:flex; flex-direction:column; gap:5px; margin:3px 0 3px 11px; padding-left:13px; border-left:1px solid var(--pd-line); }
    .pd-flow-branch,.pd-dependency-child { position:relative; display:flex; flex-direction:column; gap:2px; min-width:0; }
    .pd-flow-branch::before,.pd-dependency-child::before { content:""; position:absolute; left:-13px; top:18px; width:12px; height:1px; background:var(--pd-line); }
    .pd-flow-branch>.pd-edge-label,.pd-dependency-child>.pd-edge-label { align-self:flex-start; margin:0 0 -2px 2px; }
    .pd-reading-row { position:relative; display:grid; grid-template-columns:34px minmax(0,1fr); gap:7px; padding:3px 0; }
    .pd-reading-row:not(:last-child)::after { content:""; position:absolute; z-index:0; left:15px; top:32px; bottom:-5px; width:1px; background:var(--pd-line); }
    .pd-reading-number { position:relative; z-index:1; align-self:start; width:30px; height:30px; display:inline-flex; align-items:center; justify-content:center; border-radius:50%; color:#1e1e1e; background:var(--pd-line); font-size:11px; font-weight:750; }
    .pd-dependency-branch { display:flex; flex-direction:column; min-width:0; }
    .pd-dependency-children { display:flex; flex-direction:column; margin-left:15px; padding-left:13px; border-left:1px solid var(--pd-line); }
    .pd-reference-mark { position:absolute; left:8px; top:50%; transform:translateY(-50%); color:var(--pd-line); font-size:15px; }
    .pd-node.reference { padding-left:28px; }
    @media (max-width:520px) { body{padding:16px 8px 36px}.diagram-card{padding:10px}.pd-flow-node,.pd-reading-node,.pd-dependency-node{grid-template-columns:minmax(0,1fr);gap:3px}.pd-flow-node.no-description .pd-node-main,.pd-dependency-node.no-description .pd-node-main{grid-template-columns:minmax(0,1fr)}.pd-flow-node.no-description .pd-node-symbol,.pd-dependency-node.no-description .pd-node-symbol{text-align:left} }
  </style>
</head>
<body>
  <main class="preview">
    <div class="preview-kicker">AI Code Guide preview</div>
    <h1>${htmlText(diagram.title || "コード図", 120)}</h1>
    <p class="preview-question"><span class="preview-kind">${kindLabel}</span>質問: ${htmlText(question, 240)}</p>
    ${summary}
    <section class="diagram-card" aria-label="コード図">${diagramHtml}</section>
    <p class="preview-hint">${diagram.kind === "flow"
        ? workspaceRoot
            ? "図形を選ぶと詳細を表示し、「コードへ」からVS Codeの該当行を開きます"
            : "図形を選ぶと詳細を表示し、「コードへ」からコード位置をコピーします"
        : workspaceRoot
            ? "ノードを押すと、VS Codeで該当行を開きます"
            : "ノードを押すと、リポジトリ内のコード位置をコピーします"}</p>
    <p class="preview-status" role="status" aria-live="polite"></p>
  </main>
  <script>
    ${projectFlowchartRuntime}
    document.addEventListener("click", (event) => {
      const node = event.target.closest(".pd-node[data-file]");
      if (!node) return;
      if (node.classList.contains("pd-flow-shape")) { event.preventDefault(); selectProjectDiagramShape(node); return; }
      document.querySelectorAll(".pd-node[aria-current]").forEach((item) => item.removeAttribute("aria-current"));
      node.setAttribute("aria-current", "true");
      const location = node.dataset.file + ":" + node.dataset.line;
      const status = document.querySelector(".preview-status");
      // AI_NOTE: clipboardと外部プロトコルが同じユーザー操作権限を奪い合うため、
      // VS Code実リンクではコピーを一切行わず、a要素の既定遷移だけに専念させる。
      if (node.matches("a[href]")) {
        status.textContent = location + " をVS Codeで開いています…";
        return;
      }
      let copyPromise;
      try {
        // AI_NOTE: 外部プロトコル起動はクリック時の一時的なユーザー操作権限が必要。
        // clipboard完了をawaitすると権限が切れるため、コピーだけを開始してa要素の既定遷移を妨げない。
        copyPromise = navigator.clipboard.writeText(location);
      } catch (_) {
        status.textContent = location;
      }
      if (copyPromise) {
        copyPromise.then(() => {
          status.textContent = location + " をコピーしました";
        }).catch(() => {
          status.textContent = location;
        });
      }
    });
  </script>
</body>
</html>`;
}
