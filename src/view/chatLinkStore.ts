import * as fs from "fs";
import * as path from "path";
import { SemanticAnnotation } from "../api/annotationResolver";

// AI_NOTE: チャット引用から生まれた「注釈→過去チャット」リンクの独立永続レイヤー。
// LLM注釈(contentHashキャッシュ・再生成可・再オープンで復元されない)とは寿命が別＝人間の会話は作り直せないので、
// URI＋アンカー由来IDで別ファイルに永続する。描画時に reanchorAnnotations で現在座標へ取り直す想定。
export interface ChatLink {
    // AI_NOTE: 生成時の確定注釈(kind/anchorText/anchorEndText/id/label/座標ヒント)。座標は編集でズレるが
    // anchorText と id は「どのコードか」を保つ。描画側が reanchor で座標だけ取り直す。
    annotation: SemanticAnnotation;
    // AI_NOTE: この箇所について質問した過去チャットのセッションID群。同じ箇所へ再質問すると追記されて溜まる(上書きしない)。
    sessionIds: string[];
}

// AI_NOTE: globalStorage/chat-links.json に uri→ChatLink[] で保持する。件数はファイル単位で上限を設け暴走を防ぐ。
export class ChatLinkStore {
    private byUri: Record<string, ChatLink[]> = {};
    private readonly diskPath: string;
    private static readonly MAX_PER_URI = 200;

    constructor(storageDir: string) {
        this.diskPath = path.join(storageDir || "", "chat-links.json");
        this.load();
    }

    private load(): void {
        try {
            this.byUri = JSON.parse(fs.readFileSync(this.diskPath, "utf8")) as Record<string, ChatLink[]>;
        } catch {
            this.byUri = {};
        }
    }

    save(): void {
        try {
            fs.mkdirSync(path.dirname(this.diskPath), { recursive: true });
            fs.writeFileSync(this.diskPath, JSON.stringify(this.byUri), "utf8");
        } catch {
            // 書き込み失敗はサイレント(chatStore と同方針)
        }
    }

    // AI_NOTE: 追記方式の肝。同じ場所(annotation.id 一致)に既存リンクがあれば sessionId を push(重複は弾く)。
    // 無ければ新規。上書きしないので、同一箇所への複数会話がリンクとして溜まる。
    add(uri: string, annotation: SemanticAnnotation, sessionId: string): void {
        const list = this.byUri[uri] ?? (this.byUri[uri] = []);
        const existing = list.find((l) => l.annotation.id === annotation.id);
        if (existing) {
            if (!existing.sessionIds.includes(sessionId)) existing.sessionIds.push(sessionId);
        } else {
            list.push({ annotation, sessionIds: [sessionId] });
            if (list.length > ChatLinkStore.MAX_PER_URI) list.shift();
        }
        this.save();
    }

    getForUri(uri: string): ChatLink[] {
        return this.byUri[uri] ?? [];
    }

    // AI_NOTE: あるセッションに紐づく全リンクを uri 付きで返す。会話が進むたびに結論labelを更新する際、
    // どのファイルのどの注釈を更新すべきかを引くのに使う(1セッションが複数箇所に紐づくこともある)。
    getLinksForSession(sessionId: string): Array<{ uri: string; link: ChatLink }> {
        const out: Array<{ uri: string; link: ChatLink }> = [];
        for (const uri of Object.keys(this.byUri)) {
            for (const link of this.byUri[uri]) {
                if (link.sessionIds.includes(sessionId)) out.push({ uri, link });
            }
        }
        return out;
    }

    // AI_NOTE: 会話の進行で結論が変わったら label/explanation を最新へ更新する(id=場所は不変・中身だけ差し替え)。
    // 該当が無ければ何もしない。座標ヒントやアンカーは触らない(描画側が reanchor で取り直すため)。
    update(uri: string, id: string, label: string, explanation: string): void {
        const link = (this.byUri[uri] ?? []).find((l) => l.annotation.id === id);
        if (!link) return;
        link.annotation.label = label;
        link.annotation.explanation = explanation;
        this.save();
    }

    // AI_NOTE: 削除したチャットのリンクを掃除する用。sessionId を全リンクから外し、空になったリンクは落とす。
    removeSession(sessionId: string): void {
        let changed = false;
        for (const uri of Object.keys(this.byUri)) {
            const list = this.byUri[uri];
            for (const link of list) {
                const i = link.sessionIds.indexOf(sessionId);
                if (i !== -1) { link.sessionIds.splice(i, 1); changed = true; }
            }
            const kept = list.filter((l) => l.sessionIds.length > 0);
            if (kept.length !== list.length) { this.byUri[uri] = kept; changed = true; }
        }
        if (changed) this.save();
    }
}
