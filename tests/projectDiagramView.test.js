const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "view", "mainViewProvider.ts"), "utf8");
const clientSource = fs.readFileSync(path.join(__dirname, "..", "src", "api", "claudeClient.ts"), "utf8");
const annotationSource = fs.readFileSync(path.join(__dirname, "..", "src", "inline", "blockExplanationProvider.ts"), "utf8");
const extensionSource = fs.readFileSync(path.join(__dirname, "..", "src", "extension.ts"), "utf8");
const traceProviderSource = fs.readFileSync(path.join(__dirname, "..", "src", "inline", "traceProvider.ts"), "utf8");
let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

assert.ok(source.includes('まだありません。ここで作った図は次回から残ります。'));
ok("履歴0件でも図の質問欄を表示する");

assert.ok(source.includes('this.projectDiagramHistory = this.projectDiagramStore.list(this.projectDiagramWorkspaceKey());'));
ok("構成解析前にもワークスペースの図履歴を読み込む");

assert.ok(source.includes("private selectedProjectDiagramHistoryId: string | null = null;"));
assert.ok(source.includes("const selected = this.selectedProjectDiagramHistoryId === entry.id;"));
assert.ok(!source.includes("const selected = this.projectDiagram?.question === entry.question;"));
assert.ok(source.includes("this.selectedProjectDiagramHistoryId = historyEntry.id;"));
assert.ok(source.includes("this.selectedProjectDiagramHistoryId = this.projectDiagram ? entry.id : null;"));
ok("同じ質問文の履歴が複数あっても選択中IDの1件だけを青くする");

const tracePayload = source.slice(source.indexOf('if (request.view === "trace"'), source.indexOf('return { ok: true, view: request.view, file: relativeFile, line: request.line };'));
assert.ok(tracePayload.includes("const lines = Array.from"));
assert.ok(tracePayload.includes("trace.startLine"));
assert.ok(tracePayload.includes("trace.endLine"));
assert.ok(tracePayload.includes("const traceStandardColors = assignNodeColors"));
assert.ok(tracePayload.includes("const traceColorAt = (line: number)"));
assert.ok(tracePayload.includes("...(color ? { color } : {})"));
assert.ok(!tracePayload.includes(".slice(0, 30)"));
ok("会話内実行トレースへ対象関数の全行を渡し、値の無い条件式も隠さない");

const clearDiagramHandler = source.slice(source.indexOf('msg.type === "clearProjectDiagram"'), source.indexOf('msg.type === "selectProjectDiagramHistory"'));
assert.ok(clearDiagramHandler.includes("this.selectedProjectDiagramHistoryId = null;"));
const deleteDiagramHandler = source.slice(source.indexOf("private deleteProjectDiagramHistory"), source.indexOf("private findProjectSymbolLine"));
assert.ok(deleteDiagramHandler.includes("if (this.selectedProjectDiagramHistoryId === id) this.selectedProjectDiagramHistoryId = null;"));
ok("図を閉じるか選択中履歴を削除すると選択表示を解除する");

const initialPane = source.slice(source.indexOf('if (!this.projectData) {', source.indexOf('private buildProjectPane')), source.indexOf('const { nodes, edges }'));
assert.ok(initialPane.includes('loadRepoDesign(root)'));
assert.ok(initialPane.includes('return `${initialDesignHtml}${analyzeHtml}`'));
assert.ok(!initialPane.includes("buildProjectGuideFinder"));
ok("初期画面でリポジトリ設計を表示する");

assert.ok(source.includes("msg.type === \"ensureProject\""));
assert.ok(source.includes("if (this.projectData || this.projectAnalyzing) return;"));
assert.ok(source.includes("if (tabId === 'process') vscode.postMessage({type:'ensureProject'});"));
ok("図タブを開くと検索前に一度だけ構成解析を始める");

assert.ok(source.includes("private projectAnalysisTask: Promise<void> | null = null;"));
assert.ok(source.includes("if (this.projectAnalysisTask) {\n            await this.projectAnalysisTask;"));
assert.ok(source.includes("this.projectAnalysisTask = analysis;"));
ok("自動解析中のMCP表示要求は空応答せず同じ解析完了を待つ");

assert.ok(source.includes('{ id: "process", label: "図", full: "質問に合わせたコード図" }'));
assert.ok(source.includes('<div class="pane" data-pane="process">${this.buildProcessPane()}</div>'));
ok("構成とは別に図タブを表示する");

const processPane = source.slice(source.indexOf("private buildProcessPane"), source.indexOf("private buildProjectPane"));
assert.ok(processPane.includes("buildProjectDiagramFinder"));
assert.ok(processPane.includes("buildProjectDiagramHtml"));
assert.ok(processPane.includes('class="process-diagram"'));
assert.ok(processPane.includes('class="process-diagram-summary"'));
assert.ok(processPane.includes("this.projectDiagram.diagram.summary"));
assert.ok(processPane.includes("図形を選ぶと詳細を表示し、「コードへ」から移動します"));
assert.ok(source.includes(".process-diagram { padding: 4px 8px 8px; overflow-x: visible; }"));
assert.ok(!processPane.includes("mermaid"));
ok("質問への図と図全体の概要をサイドバー用HTMLで表示する");

assert.ok(processPane.includes("HTMLで開く"));
assert.ok(processPane.includes("type:'openProjectDiagramHtml'"));
const htmlExportHandler = source.slice(source.indexOf('msg.type === "openProjectDiagramHtml"'), source.indexOf('msg.type === "clearProjectDiagram"'));
assert.ok(htmlExportHandler.includes("this.openProjectDiagramHtml()"));
const htmlExportMethod = source.slice(source.indexOf("private async openProjectDiagramHtml"), source.indexOf("private buildProcessPane"));
assert.ok(htmlExportMethod.includes('"project-diagram-preview.html"'));
assert.ok(htmlExportMethod.includes("buildStandaloneProjectDiagramHtml"));
assert.ok(htmlExportMethod.includes("await this.projectDiagramBridgeReady"));
assert.ok(htmlExportMethod.includes("this.projectDiagram.diagram, workspaceRoot, bridge"));
assert.ok(htmlExportMethod.includes("vscode.env.clipboard.writeText(filePath)"));
assert.ok(htmlExportMethod.includes("vscode.env.openExternal(vscode.Uri.file(filePath))"));
ok("現在のコード図を安定したHTMLへ書き出し、ブラウザ表示とパスコピーを行う");

assert.ok(source.includes('details class="process-map-finder compact"'));
assert.ok(source.includes("別の図を作る・履歴"));
ok("図の表示中は質問欄と履歴を折り畳んで表示領域を空ける");

assert.ok(source.includes("event.key==='Enter'&&!event.isComposing&&event.keyCode!==229"));
assert.ok(source.includes("type:'findProjectDiagram'"));
ok("日本語IMEの変換確定Enterでは図を生成しない");

assert.ok(source.includes("const symbols = n.symbols ?? n.functions"));
assert.ok(source.includes("source: buildProjectDiagramSourceExcerpt(n.path, symbols, question)"));
assert.ok(source.includes("from \"./projectDiagramContext\""));
assert.ok(source.includes("imports: this.projectData!.edges"));
assert.ok(source.includes("(file.symbols ?? file.functions).includes(candidate.symbol)"));
assert.ok(source.includes("collapseProjectDiagramEdges(raw.edges, validIds)"));
assert.ok(source.includes("private projectDiagramGeneration: Promise<void> | null = null"));
assert.ok(source.includes("await this.projectDiagramGeneration"));
assert.ok(source.includes("this.projectDiagram?.question === normalizedQuestion"));
assert.ok(source.includes("projectDiagramConnectivity(located, edges)"));
ok("実際の処理順を判断できるコード断片とimport関係をモデルへ渡す");

assert.ok(clientSource.includes("summaryは図全体が何を表すか"));
assert.ok(clientSource.includes("何を受け取り、何を判断・処理し、最終的にどうなる流れか"));
assert.ok(clientSource.includes("node.description"));
assert.ok(clientSource.includes("node.emphasis"));
assert.ok(clientSource.includes("node.emphasisReason"));
assert.ok(clientSource.includes('role?: "start" | "process" | "decision" | "merge" | "end"'));
assert.ok(clientSource.includes("flowの各nodeにはroleを必ず付けてください"));
assert.ok(clientSource.includes("コード上の事実と、その意味または影響"));
assert.ok(clientSource.includes("開始点という理由だけでは付けず"));
assert.ok(clientSource.includes("質問で実在symbol（関数・class・method）が明示された場合"));
assert.ok(clientSource.includes("複数の例外classが明示された場合"));
assert.ok(clientSource.includes("missingRequestedProjectDiagramSymbols(initial.diagram.nodes, requestedSymbols)"));
assert.ok(clientSource.includes("「〜するため」のような目的句で終わらせず"));
assert.ok(source.includes("description: candidate.description?.trim().slice(0, 60)"));
assert.ok(source.includes("emphasis: candidate.emphasis"));
assert.ok(source.includes("emphasisReason: candidate.emphasis ? candidate.emphasisReason?.trim().slice(0, 90)"));
assert.ok(source.includes("summary: raw.summary?.trim().slice(0, 140)"));
ok("図全体の概要・完結したノード説明・意味ベースの任意強調を生成して保存する");

assert.ok(source.includes(".process-diagram { padding: 4px 8px 8px; overflow-x: visible; }"));
assert.ok(source.includes(".process-diagram-summary {"));
assert.ok(source.includes(".pd-layout { width: 100%; display: flex; flex-direction: column;"));
assert.ok(source.includes(".pd-flow-node { display: grid; grid-template-columns:"));
assert.ok(source.includes(".pd-node-description {"));
assert.ok(source.includes(".pd-emphasis-reason {"));
assert.ok(source.includes(".pd-emphasis-badge {"));
assert.ok(source.includes(".pd-node.emphasis-warning {"));
assert.ok(!source.includes(".pd-node.root {"));
assert.ok(!source.includes(".pd-node-reason {"));
assert.ok(source.includes(".pd-dependency-children { display: flex; flex-direction: column;"));
assert.ok(source.includes(".pd-reading-number {"));
ok("3種類で概要とノード説明を分け、横幅も使う専用の縦長レイアウトにする");

assert.ok(source.includes(".pd-flow-link { position: relative; height: 14px;"));
assert.ok(source.includes(".pd-reading-row:not(:last-child)::after"));
assert.ok(!source.includes(".pd-reading-link"));
assert.ok(!source.includes('content: "▼"'));
ok("処理順の矢印を短くし、読解順は矢尻のないタイムラインにする");

assert.ok(source.includes("event.target.closest('.pd-flow-shape[data-node-id]')"));
assert.ok(source.includes("selectProjectDiagramShape(shape)"));
assert.ok(source.includes("event.target.closest('.pd-detail-jump[data-node-id]')"));
assert.ok(source.includes("processDiagramNodeClick(jump.dataset.nodeId)"));
assert.ok(source.includes("PROCESS_DIAGRAM_TARGETS"));
assert.ok(source.includes("type:'openProjectSymbol'"));
ok("図形選択と詳細ペインのコード移動を分離し、実在確認済み位置へ接続する");

assert.ok(source.includes("private pendingStandardFocus:"));
assert.ok(source.includes("this.pendingStandardFocus = currentUri === targetUri ? null : { uri: targetUri, line };"));
assert.ok(source.includes("if (currentUri === targetUri) {"));
assert.ok(source.includes('await this.reveal("standard");'));
assert.ok(source.includes('type: "focusStandardCard", nodeId: node?.id ?? ""'));
assert.ok(source.includes("else if (this.currentDoc?.uri.toString() !== targetUri)"));
assert.ok(source.includes('msg.type === "webviewReady"'));
const readyHandler = source.slice(source.indexOf('msg.type === "webviewReady"'), source.indexOf('msg.type === "copyChatMessage"'));
assert.ok(readyHandler.indexOf('type: "activateTab", tab: "standard"') < readyHandler.indexOf('type: "focusStandardCard"'));
assert.ok(source.lastIndexOf("vscode.postMessage({type:'webviewReady'});") > source.indexOf("window.addEventListener('message'"));
const openProjectSymbolMethod = source.slice(source.indexOf("private async openProjectSymbol"), source.indexOf("private buildProjectDiagramFinder"));
assert.ok(!openProjectSymbolMethod.includes("focusHostWindow"));
ok("図ノードからの移動は同一ファイルなら即時、別ファイルなら再解析後に対応カードを強調する");

const agentMethod = source.slice(source.indexOf("private async showAgentView"), source.indexOf("async revealCurrentStandardCard"));
for (const [view, tab] of Object.entries({ standard: "standard", overview: "overview", project: "project", diagram: "process", inline: "inline", trace: "trace" })) {
    assert.ok(agentMethod.includes(`${view}: "${tab}"`));
}
assert.ok(agentMethod.includes("await this.refresh(document)"));
assert.ok(agentMethod.includes("Python files only"));
assert.ok(agentMethod.includes("this.suppressActiveEditorRefresh = true"));
assert.ok(agentMethod.includes("this.suppressActiveEditorRefresh = false"));
assert.ok(agentMethod.includes('request.view === "standard" && request.line'));
assert.ok(agentMethod.includes("instant: Boolean(request.expandLines?.length)"));
assert.ok(agentMethod.includes('.filter((node): node is GraphNode & { kind: "function" | "class" | "constant" }'));
assert.ok(agentMethod.includes("line: node.lineStart + 1"));
assert.ok(agentMethod.includes("description: standardDescriptions[node.id]"));
assert.ok(agentMethod.includes("if (request.focusWindow && activate) await this.focusHostWindow();"));
assert.ok(agentMethod.indexOf("if (request.focusWindow && activate) await this.focusHostWindow();") < agentMethod.indexOf("await this.refresh(document);"));
assert.ok(agentMethod.includes("request.activate !== false"));
assert.ok(agentMethod.includes("const isolatedRead = !activate && !request.run"));
assert.ok(agentMethod.includes('request.view === "standard" || request.view === "overview"'));
assert.ok(agentMethod.includes("preparedGraphNodes = result.error ? [] : result.nodes"));
assert.ok(agentMethod.includes("if (request.focusWindow && request.line)"));
assert.ok(agentMethod.includes("editor.selection = new vscode.Selection(position, position);"));
assert.ok(agentMethod.includes("await new Promise<void>((resolve) => setTimeout(resolve, 120));"));
assert.ok(agentMethod.includes("settledEditor.selection = new vscode.Selection(position, position);"));
assert.ok(agentMethod.includes('settledEditor.selection.active.line !== zeroBasedLine'));
assert.ok(agentMethod.includes('throw new Error(`VS Code did not acknowledge the requested code location:'));
assert.ok(agentMethod.includes("jumpReceipt = {"));
assert.ok(agentMethod.includes("acknowledged: true"));
assert.ok(agentMethod.includes("editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);"));
assert.ok(agentMethod.includes("const standardNodes = preparedGraphNodes ?? this.graphNodes"));
assert.ok(agentMethod.indexOf("if (isolatedRead)") < agentMethod.indexOf("await this.refresh(document);"));
assert.ok(agentMethod.includes("request.expandLines"));
assert.ok(agentMethod.includes("this.ensureStandardExpansions(request.expandLines)"));
assert.ok(agentMethod.includes("request.view === \"overview\" && request.run"));
assert.ok(agentMethod.includes("this.generateAgentOverview()"));
assert.ok(agentMethod.includes("request.view === \"project\" && request.run"));
assert.ok(agentMethod.includes("overview: {"));
assert.ok(agentMethod.includes("project: {"));
assert.ok((agentMethod.match(/await this\.reveal\(tabByView\[request\.view\], preserveFocus\);/g) ?? []).length >= 2);
assert.ok(agentMethod.lastIndexOf("await this.reveal(tabByView[request.view], preserveFocus);") > agentMethod.indexOf("await this.generateProjectDiagram"));
// 明示クリック以外はVS Codeへフォーカスを渡さない（外部AIの表示要求で前面化しない）
assert.ok(agentMethod.includes("const preserveFocus = !request.focusWindow;"));
assert.ok(agentMethod.includes("if (activate) await this.reveal(undefined, preserveFocus);"));
assert.ok(agentMethod.includes("const backgroundDocumentRequest = !activate"));
assert.ok(agentMethod.includes('request.view === "inline" || request.view === "trace" || request.view === "diagram"'));
assert.ok(agentMethod.includes("} else if (!backgroundDocumentRequest) {"));
assert.ok(!agentMethod.includes("if (activate || request.run)"));
assert.ok(source.includes("while (!this.view && Date.now() < deadline)"));
assert.ok(source.includes('throw new Error("AI Code Guide view did not initialize")'));
assert.ok(agentMethod.includes("preserveFocus,"));
assert.ok(agentMethod.includes("this.initialTabOverride = tabByView[request.view]"));
assert.ok(agentMethod.includes("this.initialTabOverride = null"));
ok("外部AIの6ビューを固定対応し、activate:falseの標準・概要参照は表示状態から隔離する");

const expansionMethod = source.slice(source.indexOf("private async ensureStandardExpansions"), source.indexOf("async revealCurrentStandardCard"));
assert.ok(expansionMethod.includes("if (this.expandedData[node.id]) continue;"));
assert.ok(expansionMethod.includes("await this.toggleExpand(node.id"));
assert.ok(source.includes("instant: pending.instant === true"));
assert.ok(source.includes("behavior: e.data.instant ? 'auto' : 'smooth'"));
assert.ok(source.includes("private async ensureFileOverview"));
assert.ok(source.includes("private async generateAgentOverview"));
ok("AIが選んだ0〜複数カードだけを確実に展開し、概要は最小単位で生成する");

assert.ok(source.includes("const forcedInitialTab = ${JSON.stringify(this.initialTabOverride)};"));
assert.ok(source.includes("if (forcedInitialTab) activate(forcedInitialTab);"));
assert.ok(source.includes("if (!this.suppressActiveEditorRefresh) void this.refresh(e?.document);"));
ok("エージェント要求タブを完成HTMLへ埋め込み、差し替え時のメッセージ競合を避ける");

const focusHostWindowMethod = source.slice(source.indexOf("private async focusHostWindow"), source.indexOf("private excludeAgentBridgeManifest"));
assert.ok(focusHostWindowMethod.includes('executeCommand("workbench.action.focusWindow")'));
assert.ok(!focusHostWindowMethod.includes('execFile("/usr/bin/open"'));
assert.ok(!source.includes('import { execFile, spawn } from "node:child_process"'));
ok("会話内図の明示クリック時は処理中のVS Codeウィンドウだけを前面化する");

assert.ok(agentMethod.includes("this.writeProjectDiagramHtml(false, false)"));
assert.ok(!agentMethod.includes("this.writeProjectDiagramHtml(true, false)"));
assert.ok(agentMethod.includes("question: this.projectDiagram.question"));
assert.ok(agentMethod.includes("diagram: this.projectDiagram.diagram"));
ok("外部AIの図生成は会話表示用データを返し、受け渡し用HTMLをブラウザで自動表示しない");

assert.ok(agentMethod.includes('"aiCodeGuide.explainBlockInline"'));
assert.ok(agentMethod.includes('"aiCodeGuide.explainSelection"'));
assert.ok(agentMethod.includes("this.traceProvider?.isActive(editor.document.uri.toString())"));
assert.ok(agentMethod.includes("if (activate && editor && this.traceProvider?.isActive"));
assert.ok(agentMethod.includes("this.traceProvider.clear(editor)"));
assert.ok(agentMethod.includes("inlineResult.status === \"empty\""));
assert.ok(agentMethod.includes("this.annotationProvider.getSavedAnnotationsForDocument(document)"));
assert.ok(agentMethod.includes("this.annotationProvider.annotateDocument("));
assert.ok(agentMethod.includes("background: !activate"));
assert.ok(agentMethod.includes("uri: targetDocument.uri.toString()"));
assert.ok(extensionSource.includes("args?.background || !editor"));
assert.ok(extensionSource.includes("traceProvider.storeTraces(document, traces)"));
assert.ok(traceProviderSource.includes("storeTraces(document: vscode.TextDocument"));
assert.ok(agentMethod.includes('contextLabel = request.startLine === undefined ? "ファイル全体" : "選択範囲"'));
assert.ok(agentMethod.includes('contextLabel = `${kind} ${match[4]}`'));
assert.ok(agentMethod.includes("const scopedItems = request.startLine === undefined"));
assert.ok(agentMethod.includes("item.endLine + 1 >= contextStart && item.startLine + 1 <= contextEnd"));
assert.ok(agentMethod.includes("label: contextLabel"));
assert.ok(agentMethod.includes("startCol: item.startCol"));
assert.ok(agentMethod.includes("endCol: item.endCol"));
assert.ok(agentMethod.indexOf("this.traceProvider.clear(editor)") < agentMethod.indexOf('"aiCodeGuide.explainBlockInline"'));
assert.ok(agentMethod.indexOf('"aiCodeGuide.explainBlockInline"') < agentMethod.lastIndexOf("this.annotationProvider.getSavedAnnotationsForDocument(document)"));
assert.ok(annotationSource.includes("getSavedAnnotations(editor: vscode.TextEditor)"));
const savedAnnotationsMethod = annotationSource.slice(
    annotationSource.indexOf("getSavedAnnotations(editor: vscode.TextEditor)"),
    annotationSource.indexOf("clearEditor(editor: vscode.TextEditor)"),
);
assert.ok(savedAnnotationsMethod.includes("this.getSavedAnnotationsForDocument(editor.document)"));
assert.ok(savedAnnotationsMethod.includes("this.cache.get(uri, document.getText())"));
assert.ok(!savedAnnotationsMethod.includes("this.activeAnnotations.get"));
ok("トレース後のインライン要求は表示を切り替え、MCPへは永続キャッシュの生成結果を返す");
assert.ok(agentMethod.includes("const removeIds = request.removeAnnotationIds ?? []"));
assert.ok(agentMethod.indexOf("replaceSavedAnnotations(editor, before.filter") < agentMethod.indexOf('executeCommand<AnnotateResult>'));
assert.ok(agentMethod.includes("replaceSavedAnnotations(editor, before)"));
assert.ok(agentMethod.includes('setAnnotationStatus(uri, id, "hidden")'));
assert.ok(annotationSource.includes("replaceSavedAnnotations(editor: vscode.TextEditor"));
ok("会話で指定した解説だけを生成前に外し、失敗時は復元し、削除と非表示を個別に永続反映する");
assert.ok(agentMethod.includes('executeCommand("aiCodeGuide.traceFunctions"'));
assert.ok(agentMethod.includes("background: !activate"));
assert.ok(agentMethod.includes("実行トレースを作成できませんでした"));
assert.ok(agentMethod.includes("traceRun.skipped"));
assert.ok(agentMethod.includes('executeCommand("aiCodeGuide.showSavedTraces"'));
assert.ok(agentMethod.includes("this.annotationProvider.restoreFromCache(editor)"));
assert.ok(agentMethod.includes("annotations: {"));
assert.ok(agentMethod.includes("request.run ? { funcNames: traceRun?.funcNames ?? []"));
assert.ok(agentMethod.includes("traceEntryId: entryReceipt.id"));
for (const field of ["sourceSha256", "runReceiptId", "role:", "location:", "controlPath:", "keyValues:", "safetyDecision:"]) assert.ok(agentMethod.includes(field));
assert.ok(!source.includes("trace-shared-receipt"), "VS Code trace pane omits receipt metadata");
assert.ok(source.includes("@media (max-width: 360px)"), "narrow VS Code trace pane stacks controls above descriptions");
assert.ok(agentMethod.includes("activeTraceEntries"));
assert.ok(source.includes("MainViewProvider.sharedActiveTraceEntries"));
assert.ok(agentMethod.includes("request.traceEntryId ?? randomUUID()"));
assert.ok(agentMethod.includes("latestTraceEntries.set(receiptKey"), "completed trace receipts remain available by exact request identity");
assert.ok(agentMethod.includes("entryReceipt = this.latestTraceEntries.get(receiptKey)"), "saved trace reuses only the exact target/arguments receipt");
assert.ok(source.includes("private traceReceiptKey("), "trace receipt identity is separated from file-level recovery continuity");
assert.ok(source.includes("functions: functions ?? []"), "trace receipt identity includes requested functions");
assert.ok(source.includes("arguments: sort(callArguments ?? null)"), "trace receipt identity includes canonical arguments");
assert.ok(agentMethod.includes("request.run"));
ok("保存済み表示と新規生成・単一／複数実行を分離して構造化結果を返す");

assert.ok(source.includes('getManifestPath: () =>'));
assert.ok(source.includes('path.join(root, ".ai-code-guide", "bridge.json")'));
assert.ok(source.includes('showView: async (request) => this.showAgentView(request)'));
assert.ok(source.includes('`${runtimePrefix}/bridge.json`'));
assert.ok(source.includes('`${runtimePrefix}/ai-code-guide.mjs`'));
assert.ok(source.includes('`${runtimePrefix}/ai-code-guide-mcp.mjs`'));
assert.ok(source.includes('["ai-code-guide.mjs", "ai-code-guide-mcp.mjs"]'));
assert.ok(source.includes('path.join(this.extensionPath, "bin", name)'));
assert.ok(source.includes("fs.copyFileSync(source, target)"));
assert.ok(source.includes('path.join(os.homedir(), "Library", "Application Support")'));
assert.ok(source.includes('path.join(sharedBase, "AI Code Guide", "mcp")'));
assert.ok(source.includes("fs.copyFileSync(sharedMcpSource, sharedMcpTarget)"));
assert.ok(source.includes('findGitExcludeInfo(root)'));
assert.ok(source.includes('path.relative(git.worktreeRoot, root)'));
ok("ワークスペース固有マニフェストと固定CLIを公開し、親Gitルートまたはworktreeのローカル除外へ追加する");

console.log(`\n${passed}/28 passed`);
