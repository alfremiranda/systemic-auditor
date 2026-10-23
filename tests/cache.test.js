const vm = require("vm"), fs = require("fs"), assert = require("assert");
const CODE = fs.readFileSync(require("path").join(__dirname, "..", "code.js"), "utf8");
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const results = [];
async function test(name, fn) { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name + " :: " + (e && e.stack || e)]); } }

function makeNode(props) {
  const n = Object.assign({
    id: props.id, type: props.type || "RECTANGLE", name: props.name || props.id,
    children: [], parent: null,
    _pd: {},
    getPluginData(k) { return this._pd[k] || ""; },
    setPluginData(k, v) { this._pd[k] = v; },
    findAll(fn) { const out = []; const walk = (node) => { for (const c of (node.children || [])) { if (fn(c)) out.push(c); walk(c); } }; walk(this); return out; },
    findOne(fn) { for (const c of (this.children || [])) { if (fn(c)) return c; const r = c.findOne ? c.findOne(fn) : null; if (r) return r; } return null; },
  }, props);
  for (const c of (n.children || [])) c.parent = n;
  return n;
}

function boot({ storage = {}, nodes = {}, selection = [], collections = [], vars = [] } = {}) {
  const store = new Map(Object.entries(storage));
  const posted = [];
  const MIXED = Symbol("mixed");
  const callCounts = { collections: 0, vars: 0 };
  const figma = {
    showUI() {}, mixed: MIXED,
    notify: () => {},
    ui: { resize() {}, postMessage: m => posted.push(m), onmessage: null },
    clientStorage: {
      getAsync: async k => store.get(k),
      setAsync: async (k, v) => { store.set(k, v); },
      deleteAsync: async k => { store.delete(k); },
    },
    currentPage: { id: "p1", name: "Page", selection, children: Object.values(nodes).filter(n => !n.parent) },
    getNodeByIdAsync: async id => nodes[id] || null,
    getStyleByIdAsync: async () => null,
    getLocalTextStylesAsync: async () => [],
    getLocalPaintStylesAsync: async () => [],
    loadFontAsync: async () => {},
    setCurrentPageAsync: async () => {},
    variables: {
      getLocalVariableCollectionsAsync: async () => { callCounts.collections++; return collections; },
      getLocalVariablesAsync: async () => { callCounts.vars++; return vars; },
      getVariableByIdAsync: async () => null,
      getVariableCollectionByIdAsync: async () => null,
      setBoundVariableForPaint: (p) => p,
    },
    teamLibrary: undefined,
    viewport: { scrollAndZoomIntoView: () => {} },
  };
  const ctx = vm.createContext({ figma, __html__: "", console, setTimeout, clearTimeout, Date, Math, fetch: async () => { throw new Error("offline"); } });
  vm.runInContext(CODE, ctx);
  return { figma, ctx, posted, store, callCounts, get: n => vm.runInContext(n, ctx), send: m => figma.ui.onmessage(m) };
}
const solid = (r, g, b) => ({ type: "SOLID", color: { r, g, b }, opacity: 1, visible: true });

(async () => {
  await test("candidate lookups for many issues share one local-variable fetch (cached)", async () => {
    const collection = { id: "vc1", name: "Colors", modes: [{ modeId: "m1", name: "Default" }], defaultModeId: "m1", remote: false };
    const colorVar = {
      id: "V:1", name: "brand/primary", resolvedType: "COLOR", variableCollectionId: "vc1",
      valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } },
      resolveForConsumer: () => ({ resolvedType: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } }),
    };
    const nodes = {};
    for (let i = 0; i < 20; i++) {
      nodes["n" + i] = makeNode({ id: "n" + i, type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    }
    const b = boot({ nodes, collections: [collection], vars: [colorVar] });
    // Fire 20 concurrent candidate requests (simulating 20 rows all matching in the background).
    await Promise.all(Object.keys(nodes).map(id =>
      b.send({ type: "pro:autofix:candidates", id, kind: "fill", key: id + ":fill" })
    ));
    await tick(10);
    const replies = b.posted.filter(m => m.type === "pro:autofix:candidates");
    assert.strictEqual(replies.length, 20, "all 20 requests got a reply");
    for (const r of replies) {
      assert.ok(r.candidates.length >= 1, "each reply found the matching variable: " + JSON.stringify(r));
    }
    assert.strictEqual(b.callCounts.collections, 1, "getLocalVariableCollectionsAsync called once, not per-request (was " + b.callCounts.collections + ")");
    assert.strictEqual(b.callCounts.vars, 1, "getLocalVariablesAsync called once, not per-request (was " + b.callCounts.vars + ")");
  });

  await test("cache is cleared on a new run-audit (new scan re-fetches once)", async () => {
    const collection = { id: "vc1", name: "Colors", modes: [{ modeId: "m1", name: "Default" }], defaultModeId: "m1", remote: false };
    const colorVar = {
      id: "V:1", name: "brand/primary", resolvedType: "COLOR", variableCollectionId: "vc1",
      valuesByMode: { m1: { r: 1, g: 0, b: 0, a: 1 } },
      resolveForConsumer: () => ({ resolvedType: "COLOR", value: { r: 1, g: 0, b: 0, a: 1 } }),
    };
    const n1 = makeNode({ id: "n1", type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    const n2 = makeNode({ id: "n2", type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    const b = boot({ nodes: { n1, n2 }, selection: [n1, n2], collections: [collection], vars: [colorVar] });
    await b.send({ type: "pro:autofix:candidates", id: "n1", kind: "fill", key: "n1:fill" });
    await tick(5);
    assert.strictEqual(b.callCounts.collections, 1);
    await b.send({ type: "run-audit", options: { scanChildren: false, checkRogueFills: true, checkRogueStrokes: false, checkDetached: false, checkTextStyles: false } });
    await tick(5);
    await b.send({ type: "pro:autofix:candidates", id: "n2", kind: "fill", key: "n2:fill" });
    await tick(5);
    assert.strictEqual(b.callCounts.collections, 2, "cache invalidated by run-audit, refetched once for the new scan");
  });

  console.log(results.map(([s, n]) => `${s}  ${n}`).join("\n"));
  const fails = results.filter(r => r[0] === "FAIL").length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})();
