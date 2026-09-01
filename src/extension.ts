import * as vscode from "vscode";
import * as path from "path";
import { setTokenUpdateCallback, getTokenUsage, getTokenLog, resetTokenUsage, DEFAULT_MODEL, initTokenLog, getAllTimeUsage, getUsageStats, resetAllTimeUsage, JPY_PER_USD } from "./api/claudeClient";
import { SemanticAnnotationProvider } from "./inline/blockExplanationProvider";
import { TraceProvider } from "./inline/traceProvider";
import { TraceCache } from "./inline/traceCache";
import { runTrace, TraceResult } from "./inline/traceRunner";
import { createHash, randomUUID } from "crypto";
import { generateTraceExample } from "./api/claudeClient";
import { funcAtLine, listFunctions } from "./flowchart/astParser";
import { MainViewProvider } from "./view/mainViewProvider";
import { ChatLinkStore } from "./view/chatLinkStore";
import { openHelpPage } from "./view/helpPage";
import { resolveCommand } from "./util/resolveCommand";
import { initSecretKeys, setSecretKey, getSecretKey, API_PROVIDERS, PROVIDER_DISPLAY, ApiProvider } from "./api/secretKeys";
import { accumulateBulkChange, BulkChange } from "./inline/bulkEditDetector";
import { getChangedLines } from "./util/gitDiff";
import { buildDesignPrompt, DesignScope } from "./design/designPrompt";
import { readExistingDesignMd } from "./design/designStore";
import { classifyTraceSafety, safetyRetryGuidance, TraceSafetyDecision } from "./inline/traceContract";
import { collectTraceDependencyContext } from "./inline/traceContext";

// AI_NOTE: SemanticAnnotationProvider は globalStorageUri を必要とするため activate 内で初期化する
let annotationProvider: SemanticAnnotationProvider | null = null;

export function activate(context: vscode.ExtensionContext): void {
    const extensionPath = context.extensionPath;
    // AI_NOTE: APIキーを settings(平文)→SecretStorage へ移行し、メモリキャッシュへ読み込む。
    // 非同期だが await しない: 完了前の getApiKey は settings フォールバックで動き、失敗しても拡張は起動させる
    void initSecretKeys(context).catch((e) => console.error("[AI Code Guide] secret key init failed:", e));
    // AI_NOTE: chatLinks(チャット引用→過去チャットのリンク)の永続レイヤーを1つ生成し、注釈provider(描画)と
    // mainViewProvider(生成)で共有する。同一インスタンスで突き合わせないと生成した直後の描画に載らないため。
    const chatLinkStore = new ChatLinkStore(context.globalStorageUri.fsPath);
    annotationProvider = new SemanticAnnotationProvider(context.globalStorageUri, chatLinkStore, context.extensionPath);
    // AI_NOTE: MainViewProvider にも annotationProvider を渡し、チャットペインから注釈件数/一覧/操作ボタンを使えるようにする

    // AI_NOTE: #14 Phase0 サイドバー常駐の統合パネルを登録。retainContextWhenHidden で隠しても中身を保つ
    const mainViewProvider = new MainViewProvider(context, annotationProvider, chatLinkStore);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MainViewProvider.viewType, mainViewProvider, {
            webviewOptions: { retainContextWhenHidden: true },
        })
    );
    context.subscriptions.push({ dispose: () => annotationProvider?.dispose() });
    // AI_NOTE: HoverProvider として登録。アノテーション範囲をホバーすると解説ポップアップを表示する
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            { language: "python" },
            annotationProvider
        )
    );
    // AI_NOTE: CodeLensProvider として登録。該当行の上に label を常時表示（クリックでチャット）
    context.subscriptions.push(
        vscode.languages.registerCodeLensProvider(
            { language: "python" },
            annotationProvider
        )
    );

    // AI_NOTE: トークン記録の永続化を初期化（globalStorage の token-usage.jsonl を読み、全期間累計を復元）
    initTokenLog(context.globalStorageUri.fsPath);

    const tokenBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    // AI_NOTE: クリックで「使用量」タブを開く（旧: showTokenLog の QuickPick。詳細統計はタブに移行した）
    tokenBar.command = "aiCodeGuide.showUsage";
    context.subscriptions.push(tokenBar);

    // AI_NOTE: バーは「今回セッション / 累計」を表示。コストはツールチップに概算で出す（バーは数字だけで簡潔に）。
    const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
    const renderTokenBar = () => {
        const s = getTokenUsage();
        const a = getAllTimeUsage();
        const sTot = s.input + s.output;
        const aTot = a.input + a.output;
        tokenBar.text = `$(sparkle) ${fmtK(sTot)} / 累計 ${fmtK(aTot)} tok`;
        tokenBar.tooltip = `AI Code Guide トークン\n今回セッション: ${sTot.toLocaleString()} tok\n全期間累計: ${aTot.toLocaleString()} tok（概算 ¥${Math.round(a.costJpy).toLocaleString()} / $${a.costUsd.toFixed(2)}）\nクリックで日別・モデル別の内訳`;
        tokenBar.show();
    };
    setTokenUpdateCallback(renderTokenBar);
    renderTokenBar(); // AI_NOTE: 起動直後に累計を表示（コールバックは次のAPIコールまで発火しないため）

    const modelBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    modelBar.tooltip = "AI Code Guide: 使用モデル（クリックで切り替え）";
    modelBar.command = "aiCodeGuide.selectModel";
    context.subscriptions.push(modelBar);

    function refreshModelBar(): void {
        const model = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("model", DEFAULT_MODEL);
        const short = model.replace("claude-", "").replace("-20251001", "");
        modelBar.text = `$(circuit-board) ${short}`;
        modelBar.show();
    }
    refreshModelBar();
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration("aiCodeGuide.model")) refreshModelBar();
            // AI_NOTE: 注釈の見え方を変える設定は settings.json 直編集でも即反映させる(再生成はしない)。
            // 以前は置き場所だけ拾っており、サイドバーのボタン経由でしか他の表示設定が反映されなかった。
            const displayKeys = [
                "symbolAnnotationPlacement", "showAnnotationStatusButtons", "showAnnotations",
                "showHiddenAnnotations", "showSymbolAnnotations", "showBlockAnnotations",
                "hideResolvedAnnotations", "warningsOnly",
            ];
            if (displayKeys.some(k => e.affectsConfiguration(`aiCodeGuide.${k}`))) {
                for (const editor of vscode.window.visibleTextEditors) annotationProvider?.refreshVisibility(editor);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.showTokenLog", () => {
            const log = getTokenLog();
            const t = getTokenUsage();
            const stats = getUsageStats(); // AI_NOTE: 永続ログから 今日/直近7日/全期間 とモデル別コストを集計
            const sumTok = (x: { in: number; out: number }) => x.in + x.out;
            // AI_NOTE: in/out とコスト概算を1行に整形するヘルパー
            const line = (x: { in: number; out: number }) => `in=${x.in.toLocaleString()} / out=${x.out.toLocaleString()}（計 ${((sumTok(x)) / 1000).toFixed(1)}k）`;
            const items = [
                { label: "─── 今回のセッション ───", description: "", picked: false },
                { label: `$(sparkle) ${line({ in: t.input, out: t.output })}`, description: "", picked: false },
                { label: "─── 期間別（永続記録）───", description: "", picked: false },
                { label: `$(calendar) 今日: ${line(stats.today)}`, description: "", picked: false },
                { label: `$(calendar) 直近7日: ${line(stats.week)}`, description: "", picked: false },
                { label: `$(history) 全期間: ${line(stats.all)}`, description: `概算 ¥${Math.round(stats.costJpy).toLocaleString()} / $${stats.costUsd.toFixed(2)}`, picked: false },
                { label: "─── モデル別（全期間・概算コスト）───", description: "", picked: false },
                ...stats.byModel.map(m => ({
                    label: `$(circuit-board) ${m.model.replace("claude-", "").replace("-20251001", "")}`,
                    description: `in=${m.in.toLocaleString()} / out=${m.out.toLocaleString()}  ¥${Math.round(m.usd * JPY_PER_USD).toLocaleString()} / $${m.usd.toFixed(2)}`,
                    picked: false,
                })),
                { label: "─── 直近の操作 ───", description: "", picked: false },
                ...log.slice().reverse().map(e => ({
                    label: `$(arrow-right) ${e.operation}`,
                    description: `in=${e.input.toLocaleString()} / out=${e.output.toLocaleString()} tok  ${e.timestamp.toLocaleTimeString()}`,
                    picked: false,
                })),
                { label: "─────────────────", description: "", picked: false },
                { label: "$(trash) リセット", description: "セッション累計をリセット（永続記録は残す）", picked: false },
                { label: "$(trash) 全期間の記録を削除", description: "永続ログ(token-usage.jsonl)を消して累計を0にする", picked: false },
            ];
            vscode.window.showQuickPick(items, { title: "AI Code Guide トークン使用ログ" }).then(selected => {
                if (selected?.label === "$(trash) 全期間の記録を削除") {
                    resetAllTimeUsage();
                    vscode.window.showInformationMessage("AI Code Guide: 全期間のトークン記録を削除しました。");
                    return;
                }
                if (selected?.label === "$(trash) リセット") {
                    resetTokenUsage();
                    vscode.window.showInformationMessage("AI Code Guide: トークンカウンターをリセットしました。");
                }
            });
        })
    );

    // AI_NOTE: ステータスバーから「使用量」タブを開く
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.showUsage", () => {
            mainViewProvider.reveal("usage");
        })
    );

    // AI_NOTE: #14 旧パネルのコマンドはサイドバーの前面化に振り替える(機能はサイドバーのタブに集約済み)
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.showFlowchart", () => {
            mainViewProvider.reveal("standard");
        })
    );

    // AI_NOTE: コード上の現在行から標準カードへ戻る明示的な入口。カーソル移動のたびにサイドバーを奪わず、
    // 必要な時だけ右クリック/コマンドパレットからカードを中央表示する。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.revealCurrentStandardCard", () => mainViewProvider.revealCurrentStandardCard())
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.showProjectFlowchart", () => {
            mainViewProvider.reveal("project");
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.setGlobalContext", async () => {
            const current = vscode.workspace
                .getConfiguration("aiCodeGuide")
                .get<string>("globalContext", "");

            const input = await vscode.window.showInputBox({
                prompt: "Set global explanation context (e.g. 'I am a beginner', 'Explain in Japanese')",
                value: current,
                placeHolder: "Leave empty to clear",
            });

            if (input === undefined) return;

            await vscode.workspace
                .getConfiguration("aiCodeGuide")
                .update("globalContext", input, vscode.ConfigurationTarget.Global);

            annotationProvider?.clearAll();
            vscode.window.showInformationMessage("AI Code Guide: Global context updated. 解説を再生成すると新しい文脈が反映されます。");
        })
    );

    context.subscriptions.push(
        // AI_NOTE: APIキーの入力/削除UI。settingsは平文なので使わせず、passwordマスク付きInputBoxから
        // SecretStorage(OSキーチェーン)へ保存する。引数 preset は設定タブの「編集」ボタンからの直接指定用
        vscode.commands.registerCommand("aiCodeGuide.setApiKey", async (preset?: string) => {
            const items = API_PROVIDERS.map((p) => ({
                label: PROVIDER_DISPLAY[p],
                description: getSecretKey(p) ? "設定済み" : "未設定",
                provider: p,
            }));
            const picked = preset && API_PROVIDERS.includes(preset as ApiProvider)
                ? items.find((i) => i.provider === preset)
                : await vscode.window.showQuickPick(items, { placeHolder: "APIキーを設定するプロバイダを選択" });
            if (!picked) return;
            const value = await vscode.window.showInputBox({
                prompt: `${picked.label} のAPIキー（空のまま Enter で削除。キーはOSのキーチェーンに保存されます）`,
                password: true,
                ignoreFocusOut: true,
            });
            if (value === undefined) return;
            await setSecretKey(picked.provider, value.trim());
            vscode.window.showInformationMessage(
                value.trim() ? `${picked.label} のAPIキーをキーチェーンに保存しました。` : `${picked.label} のAPIキーを削除しました。`
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.selectModel", async () => {
            const config = vscode.workspace.getConfiguration("aiCodeGuide");
            const current = config.get<string>("model", DEFAULT_MODEL);

            // AI_NOTE: 3プロバイダのモデルを一覧。選んだモデル名の接頭辞でプロバイダが自動判定される(claude-/gpt-/gemini-)。
            const items = [
                { label: "Claude Haiku 4.5", description: "低コスト・高速（推奨）", model: "claude-haiku-4-5" },
                { label: "Claude Sonnet 5", description: "バランス型", model: "claude-sonnet-5" },
                { label: "Claude Opus 5", description: "最高品質", model: "claude-opus-5" },
                { label: "GPT-5.6 Luna", description: "OpenAI・低コスト・高速", model: "gpt-5.6-luna" },
                { label: "GPT-5.6 Terra", description: "OpenAI・バランス", model: "gpt-5.6-terra" },
                { label: "GPT-5.6 Sol", description: "OpenAI・最高品質", model: "gpt-5.6-sol" },
                { label: "Gemini 3.5 Flash-Lite", description: "Google・低コスト・高速", model: "gemini-3.5-flash-lite" },
                { label: "Gemini 3.6 Flash", description: "Google・高品質", model: "gemini-3.6-flash" },
            ].map(item => ({
                ...item,
                label: item.model === current ? `$(check) ${item.label}` : `      ${item.label}`,
            }));

            const picked = await vscode.window.showQuickPick(items, {
                title: "AI Code Guide: モデルを選択",
                placeHolder: "使用するモデルを選んでください（キーは対応プロバイダのものを設定）",
            });
            if (!picked) return;

            await config.update("model", picked.model, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage(`AI Code Guide: モデルを ${picked.label.trim()} に変更しました。`);
        })
    );

    // AI_NOTE: #14 カーソル連動・装飾・パネル表示はサイドバー(MainViewProvider)が自前で購読するため、
    // ここではセッションログと autoInlineAnnotations(インライン解説の自動生成)だけを扱う。
    async function onActiveEditorChanged(editor: vscode.TextEditor | undefined): Promise<void> {
        if (!editor || editor.document.languageId !== "python") return;

        // AI_NOTE: ① autoInlineAnnotations=true なら生成(有料)。false でもキャッシュ済みの説明は無料復元して既定表示にする。
        const autoAnnotate = vscode.workspace.getConfiguration("aiCodeGuide").get<boolean>("autoInlineAnnotations", false);
        if (autoAnnotate) {
            annotationProvider?.annotateFile(editor);
        } else {
            annotationProvider?.restoreFromCache(editor);
        }
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(onActiveEditorChanged)
    );

    // AI_NOTE: インライン意味解説コマンド。Python ファイルのみ対象。
    // explainBlockInline = ファイル全体を解析(Cmd+Alt+E)。関数自動検出は廃止したため、選択範囲限定の用途は
    // explainSelection 側へ完全分離した。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.explainBlockInline", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== "python") {
                vscode.window.showWarningMessage("AI Code Guide: Pythonファイルを開いてください。");
                return { status: "empty", count: 0 } as const;
            }
            return await annotationProvider?.annotateFile(editor) ?? { status: "empty", count: 0 } as const;
        })
    );

    // AI_NOTE: 強制再生成。キャッシュを無視して full を作り直す（古い/不完全な結果に詰まった時の逃げ道）。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.regenerateBlockInline", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== "python") {
                vscode.window.showWarningMessage("AI Code Guide: Pythonファイルを開いてください。");
                return;
            }
            await annotationProvider?.annotateFile(editor, true);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.clearBlockExplanations", () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) return;
            // AI_NOTE: トレース表示中のCmd+Alt+Cは「トレース解除→注釈をキャッシュ復元」。それ以外は従来どおり注釈クリア。
            // トレースと注釈は排他表示(トレース開始時に注釈を隠す)なので、解除で元の注釈に戻すのが対称。
            if (traceProvider.isActive(editor.document.uri.toString())) {
                traceProvider.clear(editor);
                annotationProvider?.restoreFromCache(editor);
                mainViewProvider.refreshTraceStatus();
            } else {
                annotationProvider?.clearEditor(editor);
            }
        })
    );

    // AI_NOTE: 実行トレース。カーソル位置の関数をLLMの具体例入力で実際に実行し、各行の変数値を右余白に表示する。
    // 流れ: 関数特定 → LLM(副作用判定+入力例+型テンプレート) → 隔離実行(trace_runner.py) → 失敗なら1回だけ作り直し → 表示。
    const traceProvider = new TraceProvider();
    const traceCache = new TraceCache(context.globalStorageUri.fsPath);
    mainViewProvider.setTraceProvider(traceProvider);
    // AI_NOTE: 生成・保存済み表示の双方が同じ内容アドレスを使う。キャッシュ限定ツールが
    // 誤ってLLM生成やPython実行へ落ちないよう、キー計算だけを共有して経路は分離する。
    const stableArguments = (value?: Record<string, unknown>): string => {
        if (value === undefined) return "generated";
        const sort = (item: unknown): unknown => Array.isArray(item)
            ? item.map(sort)
            : item && typeof item === "object"
                ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, nested]) => [key, sort(nested)]))
                : item;
        return JSON.stringify(sort(value));
    };
    // AI_NOTE: 値の人間向け表現を変えた場合、古い文字列を保存したトレースを再利用しない。
    const traceValueFormat = "readable-values-v4-handled-assertions";
    const traceCacheKey = (document: vscode.TextDocument, source: string, funcName: string, callArguments?: Record<string, unknown>): string => {
        const contentHash = createHash("sha1").update(source).digest("hex");
        const argsHash = createHash("sha1").update(stableArguments(callArguments)).digest("hex");
        return `${traceValueFormat}::${document.uri.toString()}::${contentHash}::${funcName}::${argsHash}`;
    };
    // AI_NOTE: 注釈は右余白でトレースと場所が競合する。トレース中は注釈側の描画を止める
    // (生成がトレース開始後に完了しても割り込まない)。
    annotationProvider?.setTraceActiveCheck((uri) => traceProvider.isActive(uri));
    context.subscriptions.push({ dispose: () => traceProvider.dispose() });
    context.subscriptions.push(
        vscode.languages.registerHoverProvider({ language: "python" }, traceProvider)
    );
    // AI_NOTE: 周回セレクタのボタン。エディタ上の装飾はクリックを受け取れないので、素のクリック1回で押せる
    // 置き場所としてステータスバーに ◀ / 表示 / ▶ の3つを出す(対象はキーバインドと同じカーソル行の最内ループ)。
    // トレース中だけ表示し、解除・周回変更・カーソル移動で貼り直す。
    // AI_NOTE: 優先度は大きいほど左端に寄る。他拡張(Git Graph等)に押し出されて見えなくなるのを避けるため
    // 十分大きい値にし、幅が足りない窓でも隠れにくくする。
    const iterBar = [
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10002),
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10001),
        vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10000),
    ];
    iterBar[0].text = "$(chevron-left)";
    iterBar[0].tooltip = "前の周回へ (Cmd+Alt+←)";
    iterBar[0].command = { command: "aiCodeGuide.traceIterStep", title: "前の周回", arguments: [{ delta: -1 }] };
    iterBar[2].text = "$(chevron-right)";
    iterBar[2].tooltip = "次の周回へ (Cmd+Alt+→)";
    iterBar[2].command = { command: "aiCodeGuide.traceIterStep", title: "次の周回", arguments: [{ delta: 1 }] };
    iterBar[1].tooltip = "実行トレースで表示中のループの周回";
    context.subscriptions.push(...iterBar);

    const refreshIterBar = () => {
        const editor = vscode.window.activeTextEditor;
        const cur = editor ? traceProvider.getLoopAtCursor(editor) : null;
        if (!cur) {
            for (const item of iterBar) item.hide();
            return;
        }
        // AI_NOTE: 他の項目に紛れないよう「トレース」を前置する(何の数字か単体で分かるように)。
        // 一括トレースでは複数関数が同時に出るため、どの関数のループかを関数名で示す。
        iterBar[1].text = `トレース ${cur.funcName}() ${cur.iter}周目/全${cur.max}周`;
        for (const item of iterBar) item.show();
    };
    context.subscriptions.push(
        traceProvider.onDidChangeTrace(() => {
            refreshIterBar();
            mainViewProvider.refreshTraceStatus();
        }),
        vscode.window.onDidChangeTextEditorSelection(refreshIterBar),
        vscode.window.onDidChangeActiveTextEditor(refreshIterBar),
    );

    // AI_NOTE: 関数1つ分のトレース取得(キャッシュ→入力例生成→実行→失敗なら1回だけ作り直し)。表示はしない。
    // 一括トレースと単発トレースで同じ経路を通すため、結果かスキップ理由のどちらかを必ず返す。
    type TraceRejected = {
        decision: Exclude<TraceSafetyDecision, "safe">;
        reason: string;
        guidance: string;
        startedAt: string;
        endedAt: string;
    };
    type TraceCommandAttempt = {
        funcName: string;
        arguments?: Record<string, unknown>;
        decision: TraceSafetyDecision;
        reason: string;
        guidance?: string;
        states: string[];
        startedAt: string;
        endedAt: string;
        runId?: string;
        returnValue?: { short: string; full: string } | null;
        exception?: string | null;
    };
    const traceOne = async (
        document: vscode.TextDocument,
        source: string,
        funcName: string,
        force: boolean,
        callArguments: Record<string, unknown> | undefined,
        onProgress: (message: string) => void,
    ): Promise<{ result: TraceResult } | { rejected: TraceRejected } | { skipped: string }> => {
        // AI_NOTE: 制限モードでは構造表示・図解は使えるが、対象ワークスペースのPythonだけは実行しない。
        if (!vscode.workspace.isTrusted) return { skipped: "ワークスペースが未信頼のため実行トレースは無効" };
        const cacheKey = traceCacheKey(document, source, funcName, callArguments);
        if (!force) {
            const hit = traceCache.get(cacheKey);
            if (hit) return { result: hit.result };
        }
        const startedAt = new Date().toISOString();
        onProgress("安全性と入力の具体例を確認中");
        const filePath = document.uri.scheme === "file" ? document.uri.fsPath : undefined;
        const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath;
        const dependencyContext = collectTraceDependencyContext(filePath, workspaceRoot, source);
        const example = await generateTraceExample(source, funcName, undefined, dependencyContext);
        if (!example) return { skipped: "入力例の生成に失敗" };
        const safety = classifyTraceSafety(source, funcName, example.safetyDecision);
        if (safety !== "safe") {
            const reason = example.sideEffectReason || (safety === "known-unsafe"
                ? "direct external side effect detected"
                : "dynamic target cannot be proven safe");
            return { rejected: {
                decision: safety,
                reason,
                guidance: safetyRetryGuidance(safety, funcName),
                startedAt,
                endedAt: new Date().toISOString(),
            } };
        }

        onProgress("実行して変数を記録中");
        // AI_NOTE: 対象ファイルの位置とワークスペースルートを渡し、通常実行と同じimport解決で走らせる。
        const paths = { file_path: filePath, workspace_root: workspaceRoot };
        const exactSetup = callArguments === undefined
            ? example.setup
            : `${example.setup}\nEXAMPLE_ARGS = ()\nEXAMPLE_KWARGS = __import__('json').loads(${JSON.stringify(JSON.stringify(callArguments))})`;
        let result = await runTrace(extensionPath, { source, func_name: funcName, setup: exactSetup, templates: example.templates, ...paths });
        let assertionFailure = result.assertions?.some((assertion) => !assertion.outcome) ?? false;
        if (result.error && (result.stage === "setup" || result.stage === "run") && !assertionFailure) {
            // AI_NOTE: 準備コード起因の失敗は1回だけLLMに作り直させる。それでも駄目なら諦めてエラー表示。
            onProgress("入力例を作り直して再実行中");
            const retry = callArguments === undefined ? await generateTraceExample(source, funcName, { setup: example.setup, error: result.error }, dependencyContext) : null;
            if (retry && classifyTraceSafety(source, funcName, retry.safetyDecision) === "safe") {
                result = await runTrace(extensionPath, { source, func_name: funcName, setup: retry.setup, templates: retry.templates, ...paths });
                assertionFailure = result.assertions?.some((assertion) => !assertion.outcome) ?? false;
            }
        }
        if (result.error && callArguments === undefined && !assertionFailure) return { skipped: result.error };
        result.run_id = randomUUID();
        result.executed_at = new Date().toISOString();
        if (callArguments !== undefined) result.input_arguments = callArguments;
        result.safety_decision = "safe";
        result.safety_reason = "Executed in a disposable workspace copy; writes outside it, network, and subprocess access were blocked.";
        result.state_events = ["entry/confirm", "processing", result.error ? "exception" : "success"];
        if (result.error) result.retry_guidance = "Keep this trace entry open, correct only the invalid arguments, confirm safety again, and retry.";
        traceCache.set(cacheKey, result);
        return { result };
    };

    const commandAttempt = (funcName: string, callArguments: Record<string, unknown> | undefined, outcome: Awaited<ReturnType<typeof traceOne>>): TraceCommandAttempt | null => {
        if ("skipped" in outcome) return null;
        if ("rejected" in outcome) return {
            funcName,
            ...(callArguments === undefined ? {} : { arguments: callArguments }),
            decision: outcome.rejected.decision,
            reason: outcome.rejected.reason,
            guidance: outcome.rejected.guidance,
            states: [outcome.rejected.decision === "known-unsafe" ? "confirmed_unsafe" : "safety_unknown", "rejected"],
            startedAt: outcome.rejected.startedAt,
            endedAt: outcome.rejected.endedAt,
        };
        return {
            funcName,
            ...(callArguments === undefined ? {} : { arguments: callArguments }),
            decision: "safe",
            reason: outcome.result.safety_reason ?? "Safe preflight passed.",
            ...(outcome.result.retry_guidance ? { guidance: outcome.result.retry_guidance } : {}),
            states: outcome.result.state_events ?? ["entry/confirm", "processing", outcome.result.error ? "exception" : "success"],
            startedAt: outcome.result.executed_at ?? new Date().toISOString(),
            endedAt: new Date().toISOString(),
            runId: outcome.result.run_id,
            returnValue: outcome.result.return_value,
            exception: outcome.result.error,
        };
    };

    // AI_NOTE: 一括トレース。関数ごとに独立して入力例生成→実行し、成功したものだけをまとめて表示する。
    // 1件の失敗で全体を止めない(スキップ理由は最後にまとめて通知)。同時実行数はLLMとpythonの負荷を見て3。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.traceFunctions", async (args?: {
            funcs?: string[];
            line?: number;
            force?: boolean;
            arguments?: Record<string, unknown>;
            uri?: string;
            background?: boolean;
        }) => {
            const explicitDocument = args?.uri
                ? await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri))
                : undefined;
            const editor = explicitDocument
                ? vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === explicitDocument.uri.toString())
                : vscode.window.activeTextEditor
                    ?? vscode.window.visibleTextEditors.find((item) => item.document.languageId === "python");
            const document = explicitDocument ?? editor?.document;
            if (!document || document.languageId !== "python") {
                if (!args?.background) vscode.window.showWarningMessage("AI Code Guide: Pythonファイルを開いてください。");
                return { funcNames: [], skipped: ["Pythonファイルが開かれていません"] };
            }
            const source = document.getText();
            let names: string[];
            if (args?.funcs !== undefined) names = args.funcs;
            else if (args?.line !== undefined) {
                const name = await funcAtLine(extensionPath, source, Math.max(0, args.line - 1));
                names = name ? [name] : [];
            } else names = (await listFunctions(extensionPath, source)).map((item) => item.name);
            if (names.length === 0) {
                if (!args?.background) vscode.window.showWarningMessage("AI Code Guide: トレースできる関数またはメソッドが見つかりません。");
                return { funcNames: [], skipped: ["トレースできる関数またはメソッドが見つかりません"] };
            }
            if (args?.arguments !== undefined && names.length !== 1) {
                return { funcNames: [], skipped: ["Exact arguments require one function"] };
            }
            const runAll = async (report: (message: string) => void) => {
                    const traces: { trace: TraceResult; funcName: string }[] = [];
                    const skipped: string[] = [];
                    const attempts: TraceCommandAttempt[] = [];
                    let done = 0;
                    // AI_NOTE: 常に CONCURRENCY 本走らせ、1件終わるたびに次を投入する(区切りごとの全完了待ちにしない)。
                    // 遅い1件が他を止めないため。値8は scripts/trace_concurrency_bench.js の実測から
                    // (3だと8関数で約2分・8以上なら約40〜50秒で「最も遅い1件の待ち時間」に張り付き、それ以上増やしても縮まない)。
                    const CONCURRENCY = 8;
                    let next = 0;
                    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, async () => {
                        while (next < names.length) {
                            const funcName = names[next++];
                            const outcome = await traceOne(document, source, funcName, args?.force ?? false, args?.arguments, () => {});
                            done++;
                            report(`${done}/${names.length} 完了`);
                            const attempt = commandAttempt(funcName, args?.arguments, outcome);
                            if (attempt) attempts.push(attempt);
                            if ("result" in outcome) traces.push({ trace: outcome.result, funcName });
                            else if ("skipped" in outcome) skipped.push(`${funcName}(${outcome.skipped})`);
                        }
                    }));
                    if (traces.length === 0 && attempts.length === 0) {
                        if (!args?.background) vscode.window.showErrorMessage(`AI Code Guide: すべての関数でトレースできませんでした — ${skipped.join(" / ")}`);
                        return { funcNames: [], skipped };
                    }
                    // AI_NOTE: 排他表示。注釈(SemanticAnnotation)の右余白と場所が競合するため隠す(解除でキャッシュ復元)。
                    if (traces.length > 0) {
                        if (args?.background || !editor) {
                            traceProvider.storeTraces(document, traces);
                        } else {
                            annotationProvider?.clearEditor(editor);
                            traceProvider.showTraces(editor, traces);
                        }
                        if (!args?.background) mainViewProvider.refreshTraceStatus();
                    }
                    if (skipped.length > 0 && !args?.background) {
                        vscode.window.showWarningMessage(`AI Code Guide: ${skipped.length}個の関数はトレースしませんでした — ${skipped.join(" / ")}`);
                    }
                    return { funcNames: traces.map((item) => item.funcName), skipped, attempts };
            };
            return args?.background
                ? runAll(() => {})
                : vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: `AI Code Guide: ${names.length}個の関数をトレース中…` },
                    (progress) => runAll((message) => progress.report({ message })),
                );
        })
    );

    // AI_NOTE: 外部AIの「保存済みトレースを表示」専用口。キャッシュミス時にtraceOneを呼ばないため、
    // 入力例生成もPython実行も起こらない。空配列は対象なしとして保持し、全関数へ広げない。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.showSavedTraces", async (args?: {
            funcs?: string[];
            line?: number;
            arguments?: Record<string, unknown>;
            uri?: string;
            background?: boolean;
        }) => {
            const explicitDocument = args?.uri
                ? await vscode.workspace.openTextDocument(vscode.Uri.parse(args.uri))
                : undefined;
            const editor = explicitDocument
                ? vscode.window.visibleTextEditors.find((item) => item.document.uri.toString() === explicitDocument.uri.toString())
                : vscode.window.activeTextEditor
                    ?? vscode.window.visibleTextEditors.find((item) => item.document.languageId === "python");
            const document = explicitDocument ?? editor?.document;
            if (!document || document.languageId !== "python") return { funcNames: [], missing: [] };
            const source = document.getText();
            let names: string[];
            if (args?.funcs !== undefined) {
                names = args.funcs;
            } else {
                const targetLine = args?.line !== undefined
                    ? Math.max(0, args.line - 1)
                    : editor?.selection.active.line ?? 0;
                const name = await funcAtLine(extensionPath, source, targetLine);
                names = name ? [name] : [];
            }
            const traces: { trace: TraceResult; funcName: string }[] = [];
            const missing: string[] = [];
            for (const funcName of [...new Set(names)]) {
                const hit = traceCache.get(traceCacheKey(document, source, funcName, args?.arguments));
                if (hit) traces.push({ trace: hit.result, funcName });
                else missing.push(funcName);
            }
            if (traces.length > 0) {
                if (args?.background || !editor) traceProvider.storeTraces(document, traces);
                else {
                    annotationProvider?.clearEditor(editor);
                    traceProvider.showTraces(editor, traces);
                }
                if (!args?.background) mainViewProvider.refreshTraceStatus();
            }
            return { funcNames: traces.map((item) => item.funcName), missing };
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.traceFunction", async (args?: { force?: boolean }) => {
            // AI_NOTE: サイドバーのボタンから呼ばれるとフォーカスがwebviewにあり activeTextEditor が空のことがある。
            // 表示中のPythonエディタへフォールバックする(カーソル位置=selectionは保持されている)。
            const editor = vscode.window.activeTextEditor
                ?? vscode.window.visibleTextEditors.find((e) => e.document.languageId === "python");
            if (!editor || editor.document.languageId !== "python") {
                vscode.window.showWarningMessage("AI Code Guide: Pythonファイルを開いてください。");
                return { funcNames: [], skipped: ["Pythonファイルが開かれていません"] };
            }
            const source = editor.document.getText();
            const funcName = await funcAtLine(extensionPath, source, editor.selection.active.line);
            if (!funcName) {
                vscode.window.showWarningMessage("AI Code Guide: カーソルをトレースしたい関数の中に置いてください。");
                return { funcNames: [], skipped: ["指定行に関数またはメソッドがありません"] };
            }
            return vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `AI Code Guide: ${funcName}() をトレース中…` },
                async (progress) => {
                    const outcome = await traceOne(editor.document, source, funcName, args?.force ?? false, undefined, (message) => progress.report({ message }));
                    if ("skipped" in outcome) {
                        vscode.window.showErrorMessage(`AI Code Guide: ${funcName}() をトレースできませんでした — ${outcome.skipped}`);
                        return { funcNames: [], skipped: [`${funcName}(${outcome.skipped})`] };
                    }
                    const attempt = commandAttempt(funcName, undefined, outcome);
                    if ("rejected" in outcome) {
                        vscode.window.showWarningMessage(`AI Code Guide: ${funcName}() は実行しません — ${outcome.rejected.decision}: ${outcome.rejected.reason}`);
                        return { funcNames: [], skipped: [], attempts: attempt ? [attempt] : [] };
                    }
                    // AI_NOTE: 排他表示。注釈(SemanticAnnotation)の右余白と場所が競合するため隠す(解除でキャッシュ復元)。
                    annotationProvider?.clearEditor(editor);
                    traceProvider.showTrace(editor, outcome.result, funcName);
                    mainViewProvider.refreshTraceStatus();
                    return { funcNames: [funcName], skipped: [], attempts: attempt ? [attempt] : [] };
                },
            );
        })
    );

    // AI_NOTE: トレース解除専用コマンド。サイドバーの「解説表示に戻る」から呼ぶ。clearBlockExplanations と違い、
    // トレースが出ていない時は注釈を消さず案内だけ出す(切替ボタンとして押しても解説が消えない安全側)。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.traceClear", () => {
            const editor = vscode.window.activeTextEditor
                ?? vscode.window.visibleTextEditors.find((e) => e.document.languageId === "python");
            if (!editor) return;
            if (!traceProvider.isActive(editor.document.uri.toString())) {
                vscode.window.showInformationMessage("AI Code Guide: 実行トレースは表示されていません。");
                return;
            }
            traceProvider.clear(editor);
            annotationProvider?.restoreFromCache(editor);
            mainViewProvider.refreshTraceStatus();
        })
    );

    // AI_NOTE: 周回セレクタ。キーバインド(Cmd+Alt+←/→)はカーソル位置の最内ループ、ホバーリンクはloopId指定で±1する。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.traceIterStep", (args?: { uri?: string; funcName?: string; loopId?: number; delta?: number }) => {
            const delta = (args?.delta ?? 1) >= 0 ? 1 : -1;
            if (args?.uri !== undefined && args?.funcName !== undefined && args?.loopId !== undefined) {
                traceProvider.stepIterationFor(args.uri, args.funcName, args.loopId, delta);
                return;
            }
            const editor = vscode.window.activeTextEditor;
            if (editor) traceProvider.stepIteration(editor, delta);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.traceIterSet", (args?: { uri?: string; funcName?: string; loopId?: number; iter?: number }) => {
            if (args?.uri !== undefined && args?.funcName !== undefined && args?.loopId !== undefined && args?.iter !== undefined) {
                traceProvider.setIteration(args.uri, args.funcName, args.loopId, args.iter);
            }
        })
    );

    // AI_NOTE: 重なった block 説明の前面/背面を切り替える。CodeLens から呼ばれ、LLM再生成はしない。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.toggleBlockLayer", (uri: string, groupId: string) => {
            annotationProvider?.toggleBlockLayer(uri, groupId);
        })
    );

    // AI_NOTE: 選択範囲を解説する。右クリックコンテキストメニューから呼ばれる
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.explainSelection", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== "python") {
                vscode.window.showWarningMessage("AI Code Guide: Pythonファイルを開いてください。");
                return { status: "empty", count: 0 } as const;
            }
            return await annotationProvider?.annotate(editor) ?? { status: "empty", count: 0 } as const;
        })
    );

    // AI_NOTE: 選択範囲をチャットに引用する。右クリックメニュー/ショートカットから呼ばれ、生コードは貼らず
    // 場所参照(file L行-行)チップとしてチャットへ載せる。選択が空/非Pythonならガイドして中断。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.quoteSelectionToChat", async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor || editor.document.languageId !== "python") {
                vscode.window.showWarningMessage("AI Code Guide: Pythonファイルを開いてください。");
                return;
            }
            if (editor.selection.isEmpty) {
                vscode.window.showInformationMessage("AI Code Guide: 引用する範囲を選択してください。");
                return;
            }
            const code = editor.document.getText(editor.selection);
            await mainViewProvider.quoteSelectionToChat(code, editor.selection.start.line + 1, editor.selection.end.line + 1);
        })
    );

    // AI_NOTE: #14 ⑤ ホバーの「💬 質問する」から呼ばれる。引用コード付きの新規チャットを開いてチャットタブへ切り替える。
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "aiCodeGuide.openAnnotationChat",
            (args: { codeSnippet?: string; explanation?: string }) => {
                mainViewProvider.openChatWithContext(args?.codeSnippet ?? "", args?.explanation ?? "").catch(console.error);
            }
        )
    );

    // AI_NOTE: chatLinks注釈のホバー「💬 会話へ」から呼ばれる。過去チャットをIDで開いてチャットタブへ切り替える(新規作成しない)。
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "aiCodeGuide.openChatById",
            (args: { sessionId?: string }) => {
                if (args?.sessionId) mainViewProvider.openChatById(args.sessionId).catch(console.error);
            }
        )
    );

    // AI_NOTE: ホバーのトリアージ行/注釈行CodeLensから呼ばれる。注釈の状態(読んだ/後で見る/解決済み/未読)を保存し再描画する。
    // status=null は未読へ戻す。LLM再生成はしない(id単位の状態更新と再フィルタのみ)。
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "aiCodeGuide.setAnnotationStatus",
            (args: { uri?: string; id?: string; status?: "read" | "later" | "resolved" | null }) => {
                if (args?.uri && args?.id) annotationProvider?.setAnnotationStatus(args.uri, args.id, args.status ?? null);
            }
        )
    );

    // AI_NOTE: symbol 状態CodeLensの「状態:○○」ラベル用の表示専用コマンド(押しても何もしない)。
    context.subscriptions.push(vscode.commands.registerCommand("aiCodeGuide.noop", () => { /* 表示専用 */ }));

    // AI_NOTE: ようこそガイド(Walkthrough)を開くコマンド。ヘルプタブ/コマンドパレットから呼ぶ。
    // id は <publisher>.<name>#<walkthroughId>。標準コマンドに委譲するだけ。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.openWalkthrough", () => {
            vscode.commands.executeCommand("workbench.action.openWalkthrough", "neoai-research.ai-code-guide#aiCodeGuideGettingStarted", false);
        })
    );

    // AI_NOTE: フル幅の使い方マニュアル(WebviewPanel)を開く。狭いサイドバーと別に、図・画像入りの読み物版を出す。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.openHelpPage", () => {
            openHelpPage(context.extensionPath);
        })
    );

    // AI_NOTE: 設計ファイル作成の依頼プロンプトをコピーするコマンド。範囲(このファイル/このディレクトリ/リポ全体)を
    // QuickPickで選ばせ、buildDesignPrompt()で組んだ自己完結プロンプトをクリップボードへ渡すだけ(生成自体は
    // 外部エージェントに委ねる設計のため、ここでは範囲決定とコピー導線のみ担う)。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.copyDesignPrompt", async () => {
            const editor = vscode.window.activeTextEditor;
            const items: Array<vscode.QuickPickItem & { scope: DesignScope }> = [];

            if (editor) {
                const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
                if (folder) {
                    const relFile = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join("/");
                    const relDir = path.relative(folder.uri.fsPath, path.dirname(editor.document.uri.fsPath)).split(path.sep).join("/");
                    items.push({ label: "このファイル", description: relFile, scope: { kind: "file", relPath: relFile } });
                    items.push({ label: "このディレクトリ", description: relDir || ".", scope: { kind: "directory", relPath: relDir } });
                }
            }
            items.push({ label: "リポジトリ全体", scope: { kind: "repo" } });

            const picked = await vscode.window.showQuickPick(items, {
                title: "AI Code Guide: 設計ファイル作成プロンプトをコピー",
                placeHolder: "依頼プロンプトの対象範囲を選んでください",
            });
            if (!picked) return;

            // AI_NOTE: 既存の設計mdがあれば更新モード(@confirmed維持ルール+既存md埋め込み)に切り替える。
            // 新規作成プロンプトで作り直すと開発者確認済みの@confirmedが全部捨てられるため。
            const root = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            const existingMd = root ? readExistingDesignMd(root, picked.scope) : null;
            await vscode.env.clipboard.writeText(buildDesignPrompt(picked.scope, existingMd ?? undefined));
            vscode.window.showInformationMessage(`AI Code Guide: 設計ファイル${existingMd ? "更新" : "作成"}プロンプトをコピーしました。Claude Code / codex に貼り付けてください。`);
        })
    );

    // AI_NOTE: 設計ファイル機能フェーズ1ステップ5。.ai-code-guide/design/配下のmd作成・変更・削除を監視し、
    // 表示中のタブ(概要/標準/プロジェクト)を再読込する。設計データはfsから都度読み直す実装のため、既存の
    // MainViewProvider.refreshDesignFiles()(HTML再描画のみ)を呼ぶだけでよい(新しい更新機構は発明しない)。
    // 保存時に create/change が連続発火しうるため数百msデバウンスする。
    const designWatcher = vscode.workspace.createFileSystemWatcher("**/.ai-code-guide/design/**/*.md");
    let designWatcherTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleDesignRefresh = () => {
        if (designWatcherTimer) clearTimeout(designWatcherTimer);
        designWatcherTimer = setTimeout(() => mainViewProvider.refreshDesignFiles(), 300);
    };
    designWatcher.onDidCreate(scheduleDesignRefresh);
    designWatcher.onDidChange(scheduleDesignRefresh);
    designWatcher.onDidDelete(scheduleDesignRefresh);
    context.subscriptions.push(designWatcher);

    // AI_NOTE: 初回インストール時だけ自動でようこそガイドを開く。globalStateにフラグを立てて二度目以降は出さない
    // (毎回開くと邪魔なので一度きり)。.vsix手渡し配布でMarketplaceの導線が無いため、初回の発見性をここで担保する。
    if (!context.globalState.get<boolean>("aiCodeGuide.walkthroughShown", false)) {
        context.globalState.update("aiCodeGuide.walkthroughShown", true);
        vscode.commands.executeCommand("aiCodeGuide.openWalkthrough");
    }

    // AI_NOTE: 編集時はクリアせず「増分再突合」する。各注釈は保持したアンカー文字列で新コード上の位置を
    // 取り直し、触っていない注釈は生かす(全消し→再生成の数十秒+課金を避ける)。アンカーが消えた注釈だけ落ちる。
    // 連打のたびに再描画すると重い/ちらつくので uri ごとに 150ms デバウンスして編集が落ち着いてから1回回す。
    const reanchorTimers = new Map<string, NodeJS.Timeout>();

    // AI_NOTE: 一括変更(AI生成/ペースト等)検知の蓄積状態。uriごとに検知済み行集合と2000ms静止タイマーを持つ。
    // 既存の150ms再アンカーとは別目的・別タイマーで共存させる(計画書の技術的決定事項)。
    const bulkEditAccum = new Map<string, Set<number>>();
    const bulkEditTimers = new Map<string, NodeJS.Timeout>();

    // AI_NOTE: 静止タイマー発火時の確定処理。蓄積を取り出してクリア→対象editorを探す→全文リロードなら
    // git差分で絞り直しを試みる→設定値(suggest/auto)で分岐してprovider(Step3実装予定)を呼ぶ。
    // off時はそもそもタイマーが張られない(呼び出し元で入口ガード済み)。
    async function resolveBulkEdit(uri: string): Promise<void> {
        const lines = bulkEditAccum.get(uri);
        bulkEditAccum.delete(uri);
        bulkEditTimers.delete(uri);
        if (!lines || lines.size === 0) return;

        const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uri);
        if (!editor) return;

        let targetLines = lines;
        const docLineCount = editor.document.lineCount;
        const isWholeDoc = docLineCount > 0 && lines.size / docLineCount >= 0.8;
        if (isWholeDoc) {
            // AI_NOTE: エージェントがディスク上で書き換え→VSCodeが全文置換として通知するケースへの対策。
            // git差分で絞り直せれば使い、失敗(git無し等)や差分空なら検知範囲をそのまま使う(例外は握りつぶさずログだけ出す)。
            try {
                const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
                const cwd = folder?.uri.fsPath ?? path.dirname(editor.document.uri.fsPath);
                const changed = await getChangedLines(editor.document.uri.fsPath, cwd);
                if (changed.size > 0) targetLines = changed;
            } catch (e) {
                console.warn(`AI Code Guide: 全文リロード検知時のgit差分取得に失敗、検知範囲をそのまま使用します。${e instanceof Error ? e.message : String(e)}`);
            }
        }

        const mode = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("autoAnnotateOnAiEdit", "suggest");
        if (mode === "auto") {
            await annotationProvider?.annotateSuggested(editor, targetLines);
        } else if (mode === "suggest") {
            annotationProvider?.showSuggestion(editor, targetLines);
        }
    }

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((e) => {
            // AI_NOTE: [レビュー] "全ドキュメント変更で毎回タイマー登録(出力パネル/設定/git も)" → python 以外は
            // そもそも注釈対象外なので入口で弾き、無駄なデバウンスタイマー登録を避ける。
            if (e.document.languageId !== "python") return;
            // AI_NOTE: URI 比較。debug 起動直後など editor.document と event.document が別インスタンスのことがある
            const uri = e.document.uri.toString();
            // AI_NOTE: トレースは実行時点のコード行に紐づくため編集追従(再アンカー)せず、編集されたら即消す。
            traceProvider.handleDocEdit(uri);
            const existing = reanchorTimers.get(uri);
            if (existing) clearTimeout(existing);
            reanchorTimers.set(uri, setTimeout(() => {
                reanchorTimers.delete(uri);
                const editor = vscode.window.visibleTextEditors.find(ed => ed.document.uri.toString() === uri);
                if (editor) annotationProvider?.reanchorEditor(editor);
            }, 150));

            // AI_NOTE: 一括変更検知。offなら入口でスキップしタイマーも張らない。
            const bulkMode = vscode.workspace.getConfiguration("aiCodeGuide").get<string>("autoAnnotateOnAiEdit", "suggest");
            if (bulkMode === "off") return;

            const bulkChanges: BulkChange[] = e.contentChanges.map(c => ({
                startLine: c.range.start.line,
                text: c.text,
                rangeLineSpan: c.range.end.line - c.range.start.line + 1,
            }));
            const result = accumulateBulkChange(bulkEditAccum.get(uri) ?? null, bulkChanges, e.document.lineCount);
            if (!result) return; // 一括変更なし・既存蓄積も無し → タイマーは張らない

            bulkEditAccum.set(uri, result.lines);
            const existingBulkTimer = bulkEditTimers.get(uri);
            if (existingBulkTimer) clearTimeout(existingBulkTimer);
            bulkEditTimers.set(uri, setTimeout(() => {
                resolveBulkEdit(uri).catch(err => console.warn(`AI Code Guide: 一括変更検知の確定処理に失敗しました。${err instanceof Error ? err.message : String(err)}`));
            }, 2000));
        })
    );

    // AI_NOTE: CodeLens「この範囲を解説する」から呼ばれる。行集合は extension 側の蓄積(発火時に削除済み)ではなく
    // provider の pendingSuggestion が持つため、uri だけ渡して provider 側で解決する(acceptSuggestion)。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.annotateDetectedEdit", async (args: { uri?: string }) => {
            if (args?.uri) await annotationProvider?.acceptSuggestion(args.uri);
        })
    );

    // AI_NOTE: CodeLens「閉じる」から呼ばれる。provider側は現状Step2スタブ(dismissSuggestion)。
    context.subscriptions.push(
        vscode.commands.registerCommand("aiCodeGuide.dismissDetectedEdit", (args: { uri?: string }) => {
            const uriStr = args?.uri;
            if (!uriStr) return;
            annotationProvider?.dismissSuggestion(uriStr);
        })
    );

    // AI_NOTE: #14 保存時のフローチャート更新はサイドバー(MainViewProvider)が自前の onDidSaveTextDocument で行う。
    // ここではインライン解説のみ扱う(編集時クリアの再生成は別経路)。

    // AI_NOTE: activate 後に Python エディタが確定したタイミングで一度だけ自動アノテーションを起動する。
    // ウィンドウ再利用時は activeTextEditor が undefined のまま onDidChangeActiveTextEditor も発火しないため
    // ポーリングで確定を待つ。
    {
        // AI_NOTE: ① 自動生成OFFでもキャッシュ復元は起動時に走らせたいので、ポーリング自体は常に回して中で分岐する。
        const autoAnnotateInit = vscode.workspace.getConfiguration("aiCodeGuide").get<boolean>("autoInlineAnnotations", false);
        let attempts = 0;
        const poll = () => {
            attempts++;
            const editor = vscode.window.activeTextEditor
                ?? vscode.window.visibleTextEditors.find(e => e.document.languageId === "python");
            if (editor && editor.document.languageId === "python") {
                if (autoAnnotateInit) annotationProvider?.annotateFile(editor);
                else annotationProvider?.restoreFromCache(editor);
            } else if (attempts < 20) {
                setTimeout(poll, 500);
            }
        };
        setTimeout(poll, 500);
    }
}

export function deactivate(): void {
    // nothing to clean up beyond disposables registered above
}
