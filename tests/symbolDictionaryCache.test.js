const assert = require("assert");
const path = require("path");
const { spawnSync } = require("child_process");
const { findPython } = require("./pythonCommand");
const {
    buildSymbolDictionaryCacheIdentity,
    buildSymbolFingerprints,
    buildSymbolGenerationBatches,
    planSymbolDescriptionReuse,
} = require("../out/api/symbolDictionaryCache.js");

const root = path.join(__dirname, "..");
const parser = path.join(root, "python", "ast_parser.py");
const python = findPython();
const r0 = [
    "def calculate_total(price):",
    "    return price",
    "",
    "def format_label(name):",
    "    return name.strip().title()",
].join("\n");
const r1 = `${r0}\n\n# fixture revision R1`;
const r2 = r1.replace("return price", "return price * 1.10");

function symbols(code) {
    const result = spawnSync(python.command, [...python.args, parser, "symbols"], {
        cwd: root,
        input: code,
        encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
}

function cachedDescriptions(code, occurrences) {
    const fingerprints = buildSymbolFingerprints(code, occurrences);
    return [...new Map(occurrences.map((item) => [item.key, item])).values()].map((item) => ({
        symbolKey: item.key,
        symbolFingerprint: fingerprints.get(item.key),
        explanation: `${item.name}@1`,
    }));
}

const s0 = symbols(r0);
const uniqueKeys = [...new Set(s0.map((item) => item.key))];
assert.strictEqual(uniqueKeys.length, 6, "fixtureは名称辞書の6 unique keyを持つ");
const cached = cachedDescriptions(r0, s0);

const unrelatedEdit = planSymbolDescriptionReuse(r1, symbols(r1), cached);
assert.deepStrictEqual([...unrelatedEdit.missingKeys], [], "module末尾commentでは関数scopeの説明を失効しない");
assert.strictEqual(unrelatedEdit.reusedDescriptions.size, 6);

const scopedEdit = planSymbolDescriptionReuse(r2, symbols(r2), cached);
assert.deepStrictEqual(
    [...scopedEdit.missingKeys].sort(),
    ["<module>|function|calculate_total", "calculate_total|variable|price"].sort(),
    "calculate_total本体の変更は同scopeの2 keyだけを失効する",
);
assert.deepStrictEqual(
    [...scopedEdit.reusedDescriptions.keys()].sort(),
    uniqueKeys.filter((key) => !key.includes("calculate_total")).sort(),
    "format_label scopeの4 keyは再利用する",
);

const forced = planSymbolDescriptionReuse(r2, symbols(r2), cached, true);
assert.strictEqual(forced.missingKeys.size, 6, "手動再生成は全keyを失効する");
assert.strictEqual(forced.reusedDescriptions.size, 0);

const legacy = planSymbolDescriptionReuse(r0, s0, cached.map(({ symbolFingerprint: _old, ...item }) => item));
assert.strictEqual(legacy.missingKeys.size, 6, "fingerprintのない旧cacheは安全側で全keyを失効する");
assert.strictEqual(legacy.reusedDescriptions.size, 0);

const baseIdentity = buildSymbolDictionaryCacheIdentity({ model: "codex:gpt", globalContext: "初心者", providerAvailable: true });
assert.notStrictEqual(
    baseIdentity,
    buildSymbolDictionaryCacheIdentity({ model: "codex:gpt", globalContext: "熟練者", providerAvailable: true }),
    "global context変更でcache identityを変える",
);
assert.notStrictEqual(
    baseIdentity,
    buildSymbolDictionaryCacheIdentity({ model: "api:gpt", globalContext: "初心者", providerAvailable: true }),
    "effective model/provider変更でcache identityを変える",
);
assert.notStrictEqual(
    baseIdentity,
    buildSymbolDictionaryCacheIdentity({ model: "codex:gpt", globalContext: "初心者", providerAvailable: false }),
    "provider利用開始時にfallback説明を失効する",
);

console.log("symbol dictionary cache: selective reuse, force refresh, config invalidation passed");

const caller = [
    "RATE = 2", "", "def source_value():", "    return RATE", "",
    "def consumer():", "    result = source_value()", "    other = 3", "    return result + other", "",
    "def unrelated():", "    answer = 7", "    return answer",
].join("\n");
const callerSymbols = symbols(caller);
const callerCache = cachedDescriptions(caller, callerSymbols);
const changedCallee = caller.replace("return RATE", "return RATE * 100");
const calleeReuse = planSymbolDescriptionReuse(changedCallee, symbols(changedCallee), callerCache);
assert(calleeReuse.missingKeys.has("consumer|variable|result"), "callee return changes invalidate receiving variable");
assert(!calleeReuse.missingKeys.has("consumer|variable|other"), "unrelated caller variable does not receive callee evidence");
assert([...calleeReuse.reusedDescriptions.keys()].some(key => key === "unrelated|variable|answer"));
const changedConstant = caller.replace("RATE = 2", "RATE = 9");
const constantReuse = planSymbolDescriptionReuse(changedConstant, symbols(changedConstant), callerCache);
assert(constantReuse.missingKeys.has("consumer|variable|result"), "known transitive constant dependency invalidates result");
assert(!constantReuse.missingKeys.has("unrelated|variable|answer"));
const shifted = `\n\n${caller}`;
assert.strictEqual(planSymbolDescriptionReuse(shifted, symbols(shifted), callerCache).missingKeys.size, 0, "leading blank lines relocate without invalidation");
const shiftedFunction = caller.replace("def source_value", "\n\n\ndef source_value");
assert.strictEqual(planSymbolDescriptionReuse(shiftedFunction, symbols(shiftedFunction), callerCache).missingKeys.size, 0,
    "three blank lines before a function do not regenerate module RATE or any name");
const batches = buildSymbolGenerationBatches(caller, callerSymbols);
const fingerprints = buildSymbolFingerprints(caller, callerSymbols);
for (const batch of batches) {
    const inputHash = require("crypto").createHash("sha256").update(JSON.stringify(batch)).digest("hex");
    for (const target of batch.targets) assert.strictEqual(fingerprints.get(target.key), inputHash, "fingerprint is exactly the generation input hash");
}
const plain = "def total(values):\n    result = values + 1\n    return result";
assert.strictEqual(buildSymbolGenerationBatches(plain, symbols(plain)).length, 1, "same-scope names share one request");
console.log("symbol dictionary evidence: callee, transitive constants, line relocation, exact batch input passed");

const multiline = "RATE = (\n    2\n)\ndef source_value():\n    return RATE\ndef consumer():\n    result = (\n        source_value()\n    )\n    return result";
const multiSymbols = symbols(multiline);
assert(multiSymbols.every(item => Number.isInteger(item.statement_start) && Number.isInteger(item.statement_end)));
const multiCache = cachedDescriptions(multiline, multiSymbols);
const multiEdit = multiline.replace("    2", "    8");
assert(planSymbolDescriptionReuse(multiEdit, symbols(multiEdit), multiCache).missingKeys.has("consumer|variable|result"),
    "AST statement spans include multiline assignment dependencies");
const literal = "TEXT = '''first\nsecond\nthird'''\ndef read_text():\n    return TEXT";
const literalEdit = literal.replace("second", "changed");
assert(planSymbolDescriptionReuse(literalEdit, symbols(literalEdit), cachedDescriptions(literal, symbols(literal))).missingKeys.has("read_text|variable|TEXT"),
    "multiline string contents are not mistaken for independent statements");
console.log("symbol dictionary statement metadata: multiline expressions and literals passed");

const builtinPipeline = [
    "def normalize_names(values):",
    "    cleaned = [value.strip().lower() for value in values]",
    "    nonempty = [value for value in cleaned if value]",
    "    unique = list(dict.fromkeys(nonempty))",
    "    return sorted(unique)",
].join("\n");
const builtinBatches = buildSymbolGenerationBatches(builtinPipeline, symbols(builtinPipeline));
assert.strictEqual(builtinBatches.length, 1, "ordinary builtin/string pipeline shares one scope request");
assert.deepStrictEqual(builtinBatches[0].uncertainty, [], "standard Python operations are not unknown external calls");
assert.deepStrictEqual(builtinBatches[0].knownPython.builtins, ["dict", "list", "sorted"]);
assert.deepStrictEqual(builtinBatches[0].knownPython.conditionalMethods.map(item => item.name), ["fromkeys", "lower", "strip"]);
const builtinCache = cachedDescriptions(builtinPipeline, symbols(builtinPipeline));
for (const prefix of ["from external import sorted\n", "from external import *\n", "import external as sorted\n"]) {
    const shadowed = prefix + builtinPipeline;
    const batches = buildSymbolGenerationBatches(shadowed, symbols(shadowed));
    assert(batches.some(batch => batch.uncertainty.includes("sorted()")), "import shadowing keeps call uncertain");
    assert(batches.every(batch => !batch.knownPython.builtins.includes("sorted")), "shadowed name cannot claim builtin lookup");
    assert(planSymbolDescriptionReuse(shadowed, symbols(shadowed), builtinCache).missingKeys.size > 0,
        "changed builtin lookup evidence participates in fingerprint");
}
const unrelatedImport = `${builtinPipeline}\n\ndef another():\n    from external import sorted\n    return sorted([])`;
const unrelatedBatches = buildSymbolGenerationBatches(unrelatedImport, symbols(unrelatedImport));
assert(unrelatedBatches.find(batch => batch.targets.some(item => item.key === "normalize_names|function|sorted"))
    .knownPython.builtins.includes("sorted"), "other lexical scopes do not shadow local builtin lookup");
const localShadow = "def apply(sorted, values):\n    result = sorted(values)\n    return result";
assert(buildSymbolGenerationBatches(localShadow, symbols(localShadow)).some(batch => batch.uncertainty.includes("sorted()")));
console.log("symbol dictionary Python evidence: builtin lookup, conditional methods, import/parameter shadowing, one scope batch passed");
