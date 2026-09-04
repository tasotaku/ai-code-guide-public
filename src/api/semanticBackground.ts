import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { GraphNode } from "../flowchart/astParser";
import type { BlockExpansion } from "./claudeClient";
import type { StmtSpan, MeaningRange } from "./blockRangeSnapper";

export interface MeaningBlock extends MeaningRange { label: string }
export interface BackgroundIdentity { model: string; provider: string; globalContext: string; schema: string }
export interface BackgroundSnapshot {
    ranges: Record<string, MeaningBlock[]>;
    errors: Record<string, string>;
    total: number;
    completed: number;
}
export interface BackgroundOptions {
    targetIds?: string[];
    onUpdate?: (snapshot: BackgroundSnapshot) => void;
    isCurrent?: () => boolean;
}
interface Dependencies {
    identity(): BackgroundIdentity;
    generate(name: string, lines: string[], kind: string, identity: BackgroundIdentity): Promise<MeaningBlock[]>;
    details(name: string, lines: string[], kind: string, blocks: MeaningBlock[], identity: BackgroundIdentity): Promise<BlockExpansion>;
}
interface Target {
    node: GraphNode;
    key: string;
    lines: string[];
    absoluteLines: number[];
    owned: Set<number>;
}
interface Entry {
    blocks: MeaningBlock[];
    anchors: [string, string][];
    details?: BlockExpansion;
}

const MAX_ENTRIES = 200;
const MAX_BYTES = 16 * 1024 * 1024;
const VERSION = "meaning-background-cache/1";

function digest(value: unknown): string {
    // AI_NOTE: ファイル全体ではなく実際の生成入力だけを識別し、外側の行ずれで再課金しない。
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function targets(uri: string, source: string, nodes: GraphNode[], identity: BackgroundIdentity): Target[] {
    // AI_NOTE: 子宣言は親の文脈に残し、本体は除く。圧縮行と実ファイル行の対応は毎回作り直す。
    const sourceLines = source.replace(/\r\n?/g, "\n").split("\n");
    const result: Target[] = [];
    for (const node of nodes.filter(n => n.kind !== "entry")) {
        if (node.lineStart < 0 || node.lineEnd >= sourceLines.length || node.lineEnd < node.lineStart) continue;
        const children = nodes.filter(child => child.parent === node.id);
        const absoluteLines: number[] = [];
        const owned = new Set<number>();
        for (let line = node.lineStart; line <= node.lineEnd; line++) {
            // AI_NOTE: 関数外の空行追加は座標移動だけにする。関数内の空行・コメントは意味判断の入力として残す。
            if (node.id === "__background_module__" && !sourceLines[line].trim()) continue;
            const child = children.find(candidate => candidate.lineStart <= line && line <= candidate.lineEnd);
            if (!child) owned.add(line);
            if (!child || line <= (child.headerEnd ?? child.lineStart - 1)) absoluteLines.push(line);
        }
        if (![...owned].some(line => sourceLines[line].trim() && !sourceLines[line].trim().startsWith("#"))) continue;
        const lines = absoluteLines.map(line => sourceLines[line]);
        const ancestors: string[] = [];
        let parent = nodes.find(item => item.id === node.parent);
        const visited = new Set<string>([node.id]);
        while (parent && !visited.has(parent.id)) {
            visited.add(parent.id);
            ancestors.unshift(`${parent.kind}:${parent.label}`);
            parent = nodes.find(item => item.id === parent!.parent);
        }
        const scope = node.scopeKey ?? `${ancestors.join("/")}/${node.kind}:${node.label}`;
        const duplicates = nodes.filter(item => item.kind === node.kind && item.label === node.label && item.parent === node.parent);
        const ambiguity = !node.scopeKey && duplicates.length > 1 ? node.lineStart : undefined;
        result.push({ node, lines, absoluteLines, owned, key: digest([VERSION, uri, scope, ambiguity, lines, identity]) });
    }
    return result;
}

export function validateMeaningBlocks(raw: MeaningBlock[], lines: string[], stmts: StmtSpan[] = []): MeaningBlock[] {
    // AI_NOTE: LLMの区分数を増やさず、複数行文内の境界だけ終端へ補正する。不正範囲は成功保存しない。
    if (!Array.isArray(raw) || !raw.length || raw.length > lines.length) throw new Error("背景の意味区分が不正です。");
    let end = -1;
    const blocks = raw.map(block => {
        if (!block || !Number.isInteger(block.lineStart) || !Number.isInteger(block.lineEnd)
            || block.lineStart !== end + 1 || block.lineEnd < block.lineStart || block.lineEnd >= lines.length
            || typeof block.label !== "string" || !block.label.trim()) throw new Error("背景の行範囲が連続していません。");
        end = block.lineEnd;
        return { lineStart: block.lineStart, lineEnd: block.lineEnd, label: block.label.trim() };
    });
    if (end !== lines.length - 1) throw new Error("背景の行範囲が対象全体を覆っていません。");
    for (let i = 0; i < blocks.length - 1; i++) {
        const block = blocks[i];
        let previousCode = block.lineEnd;
        while (previousCode > 0 && (!lines[previousCode].trim() || lines[previousCode].trim().startsWith("#"))) previousCode--;
        if (stmts.some(stmt => stmt.end === previousCode)) continue;
        const containing = stmts.filter(stmt => stmt.start <= block.lineEnd && block.lineEnd < stmt.end)
            .sort((a, b) => (a.end - a.start) - (b.end - b.start));
        const innermost = stmts.filter(stmt => stmt.start <= block.lineEnd && block.lineEnd <= stmt.end)
            .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
        if (containing.length && innermost && innermost.end > block.lineEnd) block.lineEnd = innermost.end;
        blocks[i + 1].lineStart = block.lineEnd + 1;
        if (block.lineEnd >= blocks[i + 1].lineEnd || blocks[i + 1].lineStart > blocks[i + 1].lineEnd) {
            throw new Error("背景の境界を構文に対応付けられません。");
        }
    }
    return blocks;
}

function projectBlocks<T extends MeaningBlock>(blocks: T[], target: Target): T[] {
    // AI_NOTE: 子が所有する行を抜いて塗り重ねを防ぐ。行ずれは現在の対応表で絶対座標に戻す。
    const result: T[] = [];
    for (const block of blocks) {
        let run: T | undefined;
        for (let index = block.lineStart; index <= block.lineEnd; index++) {
            const line = target.absoluteLines[index];
            if (!target.owned.has(line)) { run = undefined; continue; }
            if (run && run.lineEnd + 1 === line) run.lineEnd = line;
            else { run = { ...block, lineStart: line, lineEnd: line }; result.push(run); }
        }
    }
    return result;
}

function validateDetails(details: BlockExpansion, blocks: MeaningBlock[]): void {
    // AI_NOTE: LLM出力とディスク再読込に同じ契約を適用し、壊れた詳細が検証済み背景の範囲を変えない。
    if (!details || !details.overview || typeof details.overview.purpose !== "string"
        || !Array.isArray(details.blocks) || details.blocks.length !== blocks.length
        || details.blocks.some((block, i) => block.lineStart !== blocks[i].lineStart || block.lineEnd !== blocks[i].lineEnd
            || block.label !== blocks[i].label || typeof block.description !== "string" || !block.description.trim())) {
        throw new Error("詳細が保存済みの意味区分と一致しません。");
    }
}

export class SemanticBackgroundService {
    private readonly cache = new Map<string, Entry>();
    private readonly inFlight = new Map<string, { promise: Promise<Entry>; interests: Set<() => boolean> }>();
    private readonly detailFlight = new Map<string, Promise<BlockExpansion>>();
    private readonly errors = new Map<string, string>();
    private readonly dependencies: Dependencies;
    private readonly file: string;
    private writes: Promise<void> = Promise.resolve();
    private queue: Promise<unknown> = Promise.resolve();
    private epoch = 0;

    constructor(storagePath: string, dependencies?: Dependencies) {
        // AI_NOTE: VSCode依存は既定生成器だけに隔離し、永続化と競合処理を課金なしの単体試験で検証する。
        const client = dependencies ? undefined : require("./claudeClient") as typeof import("./claudeClient");
        this.dependencies = dependencies ?? { identity: client!.getSemanticBackgroundIdentity, generate: client!.generateMeaningBackground, details: client!.generateMeaningDetails };
        this.file = path.join(storagePath, "semantic-backgrounds.json");
        try {
            if (!fs.existsSync(this.file)) return;
            if (fs.statSync(this.file).size > MAX_BYTES) return;
            const stored = JSON.parse(fs.readFileSync(this.file, "utf8"));
            if (stored.version !== VERSION || !Array.isArray(stored.entries)) return;
            for (const pair of stored.entries.slice(-MAX_ENTRIES)) {
                if (Array.isArray(pair) && typeof pair[0] === "string" && Array.isArray(pair[1]?.blocks) && Array.isArray(pair[1]?.anchors)) this.cache.set(pair[0], pair[1]);
            }
        } catch (error) { console.warn("[AI Code Guide] background cache load failed:", error); }
    }

    private read(target: Target): Entry | undefined {
        // AI_NOTE: ディスク内容も非信頼入力。アンカーと座標を照合できた成功結果だけ再利用する。
        const entry = this.cache.get(target.key);
        if (!entry) return undefined;
        try {
            validateMeaningBlocks(entry.blocks, target.lines);
            if (entry.anchors.length !== entry.blocks.length || entry.blocks.some((block, i) => entry.anchors[i]?.[0] !== target.lines[block.lineStart] || entry.anchors[i]?.[1] !== target.lines[block.lineEnd])) throw new Error("anchor mismatch");
        } catch { this.cache.delete(target.key); return undefined; }
        if (entry.details) {
            try { validateDetails(entry.details, entry.blocks); }
            catch { delete entry.details; }
        }
        this.cache.delete(target.key);
        this.cache.set(target.key, entry);
        return entry;
    }

    getSnapshot(uri: string, source: string, nodes: GraphNode[]): BackgroundSnapshot {
        // AI_NOTE: 編集中の位置合わせはcache-onlyで行い、この入口からLLMを起動しない。
        const selected = targets(uri, source, nodes, this.dependencies.identity());
        const snapshot: BackgroundSnapshot = { ranges: {}, errors: {}, total: selected.length, completed: 0 };
        for (const target of selected) {
            const cached = this.read(target);
            if (cached) { snapshot.ranges[target.node.id] = projectBlocks(cached.blocks, target); snapshot.completed++; }
            else if (this.errors.has(target.key)) snapshot.errors[target.node.id] = this.errors.get(target.key)!;
        }
        return snapshot;
    }

    peek(uri: string, source: string, nodes: GraphNode[]): Record<string, MeaningBlock[]> {
        // AI_NOTE: 従来の表示側が範囲だけ必要な場合にも生成せず答える。
        return this.getSnapshot(uri, source, nodes).ranges;
    }

    peekDetails(uri: string, source: string, nodes: GraphNode[], nodeId: string): BlockExpansion | undefined {
        // AI_NOTE: 未変更対象の開いている詳細は、保存済み相対座標から位置だけ直す。編集中にLLMは呼ばない。
        const target = targets(uri, source, nodes, this.dependencies.identity()).find(item => item.node.id === nodeId);
        if (!target) return undefined;
        const details = this.read(target)?.details;
        return details ? { overview: details.overview, blocks: projectBlocks(details.blocks, target) } : undefined;
    }

    async ensure(uri: string, source: string, nodes: GraphNode[], stmts: StmtSpan[], options: BackgroundOptions = {}): Promise<BackgroundSnapshot> {
        // AI_NOTE: ファイル全体の待ち合わせにせず対象ごとに通知。失敗は対象単位で残し、他の背景を止めない。
        const identity = this.dependencies.identity();
        const epoch = this.epoch;
        const selected = targets(uri, source, nodes, identity).filter(target => !options.targetIds || options.targetIds.includes(target.node.id));
        const snapshot = this.getSnapshot(uri, source, nodes);
        const isCurrent = () => (options.isCurrent?.() ?? true) && digest(this.dependencies.identity()) === digest(identity);
        for (const target of selected) {
            if (!isCurrent() || epoch !== this.epoch) break;
            try {
                const entry = await this.prepare(target, identity, stmts, isCurrent);
                if (!isCurrent() || epoch !== this.epoch) break;
                if (!snapshot.ranges[target.node.id]) snapshot.completed++;
                snapshot.ranges[target.node.id] = projectBlocks(entry.blocks, target);
                delete snapshot.errors[target.node.id];
            } catch (error) {
                if (!isCurrent() || epoch !== this.epoch) break;
                snapshot.errors[target.node.id] = error instanceof Error ? error.message : String(error);
                this.errors.set(target.key, snapshot.errors[target.node.id]);
                while (this.errors.size > MAX_ENTRIES) this.errors.delete(this.errors.keys().next().value!);
            }
            options.onUpdate?.({ ...snapshot, ranges: { ...snapshot.ranges }, errors: { ...snapshot.errors } });
        }
        return snapshot;
    }

    private async prepare(target: Target, identity: BackgroundIdentity, stmts: StmtSpan[], isCurrent: () => boolean): Promise<Entry> {
        // AI_NOTE: 同内容だけinflightを共有する。複数画面のうち一つが閉じても、他の要求が有効なら続ける。
        const cached = this.read(target);
        if (cached) return cached;
        const existing = this.inFlight.get(target.key);
        if (existing) { existing.interests.add(isCurrent); return existing.promise; }
        const interests = new Set([isCurrent]);
        const epoch = this.epoch;
        const promise = this.queue.then(async () => {
            if (epoch !== this.epoch || ![...interests].some(current => current())) throw new Error("背景生成を停止しました。");
            const raw = await this.dependencies.generate(target.node.label, target.lines, target.node.kind, identity);
            const compressedSpans = stmts.flatMap(span => {
                if (span.start < target.node.lineStart || span.end > target.node.lineEnd
                    || span.start === target.node.lineStart && span.end === target.node.lineEnd) return [];
                const start = target.absoluteLines.indexOf(span.start);
                const end = target.absoluteLines.indexOf(span.end);
                return start >= 0 && end >= start ? [{ start, end }] : [];
            });
            const blocks = validateMeaningBlocks(raw, target.lines, compressedSpans);
            const entry: Entry = { blocks, anchors: blocks.map(block => [target.lines[block.lineStart], target.lines[block.lineEnd]]) };
            if (epoch === this.epoch && [...interests].some(current => current())) {
                // AI_NOTE: 停止後の結果を保存するとcache-only画面更新で遅れて現れる。生きた要求がある成功だけ保存する。
                this.save(target.key, entry); this.errors.delete(target.key);
            }
            return entry;
        });
        this.queue = promise.catch(() => undefined);
        this.inFlight.set(target.key, { promise, interests });
        try { return await promise; }
        finally { if (this.inFlight.get(target.key)?.promise === promise) this.inFlight.delete(target.key); }
    }

    async details(uri: string, source: string, nodes: GraphNode[], stmts: StmtSpan[], nodeId: string, sourceIsCurrent: () => boolean = () => true): Promise<BlockExpansion> {
        // AI_NOTE: トグルは同じ背景生成を待ってから、その固定区分に詳細を追加する。編集後は送信を始めない。
        const identity = this.dependencies.identity();
        const epoch = this.epoch;
        const isCurrent = () => sourceIsCurrent() && digest(this.dependencies.identity()) === digest(identity);
        const target = targets(uri, source, nodes, identity).find(item => item.node.id === nodeId);
        if (!target) throw new Error("詳細の対象がありません。");
        if (!isCurrent() || epoch !== this.epoch) throw new Error("コードが変更されました。詳細を更新してください。");
        const entry = await this.prepare(target, identity, stmts, isCurrent);
        if (!isCurrent() || epoch !== this.epoch) throw new Error("コードが変更されました。詳細を更新してください。");
        const key = `${target.key}:${digest(entry.blocks)}`;
        let details = entry.details;
        if (!details) {
            let pending = this.detailFlight.get(key);
            if (!pending) {
                const epoch = this.epoch;
                pending = this.dependencies.details(target.node.label, target.lines, target.node.kind, entry.blocks, identity).then(result => {
                    validateDetails(result, entry.blocks);
                    if (epoch === this.epoch) this.save(target.key, { ...entry, details: result });
                    return result;
                });
                this.detailFlight.set(key, pending);
            }
            try { details = await pending; }
            finally { if (this.detailFlight.get(key) === pending) this.detailFlight.delete(key); }
        }
        if (!isCurrent() || epoch !== this.epoch) throw new Error("コードが変更されました。詳細を更新してください。");
        return { overview: details.overview, blocks: projectBlocks(details.blocks, target) };
    }

    private save(key: string, entry: Entry): void {
        // AI_NOTE: 200対象/16MiBの早い方でLRUを削る。巨大1件は画面には返すが永続キャッシュを圧迫しない。
        if (Buffer.byteLength(JSON.stringify({ version: VERSION, entries: [[key, entry]] })) > MAX_BYTES) return;
        this.cache.delete(key);
        this.cache.set(key, entry);
        while (this.cache.size > MAX_ENTRIES || Buffer.byteLength(JSON.stringify({ version: VERSION, entries: [...this.cache] })) > MAX_BYTES) this.cache.delete(this.cache.keys().next().value!);
        this.persist();
    }

    private persist(): void {
        // AI_NOTE: 同時保存は直列化し、一時ファイルから置換する。I/O失敗を記録しても生成結果は画面へ返せる。
        const data = JSON.stringify({ version: VERSION, entries: [...this.cache] });
        this.writes = this.writes.then(async () => {
            await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
            const temporary = `${this.file}.${process.pid}.tmp`;
            await fs.promises.writeFile(temporary, data, "utf8");
            await fs.promises.rename(temporary, this.file);
        }).catch(error => { console.warn("[AI Code Guide] background cache save failed:", error); });
    }

    clear(): void {
        // AI_NOTE: 進行中の旧生成が後から消去済みキャッシュへ戻ることもepochで防ぐ。
        this.epoch++;
        this.cache.clear();
        this.errors.clear();
        this.inFlight.clear();
        this.detailFlight.clear();
        this.persist();
    }

    async flush(): Promise<void> {
        // AI_NOTE: 拡張終了と単体検証で、最後の原子的保存の完了を明示的に待てる。
        await this.writes;
    }
}
