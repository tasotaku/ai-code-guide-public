import * as fs from "fs";
import * as path from "path";

// AI_NOTE: FNV-1a 32bit ハッシュ。コード内容(+文脈)をキーにして行番号・URI非依存のキャッシュを実現する。
// blockExplanationProvider と同じ方式に揃える（あちらは独自に持つ。本モジュールはフローチャート用）。
export function fnv1a(str: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16);
}

// AI_NOTE: フローチャートのLLM生成物(AI説明/概要グループ/分解)を内容ハッシュkeyで永続化する汎用KVキャッシュ。
// Dev Host を再起動しても残るため、いじっていない example は二度と推論されない（トークン節約）。
// 値は JSON シリアライズ可能なものに限る。LRU 上限で古いものから捨てる。
export class PersistentCache {
    private cache = new Map<string, unknown>();
    private readonly diskPath: string;
    // AI_NOTE: カード説明がノード単位キーになり1ファイルで数十エントリ使うため上限を引き上げる(各値は短文で軽い)。
    private static readonly MAX_ENTRIES = 3000;

    constructor(storageDir: string, fileName = "flowchart-cache.json") {
        this.diskPath = path.join(storageDir || "", fileName);
        this.load();
    }

    // AI_NOTE: 起動時に一度だけ読み込む。ファイルなし・破損はサイレントに空スタート
    private load(): void {
        try {
            const obj = JSON.parse(fs.readFileSync(this.diskPath, "utf8")) as Record<string, unknown>;
            for (const [k, v] of Object.entries(obj)) {
                this.cache.set(k, v);
            }
        } catch {
            // 何もしない（初回 or 破損）
        }
    }

    // AI_NOTE: set のたびに全量書き出す。件数が少ない前提でシンプルさを優先する
    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.diskPath), { recursive: true });
            const obj: Record<string, unknown> = {};
            for (const [k, v] of this.cache) {
                obj[k] = v;
            }
            fs.writeFileSync(this.diskPath, JSON.stringify(obj), "utf8");
        } catch {
            // ディスク書き込み失敗はサイレントに無視
        }
    }

    get<T>(key: string): T | undefined {
        const val = this.cache.get(key);
        if (val === undefined) {
            return undefined;
        }
        // LRU: 参照したら最後尾へ
        this.cache.delete(key);
        this.cache.set(key, val);
        return val as T;
    }

    set<T>(key: string, value: T): void {
        this.cache.delete(key);
        this.cache.set(key, value);
        if (this.cache.size > PersistentCache.MAX_ENTRIES) {
            this.cache.delete(this.cache.keys().next().value!);
        }
        this.save();
    }
}
