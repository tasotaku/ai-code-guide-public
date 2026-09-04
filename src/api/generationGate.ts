export type GenerationTrigger = "open" | "save" | "explicit";

// AI_NOTE: 入力停止や自動保存をLLM実行の許可にしない。タブ往復でも編集待ち・停止を維持する。
export class GenerationGate {
    private readonly edited = new Set<string>();
    private readonly stopped = new Set<string>();
    private readonly revisions = new Map<string, number>();

    edit(uri: string): void {
        this.edited.add(uri);
        this.pause(uri);
    }

    pause(uri: string): void {
        // AI_NOTE: 送信許可の世代だけ失効。編集待ち・利用者による停止とは区別する。
        this.revisions.set(uri, this.revision(uri) + 1);
    }

    stop(uri: string): void {
        this.stopped.add(uri);
        this.revisions.set(uri, this.revision(uri) + 1);
    }

    revision(uri: string): number { return this.revisions.get(uri) ?? 0; }
    isStopped(uri: string): boolean { return this.stopped.has(uri); }
    needsSave(uri: string): boolean { return this.edited.has(uri); }

    // AI_NOTE: 明示更新だけは未保存コードを読む意図とする。保存は停止の解除には使わない。
    allow(uri: string, dirty: boolean, trigger: GenerationTrigger): boolean {
        if (trigger === "explicit") {
            this.stopped.delete(uri);
            this.edited.delete(uri);
            return true;
        }
        if (this.stopped.has(uri) || dirty) return false;
        if (trigger === "save") this.edited.delete(uri);
        return !this.edited.has(uri);
    }
}
