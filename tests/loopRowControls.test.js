const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { loopRowControlsCss, loopRowControlsRuntime } = require('../out/view/loopRowControls');
const { buildCombinedWebView } = require('../out/view/combinedWebView');

function setup(functions) {
    class Element {
        constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.textContent = ''; this.classList = { toggle() {} }; }
        setAttribute(k, v) { this[k] = v; }
        append(...items) { items.forEach(item => { item.parent = this; this.children.push(item); }); }
        insertBefore(item, before) { item.parent = this; this.children.splice(this.children.indexOf(before), 0, item); }
        remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
        querySelectorAll(selector) { return this.children.flatMap(item => [item, ...item.querySelectorAll('*')]).filter(item => selector === '*' || item.className === selector.slice(1)); }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
        focus() { this.focused = true; }
    }
    const nodes = new Map();
    let api;
    const refresh = () => { api.refresh(); nodes.forEach((node, line) => api.render(node, line)); };
    api = vm.runInNewContext(loopRowControlsRuntime + ';installLoopRowControls({functions,afterChange})', {
        functions: () => functions, afterChange: refresh, document: { createElement: tag => new Element(tag) }
    });
    const row = line => { if (!nodes.has(line)) nodes.set(line, new Element('span')); refresh(); return nodes.get(line); };
    return { row, refresh, functions };
}
function trace(funcName = 'main', offset = 0) {
    return { funcName, startLine: 1 + offset, playback: {
        loops: [{ id: 1, headerLine: 2 + offset, parent: null }, { id: 2, headerLine: 3 + offset, parent: 1 }, { id: 3, headerLine: 5 + offset, parent: null }],
        counts: { 1: { '': 2 }, 2: { '1:1': 1, '1:2': 3 }, 3: { '': 2 } },
        samples: [1, 2].flatMap(outer => Array.from({ length: outer === 1 ? 1 : 3 }, (_, n) => ({ line: 4 + offset, path: [[1, outer], [2, n + 1]], text: `pair=${outer},${n}` }))),
        staticValues: []
    } };
}
test('row-local controls preserve DOM and sibling selections, resetting only descendants', () => {
    const s = setup([trace()]);
    const outer = s.row(2), inner = s.row(3), value = s.row(4), sibling = s.row(5);
    const button = outer.querySelector('.loop-next');
    assert.equal(inner.querySelector('.loop-next').hidden, true);
    sibling.querySelector('.loop-next').onclick();
    button.onclick();
    assert.equal(button.focused, true);
    assert.equal(outer.querySelector('.loop-next'), button);
    assert.equal(inner.querySelector('.loop-label').textContent, '1/3');
    inner.querySelector('.loop-next').onclick(); inner.querySelector('.loop-next').onclick();
    assert.equal(value.querySelector('.trace-value').textContent, 'pair=2,2');
    outer.querySelector('.loop-previous').onclick();
    assert.equal(inner.querySelector('.loop-label').textContent, '1/1');
    assert.equal(value.querySelector('.trace-value').textContent, 'pair=1,0');
    assert.equal(sibling.querySelector('.loop-label').textContent, '2/2');
});
test('functions have independent state and late removal removes stale row controls', () => {
    const s = setup([trace(), trace('other', 10)]), first = s.row(2), other = s.row(12);
    first.querySelector('.loop-next').onclick();
    assert.equal(other.querySelector('.loop-label').textContent, '1/2');
    s.functions.shift(); s.refresh();
    assert.equal(first.querySelector('.loop-controls'), null);
});
test('zero iterations has no active arrows or made-up values; legacy snapshots remain readable', () => {
    const fn = trace(); fn.playback.counts[1][''] = 0;
    const s = setup([fn]);
    assert.equal(s.row(2).querySelector('.loop-label').textContent, '0周');
    assert.equal(s.row(2).querySelector('.loop-next').hidden, true);
    assert.equal(s.row(4).querySelector('.trace-value').textContent, '');
    const legacy = setup([{funcName:'old',startLine:1,loop:{headerLine:2},iterations:[{values:[{line:3,text:'a=1'}]},{values:[{line:3,text:'a=2'}]}]}]);
    const result = legacy.row(3); legacy.row(2).querySelector('.loop-next').onclick();
    assert.equal(result.querySelector('.trace-value').textContent, 'a=2');
});
test('combined header contains no function loop controls; embedded script parses', () => {
    const html = buildCombinedWebView({file:'loops.py',trace:{functions:[trace()]}}, 'test');
    assert.doesNotMatch(html.match(/<header class="header" id="header">.*?<\/header>/s)[0], /trace-controls|loop-controls/);
    assert.match(html, /loopRows\.render\(traceRow\.querySelector\("\.trace-note"\),line\)/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    new vm.Script(script);
});
test('combined view gives code and sidebar trace independent horizontal panes with synchronized rows', () => {
    const html = buildCombinedWebView({file:'loops.py',trace:{functions:[trace()]}}, 'test');
    assert.match(html, /source-pane source-code-pane/);
    assert.match(html, /source-pane source-trace-pane/);
    assert.match(html, /panel trace-panel/);
    assert.match(html, /<header class="header" id="header">.*?<div class="tabs" id="tabs"><\/div>/);
    assert.doesNotMatch(html, /sidebar-head/);
    assert.match(html, /addTab\("trace","実行トレース"\)/);
    assert.doesNotMatch(html, /source-lines\{[^}]*grid-template-columns/);
    assert.match(html, /\.source-pane\{[^}]*overflow:auto/);
    assert.match(html, /\.trace-note\{[^}]*height:var\(--line-height\)[^}]*white-space:pre/);
    assert.doesNotMatch(html.match(/\.trace-note\{[^}]*\}/)[0], /pre-wrap|overflow-wrap/);
    assert.doesNotMatch(html, /trace-line/);
    assert.match(html, /const syncVertical=\(from,to\)=>\{if\(to\.scrollTop!==from\.scrollTop\)to\.scrollTop=from\.scrollTop\}/);
    assert.match(html, /codePane\.addEventListener\("scroll"/);
    assert.match(html, /tracePane\.addEventListener\("scroll"/);
});
test('loop controls use an amber button treatment distinct from cyan trace values', () => {
    assert.match(loopRowControlsCss, /\.loop-controls\{[^}]*color:#f1d995[^}]*background:#2d2a20/);
    assert.match(loopRowControlsCss, /\.loop-controls button\{[^}]*border:1px solid #796b3f[^}]*background:#433b22/);
    assert.match(loopRowControlsCss, /button:hover,[^}]*background:#5a4d27/);
    assert.doesNotMatch(loopRowControlsCss.match(/\.loop-controls\{[^}]*\}/)[0], /var\(--trace\)/);
});
