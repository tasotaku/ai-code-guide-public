import * as fs from "fs";
import * as path from "path";

// AI_NOTE: 注釈のトリアージ状態を id 単位で永続化する。vscode 非依存にして単体テスト可能にする
// (resolver と同じ方針)。状態は安定 id(位置由来)に紐づくので、編集・再生成をまたいで保たれる。
// 未読は「保存しない(=mapに無い)」で表す。read/later/resolved/hidden だけ明示保存する。
// hidden=この注釈だけ手動で非表示。resolved(解決済み)とは独立した表示制御。
export type AnnotationStatus = "read" | "later" | "resolved" | "hidden";

export class AnnotationStatusStore {
    private map = new Map<string, AnnotationStatus>();
    private readonly diskPath: string;
    // AI_NOTE: [レビュー] "全ファイル分の状態が無限蓄積" → AnnotationCache(LRU200)と非対称だったので上限を設ける。
    // 状態は read/later/resolved の非クリティカル情報なので、超過時は挿入順で最古を捨てる(FIFO)。Map は挿入順を保つ。
    private static readonly MAX_ENTRIES = 5000;

    constructor(storageDir: string) {
        this.diskPath = path.join(storageDir, "annotation-status.json");
        this.load();
    }

    // AI_NOTE: ファイル間で同一アンカー行が衝突しないよう uri で名前空間を切る。id は位置由来なので
    // 別ファイルの同一コード行が同 id になり得るが、{uri}::{id} なら混ざらない。
    private key(uri: string, id: string): string {
        return `${uri}::${id}`;
    }

    private load(): void {
        try {
            const obj = JSON.parse(fs.readFileSync(this.diskPath, "utf8")) as Record<string, AnnotationStatus>;
            for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
        } catch {
            // ファイルなし・破損はサイレントに空スタート
        }
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.diskPath), { recursive: true });
            fs.writeFileSync(this.diskPath, JSON.stringify(Object.fromEntries(this.map)), "utf8");
        } catch {
            // 書き込み失敗はサイレントに無視(状態は次回に再設定可能)
        }
    }

    // AI_NOTE: 未保存(未読)は undefined。
    get(uri: string, id: string): AnnotationStatus | undefined {
        return this.map.get(this.key(uri, id));
    }

    // AI_NOTE: status=null/undefined は未読へ戻す(=削除)。それ以外は保存。どちらも即ディスク反映する。
    set(uri: string, id: string, status: AnnotationStatus | null): void {
        const k = this.key(uri, id);
        if (status) {
            // AI_NOTE: 既存キーは一旦消してから入れ直し「最近使った」を末尾に寄せる(FIFO eviction が最古を狙えるように)。
            this.map.delete(k);
            this.map.set(k, status);
            if (this.map.size > AnnotationStatusStore.MAX_ENTRIES) this.map.delete(this.map.keys().next().value!);
        } else {
            this.map.delete(k);
        }
        this.save();
    }
}
