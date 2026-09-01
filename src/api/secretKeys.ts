import * as vscode from "vscode";

// AI_NOTE: APIキーの保存先を settings.json(平文・Settings Syncでクラウドに載る) から
// SecretStorage(OSキーチェーン相当・Sync対象外) へ移すモジュール。
// secrets.get は非同期だが llmProvider.getApiKey は同期前提のため、activate 時に
// 全キーをメモリキャッシュへ読み込み、以降の参照は同期の getSecretKey で返す。

export type ApiProvider = "anthropic" | "openai" | "gemini";
export const API_PROVIDERS: ApiProvider[] = ["anthropic", "openai", "gemini"];

export const PROVIDER_DISPLAY: Record<ApiProvider, string> = {
    anthropic: "Anthropic (Claude)",
    openai: "OpenAI (GPT)",
    gemini: "Google (Gemini)",
};

// AI_NOTE: SecretStorage のキー名は旧設定IDと同じにして対応関係を追いやすくする
const SETTING_NAME: Record<ApiProvider, string> = {
    anthropic: "anthropicApiKey",
    openai: "openaiApiKey",
    gemini: "geminiApiKey",
};

export function settingToProvider(name: string): ApiProvider | undefined {
    return API_PROVIDERS.find((p) => SETTING_NAME[p] === name);
}

const cache = new Map<ApiProvider, string>();
let storage: vscode.SecretStorage | undefined;

export function getSecretKey(provider: ApiProvider): string {
    return cache.get(provider) ?? "";
}

// AI_NOTE: 空文字は「削除」。キャッシュも同時に更新して以降の同期参照へ即反映する
export async function setSecretKey(provider: ApiProvider, value: string): Promise<void> {
    if (!storage) throw new Error("secretKeys not initialized");
    const id = `aiCodeGuide.${SETTING_NAME[provider]}`;
    if (value) await storage.store(id, value);
    else await storage.delete(id);
    cache.set(provider, value);
}

export async function initSecretKeys(context: vscode.ExtensionContext): Promise<void> {
    storage = context.secrets;
    const cfg = vscode.workspace.getConfiguration("aiCodeGuide");
    for (const provider of API_PROVIDERS) {
        const name = SETTING_NAME[provider];
        const id = `aiCodeGuide.${name}`;
        // AI_NOTE: 旧settingsからの移行。平文キーが残っていたら SecretStorage へ移し、settings側は
        // 全スコープ削除する（消さないと平文が残り移行の意味がない）。移行後は常に空なので素通り。
        // workspace値をglobal値より優先するのは、両方あるとき実際に効いていたのがworkspace側のため。
        const insp = cfg.inspect<string>(name);
        const fromSettings = insp?.workspaceValue || insp?.globalValue || "";
        if (fromSettings) {
            await storage.store(id, fromSettings);
            if (insp?.globalValue !== undefined) await cfg.update(name, undefined, vscode.ConfigurationTarget.Global);
            if (insp?.workspaceValue !== undefined) await cfg.update(name, undefined, vscode.ConfigurationTarget.Workspace);
        }
        cache.set(provider, (await storage.get(id)) ?? "");
    }
}
