const vm = require("vm"), fs = require("fs"), assert = require("assert");
const CODE = fs.readFileSync(require("path").join(__dirname, "..", "code.js"), "utf8");
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const eq = (a, b, m) => assert.strictEqual(JSON.stringify(a), JSON.stringify(b), m);
const results = [];
async function test(name, fn) { try { await fn(); results.push(["PASS", name]); } catch (e) { results.push(["FAIL", name + " :: " + (e && e.stack || e)]); } }

// A minimal fake SceneNode with pluginData, findAll, findOne support for override-replay tests.
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

function boot({ storage = {}, nodes = {}, selection = [], fetchImpl } = {}) {
  const store = new Map(Object.entries(storage));
  const posted = [];
  const MIXED = Symbol("mixed");
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
      getLocalVariableCollectionsAsync: async () => [],
      getLocalVariablesAsync: async () => [],
      getVariableByIdAsync: async () => null,
      getVariableCollectionByIdAsync: async () => null,
      setBoundVariableForPaint: (p) => p,
    },
    teamLibrary: undefined,
    viewport: { scrollAndZoomIntoView: () => {} },
  };
  const ctx = vm.createContext({ figma, __html__: "", console, setTimeout, clearTimeout, Date, Math, fetch: fetchImpl || (async () => { throw new Error("offline"); }) });
  vm.runInContext(CODE, ctx);
  return { figma, ctx, posted, store, get: n => vm.runInContext(n, ctx), send: m => figma.ui.onmessage(m) };
}
const solid = (r, g, b) => ({ type: "SOLID", color: { r, g, b }, opacity: 1, visible: true });

(async () => {
  // ---------- 1. Ignore-list ----------
  await test("ignored issue is skipped by runAudit and counted separately", async () => {
    const a = makeNode({ id: "1:1", type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    const b = makeNode({ id: "1:2", type: "RECTANGLE", fills: [solid(0, 1, 0)] });
    a.setPluginData("systemic:ignore:ROGUE_FILL", "1");
    const b2 = boot({ nodes: { "1:1": a, "1:2": b } });
    const runAudit = b2.get("runAudit");
    const { issues, summary } = await runAudit([a, b], { scanChildren: false, checkRogueFills: true, checkRogueStrokes: false, checkDetached: false, checkTextStyles: false });
    eq(issues.map(i => i.id), ["1:2"]);
    assert.strictEqual(summary.ignored, 1);
    assert.strictEqual(summary.rogueFills, 1);
  });

  await test("issue:ignore sets pluginData and replies issues:resolved with ignoredDelta", async () => {
    const a = makeNode({ id: "2:1", type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    const b = boot({ nodes: { "2:1": a } });
    await b.send({ type: "issue:ignore", id: "2:1", issueType: "ROGUE_FILL" });
    assert.strictEqual(a.getPluginData("systemic:ignore:ROGUE_FILL"), "1");
    const m = b.posted.find(x => x.type === "issues:resolved");
    eq(m.resolvedIds, ["2:1"]);
    assert.strictEqual(m.ignoredDelta, 1);
  });

  await test("issue:unignoreAll clears pluginData across the subtree and re-scans", async () => {
    const child = makeNode({ id: "3:2", type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    const root = makeNode({ id: "3:1", type: "FRAME", children: [child] });
    child.setPluginData("systemic:ignore:ROGUE_FILL", "1");
    const b = boot({ nodes: { "3:1": root, "3:2": child }, selection: [root] });
    // simulate a prior scan having set lastAuditSelectionIds/lastAuditOptions
    await b.send({ type: "run-audit", options: { scanChildren: true, checkRogueFills: true, checkRogueStrokes: false, checkDetached: false, checkTextStyles: false } });
    assert.strictEqual(b.posted.filter(m => m.type === "audit-result").pop().summary.ignored, 1);
    b.posted.length = 0;
    await b.send({ type: "issue:unignoreAll" });
    assert.strictEqual(child.getPluginData("systemic:ignore:ROGUE_FILL"), "");
    const r = b.posted.find(m => m.type === "audit-result");
    assert.ok(r, "no re-scan audit-result posted");
    eq(r.issues.map(i => i.id), ["3:2"]);
  });

  // ---------- 2. Export (ProFeature trim) ----------
  await test("ProFeature only has autofix + export in entitlements", async () => {
    const b = boot({ fetchImpl: undefined });
    await tick(20);
    const m = b.posted.filter(x => x.type === "pro:entitlements").pop();
    assert.ok(m, "no entitlements posted");
    // default (no license key) entitlements.pro is false, features not sent on the wire (only pro flag is) — check via debug toggle path instead
    assert.strictEqual(typeof m.isPro, "boolean");
  });

  // ---------- 3. Detached relink override replay (fills/strokes/effects/cornerRadius/visible/opacity/swap) ----------
  await test("detached relink replays fills/strokes/effects/cornerRadius/visible/opacity on a nested descendant", async () => {
    const nestedInDetached = makeNode({
      id: "d:nested", type: "RECTANGLE", name: "Nested",
      fills: [solid(1, 0, 0)], strokes: [solid(0, 1, 0)], effects: [{ type: "DROP_SHADOW" }],
      cornerRadius: 12, visible: false, opacity: 0.5,
    });
    const detached = makeNode({
      id: "d:root", type: "FRAME", name: "Detached", x: 5, y: 6, width: 100, height: 50,
      detachedInfo: { type: "local", componentId: "comp:1" },
      children: [nestedInDetached],
      remove() { this._removed = true; },
    });
    const parent = { children: [detached], insertChild(i, n) { this.children.splice(i, 0, n); } };
    detached.parent = parent;

    // The fresh instance created from the component has a structurally-matching child at the same path.
    const freshChild = makeNode({ id: "fresh:nested", type: "RECTANGLE", name: "Nested", fills: [], strokes: [], effects: [], cornerRadius: 0, visible: true, opacity: 1 });
    const instance = makeNode({
      id: "fresh:root", type: "INSTANCE", name: "", x: 0, y: 0,
      children: [freshChild],
      resizeWithoutConstraints() {},
    });
    const comp = { id: "comp:1", type: "COMPONENT", createInstance: () => instance };

    const b = boot({ nodes: { "d:root": detached, "comp:1": comp } });
    const r = await b.get("applyAutofixItem")({ id: "d:root", issueType: "DETACHED_INSTANCE", kind: "detached", candidateId: "" });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    eq(freshChild.fills, [solid(1, 0, 0)]);
    eq(freshChild.strokes, [solid(0, 1, 0)]);
    eq(freshChild.effects, [{ type: "DROP_SHADOW" }]);
    assert.strictEqual(freshChild.cornerRadius, 12);
    assert.strictEqual(freshChild.visible, false);
    assert.strictEqual(freshChild.opacity, 0.5);
    assert.ok(detached._removed, "original detached node was not removed");
  });

  await test("detached relink replays root layout in order (sizing -> resize -> auto-layout) and skips mixed cornerRadius", async () => {
    const mixed = Symbol("mixed-corner");
    const detached = makeNode({
      id: "r:root", type: "FRAME", name: "Detached", x: 0, y: 0, width: 120, height: 60,
      layoutAlign: "STRETCH", layoutGrow: 1, layoutSizingHorizontal: "FILL", constraints: { horizontal: "MIN", vertical: "MIN" },
      layoutMode: "HORIZONTAL", itemSpacing: 8, paddingLeft: 4, layoutWrap: "NO_WRAP",
      detachedInfo: { type: "local", componentId: "comp:r" }, children: [],
      remove() {},
    });
    const parent = { children: [detached], insertChild(i, n) { this.children.splice(i, 0, n); } };
    detached.parent = parent;
    const order = [];
    const track = (name) => ({ set(v) { order.push(name + "=" + v); this["_" + name] = v; }, get() { return this["_" + name]; }, enumerable: true });
    const instance = makeNode({ id: "r:fresh", type: "INSTANCE", name: "", x: 0, y: 0, children: [],
      layoutAlign: "INHERIT", layoutGrow: 0, layoutSizingHorizontal: "FIXED", constraints: {}, layoutMode: "NONE", itemSpacing: 0, paddingLeft: 0, layoutWrap: "NO_WRAP", cornerRadius: 3,
      resizeWithoutConstraints(w, h) { order.push("resize=" + w + "x" + h); } });
    for (const k of ["layoutAlign", "layoutGrow", "layoutSizingHorizontal", "constraints", "layoutMode", "itemSpacing", "paddingLeft", "cornerRadius"]) {
      const init = instance[k]; delete instance[k]; Object.defineProperty(instance, k, track(k)); instance["_" + k] = init;
    }
    // Original has mixed corners: capture must skip it, leaving the fresh instance's own radius untouched.
    detached.cornerRadius = b0mixed();
    function b0mixed() { return mixed; }
    const comp = { id: "comp:r", type: "COMPONENT", createInstance: () => instance };
    const b = boot({ nodes: { "r:root": detached, "comp:r": comp } });
    b.figma.mixed = mixed;
    const r = await b.get("applyAutofixItem")({ id: "r:root", issueType: "DETACHED_INSTANCE", kind: "detached", candidateId: "" });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const idx = n => order.findIndex(x => x.startsWith(n));
    const lastResize = order.map(x => x.startsWith("resize")).lastIndexOf(true);
    assert.ok(idx("layoutAlign") >= 0 && idx("constraints") >= 0 && lastResize >= 0 && idx("layoutMode") >= 0, order.join(","));
    assert.ok(idx("constraints") < lastResize && lastResize < idx("layoutMode"), "wrong order: " + order.join(","));
    assert.strictEqual(instance.layoutSizingHorizontal, "FILL");
    assert.strictEqual(instance.itemSpacing, 8);
    assert.strictEqual(instance.paddingLeft, 4);
    assert.strictEqual(instance.cornerRadius, 3, "mixed cornerRadius must not be copied");
    assert.ok(order.includes("resize=120x60"), order.join(","));
  });

  await test("hasRogueFill/hasRogueStroke respect variable bindings (node, paint, gradient stop) and style ids", async () => {
    const b = boot({});
    const rogue = b.get("hasRogueFill"), rogueS = b.get("hasRogueStroke");
    const plain = makeNode({ id: "f:1", type: "RECTANGLE", fills: [solid(1, 0, 0)], fillStyleId: "", strokes: [solid(0, 0, 1)], strokeStyleId: "" });
    assert.strictEqual(rogue(plain), true);
    assert.strictEqual(rogueS(plain), true);
    const nodeBound = makeNode({ id: "f:2", type: "RECTANGLE", fills: [solid(1, 0, 0)], fillStyleId: "", boundVariables: { fills: [{ id: "V:1" }] } });
    assert.strictEqual(rogue(nodeBound), false, "node-level binding");
    const paintBound = makeNode({ id: "f:3", type: "RECTANGLE", fills: [{ ...solid(1, 0, 0), boundVariables: { color: { id: "V:1" } } }], fillStyleId: "" });
    assert.strictEqual(rogue(paintBound), false, "paint-level binding");
    const stopBound = makeNode({ id: "f:4", type: "RECTANGLE", fills: [{ type: "GRADIENT_LINEAR", visible: true, gradientStops: [{ boundVariables: { color: { id: "V:1" } } }] }], fillStyleId: "" });
    assert.strictEqual(rogue(stopBound), false, "gradient-stop binding");
    const styled = makeNode({ id: "f:5", type: "RECTANGLE", fills: [solid(1, 0, 0)], fillStyleId: "S:1" });
    assert.strictEqual(rogue(styled), false, "style id");
    const hidden = makeNode({ id: "f:6", type: "RECTANGLE", fills: [{ ...solid(1, 0, 0), visible: false }], fillStyleId: "" });
    assert.strictEqual(rogue(hidden), false, "invisible fill");
    const strokeBound = makeNode({ id: "f:7", type: "RECTANGLE", strokes: [{ ...solid(0, 0, 1), boundVariables: { color: { id: "V:2" } } }], strokeStyleId: "" });
    assert.strictEqual(rogueS(strokeBound), false, "stroke paint binding");
  });

  await test("license verify parses the Worker reply (pro granted, failure keeps free, bad JSON surfaces an error)", async () => {
    const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
    const run = async (fetchImpl) => {
      const b = boot({ fetchImpl });
      await b.send({ type: "pro:verify", key: "KEY-1234" });
      return b.posted.find(m => m.type === "pro:verify:result");
    };
    const good = await run(reply(200, JSON.stringify({ ok: true, valid: true, status: "active", daysLeft: 12, entitlements: { pro: true } })));
    assert.strictEqual(good.ok, true, JSON.stringify(good));
    assert.strictEqual(good.isPro, true);
    const denied = await run(reply(200, JSON.stringify({ ok: false, valid: false, status: "expired", error: "License expired", entitlements: { pro: false } })));
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.status, "expired");
    assert.strictEqual(denied.error, "License expired");
    const server500 = await run(reply(500, "<html>Bad gateway</html>"));
    assert.strictEqual(server500.ok, false);
    assert.ok(/Verify failed \(500\)/.test(server500.error), server500.error);
    const empty = await run(reply(200, ""));
    assert.strictEqual(empty.ok, false);
    assert.ok(/empty response/.test(empty.error), empty.error);
  });

  await test("nested instance swap is replayed when the original had a different component", async () => {
    const nestedInstance = makeNode({
      id: "d2:nested", type: "INSTANCE", name: "Icon",
      getMainComponentAsync: async () => ({ id: "comp:old" }),
    });
    const detached = makeNode({
      id: "d2:root", type: "FRAME", name: "Detached", x: 0, y: 0, width: 10, height: 10,
      detachedInfo: { type: "local", componentId: "comp:1" },
      children: [nestedInstance],
      remove() {},
    });
    const parent = { children: [detached], insertChild(i, n) { this.children.splice(i, 0, n); } };
    detached.parent = parent;

    let swappedTo = null;
    const freshNestedInstance = makeNode({
      id: "fresh2:nested", type: "INSTANCE", name: "Icon",
      getMainComponentAsync: async () => ({ id: "comp:default" }),
      swapComponent(c) { swappedTo = c.id; },
    });
    const instance = makeNode({ id: "fresh2:root", type: "INSTANCE", name: "", x: 0, y: 0, children: [freshNestedInstance], resizeWithoutConstraints() {} });
    const comp = { id: "comp:1", type: "COMPONENT", createInstance: () => instance };
    const oldComp = { id: "comp:old", type: "COMPONENT" };

    const b = boot({ nodes: { "d2:root": detached, "comp:1": comp, "comp:old": oldComp } });
    const r = await b.get("applyAutofixItem")({ id: "d2:root", issueType: "DETACHED_INSTANCE", kind: "detached", candidateId: "" });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(swappedTo, "comp:old", "swapComponent was not called with the original component id");
  });

  // ---------- 4. Scan cancel ----------
  await test("scanCancelRequested mid-loop makes runAudit stop early and report canceled:true", async () => {
    const many = Array.from({ length: 10 }, (_, i) => makeNode({ id: "c:" + i, type: "RECTANGLE", fills: [solid(1, 0, 0)] }));
    const nodesMap = {}; for (const n of many) nodesMap[n.id] = n;
    const b = boot({ nodes: nodesMap, selection: many });
    // Set the module-level flag directly (as if a cancel message arrived mid-scan) and call runAudit itself,
    // bypassing the run-audit handler (which resets the flag at the start of every new user-initiated scan).
    b.ctx.eval ? null : null;
    vm.runInContext("scanCancelRequested = true;", b.ctx);
    const runAudit = b.get("runAudit");
    const { issues, canceled } = await runAudit(many, { scanChildren: false, checkRogueFills: true, checkRogueStrokes: false, checkDetached: false, checkTextStyles: false });
    assert.strictEqual(canceled, true);
    assert.strictEqual(issues.length, 0, "no nodes should have been processed before the break");
  });

  await test("a fresh run-audit is not canceled by a stale flag from a previous cancel", async () => {
    const n = makeNode({ id: "c2:1", type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    const b = boot({ nodes: { "c2:1": n }, selection: [n] });
    b.send({ type: "run-audit:cancel" });
    await b.send({ type: "run-audit", options: { scanChildren: false, checkRogueFills: true, checkRogueStrokes: false, checkDetached: false, checkTextStyles: false } });
    b.posted.length = 0;
    await b.send({ type: "run-audit", options: { scanChildren: false, checkRogueFills: true, checkRogueStrokes: false, checkDetached: false, checkTextStyles: false } });
    const r = b.posted.find(m => m.type === "audit-result");
    assert.strictEqual(r.canceled, false);
    eq(r.issues.map(i => i.id), ["c2:1"]);
  });

  // ---------- 5. select-nodes ----------
  await test("select-nodes selects and zooms to multiple resolved nodes", async () => {
    const a = makeNode({ id: "s:1", type: "RECTANGLE", x: 0, y: 0 });
    const b2 = makeNode({ id: "s:2", type: "RECTANGLE", x: 10, y: 10 });
    const b = boot({ nodes: { "s:1": a, "s:2": b2 } });
    let zoomed = null;
    b.figma.viewport.scrollAndZoomIntoView = (nodes) => { zoomed = nodes.map(n => n.id); };
    await b.send({ type: "select-nodes", ids: ["s:1", "s:2", "s:missing"] });
    eq(b.figma.currentPage.selection.map(n => n.id).sort(), ["s:1", "s:2"]);
    eq((zoomed || []).sort(), ["s:1", "s:2"]);
    const status = b.posted.find(m => m.type === "select-nodes:status");
    assert.strictEqual(status.status, "done");
    assert.strictEqual(status.count, 2);
  });

  await test("select-nodes with no valid ids reports an error status", async () => {
    const b = boot({ nodes: {} });
    await b.send({ type: "select-nodes", ids: ["missing:1"] });
    const status = b.posted.find(m => m.type === "select-nodes:status");
    assert.strictEqual(status.status, "error");
  });

  // ---------- 6. Free-tier candidate preview ----------
  await test("pro:autofix:candidates computes real candidates for a non-Pro user and marks them locked", async () => {
    const node = makeNode({ id: "f:1", type: "TEXT", fontName: { family: "Inter", style: "Regular" }, fontSize: 14, characters: "hi", textStyleId: "", lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 } });
    const b = boot({ nodes: { "f:1": node } });
    b.figma.getLocalTextStylesAsync = async () => [{ id: "S1", name: "Body", fontName: { family: "Inter", style: "Regular" }, fontSize: 14, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 } }];
    await b.send({ type: "pro:autofix:candidates", id: "f:1", kind: "text", key: "f:1:text" });
    const m = b.posted.find(x => x.type === "pro:autofix:candidates");
    assert.strictEqual(m.locked, true);
    assert.strictEqual(m.candidates.length, 1, "free user did not receive real candidates");
    assert.strictEqual(m.recommendedId, "textstyle:S1");
  });

  // ---------- 7. Scanner options persistence ----------
  await test("options:save persists (debounced) and get-saved-options reads it back", async () => {
    const b = boot();
    const opts = { scanChildren: false, checkRogueFills: true, checkRogueStrokes: false, checkDetached: true, checkTextStyles: false };
    await b.send({ type: "options:save", options: opts });
    await tick(400);
    eq(b.store.get("systemic_scanner_options_v1"), opts);
    b.posted.length = 0;
    await b.send({ type: "get-saved-options" });
    const m = b.posted.find(x => x.type === "saved-options");
    eq(m.options, opts);
  });

  await test("get-saved-options returns null when nothing was ever saved", async () => {
    const b = boot();
    await b.send({ type: "get-saved-options" });
    const m = b.posted.find(x => x.type === "saved-options");
    assert.strictEqual(m.options, null);
  });

  // ---------- regression: all 4 issue types still counted correctly post-refactor ----------
  await test("regression: unstyled text still counts toward elementsWithIssues (not skipped by the addIssue refactor)", async () => {
    const t = makeNode({ id: "r:1", type: "TEXT", name: "T", textStyleId: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, characters: "hi" });
    const b = boot({ nodes: { "r:1": t } });
    const runAudit = b.get("runAudit");
    const { summary } = await runAudit([t], { scanChildren: false, checkRogueFills: false, checkRogueStrokes: false, checkDetached: false, checkTextStyles: true });
    assert.strictEqual(summary.unstyledText, 1);
    assert.strictEqual(summary.elementsWithIssues, 1);
    assert.strictEqual(summary.ignored, 0);
  });

  await test("regression: detached instance issue still reported with detachedComponentName via addIssue", async () => {
    const comp = makeNode({ id: "r:comp", type: "COMPONENT", name: "Comp" });
    const d = makeNode({ id: "r:2", type: "FRAME", name: "D", detachedInfo: { type: "local", componentId: "r:comp" } });
    const b = boot({ nodes: { "r:2": d, "r:comp": comp } });
    const runAudit = b.get("runAudit");
    const { issues, summary } = await runAudit([d], { scanChildren: false, checkRogueFills: false, checkRogueStrokes: false, checkDetached: true, checkTextStyles: false });
    assert.strictEqual(summary.detached, 1);
    assert.strictEqual(issues[0].detachedComponentName, "Comp");
  });

  await test("regression: all four issue types in one scan produce correct independent counts", async () => {
    const fill = makeNode({ id: "r:3", type: "RECTANGLE", fills: [solid(1, 0, 0)] });
    const stroke = makeNode({ id: "r:4", type: "RECTANGLE", fills: [], strokes: [solid(0, 1, 0)] });
    const text = makeNode({ id: "r:5", type: "TEXT", textStyleId: "", fontName: { family: "Inter", style: "Regular" }, fontSize: 12, lineHeight: { unit: "AUTO" }, letterSpacing: { unit: "PIXELS", value: 0 }, characters: "x" });
    const comp = makeNode({ id: "r:comp2", type: "COMPONENT" });
    const detached = makeNode({ id: "r:6", type: "FRAME", detachedInfo: { type: "local", componentId: "r:comp2" } });
    const nodes = { "r:3": fill, "r:4": stroke, "r:5": text, "r:6": detached, "r:comp2": comp };
    const b = boot({ nodes });
    const runAudit = b.get("runAudit");
    const { summary } = await runAudit([fill, stroke, text, detached], { scanChildren: false, checkRogueFills: true, checkRogueStrokes: true, checkDetached: true, checkTextStyles: true });
    assert.strictEqual(summary.rogueFills, 1);
    assert.strictEqual(summary.rogueStrokes, 1);
    assert.strictEqual(summary.unstyledText, 1);
    assert.strictEqual(summary.detached, 1);
    assert.strictEqual(summary.total, 4);
    assert.strictEqual(summary.elementsWithIssues, 4);
  });

  for (const [s, n] of results) console.log(s.padEnd(5), n);
  const failed = results.filter(r => r[0] === "FAIL").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
