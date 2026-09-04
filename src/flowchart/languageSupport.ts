export const SUPPORTED_LANGUAGE_IDS = [
    "python",
    "javascript",
    "javascriptreact",
    "typescript",
    "typescriptreact",
] as const;

export type SupportedLanguageId = typeof SUPPORTED_LANGUAGE_IDS[number];

export interface LanguageProfile {
    id: SupportedLanguageId;
    family: "python" | "javascript";
    displayName: string;
    codeFence: string;
    extensions: readonly string[];
    canTrace: boolean;
}

const PROFILES: Record<SupportedLanguageId, LanguageProfile> = {
    python: { id: "python", family: "python", displayName: "Python", codeFence: "python", extensions: [".py"], canTrace: true },
    javascript: { id: "javascript", family: "javascript", displayName: "JavaScript", codeFence: "javascript", extensions: [".js", ".mjs", ".cjs"], canTrace: false },
    javascriptreact: { id: "javascriptreact", family: "javascript", displayName: "JavaScript (JSX)", codeFence: "jsx", extensions: [".jsx"], canTrace: false },
    typescript: { id: "typescript", family: "javascript", displayName: "TypeScript", codeFence: "typescript", extensions: [".ts", ".mts", ".cts"], canTrace: false },
    typescriptreact: { id: "typescriptreact", family: "javascript", displayName: "TypeScript (TSX)", codeFence: "tsx", extensions: [".tsx"], canTrace: false },
};

const EXTENSION_TO_LANGUAGE = new Map<string, SupportedLanguageId>();
for (const profile of Object.values(PROFILES)) {
    for (const extension of profile.extensions) EXTENSION_TO_LANGUAGE.set(extension, profile.id);
}

// AI_NOTE: 言語固有の条件分岐をUI・MCP・LLMへ散らさず、このレジストリを唯一の対応言語判定にする。
// 新しい言語は解析アダプターとここを追加すれば、共通表示へ自動的に参加できる。
export function languageProfile(languageId: string | undefined): LanguageProfile | undefined {
    return languageId ? PROFILES[languageId as SupportedLanguageId] : undefined;
}

export function isSupportedLanguage(languageId: string | undefined): languageId is SupportedLanguageId {
    return languageProfile(languageId) !== undefined;
}

export function languageIdForPath(filePath: string): SupportedLanguageId | undefined {
    const match = /(?:^|\/)([^/]+)$/.exec(filePath.replace(/\\/g, "/"));
    const fileName = match?.[1] ?? filePath;
    const dot = fileName.lastIndexOf(".");
    return dot >= 0 ? EXTENSION_TO_LANGUAGE.get(fileName.slice(dot).toLowerCase()) : undefined;
}
