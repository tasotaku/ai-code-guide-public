import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { GraphNode, GraphEdge } from "./astParser";

// AI_NOTE: #14 単一関数フローチャート描画の共有モジュール。
// 旧FlowchartPanel内の同等ロジックを切り出し、サイドバー(MainViewProvider)と共用する。
// 旧FlowchartPanel撤去後はこちらが正となる。

export type NodeColor = { color: string; bg: string; mermaidFill: string };

const NODE_PALETTE: NodeColor[] = [
    { color: "#4fc1ff", bg: "rgba(79,193,255,0.15)", mermaidFill: "#1a3a4f" },
    { color: "#f48771", bg: "rgba(244,135,113,0.15)", mermaidFill: "#42251f" },
    { color: "#4ec9b0", bg: "rgba(78,201,176,0.15)", mermaidFill: "#1a3a32" },
    { color: "#dcdcaa", bg: "rgba(220,220,170,0.15)", mermaidFill: "#38381e" },
    { color: "#c586c0", bg: "rgba(197,134,192,0.15)", mermaidFill: "#3a1f38" },
    { color: "#9cdcfe", bg: "rgba(156,220,254,0.15)", mermaidFill: "#1e3040" },
    { color: "#d7ba7d", bg: "rgba(215,186,125,0.15)", mermaidFill: "#3d321d" },
    { color: "#b8a1e3", bg: "rgba(184,161,227,0.15)", mermaidFill: "#322842" },
    { color: "#8fbc8f", bg: "rgba(143,188,143,0.15)", mermaidFill: "#233b28" },
    { color: "#e87ea1", bg: "rgba(232,126,161,0.15)", mermaidFill: "#422338" },
    { color: "#75beff", bg: "rgba(117,190,255,0.15)", mermaidFill: "#1c354d" },
    { color: "#ce9178", bg: "rgba(206,145,120,0.15)", mermaidFill: "#3a2518" },
];

// AI_NOTE: 描画対象ノードにパレット色を順に割り当てる(entryは固定classDefなので除外)。
// kinds で対象種別を絞れる。topLevelOnly=true なら parent 持ち(メソッド等)を飛ばす。
// 標準ビューは {function,class}×topLevelで構造だけ色付けし、import/実行/その他ブロックは色を持たせない(呼び出し側でグレー化)。
const ALL_COLOR_KINDS = new Set(["block", "condition", "loop", "return", "function", "class"]);
export function assignNodeColors(
    nodes: GraphNode[],
    kinds: Set<string> = ALL_COLOR_KINDS,
    topLevelOnly = false
): Map<string, NodeColor> {
    const map = new Map<string, NodeColor>();
    let idx = 0;
    for (const n of nodes) {
        if (topLevelOnly && n.parent) continue;
        if (kinds.has(n.kind)) {
            map.set(n.id, NODE_PALETTE[idx % NODE_PALETTE.length]);
            idx++;
        }
    }
    return map;
}

// AI_NOTE: ノード/エッジを Mermaid flowchart のソースに変換する。kindで形状を変える。
export function buildMermaidCode(
    nodes: GraphNode[],
    edges: GraphEdge[],
    colorMap: Map<string, NodeColor>,
    labelOverrides: Map<string, string> = new Map()
): string {
    const lines: string[] = ["flowchart TD"];
    for (const n of nodes) {
        const override = labelOverrides.get(n.id);
        const rawLabel = (n.kind === "function" && override)
            ? `${n.label.split("(")[0]}: ${override}`
            : (override ?? n.label);
        const safeLabel = rawLabel
            .replace(/"/g, "'")
            .replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"))
            .substring(0, 55);
        let def: string;
        switch (n.kind) {
            case "entry": def = `(["${safeLabel}"])`; break;
            case "condition": def = `{"${safeLabel}"}`; break;
            case "return": def = `(("${safeLabel}"))`; break;
            case "loop": def = `[/"${safeLabel}"/]`; break;
            case "function": def = `[["${safeLabel}"]]`; break;
            default: def = `["${safeLabel}"]`; break;
        }
        const cls = n.kind === "entry" ? `:::${n.kind}` : "";
        lines.push(`  ${n.id}${def}${cls}`);
    }
    for (const e of edges) {
        const arrow = e.label ? `-->|"${e.label}"|` : "-->";
        lines.push(`  ${e.from} ${arrow} ${e.to}`);
    }
    // AI_NOTE: モジュールマップ時は不可視エッジでファイル順を固定(レイアウト制約)
    if (nodes.some((n) => n.kind === "function")) {
        for (let i = 0; i < nodes.length - 1; i++) {
            lines.push(`  ${nodes[i].id} ~~~ ${nodes[i + 1].id}`);
        }
    }
    lines.push(`  classDef entry fill:#1e3a5f,stroke:#4fc1ff,color:#c6e7ff`);
    for (const n of nodes) {
        const c = colorMap.get(n.id);
        if (c) lines.push(`  style ${n.id} fill:${c.mermaidFill},stroke:${c.color},color:#e0e0e0`);
    }
    return lines.join("\n");
}

// AI_NOTE: webviewでローカルmermaidを読むための <script> タグだけを返す。
// [レビュー] 以前はここでも独自の <meta CSP> を出していたが、buildHtml 側の head CSP と二重になると
// ブラウザは両者の積(交差)を適用し、片方に 'unsafe-eval' が欠けると mermaid が壊れる。CSP は head に一本化し、
// mermaid 実行に必要な 'unsafe-eval' / ローカル script 許可はそちらに含める。ここは script 参照のみ責務とする。
export function mermaidHead(webview: vscode.Webview, extensionPath: string): string {
    // AI_NOTE: 配布(.vsix)では node_modules を同梱しないので media/ にコピーした mermaid を優先。
    // 開発(debug.sh)では media/ が無いので従来どおり node_modules を読む。
    const media = path.join(extensionPath, "media", "mermaid.min.js");
    const mermaidPath = fs.existsSync(media)
        ? media
        : path.join(extensionPath, "node_modules", "mermaid", "dist", "mermaid.min.js");
    const uri = webview.asWebviewUri(vscode.Uri.file(mermaidPath));
    return `<script src="${uri}"></script>`;
}
