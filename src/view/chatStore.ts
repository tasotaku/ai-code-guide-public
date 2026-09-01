import * as fs from "fs";
import * as path from "path";

// AI_NOTE: #14 ⑤ チャットを「セッション」単位で永続化する。複数の過去チャットに戻れるようにし、
// 「質問する」から渡されたコード片(context)も保持して文脈付きで会話できるようにする。
// AI_NOTE: 引用はセッション添付からメッセージ添付に変更。quotes はそのメッセージ送信時に添付された引用の確定スナップショット。
export interface ChatMessage { role: "user" | "assistant"; content: string; quotes?: ChatQuote[]; }
// AI_NOTE: チャットの引用文脈。2系統ある: (a)インライン解説の「質問する」由来は explanation 付き、
// (b)エディタ選択の「チャットに引用」由来は fileName/lineStart/lineEnd(1始まり)付きで場所参照を表示する。
export interface ChatQuote {
    code: string;
    explanation?: string;
    fileName?: string;
    lineStart?: number;
    lineEnd?: number;
}
export interface ChatSession {
    id: string;
    title: string;
    createdAt: number;
    fileName: string;
    // AI_NOTE: ⑤ インライン解説の「質問する」/エディタ選択の「引用」由来。複数持てる（Cursor風に入力欄直上へチップで並べる）。
    // 未送信のpending引用（入力欄のチップ）のみを表す。送信されると ChatMessage.quotes へ移り、ここは空になる。
    // 旧データの単数 context は load() で配列へ移行する。旧仕様(議論済み引用がここに残る)は load() の移行処理で解消する。
    contexts: ChatQuote[];
    messages: ChatMessage[];
}

// AI_NOTE: globalStorage/chats.json に新しい順で保持する。件数上限で古いものから捨てる。
export class ChatStore {
    private sessions: ChatSession[] = [];
    private readonly diskPath: string;
    private static readonly MAX = 50;

    constructor(storageDir: string) {
        this.diskPath = path.join(storageDir || "", "chats.json");
        this.load();
    }

    private load(): void {
        try {
            const raw = JSON.parse(fs.readFileSync(this.diskPath, "utf8")) as Array<ChatSession & { context?: ChatQuote }>;
            // AI_NOTE: ⑤ 旧スキーマ(単数 context)を配列 contexts に移行する。未設定は空配列で正規化。
            this.sessions = raw.map((s) => {
                const contexts = s.contexts ?? (s.context ? [s.context] : []);
                delete s.context;
                const session = { ...s, contexts };
                // AI_NOTE: 旧「セッション添付」データの移行。議論済み引用が contexts に残っているとpendingチップとして
                // 再出現してしまうため、最初の user メッセージの quotes へ移す（既に quotes があれば上書きしない）。
                if (session.messages.length > 0 && session.contexts.length > 0) {
                    const firstUser = session.messages.find((m) => m.role === "user");
                    if (firstUser && !firstUser.quotes) firstUser.quotes = session.contexts;
                    session.contexts = [];
                }
                return session;
            });
        } catch {
            this.sessions = [];
        }
    }

    save(): void {
        try {
            fs.mkdirSync(path.dirname(this.diskPath), { recursive: true });
            fs.writeFileSync(this.diskPath, JSON.stringify(this.sessions), "utf8");
        } catch {
            // 書き込み失敗はサイレント
        }
    }

    list(): ChatSession[] {
        return this.sessions;
    }

    get(id: string): ChatSession | undefined {
        return this.sessions.find((s) => s.id === id);
    }

    // AI_NOTE: 新規セッションを先頭に作る。context があればそれをタイトルの種にする。
    create(fileName: string, context?: ChatQuote): ChatSession {
        const title = context
            ? (context.explanation || context.code).slice(0, 24)
            : `${fileName} のチャット`;
        const session: ChatSession = {
            id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            title,
            createdAt: Date.now(),
            fileName,
            contexts: context ? [context] : [],
            messages: [],
        };
        this.sessions.unshift(session);
        if (this.sessions.length > ChatStore.MAX) this.sessions.length = ChatStore.MAX;
        this.save();
        return session;
    }

    // AI_NOTE: 履歴リストの🗑用。該当IDのセッションを永続から削除する
    remove(id: string): void {
        const before = this.sessions.length;
        this.sessions = this.sessions.filter((s) => s.id !== id);
        if (this.sessions.length !== before) this.save();
    }

    // AI_NOTE: 履歴リストの✎用。タイトルを書き換えて永続化する(空文字は無視)
    rename(id: string, title: string): void {
        const trimmed = title.trim();
        if (!trimmed) return;
        const s = this.sessions.find((x) => x.id === id);
        if (!s) return;
        s.title = trimmed.slice(0, 80);
        this.save();
    }
}
