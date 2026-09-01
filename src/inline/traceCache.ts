import * as fs from "fs";
import * as path from "path";
import { TraceResult } from "./traceRunner";

// AI_NOTE: 実行トレースの結果キャッシュ。semantic-annotations と同じ思想:
// キー = {valueFormat}::{uri}::{contentHash}::{funcName}::{argsHash}。
// コード編集または値表現の更新で自然に無効化される。
// 値はLLM入力例まで含んだ実行結果そのもの(TraceResult)なので、ヒット時はLLMも実行も不要で即表示できる。
export interface CachedTrace {
    result: TraceResult;
    savedAt: string;
}

const MAX_ENTRIES = 50;

export class TraceCache {
    private readonly filePath: string;
    private entries: Map<string, CachedTrace> | null = null;

    constructor(storageDir: string) {
        this.filePath = path.join(storageDir, "trace-cache.json");
    }

    // AI_NOTE: 遅延ロード。壊れたファイル・初回は空で開始(I/O境界の最小例外処理)。
    private load(): Map<string, CachedTrace> {
        if (this.entries) return this.entries;
        try {
            const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, CachedTrace>;
            this.entries = new Map(Object.entries(raw));
        } catch {
            this.entries = new Map();
        }
        return this.entries;
    }

    get(key: string): CachedTrace | null {
        const entries = this.load();
        const hit = entries.get(key);
        if (!hit) return null;
        // AI_NOTE: LRU: ヒットしたら末尾(最新)へ移動する。
        entries.delete(key);
        entries.set(key, hit);
        return hit;
    }

    set(key: string, result: TraceResult): void {
        const entries = this.load();
        entries.delete(key);
        entries.set(key, { result, savedAt: new Date().toISOString() });
        while (entries.size > MAX_ENTRIES) {
            const oldest = entries.keys().next().value;
            if (oldest === undefined) break;
            entries.delete(oldest);
        }
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            fs.writeFileSync(this.filePath, JSON.stringify(Object.fromEntries(entries)));
        } catch (e) {
            console.error("[AI Code Guide] trace cache save failed:", e);
        }
    }
}
