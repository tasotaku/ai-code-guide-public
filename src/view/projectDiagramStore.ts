import * as fs from "fs";
import * as path from "path";
import { LocatedProjectDiagram } from "./projectDiagram";

export interface ProjectDiagramHistoryEntry {
    id: string;
    question: string;
    createdAt: number;
    diagram: LocatedProjectDiagram;
}

// AI_NOTE: 質問から作った図をワークスペース別に保存し、同じ質問をLLMへ再送せず開き直せるようにする。
// 旧「読む順番」と意味が異なるため別ファイルへ保存し、古い履歴を新しい図として誤表示しない。
export class ProjectDiagramStore {
    private byWorkspace: Record<string, ProjectDiagramHistoryEntry[]> = {};
    private readonly diskPath: string;
    private static readonly MAX_PER_WORKSPACE = 30;

    constructor(storageDir: string) {
        this.diskPath = path.join(storageDir || "", "project-diagrams.json");
        this.load();
    }

    private load(): void {
        try {
            this.byWorkspace = JSON.parse(fs.readFileSync(this.diskPath, "utf8")) as Record<string, ProjectDiagramHistoryEntry[]>;
        } catch {
            this.byWorkspace = {};
        }
    }

    private save(): void {
        try {
            fs.mkdirSync(path.dirname(this.diskPath), { recursive: true });
            fs.writeFileSync(this.diskPath, JSON.stringify(this.byWorkspace), "utf8");
        } catch {
            // 保存できない時も、現在のウィンドウで作った図は使える。
        }
    }

    list(workspace: string): ProjectDiagramHistoryEntry[] {
        return this.byWorkspace[workspace] ?? [];
    }

    add(workspace: string, question: string, diagram: LocatedProjectDiagram): ProjectDiagramHistoryEntry {
        const list = this.byWorkspace[workspace] ?? (this.byWorkspace[workspace] = []);
        const entry: ProjectDiagramHistoryEntry = {
            id: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            question,
            createdAt: Date.now(),
            diagram,
        };
        list.unshift(entry);
        if (list.length > ProjectDiagramStore.MAX_PER_WORKSPACE) list.length = ProjectDiagramStore.MAX_PER_WORKSPACE;
        this.save();
        return entry;
    }

    remove(workspace: string, id: string): void {
        const list = this.byWorkspace[workspace];
        if (!list) return;
        const kept = list.filter((entry) => entry.id !== id);
        if (kept.length === list.length) return;
        this.byWorkspace[workspace] = kept;
        this.save();
    }
}
