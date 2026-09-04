import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";
import type { FuncInfo, GraphEdge, GraphNode, GraphResult, ProjectFileNode, ProjectGraphResult, StmtSpan } from "./astParser";
import { languageIdForPath, SupportedLanguageId } from "./languageSupport";

const PROJECT_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"] as const;
const EXCLUDED_DIRS = new Set([".git", ".venv", "venv", "node_modules", "dist", "build", "out", "coverage", ".tox", "__pycache__"]);

function scriptKind(languageId: SupportedLanguageId): ts.ScriptKind {
    if (languageId === "typescriptreact") return ts.ScriptKind.TSX;
    if (languageId === "typescript") return ts.ScriptKind.TS;
    if (languageId === "javascriptreact") return ts.ScriptKind.JSX;
    return ts.ScriptKind.JS;
}

function sourceFile(source: string, languageId: SupportedLanguageId, fileName = `source.${languageId === "typescript" ? "ts" : "js"}`): ts.SourceFile {
    return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(languageId));
}

function linesOf(node: ts.Node, file: ts.SourceFile): { start: number; end: number } {
    const start = file.getLineAndCharacterOfPosition(node.getStart(file, false)).line;
    const lastPosition = Math.max(node.getStart(file, false), node.end - 1);
    const end = file.getLineAndCharacterOfPosition(lastPosition).line;
    return { start, end };
}

function nameText(name: ts.PropertyName | ts.BindingName | undefined, file: ts.SourceFile): string {
    if (!name) return "anonymous";
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
    return name.getText(file);
}

function parameterText(node: ts.SignatureDeclarationBase, file: ts.SourceFile): string {
    return node.parameters.map((parameter) => parameter.getText(file)).join(", ");
}

function callableBody(node: ts.Node): ts.ConciseBody | ts.Block | undefined {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)
        || ts.isConstructorDeclaration(node)) return node.body;
    return undefined;
}

interface Definition {
    node: ts.Node;
    name: string;
    qualifiedName: string;
    label: string;
    kind: "function" | "class" | "constant";
    parent?: string;
}

function collectDefinitions(file: ts.SourceFile): Definition[] {
    const definitions: Definition[] = [];

    const visitClassMembers = (members: ts.NodeArray<ts.ClassElement>, classPath: string[], parentName: string): void => {
        for (const member of members) {
            if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isConstructorDeclaration(member)) {
                const name = ts.isConstructorDeclaration(member) ? "constructor" : nameText(member.name, file);
                definitions.push({
                    node: member,
                    name,
                    qualifiedName: [...classPath, name].join("."),
                    label: `${name}(${parameterText(member, file)})`,
                    kind: "function",
                    parent: parentName,
                });
            } else if (ts.isPropertyDeclaration(member) && member.initializer && (ts.isArrowFunction(member.initializer) || ts.isFunctionExpression(member.initializer))) {
                const name = nameText(member.name, file);
                definitions.push({
                    node: member,
                    name,
                    qualifiedName: [...classPath, name].join("."),
                    label: `${name}(${parameterText(member.initializer, file)})`,
                    kind: "function",
                    parent: parentName,
                });
            }
        }
    };

    for (const statement of file.statements) {
        if (ts.isFunctionDeclaration(statement) && statement.name) {
            definitions.push({
                node: statement,
                name: statement.name.text,
                qualifiedName: statement.name.text,
                label: `${statement.name.text}(${parameterText(statement, file)})`,
                kind: "function",
            });
        } else if (ts.isClassDeclaration(statement) && statement.name) {
            const definition: Definition = {
                node: statement,
                name: statement.name.text,
                qualifiedName: statement.name.text,
                label: `class ${statement.name.text}`,
                kind: "class",
            };
            definitions.push(definition);
            visitClassMembers(statement.members, [statement.name.text], statement.name.text);
        } else if (ts.isInterfaceDeclaration(statement)) {
            definitions.push({ node: statement, name: statement.name.text, qualifiedName: statement.name.text, label: `interface ${statement.name.text}`, kind: "class" });
        } else if (ts.isTypeAliasDeclaration(statement)) {
            definitions.push({ node: statement, name: statement.name.text, qualifiedName: statement.name.text, label: `type ${statement.name.text}`, kind: "constant" });
        } else if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
                if (!ts.isIdentifier(declaration.name)) continue;
                const name = declaration.name.text;
                if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
                    definitions.push({
                        node: statement,
                        name,
                        qualifiedName: name,
                        label: `${name}(${parameterText(declaration.initializer, file)})`,
                        kind: "function",
                    });
                } else if (/^[A-Z][A-Z0-9_]*$/.test(name)) {
                    definitions.push({ node: statement, name, qualifiedName: name, label: name, kind: "constant" });
                }
            }
        }
    }
    return definitions;
}

function bodyForDefinition(definition: Definition): ts.Node | undefined {
    if (ts.isVariableStatement(definition.node)) {
        const declaration = definition.node.declarationList.declarations.find((item) => ts.isIdentifier(item.name) && item.name.text === definition.name);
        return declaration?.initializer ? callableBody(declaration.initializer) : undefined;
    }
    return callableBody(definition.node);
}

function callName(expression: ts.Expression, file: ts.SourceFile): string {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.getText(file);
    if (ts.isElementAccessExpression(expression)) return expression.getText(file);
    return expression.getText(file);
}

function firstLine(node: ts.Node, file: ts.SourceFile): string {
    return node.getText(file).split(/\r?\n/, 1)[0].trim().slice(0, 90);
}

function moduleGraph(file: ts.SourceFile): GraphResult {
    const definitions = collectDefinitions(file);
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const relationships: Array<{ from: string; to: string; line: number }> = [];
    const ids = new Map<string, string>();
    let counter = 0;
    const addNode = (kind: GraphNode["kind"], label: string, node: ts.Node, parent?: string, endNode: ts.Node = node): string => {
        const id = `j${kind[0]}_${++counter}`;
        const firstSpan = linesOf(node, file);
        const lastSpan = linesOf(endNode, file);
        const span = { start: firstSpan.start, end: lastSpan.end };
        nodes.push({ id, kind, label, lineStart: span.start, lineEnd: span.end, ...(parent ? { parent } : {}) });
        return id;
    };

    const firstStatement = file.statements[0];
    if (firstStatement) addNode("entry", "モジュール概要", firstStatement);

    const imports = file.statements.filter((statement) => ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement));
    if (imports.length > 0) {
        const names = imports.map((statement) => firstLine(statement, file)).join(", ");
        addNode("block", names.slice(0, 90), imports[0], undefined, imports[imports.length - 1]);
    }

    for (const definition of definitions) {
        const parentId = definition.parent ? ids.get(definition.parent) : undefined;
        const id = addNode(definition.kind, definition.label, definition.node, parentId);
        ids.set(definition.qualifiedName, id);
        if (!definition.parent) ids.set(definition.name, id);
    }

    const topLevelDefinitionNodes = new Set(definitions.filter((item) => !item.parent).map((item) => item.node));
    const pending = file.statements.filter((statement) =>
        !topLevelDefinitionNodes.has(statement)
        && !ts.isImportDeclaration(statement)
        && !ts.isImportEqualsDeclaration(statement)
        && !ts.isExportDeclaration(statement)
        && !ts.isEmptyStatement(statement)
    );
    if (pending.length > 0) {
        addNode("block", pending.length === 1 ? firstLine(pending[0], file) : `トップレベル処理 ほか${pending.length - 1}件`, pending[0], undefined, pending[pending.length - 1]);
    }

    const edgeKeys = new Set<string>();
    for (const definition of definitions) {
        const callerId = ids.get(definition.qualifiedName);
        const body = bodyForDefinition(definition);
        if (!callerId || !body) continue;
        const visit = (node: ts.Node): void => {
            if (node !== body && (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isClassDeclaration(node))) return;
            if (ts.isCallExpression(node)) {
                const target = callName(node.expression, file);
                const shortTarget = target.split(".").pop() ?? target;
                const line = linesOf(node, file).start;
                relationships.push({ from: definition.qualifiedName, to: target, line: line + 1 });
                const calleeId = ids.get(target) ?? ids.get(shortTarget);
                const key = `${callerId}\0${calleeId ?? ""}`;
                if (calleeId && calleeId !== callerId && !edgeKeys.has(key)) {
                    edgeKeys.add(key);
                    edges.push({ from: callerId, to: calleeId, label: "", fromLine: line });
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(body);
    }
    return { nodes, edges, relationships };
}

function controlFlow(file: ts.SourceFile, definition: Definition): GraphResult {
    const body = bodyForDefinition(definition);
    if (!body) return { nodes: [], edges: [] };
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    let counter = 0;
    const add = (kind: GraphNode["kind"], label: string, node: ts.Node): string => {
        const id = `jc_${++counter}`;
        const span = linesOf(node, file);
        nodes.push({ id, kind, label, lineStart: span.start, lineEnd: span.end });
        return id;
    };
    const entry = add("entry", definition.label, definition.node);
    let previous = entry;

    const appendStatements = (statements: readonly ts.Statement[], incoming: string): string => {
        let tail = incoming;
        for (const statement of statements) {
            if (ts.isIfStatement(statement)) {
                const condition = add("condition", `if ${statement.expression.getText(file)}`, statement);
                edges.push({ from: tail, to: condition, label: "" });
                const thenStatements = ts.isBlock(statement.thenStatement) ? statement.thenStatement.statements : [statement.thenStatement];
                const yesTail = appendStatements(thenStatements, condition);
                if (yesTail !== condition) edges.find((edge) => edge.from === condition && edge.label === "")!.label = "Yes";
                if (statement.elseStatement) {
                    const elseStatements = ts.isBlock(statement.elseStatement) ? statement.elseStatement.statements : [statement.elseStatement];
                    const before = edges.length;
                    const noTail = appendStatements(elseStatements, condition);
                    const firstNo = edges.slice(before).find((edge) => edge.from === condition);
                    if (firstNo) firstNo.label = "No";
                    tail = noTail;
                } else {
                    tail = yesTail;
                }
            } else {
                const kind: GraphNode["kind"] = ts.isReturnStatement(statement) || ts.isThrowStatement(statement)
                    ? "return"
                    : ts.isForStatement(statement) || ts.isForInStatement(statement) || ts.isForOfStatement(statement)
                        || ts.isWhileStatement(statement) || ts.isDoStatement(statement)
                        ? "loop"
                        : ts.isSwitchStatement(statement) || ts.isTryStatement(statement)
                            ? "condition"
                            : "block";
                const current = add(kind, firstLine(statement, file), statement);
                edges.push({ from: tail, to: current, label: "" });
                tail = current;
            }
        }
        return tail;
    };

    const statements = ts.isBlock(body) ? body.statements : [];
    previous = appendStatements(statements, previous);
    return { nodes, edges };
}

export function extractJavaScriptGraph(source: string, languageId: SupportedLanguageId, targetFunc = ""): GraphResult {
    const file = sourceFile(source, languageId);
    const diagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (diagnostics.length > 0) {
        const diagnostic = diagnostics[0];
        return { nodes: [], edges: [], error: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") };
    }
    if (!targetFunc) return moduleGraph(file);
    const definition = collectDefinitions(file).find((item) => item.qualifiedName === targetFunc || item.name === targetFunc);
    return definition ? controlFlow(file, definition) : { nodes: [], edges: [] };
}

export function javaScriptFuncAtLine(source: string, languageId: SupportedLanguageId, line: number): string {
    const file = sourceFile(source, languageId);
    return collectDefinitions(file)
        .filter((definition) => definition.kind === "function")
        .map((definition) => ({ definition, ...linesOf(definition.node, file) }))
        .filter((item) => item.start <= line && line <= item.end)
        .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]?.definition.qualifiedName ?? "";
}

export function listJavaScriptFunctions(source: string, languageId: SupportedLanguageId): FuncInfo[] {
    const file = sourceFile(source, languageId);
    return collectDefinitions(file)
        .filter((definition) => definition.kind === "function")
        .map((definition) => {
            const span = linesOf(definition.node, file);
            return { name: definition.qualifiedName, line_start: span.start + 1, line_end: span.end + 1 };
        })
        .sort((a, b) => a.line_start - b.line_start);
}

export function javaScriptStmtSpans(source: string, languageId: SupportedLanguageId): StmtSpan[] {
    const file = sourceFile(source, languageId);
    const spans: StmtSpan[] = [];
    const visit = (node: ts.Node): void => {
        if (ts.isStatement(node)) {
            const span = linesOf(node, file);
            spans.push({ start: span.start, end: span.end });
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return spans.sort((a, b) => a.start - b.start || a.end - b.end);
}

function walkProject(root: string): string[] {
    const files: string[] = [];
    const visit = (directory: string): void => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            if (entry.name.startsWith(".") && entry.name !== ".config") continue;
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                if (!EXCLUDED_DIRS.has(entry.name)) visit(absolute);
            } else if (entry.isFile() && PROJECT_EXTENSIONS.includes(path.extname(entry.name).toLowerCase() as typeof PROJECT_EXTENSIONS[number])) {
                files.push(absolute);
            }
        }
    };
    visit(root);
    return files.sort();
}

function moduleImports(file: ts.SourceFile): string[] {
    const imports: string[] = [];
    const visit = (node: ts.Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
            imports.push(node.moduleSpecifier.text);
        } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require"
            && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
            imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return imports;
}

function resolveProjectImport(importer: string, specifier: string, knownFiles: Set<string>): string | undefined {
    if (!specifier.startsWith(".")) return undefined;
    const base = path.resolve(path.dirname(importer), specifier);
    const candidates = [base, ...PROJECT_EXTENSIONS.map((extension) => base + extension), ...PROJECT_EXTENSIONS.map((extension) => path.join(base, `index${extension}`))];
    return candidates.find((candidate) => knownFiles.has(path.normalize(candidate)));
}

export function extractJavaScriptProjectGraph(projectDir: string): ProjectGraphResult {
    try {
        const root = path.resolve(projectDir);
        const files = walkProject(root);
        const knownFiles = new Set(files.map((file) => path.normalize(file)));
        const nodes: ProjectFileNode[] = [];
        const importsByFile = new Map<string, string[]>();
        const idByFile = new Map<string, string>();
        for (const absolute of files) {
            const languageId = languageIdForPath(absolute);
            if (!languageId || languageId === "python") continue;
            const source = fs.readFileSync(absolute, "utf8");
            const file = sourceFile(source, languageId, absolute);
            const definitions = collectDefinitions(file);
            const imports = moduleImports(file);
            const relPath = path.relative(root, absolute).replace(/\\/g, "/");
            const id = `js:${relPath}`;
            idByFile.set(path.normalize(absolute), id);
            importsByFile.set(path.normalize(absolute), imports);
            nodes.push({
                id,
                path: absolute,
                rel_path: relPath,
                dir: path.posix.dirname(relPath) === "." ? "" : path.posix.dirname(relPath),
                functions: definitions.filter((item) => item.kind === "function").map((item) => item.qualifiedName),
                symbols: definitions.map((item) => item.qualifiedName),
                imports,
            });
        }
        const edges: Array<{ from: string; to: string; label: string }> = [];
        const seen = new Set<string>();
        for (const absolute of files) {
            const from = idByFile.get(path.normalize(absolute));
            if (!from) continue;
            for (const specifier of importsByFile.get(path.normalize(absolute)) ?? []) {
                const resolved = resolveProjectImport(absolute, specifier, knownFiles);
                const to = resolved ? idByFile.get(path.normalize(resolved)) : undefined;
                const key = `${from}\0${to ?? ""}`;
                if (to && to !== from && !seen.has(key)) {
                    seen.add(key);
                    edges.push({ from, to, label: specifier });
                }
            }
        }
        return { nodes, edges, projectDir: root };
    } catch (error) {
        return { nodes: [], edges: [], projectDir, error: error instanceof Error ? error.message : String(error) };
    }
}
