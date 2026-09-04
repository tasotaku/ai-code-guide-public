import Anthropic from "@anthropic-ai/sdk";
import * as vscode from "vscode";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCommand, separateClaudeConfigDir } from "../util/resolveCommand";
import { getSecretKey } from "./secretKeys";

// AI_NOTE: 3プロバイダ(Claude/GPT/Gemini)を1つの呼び出し口に集約するアダプタ。
// 呼び出し側は createMessage() だけを使い、レスポンスは常に Anthropic 形式
// {content:[{type:"text",text}], usage:{input_tokens,output_tokens}, model} に正規化して返す。
// これにより claudeClient.ts の各関数(content[0].text / usage を直接読む)を書き換えずに済む。

export type Provider = "anthropic" | "openai" | "gemini" | "cli" | "codex";
export const CODEX_SUBSCRIPTION_MODEL = "codex:gpt-5.6-sol";

export interface LlmMessage {
    role: "user" | "assistant";
    content: string;
}

// AI_NOTE: 統一 effort（思考の深さ）。プロバイダ差はここで1語に吸収し、各 call* が自社の機構へ写す。
// "low"=既定＝現状の挙動を一切変えない（全社で thinking を足さない）。medium/high の時だけ深く考えさせる。
export type LlmEffort = "low" | "medium" | "high";

export interface LlmParams {
    model: string;
    max_tokens: number;
    system?: string;
    messages: LlmMessage[];
    // AI_NOTE: 省略時は "low"（＝今まで通り速い）。チャットだけがこれを渡す。
    effort?: LlmEffort;
    // AI_NOTE: 中断用。fetch/SDKにそのまま渡し、CLI/codexは abort で子プロセスをkillする。省略時は中断不可(従来通り)。
    signal?: AbortSignal;
}

export interface LlmResponse {
    content: Array<{ type: "text"; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
    model: string;
}

// AI_NOTE: モデルID接頭辞でプロバイダを判定する。3スロット(構造/会話/インライン)で混在可能にするため、
// グローバルなプロバイダ設定は持たずモデル名だけで決める。未知の接頭辞は anthropic に倒す(既存挙動の維持)。
export function providerOf(model: string): Provider {
    // AI_NOTE: サブスクCLI系(cli=claude / codex=ChatGPT)は接頭辞で判定。他プロバイダ判定より先に見る。
    if (model.startsWith("codex:")) return "codex";
    if (model.startsWith("cli:")) return "cli";
    if (model.startsWith("gpt") || model.startsWith("o1") || model.startsWith("o3")) return "openai";
    if (model.startsWith("gemini")) return "gemini";
    return "anthropic";
}

// AI_NOTE: APIキーの正はSecretStorage(secretKeys.tsのメモリキャッシュ)。settingsフォールバックは
// (1) activate直後で移行が終わる前の一瞬 (2) VSCode外実行(annotations_smoke.jsの設定スタブ) のために残す。
export function getApiKey(provider: Provider): string {
    const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
    // AI_NOTE: cli/codex はAPIキーを持たない。代わりにCLIコマンド(パス)を「キー」として返し、未設定ガードを常に通す。
    // 既定値があるので空にならず、実際にCLIが無い場合は spawn のENOENTで検知する。
    if (provider === "cli") return cfg.get<string>("claudeCliPath", "claude") ?? "claude";
    if (provider === "codex") return cfg.get<string>("codexCliPath", "codex") ?? "codex";
    const settingName = provider === "openai" ? "openaiApiKey" : provider === "gemini" ? "geminiApiKey" : "anthropicApiKey";
    return getSecretKey(provider) || (cfg.get<string>(settingName, "") ?? "");
}

// AI_NOTE: サブスクトグル。ONなら下の effectiveModel が全モデルを cli:/codex: に振り替える。
function subscriptionEnabled(): boolean {
    return vscode.workspace.getConfiguration("aiCodeGuide").get<boolean>("useSubscription", true);
}

// AI_NOTE: サブスクON時にどのCLIで動かすか。claude=claude CLI / codex=ChatGPTのcodex CLI。
function subscriptionProvider(): "claude" | "codex" {
    return vscode.workspace.getConfiguration("aiCodeGuide").get<string>("subscriptionProvider", "codex") === "claude" ? "claude" : "codex";
}

// AI_NOTE: 実際に呼ぶモデル名を決める。サブスクONなら提供元で振り替える:
// claude→品質ティア(haiku/sonnet/opus)を名前から拾い cli:<tier>。
// codex→元の3スロットや古いcodex:default設定に関係なく、ChatGPTサブスクのGPT-5.6 Solへ固定する。
export function effectiveModel(model: string): string {
    if (subscriptionEnabled() && subscriptionProvider() === "codex") return CODEX_SUBSCRIPTION_MODEL;
    if (!subscriptionEnabled() || model.startsWith("cli:") || model.startsWith("codex:")) return model;
    const tier = /haiku/i.test(model) ? "haiku" : /opus/i.test(model) ? "opus" : "sonnet";
    return `cli:${tier}`;
}

// AI_NOTE: 「このモデルを呼ぶキーが設定済みか」。各関数の早期returnガードに使う(キー無しならAPIを呼ばず空を返す)。
// サブスクONなら cli に振り替わり常にキーあり扱いになる。
export function hasKeyForModel(model: string): boolean {
    return !!getApiKey(providerOf(effectiveModel(model)));
}

// AI_NOTE: ユーザー向け表記。プロバイダ名と編集すべき設定キーをメッセージに埋める。
const PROVIDER_LABEL: Record<Provider, string> = { anthropic: "Claude", openai: "GPT(OpenAI)", gemini: "Gemini", cli: "Claude CLI（サブスク）", codex: "Codex CLI（ChatGPTサブスク）" };
const KEY_SETTING: Record<Provider, string> = {
    anthropic: "aiCodeGuide.anthropicApiKey",
    openai: "aiCodeGuide.openaiApiKey",
    gemini: "aiCodeGuide.geminiApiKey",
    cli: "aiCodeGuide.claudeCliPath",
    codex: "aiCodeGuide.codexCliPath",
};

// AI_NOTE: エラー原因の分類。呼び出し側は message を表示するだけでよいよう、ここで日本語の対処文まで作る。
export type LlmErrorKind =
    | "missing_key" | "invalid_key" | "expired" | "quota" | "rate_limit" | "bad_request" | "server" | "network" | "unknown";

export class LlmError extends Error {
    constructor(readonly provider: Provider, readonly kind: LlmErrorKind, readonly status?: number, detail?: string) {
        super(buildMessage(provider, kind, status, detail));
        this.name = "LlmError";
    }
}

function buildMessage(provider: Provider, kind: LlmErrorKind, status?: number, detail?: string): string {
    const label = PROVIDER_LABEL[provider];
    const code = status ? `（HTTP ${status}）` : "";
    const tail = detail ? ` 詳細: ${detail.slice(0, 200)}` : "";
    switch (kind) {
        // AI_NOTE: キーはSecretStorage保存に移行したため、設定画面でなくコマンドへ誘導する(cli/codexはmissing_keyにならない)
        case "missing_key": return `${label} のAPIキーが未設定です。コマンドパレット（Cmd+Shift+P）から「AI Code Guide: APIキーを設定」で入力してください。`;
        case "invalid_key": return `${label} のAPIキーが無効です${code}。キーが正しいか（コピーミス・別プロバイダのキー混在がないか）確認してください。${tail}`;
        case "expired": return `${label} のAPIキーが失効/無効化されています${code}。新しいキーを発行して設定し直してください。${tail}`;
        case "quota": return `${label} の利用枠/クレジットが不足しています${code}。プランの残高・支払い設定を確認してください。${tail}`;
        case "rate_limit": return `${label} のレート制限に達しました${code}。少し待ってから再実行してください。${tail}`;
        case "bad_request": return `${label} へのリクエストが不正です${code}。モデル名が正しいか確認してください。${tail}`;
        case "server": return `${label} 側で一時的なエラーが発生しています${code}。時間をおいて再実行してください。${tail}`;
        case "network": return `${label} に接続できませんでした。ネットワーク接続を確認してください。${tail}`;
        default: return `${label} の呼び出しに失敗しました${code}。${tail}`;
    }
}

// AI_NOTE: HTTPステータスと本文から原因を分類する。プロバイダごとに「無効キー」の返し方が違うため本文も見る。
// 例: Gemini は無効キーを 400「API key not valid」で返す。失効は本文の "expired" で判別する。
function classify(status: number, body: string): LlmErrorKind {
    const b = body.toLowerCase();
    if (status === 401 || status === 403) return b.includes("expired") ? "expired" : "invalid_key";
    if (status === 429) return b.includes("quota") || b.includes("insufficient") ? "quota" : "rate_limit";
    if (status === 400) {
        if (b.includes("api key") || b.includes("api_key")) return b.includes("expired") ? "expired" : "invalid_key";
        return "bad_request";
    }
    if (status === 404) return "bad_request";
    if (status >= 500) return "server";
    return "unknown";
}

// シングルトン。設定変更で別キーになったら作り直すため getAnthropic() 経由で取る
let anthropicClient: Anthropic | null = null;
let cachedAnthropicKey = "";

function getAnthropic(apiKey: string): Anthropic {
    if (anthropicClient && cachedAnthropicKey === apiKey) return anthropicClient;
    anthropicClient = new Anthropic({ apiKey });
    cachedAnthropicKey = apiKey;
    return anthropicClient;
}

// AI_NOTE: 統一 effort → 各社の値へのマップ。低いほど速い。low は各社「思考を足さない/最小」に対応。
// CLI(Claude)は MAX_THINKING_TOKENS のトークン数、codex/openai は reasoning_effort の段階名。
const CLI_THINKING_TOKENS: Record<LlmEffort, number> = { low: 0, medium: 8000, high: 24000 };
const REASONING_EFFORT: Record<LlmEffort, string> = { low: "low", medium: "medium", high: "high" };

// AI_NOTE: fetch自体の失敗(DNS/オフライン等)は network として投げ直す。HTTPエラーは呼び出し側で分類する。
async function postJson(provider: Provider, url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<Response> {
    try {
        return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
        throw new LlmError(provider, "network", undefined, e instanceof Error ? e.message : String(e));
    }
}

// AI_NOTE: OpenAI Chat Completions を fetch で直叩きし、Anthropic形式へ正規化する。
// system は messages 先頭の system ロールに変換。max_completion_tokens は新系統(gpt-5/o系)互換のため採用。
async function callOpenai(params: LlmParams, apiKey: string): Promise<LlmResponse> {
    const messages = [
        ...(params.system ? [{ role: "system", content: params.system }] : []),
        ...params.messages,
    ];
    // AI_NOTE: effort=medium/high の時だけ reasoning_effort を足す。推論モデル(gpt-5/o系)のみ対応で、非推論モデルに付けると 400。
    // low(既定)は従来通り何も足さない。
    const effort = params.effort ?? "low";
    const reasoningModel = /^(gpt-5|o1|o3|o4)/.test(params.model);
    const body: Record<string, unknown> = { model: params.model, messages, max_completion_tokens: params.max_tokens };
    if (effort !== "low" && reasoningModel) body.reasoning_effort = REASONING_EFFORT[effort];
    const res = await postJson("openai", "https://api.openai.com/v1/chat/completions",
        { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body, params.signal);
    if (!res.ok) {
        const body = await res.text();
        throw new LlmError("openai", classify(res.status, body), res.status, body);
    }
    const data = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = data.choices?.[0]?.message?.content ?? "";
    return {
        content: [{ type: "text", text }],
        usage: { input_tokens: data.usage?.prompt_tokens ?? 0, output_tokens: data.usage?.completion_tokens ?? 0 },
        model: data.model ?? params.model,
    };
}

// AI_NOTE: Gemini generateContent を fetch で直叩きし、Anthropic形式へ正規化する。
// ロールは assistant→model に変換、system は systemInstruction に入れる。トークン数は usageMetadata から取る。
async function callGemini(params: LlmParams, apiKey: string): Promise<LlmResponse> {
    // AI_NOTE: キーは URL クエリでなく x-goog-api-key ヘッダで渡す。クエリだと URL がエラーログ/プロキシ/例外文に
    // 乗って漏れやすいため。model はパスに入るので encodeURIComponent で安全化する。
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(params.model)}:generateContent`;
    // AI_NOTE: 思考量の指定は世代で別パラメータ。3系は thinkingLevel(low/medium/high)、2.5系は旧 thinkingBudget。
    // 両方を同時に送ると 400 になるためどちらか一方だけ入れる。3系は既定が high(=遅い・高コスト)なので
    // low のときも明示的に low を送る。2.5系の low は従来どおり何も足さない（モデル既定に委ねる）。
    const effort = params.effort ?? "low";
    const gemini3 = /^gemini-3/.test(params.model);
    const gemini25 = /2\.5/.test(params.model);
    const generationConfig: Record<string, unknown> = { maxOutputTokens: params.max_tokens };
    if (gemini3) generationConfig.thinkingLevel = effort;
    if (effort === "medium" && gemini25) generationConfig.thinkingConfig = { thinkingBudget: -1 };
    if (effort === "high" && gemini25) generationConfig.thinkingConfig = { thinkingBudget: 24000 };
    const body = {
        ...(params.system ? { systemInstruction: { parts: [{ text: params.system }] } } : {}),
        contents: params.messages.map((m) => ({
            role: m.role === "assistant" ? "model" : "user",
            parts: [{ text: m.content }],
        })),
        generationConfig,
    };
    const res = await postJson("gemini", url, { "Content-Type": "application/json", "x-goog-api-key": apiKey }, body, params.signal);
    if (!res.ok) {
        const errBody = await res.text();
        throw new LlmError("gemini", classify(res.status, errBody), res.status, errBody);
    }
    const data = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    return {
        content: [{ type: "text", text }],
        usage: {
            input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
            output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
        },
        model: params.model,
    };
}

// AI_NOTE: Anthropic は既存SDKを使う。SDKは APIError(.status) を投げるので status から同じ分類器で原因を判定する。
async function callAnthropic(params: LlmParams, apiKey: string): Promise<LlmResponse> {
    try {
        // AI_NOTE: effort=low は現状通り（thinking無し）。medium/high の時だけ adaptive思考+output_config.effort を足す。
        // effort非対応モデル（Haiku4.5 / Sonnet4.5）には付けない（付けると 400）。旧SDK型に無いフィールドは Object.assign で載せる（bodyはそのまま送られる）。
        const create: Anthropic.MessageCreateParamsNonStreaming = {
            model: params.model,
            max_tokens: params.max_tokens,
            system: params.system,
            messages: params.messages,
        };
        const effort = params.effort ?? "low";
        const capable = !/haiku/i.test(params.model) && !/sonnet-4-5/i.test(params.model);
        if (effort !== "low" && capable) {
            Object.assign(create, { thinking: { type: "adaptive" }, output_config: { effort } });
        }
        // AI_NOTE: signal 経由の中断は APIUserAbortError で reject する。下の catch は status 無しを network に倒すが、
        // 実際の中断判定は呼び出し側(mainViewProvider)が signal.aborted で行うのでここでの kind は問わない。
        const message = await getAnthropic(apiKey).messages.create(create, { signal: params.signal });
        const text = message.content[0]?.type === "text" ? message.content[0].text : "";
        return {
            content: [{ type: "text", text }],
            usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
            model: message.model,
        };
    } catch (e) {
        if (e instanceof Anthropic.APIError && typeof e.status === "number") {
            throw new LlmError("anthropic", classify(e.status, e.message), e.status, e.message);
        }
        throw new LlmError("anthropic", "network", undefined, e instanceof Error ? e.message : String(e));
    }
}

// AI_NOTE: claude CLI を子プロセスで起動し stdout(JSON文字列)を集める。
// プロンプトは argv 長制限を避けるため stdin で渡す。spawn失敗(ENOENT=CLI無し)と非0終了は LlmError に変換する。
function runCli(command: string, args: string[], stdin: string, thinkingTokens: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
        // AI_NOTE: MAX_THINKING_TOKENS で thinking 量を制御。既定(effort=low)=0 で無効化＝従来通り高速。
        // Claude Code CLIは既定で adaptive thinking がONで判断系プロンプトが5〜6倍遅くなるため、構造抽出は0のまま。
        // チャットで effort を上げた時だけ呼び出し側が正の値を渡し、深く考えさせる。
        const env: NodeJS.ProcessEnv = { ...process.env, MAX_THINKING_TOKENS: String(thinkingTokens) };
        // AI_NOTE: 別アカウント設定がONなら CLAUDE_CONFIG_DIR を専用dirに向け、この子プロセスだけ別ログインで動かす。
        // env はプロセス内限定なのでターミナルや他拡張のclaudeには波及しない。OFFなら既定ログイン(キーチェーン)のまま。
        if (vscode.workspace.getConfiguration("aiCodeGuide").get<boolean>("useSeparateClaudeLogin", false)) {
            env.CLAUDE_CONFIG_DIR = separateClaudeConfigDir();
        }
        const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], env });
        // AI_NOTE: 中断。CLIはcloseが生成完了まで来ない/SIGTERMで即死しない事があるため、abort時はcloseを待たず
        // 即reject（UIを即停止）。killはベストエフォート（残ってもUIは止まる）。SIGTERM→効かない実装のためSIGKILLも打つ。
        const onAbort = () => {
            try { child.kill(); child.kill("SIGKILL"); } catch { /* 既に終了/kill不可は無視 */ }
            reject(new LlmError("cli", "network", undefined, "中止されました"));
        };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }
        child.stdin.on("error", () => { /* kill後のEPIPE等は無視 */ });
        let out = "";
        let err = "";
        // AI_NOTE: setEncoding("utf8") でストリーム側にマルチバイト境界を吸収させる。これが無いと Buffer を
        // チャンクごとに文字列連結することになり、日本語/絵文字が data イベントの境界で分割されて文字化けする。
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => {
            const notFound = (e as NodeJS.ErrnoException).code === "ENOENT";
            const detail = notFound
                ? `CLI '${command}' が見つかりません。設定 ${KEY_SETTING.cli} に claude の絶対パスを指定してください。`
                : e.message;
            reject(new LlmError("cli", "network", undefined, detail));
        });
        // AI_NOTE: claude CLI は api エラー時 exit≠0 でも stdout に {is_error,api_error_status,result} の
        // JSON を出す。stdout があれば握り潰さず callCli へ渡し、そこで原因分類させる（週次上限を
        // server="一時エラー、時間をおいて"に誤分類しないため）。stdout が空の時だけ stderr を載せて落とす。
        child.on("close", (code) =>
            code === 0 || out.trim()
                ? resolve(out)
                : reject(new LlmError("cli", "server", code ?? undefined, err.slice(0, 300) || `exit ${code}`)),
        );
        child.stdin.end(stdin);
    });
}

// AI_NOTE: サブスク認証のClaude Code CLIを呼ぶ第4プロバイダ。APIキーではなくCLIのログイン状態で動く。
// model名 "cli:haiku" の ":" 以降をモデルヒントとして --model に渡す(空/"claude"/"default" は既定モデル)。
// system は --append-system-prompt、本文は stdin。--output-format json の .result を本文、.usage をトークンとして正規化する。
async function callCli(params: LlmParams, command: string): Promise<LlmResponse> {
    // AI_NOTE: 配布先のDock起動でPATHが細くても claude を見つけられるよう実体を解決してから起動する。
    // 設定 claudeCliPath が絶対パスならそれを尊重、未設定(既定"claude")なら既知の場所/ログインシェルで探す。
    command = resolveCommand(command, "claude");
    const modelHint = params.model.slice("cli:".length);
    const args = ["-p", "--output-format", "json"];
    if (modelHint && modelHint !== "claude" && modelHint !== "default") args.push("--model", modelHint);
    if (params.system) args.push("--append-system-prompt", params.system);

    // AI_NOTE: 単発呼びは1メッセージなのでそのまま。chat履歴(複数)は CLI が単発入力なので role見出しで1本に平坦化する。
    const prompt =
        params.messages.length === 1
            ? params.messages[0].content
            : params.messages.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n\n");

    const raw = await runCli(command, args, prompt, CLI_THINKING_TOKENS[params.effort ?? "low"], params.signal);

    // AI_NOTE: CLIのJSONは {result, is_error, subtype, api_error_status, usage} 形式。
    // パース不能やis_errorは握りつぶさずLlmErrorで上げ、呼び出し側に原因を見せる。
    let data: { result?: string; is_error?: boolean; subtype?: string; api_error_status?: number; usage?: { input_tokens?: number; output_tokens?: number } };
    try {
        data = JSON.parse(raw);
    } catch {
        throw new LlmError("cli", "unknown", undefined, `JSON parse失敗: ${raw.slice(0, 200)}`);
    }
    // AI_NOTE: is_error 時は HTTP 由来の api_error_status を classify に通して quota/rate_limit を出し分ける。
    // 週次上限(429)を一律 server="一時的なエラー、時間をおいて"にすると数日復帰しないのに誤誘導するため。
    // detail には result(週次上限の人間向け文言"You've hit your weekly limit…"等)を載せて捨てない。
    if (data.is_error) {
        const detail = data.result ?? data.subtype ?? "cli error";
        const kind = data.api_error_status ? classify(data.api_error_status, detail) : "server";
        throw new LlmError("cli", kind, data.api_error_status, detail);
    }
    return {
        content: [{ type: "text", text: data.result ?? "" }],
        usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 },
        model: params.model,
    };
}

// AI_NOTE: codex を起動して終了を待つ。最終回答は --output-last-message のファイルに出るので stdout は捨て、
// stderr だけ拾ってエラー文に使う。ENOENT(CLI無し)と非0終了は LlmError に変換する。
// Windowsのnpm global binは codex.cmd / codex.bat になり得る。Nodeのspawnはこれらを
// executableとして直接起動すると EINVAL になるため、その2拡張子だけOS shellへ委ねる。
// .exeやmacOS/Linuxの実体は従来どおりshellを介さず起動する。
export function needsWindowsCommandShell(command: string, platform = process.platform): boolean {
    return platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
}

function runCodex(command: string, args: string[], stdin: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const useCommandShell = needsWindowsCommandShell(command);
        const executable = useCommandShell ? (process.env.ComSpec || "cmd.exe") : command;
        const childArgs = useCommandShell ? ["/d", "/s", "/c", command, ...args] : args;
        const child = spawn(executable, childArgs, { stdio: ["pipe", "ignore", "pipe"] });
        // AI_NOTE: 中断。runCli と同じくcloseを待たず即reject（UI即停止）。killはベストエフォート（SIGTERM+SIGKILL）。
        const onAbort = () => {
            try { child.kill(); child.kill("SIGKILL"); } catch { /* 既に終了は無視 */ }
            reject(new LlmError("codex", "network", undefined, "中止されました"));
        };
        if (signal) {
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
        }
        child.stdin.on("error", () => { /* kill後のEPIPE等は無視 */ });
        let err = "";
        // AI_NOTE: stdout と同じく境界吸収のため utf8 指定。codex の stderr はエラー文(日本語含みうる)に使う。
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (d) => (err += d));
        child.on("error", (e) => {
            const notFound = (e as NodeJS.ErrnoException).code === "ENOENT";
            const detail = notFound
                ? `CLI '${command}' が見つかりません。設定 ${KEY_SETTING.codex} に codex の絶対パスを指定してください。`
                : e.message;
            reject(new LlmError("codex", "network", undefined, detail));
        });
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new LlmError("codex", "server", code ?? undefined, err.slice(0, 300) || `exit ${code}`)),
        );
        child.stdin.end(stdin);
    });
}

// AI_NOTE: codex(ChatGPTサブスク)を叩く第二のサブスクプロバイダ。codex は最終回答を -o のファイルに書くので
// それを読んで本文にする。--ignore-user-config でユーザーのcodexフック/設定を切り、--skip-git-repo-check と
// -C tmpdir でユーザーのワークスペースを触らせない。usage はサブスク(非課金)のため 0 で返す。
// model名 "codex:gpt-5" の ":" 以降を --model に渡す(空/"codex"/"default" は codex 既定モデル)。
async function callCodex(params: LlmParams, command: string): Promise<LlmResponse> {
    command = resolveCommand(command, "codex");
    const outFile = path.join(os.tmpdir(), `acg-codex-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    // AI_NOTE: model_reasoning_effort で推論の深さを制御。既定(effort=low)は low で高速（構造抽出は深い推論不要）。
    // チャットで effort を上げた時だけ medium/high を渡して深く考えさせる（claudeの MAX_THINKING_TOKENS と同趣旨）。
    const reasoning = REASONING_EFFORT[params.effort ?? "low"];
    const args = ["exec", "--ignore-user-config", "--skip-git-repo-check", "-c", `model_reasoning_effort=${reasoning}`, "-C", os.tmpdir(), "-o", outFile];
    const modelHint = params.model.slice("codex:".length);
    if (modelHint && modelHint !== "codex" && modelHint !== "default") args.push("--model", modelHint);
    args.push("-"); // プロンプトは stdin から

    const body =
        params.messages.length === 1
            ? params.messages[0].content
            : params.messages.map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${m.content}`).join("\n\n");
    const prompt = params.system ? `${params.system}\n\n${body}` : body;

    try {
        await runCodex(command, args, prompt, params.signal);
        const text = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8").trim() : "";
        return { content: [{ type: "text", text }], usage: { input_tokens: 0, output_tokens: 0 }, model: params.model };
    } finally {
        // AI_NOTE: 一時ファイルの後始末。失敗してもベストエフォートで無視(残骸はOSのtmp掃除に任せる)。
        try {
            fs.unlinkSync(outFile);
        } catch {
            /* best-effort cleanup */
        }
    }
}

// AI_NOTE: キー未設定なら原因が分かるメッセージを返す。早期returnする呼び出し側で「なぜ生成されないか」を伝えるのに使う。
export function getKeyMissingReason(model: string): string | null {
    const provider = providerOf(effectiveModel(model));
    return getApiKey(provider) ? null : buildMessage(provider, "missing_key");
}

// AI_NOTE: 統一エントリ。モデル名でプロバイダを選び、キー未設定なら分類付きで投げる(I/O境界の最小例外)。
export async function createMessage(params: LlmParams): Promise<LlmResponse> {
    // AI_NOTE: サブスクONなら model を cli: に振り替えてから provider を決める。callCli は params.model を見るので差し替えて渡す。
    const model = effectiveModel(params.model);
    if (model !== params.model) params = { ...params, model };
    const provider = providerOf(model);
    const apiKey = getApiKey(provider);
    if (!apiKey) throw new LlmError(provider, "missing_key");

    if (provider === "openai") return callOpenai(params, apiKey);
    if (provider === "gemini") return callGemini(params, apiKey);
    // AI_NOTE: cli/codex は apiKey にCLIコマンド(パス)が入っている。それを spawn 先のコマンドとして渡す。
    if (provider === "cli") return callCli(params, apiKey);
    if (provider === "codex") return callCodex(params, apiKey);
    return callAnthropic(params, apiKey);
}
