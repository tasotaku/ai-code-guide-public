import * as fs from "fs";
import * as path from "path";

export interface TraceDependencyContextOptions {
    maxDepth?: number;
    maxFiles?: number;
    maxChars?: number;
}

function importedModules(source: string): string[] {
    const modules: string[] = [];
    for (const rawLine of source.split(/\r?\n/)) {
        const line = rawLine.trim();
        const from = line.match(/^from\s+([.\w]+)\s+import\s+/);
        if (from) {
            modules.push(from[1]);
            continue;
        }
        const direct = line.match(/^import\s+(.+)$/);
        if (!direct) continue;
        for (const item of direct[1].split(",")) {
            const module = item.trim().split(/\s+as\s+/)[0];
            if (module) modules.push(module);
        }
    }
    return modules;
}

function inside(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveLocalModule(moduleName: string, importer: string, workspaceRoot: string): string | null {
    let base: string;
    let modulePath: string;
    if (moduleName.startsWith(".")) {
        const dots = moduleName.match(/^\.+/)?.[0].length ?? 0;
        base = path.dirname(importer);
        for (let index = 1; index < dots; index += 1) base = path.dirname(base);
        modulePath = moduleName.slice(dots).replace(/\./g, path.sep);
    } else {
        base = workspaceRoot;
        modulePath = moduleName.replace(/\./g, path.sep);
    }
    const stem = path.resolve(base, modulePath);
    for (const candidate of [`${stem}.py`, path.join(stem, "__init__.py")]) {
        if (inside(workspaceRoot, candidate) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }
    return null;
}

/** Collect bounded workspace-local import sources for trace safety analysis. */
export function collectTraceDependencyContext(
    filePath: string | undefined,
    workspaceRoot: string | undefined,
    source: string,
    options: TraceDependencyContextOptions = {},
): string {
    if (!filePath || !workspaceRoot) return "";
    const root = path.resolve(workspaceRoot);
    const entry = path.resolve(filePath);
    if (!inside(root, entry)) return "";
    const maxDepth = options.maxDepth ?? 3;
    const maxFiles = options.maxFiles ?? 8;
    const maxChars = options.maxChars ?? 60_000;
    const queue = importedModules(source).map(moduleName => ({ moduleName, importer: entry, depth: 1 }));
    const visited = new Set<string>([entry]);
    const sections: string[] = [];
    let chars = 0;

    while (queue.length > 0 && sections.length < maxFiles && chars < maxChars) {
        const item = queue.shift()!;
        if (item.depth > maxDepth) continue;
        const resolved = resolveLocalModule(item.moduleName, item.importer, root);
        if (!resolved || visited.has(resolved)) continue;
        visited.add(resolved);
        const dependencySource = fs.readFileSync(resolved, "utf8");
        const relative = path.relative(root, resolved).replace(/\\/g, "/");
        const header = `# workspace-local dependency: ${relative}\n`;
        const remaining = maxChars - chars - header.length;
        if (remaining <= 0) break;
        const body = dependencySource.slice(0, remaining);
        sections.push(header + body);
        chars += header.length + body.length;
        for (const moduleName of importedModules(dependencySource)) {
            queue.push({ moduleName, importer: resolved, depth: item.depth + 1 });
        }
    }
    return sections.join("\n\n");
}
