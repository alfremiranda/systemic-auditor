"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
const DEFAULT_W = 440;
const DEFAULT_H = 540;
const MIN_W = 360;
const MIN_H = 360; // the condensed empty/no-selection state fits well under this
// Show the plugin window
figma.showUI(__html__, { width: DEFAULT_W, height: DEFAULT_H, title: "Systemic Auditor" });
// Restore last window size (if available)
(() => __awaiter(void 0, void 0, void 0, function* () {
    const saved = yield figma.clientStorage.getAsync("uiSize");
    if (saved && typeof saved.width === "number" && typeof saved.height === "number") {
        const width = Math.max(MIN_W, Math.round(saved.width));
        const height = Math.max(MIN_H, Math.round(saved.height));
        figma.ui.resize(width, height);
    }
}))();
const ENTITLEMENTS_STORAGE_KEY = "systemic_entitlements_v1";
const LICENSE_KEY_STORAGE_KEY = "systemic_license_key_v1";
const INSTANCE_ID_STORAGE_KEY = "systemic_instance_id";
const DEBUG_PRO_STORAGE_KEY = "systemic_debug_pro_override";
const SCANNER_OPTIONS_STORAGE_KEY = "systemic_scanner_options_v1";
// ✅ DEV OVERRIDE (set true locally when testing Pro features)
const DEV_PRO = false;
// ✅ DEV license state override for UI testing ("expired" | "trial" | "pro" | null)
const DEV_FORCE_LICENSE_STATUS = null;
// ✅ Cloudflare Worker (License server)
const LICENSE_WORKER_BASE = "https://systemic-license.im-94e.workers.dev";
const WORKER_VERIFY_URL = `${LICENSE_WORKER_BASE}/verify`;
const WORKER_ACTIVATE_URL = `${LICENSE_WORKER_BASE}/activate`;
// ✅ Secret header to protect the Worker (matches env.SYSTEMIC_TOKEN)
// NOTE: This is still visible in the plugin bundle; later we can harden this.
const SYSTEMIC_TOKEN = "rK8pVt_3Qm7nZx2Lh6YbW9cD1sF4aJ0uN5gHkP2eT8vXqM3iR7wS1yU6oC9lB4d";
const ALL_PRO_FEATURES = ["autofix", "export"];
function stringifyMessage(value) {
    if (typeof value === "string")
        return value;
    if (value instanceof Error && value.message)
        return value.message;
    if (value == null)
        return "";
    const seen = new WeakSet();
    try {
        return JSON.stringify(value, (_key, val) => {
            if (val && typeof val === "object") {
                if (seen.has(val))
                    return "[Circular]";
                seen.add(val);
            }
            return val;
        });
    }
    catch (_a) {
        return String(value);
    }
}
function makeDefaultEntitlements() {
    return {
        pro: false,
        source: "none",
        features: {
            autofix: false,
            export: false,
        },
    };
}
function makeDevEntitlements() {
    const features = ALL_PRO_FEATURES.reduce((acc, f) => {
        acc[f] = true;
        return acc;
    }, {});
    return { pro: true, source: "dev", features };
}
function makeDebugEntitlements(isPro) {
    if (!isPro)
        return makeDefaultEntitlements();
    const features = ALL_PRO_FEATURES.reduce((acc, f) => {
        acc[f] = true;
        return acc;
    }, {});
    return { pro: true, source: "dev", features };
}
function loadDebugProOverride() {
    return __awaiter(this, void 0, void 0, function* () {
        const saved = yield figma.clientStorage.getAsync(DEBUG_PRO_STORAGE_KEY);
        return typeof saved === "boolean" ? saved : null;
    });
}
function isExpired(ent) {
    if (!ent.expiresAt)
        return false;
    return Date.now() > ent.expiresAt;
}
function loadEntitlements() {
    return __awaiter(this, void 0, void 0, function* () {
        if (DEV_PRO)
            return makeDevEntitlements();
        // Always start fresh each launch; do not persist Pro status across sessions.
        return makeDefaultEntitlements();
    });
}
function hasFeature(ent, feature) {
    var _a;
    return !!ent.pro && !!((_a = ent.features) === null || _a === void 0 ? void 0 : _a[feature]) && !isExpired(ent);
}
function loadLibraryVariables(varsApi_1) {
    return __awaiter(this, arguments, void 0, function* (varsApi, force = false) {
        if (!figma.teamLibrary || typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== "function") {
            return [];
        }
        if (!varsApi || typeof varsApi.importVariableByKeyAsync !== "function") {
            return [];
        }
        // A load is already running: share it instead of importing the same variables twice.
        if (libraryLoadPromise)
            return libraryLoadPromise;
        const now = Date.now();
        if (!force && libraryVariablesLoaded) {
            return Array.from(libraryVariableCache.values());
        }
        if (!force && libraryVariableCache.size === 0 && now - libraryVariablesLastAttempt < 5000) {
            return [];
        }
        libraryVariablesLastAttempt = now;
        libraryLoadPromise = (() => __awaiter(this, void 0, void 0, function* () {
            try {
                return yield importLibraryVariables(varsApi);
            }
            finally {
                libraryLoadPromise = null;
            }
        }))();
        return libraryLoadPromise;
    });
}
function importLibraryVariables(varsApi) {
    return __awaiter(this, void 0, void 0, function* () {
        libraryVariablesLoading = true;
        try {
            const collections = yield figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
            libraryCollectionsCount = collections.length;
            for (const collection of collections) {
                const variables = yield figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
                for (const variable of variables) {
                    if (variable.resolvedType !== "COLOR")
                        continue;
                    if (libraryVariableCache.has(variable.key))
                        continue;
                    try {
                        const imported = yield varsApi.importVariableByKeyAsync(variable.key);
                        if (imported) {
                            let hydrated = imported;
                            try {
                                if (typeof varsApi.getVariableByIdAsync === "function") {
                                    const fetched = yield varsApi.getVariableByIdAsync(imported.id);
                                    if (fetched)
                                        hydrated = fetched;
                                }
                            }
                            catch (_a) {
                                // ignore hydration failures
                            }
                            libraryVariableCache.set(variable.key, hydrated);
                        }
                    }
                    catch (_b) {
                        libraryImportErrors += 1;
                        // ignore import failures
                    }
                }
            }
        }
        finally {
            libraryVariablesLoaded = libraryVariableCache.size > 0;
            libraryVariablesLoading = false;
        }
        return Array.from(libraryVariableCache.values());
    });
}
let entitlements = makeDefaultEntitlements();
let autofixCancelRequested = false;
let scanCancelRequested = false;
// Ignore-list: stored on each node itself (travels with the file, visible to teammates),
// not in clientStorage (which is per-device). Keyed "<ISSUE_TYPE>", one pluginData entry per type.
function ignoreDataKey(issueType) {
    return `systemic:ignore:${issueType}`;
}
function isIssueIgnored(node, issueType) {
    try {
        return node.getPluginData(ignoreDataKey(issueType)) === "1";
    }
    catch (_a) {
        return false;
    }
}
const libraryVariableCache = new Map();
let libraryVariablesLoaded = false;
let libraryVariablesLastAttempt = 0;
let libraryCollectionsCount = 0;
let libraryImportErrors = 0;
let libraryVariablesLoading = false;
let libraryLoadPromise = null;
// Variable id + mode id -> resolved color. Cleared at the start of every scan.
const variableColorCache = new Map();
// Local variable collections + color variables are identical across every candidate-matching
// request in a batch (nothing changes the document while the user watches the spinner), but
// findColorCandidates() re-fetched them from Figma on every single call — the dominant cost under
// a heavy scan (many rogue-fill/-stroke issues fire one candidate request each). Cache them for a
// few seconds so a batch of requests shares one fetch instead of re-fetching per issue.
let localColorVariablesCache = null;
let localColorVariablesLoadPromise = null;
const LOCAL_COLOR_VARS_CACHE_TTL_MS = 5000;
let storedLicenseKey = "";
let autofixRunning = false;
let licenseInfo = { status: null };
const LAST_VERIFIED_STORAGE_KEY = "systemic_last_verified_v1";
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
function buildEntitlementsMessage(extra = {}) {
    const isPro = !!entitlements.pro && !isExpired(entitlements);
    return Object.assign({ type: "pro:entitlements", isPro, entitlements: { pro: isPro }, source: entitlements.source, expiresAt: entitlements.expiresAt, licenseKeyLast4: entitlements.licenseKeyLast4, licenseKey: storedLicenseKey, status: licenseInfo.status, valid: licenseInfo.valid, daysLeft: licenseInfo.daysLeft, offline: licenseInfo.offline }, extra);
}
function rememberSuccessfulVerify(status) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield figma.clientStorage.setAsync(LAST_VERIFIED_STORAGE_KEY, { at: Date.now(), status });
        }
        catch (_a) {
            /* ignore storage failures */
        }
    });
}
function forgetLastVerified() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            yield figma.clientStorage.deleteAsync(LAST_VERIFIED_STORAGE_KEY);
        }
        catch (_a) {
            /* ignore storage failures */
        }
    });
}
// Returns true when a previous non-trial verification is recent enough to keep Pro offline.
function withinOfflineGrace() {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            const saved = yield figma.clientStorage.getAsync(LAST_VERIFIED_STORAGE_KEY);
            if (!saved || typeof saved.at !== "number")
                return { ok: false, status: null };
            const status = typeof saved.status === "string" ? saved.status : null;
            if (status === "trial")
                return { ok: false, status };
            return { ok: Date.now() - saved.at < OFFLINE_GRACE_MS, status };
        }
        catch (_a) {
            return { ok: false, status: null };
        }
    });
}
function loadStoredLicenseKey() {
    return __awaiter(this, void 0, void 0, function* () {
        const key = yield figma.clientStorage.getAsync(LICENSE_KEY_STORAGE_KEY);
        storedLicenseKey = typeof key === "string" ? key : "";
        return storedLicenseKey;
    });
}
function saveStoredLicenseKey(key) {
    return __awaiter(this, void 0, void 0, function* () {
        storedLicenseKey = key;
        yield figma.clientStorage.setAsync(LICENSE_KEY_STORAGE_KEY, key);
    });
}
function clearStoredLicenseKey() {
    return __awaiter(this, void 0, void 0, function* () {
        storedLicenseKey = "";
        yield figma.clientStorage.deleteAsync(LICENSE_KEY_STORAGE_KEY);
    });
}
// Initialize entitlements and send to UI
(() => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b;
    entitlements = yield loadEntitlements();
    yield loadStoredLicenseKey();
    if (DEV_PRO) {
        const debugOverride = yield loadDebugProOverride();
        if (debugOverride !== null) {
            entitlements = makeDebugEntitlements(debugOverride);
        }
    }
    if (storedLicenseKey) {
        figma.ui.postMessage({ type: "pro:verify:state", state: "verifying", source: "startup" });
        // Network failures and 5xx answers are "transient": a paying user who is offline keeps Pro
        // for OFFLINE_GRACE_MS after their last successful (non-trial) verification. An explicit
        // denial from the Worker downgrades immediately.
        let result = null;
        let failure = "";
        try {
            const instanceId = yield getOrCreateInstanceId();
            result = yield verifyLicenseWithWorker(storedLicenseKey, instanceId);
        }
        catch (e) {
            failure = stringifyMessage(e) || "Verify failed.";
        }
        if (result && !result.transient) {
            const isPro = !!((_a = result.entitlements) === null || _a === void 0 ? void 0 : _a.pro) && !!result.ok;
            licenseInfo = {
                status: (_b = result.status) !== null && _b !== void 0 ? _b : null,
                valid: typeof result.valid === "boolean" ? result.valid : undefined,
                daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
            };
            if (isPro) {
                entitlements = makeLicenseEntitlements(storedLicenseKey);
                if (licenseInfo.status !== "trial")
                    yield rememberSuccessfulVerify(licenseInfo.status);
            }
            else {
                entitlements = makeDefaultEntitlements();
                yield forgetLastVerified();
            }
            figma.ui.postMessage(buildEntitlementsMessage({ error: result.error }));
        }
        else {
            // Could not reach the Worker (fetch threw, or HTTP 5xx/429).
            const grace = yield withinOfflineGrace();
            const error = (result && result.error) || failure || "Verify failed.";
            if (grace.ok) {
                entitlements = makeLicenseEntitlements(storedLicenseKey);
                licenseInfo = { status: grace.status, offline: true };
            }
            else {
                entitlements = makeDefaultEntitlements();
                licenseInfo = { status: null };
            }
            figma.ui.postMessage(buildEntitlementsMessage({ error }));
        }
    }
    else {
        figma.ui.postMessage(buildEntitlementsMessage());
    }
}))();
let lastAuditOptions = null;
let lastAuditSelectionIds = [];
function isMixed(value) {
    return value === figma.mixed;
}
function findAllNodes(root) {
    return "findAll" in root ? root.findAll(() => true) : [];
}
function getNodePath(node) {
    const parts = [];
    let current = node;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
        parts.unshift(current.name || current.type);
        current = current.parent;
    }
    if (parts.length > 4)
        return "… / " + parts.slice(-4).join(" / ");
    return parts.join(" / ");
}
function hasChildren(node) {
    return "children" in node;
}
function collectNodes(start, scanChildren) {
    const out = [];
    const visit = (n) => {
        out.push(n);
        if (scanChildren && hasChildren(n)) {
            for (const child of n.children)
                visit(child);
        }
    };
    for (const n of start)
        visit(n);
    return out;
}
function isDetachedInstanceLike(node) {
    return node.detachedInfo != null;
}
function canCheckDetachedInfo(node) {
    return node.detachedInfo !== undefined;
}
const detachedLabelCache = new Map();
function getDetachedComponentName(info) {
    return __awaiter(this, void 0, void 0, function* () {
        const key = info.type === "local" ? `local:${info.componentId}` : `lib:${info.componentKey}`;
        const cached = detachedLabelCache.get(key);
        if (cached)
            return cached;
        let label = info.type === "library" ? "Library component" : "Component";
        try {
            if (info.type === "local") {
                const comp = yield figma.getNodeByIdAsync(info.componentId);
                if (comp && "name" in comp) {
                    if (comp.type === "COMPONENT" && comp.parent && comp.parent.type === "COMPONENT_SET") {
                        label = comp.parent.name || comp.name || label;
                    }
                    else {
                        label = comp.name || label;
                    }
                }
            }
            else {
                const comp = yield figma.importComponentByKeyAsync(info.componentKey);
                if (comp && "name" in comp) {
                    if (comp.parent && comp.parent.type === "COMPONENT_SET") {
                        label = comp.parent.name || comp.name || label;
                    }
                    else {
                        label = comp.name || label;
                    }
                }
            }
        }
        catch (_a) {
            // keep fallback label
        }
        detachedLabelCache.set(key, label);
        return label;
    });
}
function createInstanceFromDetachedInfo(info) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            if (info.type === "local") {
                const comp = yield figma.getNodeByIdAsync(info.componentId);
                if (!comp)
                    return null;
                if (comp.type === "COMPONENT") {
                    return comp.createInstance();
                }
                if (comp.type === "COMPONENT_SET") {
                    return comp.defaultVariant.createInstance();
                }
                return null;
            }
            if (info.type === "library") {
                const comp = yield figma.importComponentByKeyAsync(info.componentKey);
                if (!comp)
                    return null;
                return comp.createInstance();
            }
        }
        catch (_a) {
            return null;
        }
        return null;
    });
}
function buildNodePath(node, root) {
    const parts = [];
    let current = node;
    while (current && current.id !== root.id && current.type !== "PAGE" && current.type !== "DOCUMENT") {
        let indexSuffix = "";
        if (current.parent && "children" in current.parent) {
            const siblings = current.parent.children;
            const idx = siblings.indexOf(current);
            if (idx >= 0)
                indexSuffix = `#${idx}`;
        }
        parts.unshift(`${current.name || "unnamed"}${indexSuffix}`);
        current = current.parent;
    }
    return parts.join(" > ");
}
// Order matters when writing back: sizing/constraints before the auto-layout block, which
// (for the root) is separated by the resize call.
const LAYOUT_PRE_PROPS = [
    ["layoutAlign", "truthy"],
    ["layoutGrow", "number"],
    ["layoutSizingHorizontal", "truthy"],
    ["layoutSizingVertical", "truthy"],
    ["constraints", "truthy"],
];
const LAYOUT_POST_PROPS = [
    ["layoutMode", "truthy"],
    ["primaryAxisAlignItems", "truthy"],
    ["counterAxisAlignItems", "truthy"],
    ["primaryAxisSizingMode", "truthy"],
    ["counterAxisSizingMode", "truthy"],
    ["itemSpacing", "number"],
    ["paddingLeft", "number"],
    ["paddingRight", "number"],
    ["paddingTop", "number"],
    ["paddingBottom", "number"],
    ["layoutWrap", "truthy"],
];
const VISUAL_PROPS = [
    ["fills", "paints"],
    ["strokes", "paints"],
    ["effects", "paints"],
    ["visible", "boolean"],
    ["opacity", "number"],
    ["cornerRadius", "number"],
    ["topLeftRadius", "number"],
    ["topRightRadius", "number"],
    ["bottomLeftRadius", "number"],
    ["bottomRightRadius", "number"],
];
function captureProps(node, override, specs) {
    const src = node;
    const dst = override;
    for (const [key] of specs) {
        if (!(key in node))
            continue;
        // cornerRadius is figma.mixed when the corners differ; the per-corner props carry that case.
        if (key === "cornerRadius" && isMixed(src[key]))
            continue;
        dst[key] = src[key];
    }
}
function applyProps(node, override, specs) {
    const target = node;
    const stored = override;
    for (const [key, kind] of specs) {
        if (!(key in node))
            continue;
        const value = stored[key];
        const valid = kind === "number" ? typeof value === "number" : kind === "boolean" ? typeof value === "boolean" : !!value;
        if (!valid)
            continue;
        try {
            target[key] = kind === "paints" ? value.slice() : value;
        }
        catch (_a) {
            /* ignore */
        }
    }
}
// Fills/strokes/effects/corner-radius/visible/opacity: shared between the root node and every
// descendant, so a detached relink also restores an instance's own paint/effect/radius tweaks,
// not just its layout and text. All synchronous — no font loading or async API involved.
function captureVisualOverride(node, override) {
    captureProps(node, override, VISUAL_PROPS);
}
function applyVisualOverride(node, override) {
    applyProps(node, override, VISUAL_PROPS);
}
function resizeNode(node, width, height) {
    const r = node;
    if (typeof r.resizeWithoutConstraints === "function")
        r.resizeWithoutConstraints(width, height);
    else if (typeof r.resize === "function")
        r.resize(width, height);
}
function collectInstanceOverrides(root) {
    return __awaiter(this, void 0, void 0, function* () {
        const map = new Map();
        const rootOverride = {};
        captureProps(root, rootOverride, LAYOUT_PRE_PROPS);
        if ("width" in root)
            rootOverride.width = root.width;
        if ("height" in root)
            rootOverride.height = root.height;
        captureProps(root, rootOverride, LAYOUT_POST_PROPS);
        captureVisualOverride(root, rootOverride);
        if (Object.keys(rootOverride).length > 0) {
            map.set("__root__", rootOverride);
        }
        const nodes = findAllNodes(root);
        for (const node of nodes) {
            const path = buildNodePath(node, root);
            if (!path)
                continue;
            const override = {};
            if (node.type === "TEXT") {
                const textNode = node;
                override.text = textNode.characters;
                override.textAlignHorizontal = textNode.textAlignHorizontal;
                override.textAlignVertical = textNode.textAlignVertical;
                override.textAutoResize = textNode.textAutoResize;
            }
            if (node.type === "INSTANCE") {
                // Best-effort: a nested instance (unrelated to the outer detach) may have been swapped to
                // a different component. mainComponent is write-only under dynamic-page — read via the async getter.
                try {
                    const main = yield node.getMainComponentAsync();
                    if (main)
                        override.mainComponentId = main.id;
                }
                catch (_a) {
                    /* ignore */
                }
            }
            captureProps(node, override, LAYOUT_PRE_PROPS);
            captureProps(node, override, LAYOUT_POST_PROPS);
            captureVisualOverride(node, override);
            if (Object.keys(override).length > 0) {
                map.set(path, override);
            }
        }
        return map;
    });
}
function loadTextNodeFonts(node) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            if (node.fontName !== figma.mixed) {
                yield figma.loadFontAsync(node.fontName);
                return;
            }
            const fontNames = node.getRangeAllFontNames(0, node.characters.length);
            for (const fontName of fontNames) {
                yield figma.loadFontAsync(fontName);
            }
        }
        catch (_a) {
            // ignore font load errors; we'll skip applying text if loading fails
        }
    });
}
function applyInstanceOverridesToInstance(instance, overrides) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!overrides.size)
            return;
        const rootOverride = overrides.get("__root__");
        if (rootOverride) {
            applyProps(instance, rootOverride, LAYOUT_PRE_PROPS);
            if (typeof rootOverride.width === "number" && typeof rootOverride.height === "number") {
                try {
                    resizeNode(instance, rootOverride.width, rootOverride.height);
                }
                catch (_a) {
                    // ignore resize errors on auto-layout instances
                }
            }
            applyProps(instance, rootOverride, LAYOUT_POST_PROPS);
            applyVisualOverride(instance, rootOverride);
        }
        const nodes = findAllNodes(instance);
        for (const node of nodes) {
            const path = buildNodePath(node, instance);
            if (!path || !overrides.has(path))
                continue;
            const override = overrides.get(path);
            if (!override)
                continue;
            if (node.type === "TEXT") {
                const textNode = node;
                if (typeof override.text === "string" && textNode.characters !== override.text) {
                    yield loadTextNodeFonts(textNode);
                    try {
                        textNode.characters = override.text;
                    }
                    catch (_b) {
                        // ignore if fonts failed to load or text is read-only
                    }
                }
                if (override.textAlignHorizontal) {
                    try {
                        textNode.textAlignHorizontal = override.textAlignHorizontal;
                    }
                    catch ( /* ignore */_c) { /* ignore */ }
                }
                if (override.textAlignVertical) {
                    try {
                        textNode.textAlignVertical = override.textAlignVertical;
                    }
                    catch ( /* ignore */_d) { /* ignore */ }
                }
                if (override.textAutoResize) {
                    try {
                        textNode.textAutoResize = override.textAutoResize;
                    }
                    catch ( /* ignore */_f) { /* ignore */ }
                }
            }
            applyProps(node, override, LAYOUT_PRE_PROPS);
            applyProps(node, override, LAYOUT_POST_PROPS);
            applyVisualOverride(node, override);
            if (node.type === "INSTANCE" && override.mainComponentId) {
                // Best-effort nested instance-swap replay: only touch it if the fresh instance's
                // corresponding node actually resolved to a different component than before.
                try {
                    const inst = node;
                    const current = yield inst.getMainComponentAsync();
                    if (!current || current.id !== override.mainComponentId) {
                        const target = yield figma.getNodeByIdAsync(override.mainComponentId);
                        if (target && target.type === "COMPONENT") {
                            inst.swapComponent(target);
                        }
                    }
                }
                catch (_g) {
                    /* ignore — not critical, layout/text/paint overrides above already applied */
                }
            }
        }
    });
}
function applyAutofixItem(item) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        const id = String(item.id || "");
        if (!id)
            return { ok: false, error: "Missing node id." };
        const node = yield figma.getNodeByIdAsync(id);
        if (!node || !("id" in node))
            return { ok: false, error: "Node not found." };
        if (item.issueType === "DETACHED_INSTANCE" || item.kind === "detached") {
            const info = (_a = node.detachedInfo) !== null && _a !== void 0 ? _a : null;
            if (!info)
                return { ok: false, error: "Node is not detached." };
            const overrides = yield collectInstanceOverrides(node);
            const instance = yield createInstanceFromDetachedInfo(info);
            if (!instance)
                return { ok: false, error: "Component not found or unavailable." };
            try {
                const parent = node.parent;
                if (parent && "insertChild" in parent) {
                    const idx = parent.children.indexOf(node);
                    parent.insertChild(Math.max(0, idx), instance);
                }
                else {
                    figma.currentPage.appendChild(instance);
                }
                instance.name = node.name;
                instance.x = node.x;
                instance.y = node.y;
                const original = node;
                if ("rotation" in instance)
                    instance.rotation = original.rotation || 0;
                if ("opacity" in instance)
                    instance.opacity = (_b = original.opacity) !== null && _b !== void 0 ? _b : 1;
                if ("visible" in instance)
                    instance.visible = (_c = original.visible) !== null && _c !== void 0 ? _c : true;
                if ("locked" in instance)
                    instance.locked = (_d = original.locked) !== null && _d !== void 0 ? _d : false;
                if (typeof original.width === "number" && typeof original.height === "number") {
                    resizeNode(instance, original.width, original.height);
                }
                yield applyInstanceOverridesToInstance(instance, overrides);
            }
            catch (e) {
                // Roll back: never leave a second instance next to the untouched original.
                try {
                    instance.remove();
                }
                catch (_f) {
                    /* already removed */
                }
                return { ok: false, error: stringifyMessage(e) || "Relink failed." };
            }
            node.remove();
            return { ok: true };
        }
        if (item.issueType === "UNSTYLED_TEXT" || item.kind === "text") {
            if (node.type !== "TEXT")
                return { ok: false, error: "Unsupported node." };
            let candidateId = item.candidateId || "";
            if (!candidateId) {
                if (isMixedTextProps(node)) {
                    return { ok: false, error: "Mixed text styles." };
                }
                const { recommendedId } = yield findTextCandidates(node);
                candidateId = recommendedId || "";
                if (!candidateId)
                    return { ok: false, error: "No high-confidence match." };
            }
            if (!candidateId || !candidateId.startsWith("textstyle:")) {
                return { ok: false, error: "Text style not found." };
            }
            const styleId = candidateId.replace("textstyle:", "");
            const style = yield figma.getStyleByIdAsync(styleId);
            if (!style || style.type !== "TEXT")
                return { ok: false, error: "Text style not found." };
            yield figma.loadFontAsync(style.fontName);
            yield node.setTextStyleIdAsync(styleId);
            return { ok: true };
        }
        let candidateId = item.candidateId || "";
        const kind = item.kind === "stroke" ? "strokes" : "fills";
        if (!candidateId) {
            const color = getSolidPaintColor(node, kind);
            if (!color)
                return { ok: false, error: "No paint to match." };
            const { recommendedId } = yield findColorCandidates(color, node, kind);
            candidateId = recommendedId || "";
        }
        if (!candidateId)
            return { ok: false, error: "No high-confidence match." };
        if (candidateId.startsWith("style:")) {
            const styleId = candidateId.replace("style:", "");
            // documentAccess is "dynamic-page": the sync fillStyleId/strokeStyleId setters throw.
            const styleHolder = node;
            if (kind === "fills" && styleHolder.setFillStyleIdAsync) {
                yield styleHolder.setFillStyleIdAsync(styleId);
            }
            else if (kind === "strokes" && styleHolder.setStrokeStyleIdAsync) {
                yield styleHolder.setStrokeStyleIdAsync(styleId);
            }
            else {
                return { ok: false, error: "Unsupported node." };
            }
            return { ok: true };
        }
        const variable = yield figma.variables.getVariableByIdAsync(candidateId);
        if (!variable)
            return { ok: false, error: "Variable not found." };
        const paintHolder = node;
        const paints = paintHolder[kind];
        if (!paints || paints === figma.mixed || !Array.isArray(paints) || paints.length === 0) {
            return { ok: false, error: "No paint to bind." };
        }
        const next = paints.slice();
        const idx = next.findIndex((p) => p && p.type === "SOLID" && p.visible !== false);
        const paintIndex = idx >= 0 ? idx : 0;
        const paint = next[paintIndex];
        if (!paint || paint.type !== "SOLID")
            return { ok: false, error: "Unsupported paint type." };
        next[paintIndex] = figma.variables.setBoundVariableForPaint(paint, "color", variable);
        paintHolder[kind] = next;
        return { ok: true };
    });
}
let textStyleCache = null;
function collectTextStyleIdsFromPage(page) {
    return __awaiter(this, void 0, void 0, function* () {
        const ids = new Set();
        const stack = [...page.children];
        while (stack.length) {
            const node = stack.pop();
            if (!node)
                continue;
            if (node.type === "TEXT") {
                const textNode = node;
                const styleId = textNode.textStyleId;
                if (typeof styleId === "string" && styleId) {
                    ids.add(styleId);
                }
                else if (isMixed(styleId) && textNode.characters && textNode.characters.length > 0) {
                    const segments = textNode.getStyledTextSegments(["fontName"]);
                    for (const seg of segments) {
                        const segStyleId = textNode.getRangeTextStyleId(seg.start, seg.end);
                        if (typeof segStyleId === "string" && segStyleId)
                            ids.add(segStyleId);
                    }
                }
            }
            if (hasChildren(node)) {
                for (const child of node.children)
                    stack.push(child);
            }
        }
        return ids;
    });
}
function getTextStylesForMatching() {
    return __awaiter(this, void 0, void 0, function* () {
        const page = figma.currentPage;
        if (textStyleCache && textStyleCache.pageId === page.id) {
            return textStyleCache.styles;
        }
        const locals = yield figma.getLocalTextStylesAsync();
        const styleById = new Map();
        for (const style of locals)
            styleById.set(style.id, style);
        const ids = yield collectTextStyleIdsFromPage(page);
        for (const id of ids) {
            if (styleById.has(id))
                continue;
            try {
                const style = yield figma.getStyleByIdAsync(id);
                if (style && style.type === "TEXT") {
                    styleById.set(style.id, style);
                }
            }
            catch (_a) {
                // ignore missing styles (e.g., removed library)
            }
        }
        const styles = Array.from(styleById.values());
        textStyleCache = { pageId: page.id, styles };
        return styles;
    });
}
// Any truthy entry in a boundVariables map (color, opacity, gradient-stop fields, ...) counts.
function hasTruthyBinding(bindings) {
    if (!bindings || typeof bindings !== "object")
        return false;
    const map = bindings;
    return Object.keys(map).some((k) => !!map[k]);
}
function hasBoundPaintVariable(node, kind) {
    const holder = node;
    // Node-level bindings
    const bv = holder.boundVariables;
    if (bv && bv[kind])
        return true;
    // Paint-level bindings
    if (kind in node) {
        const paints = holder[kind];
        if (!isMixed(paints) && Array.isArray(paints)) {
            for (const paint of paints) {
                const p = paint;
                if (hasTruthyBinding(p === null || p === void 0 ? void 0 : p.boundVariables))
                    return true;
                const stops = p === null || p === void 0 ? void 0 : p.gradientStops;
                if (Array.isArray(stops)) {
                    for (const stop of stops) {
                        if (hasTruthyBinding(stop === null || stop === void 0 ? void 0 : stop.boundVariables))
                            return true;
                    }
                }
            }
        }
    }
    return false;
}
function hasRogueFill(node) {
    if (!("fills" in node))
        return false;
    const paintHolder = node;
    const fills = paintHolder.fills;
    if (isMixed(fills) || !Array.isArray(fills) || fills.length === 0)
        return false;
    const fillStyleId = paintHolder.fillStyleId;
    const visibleFills = fills.filter((p) => { var _a; return ((_a = p.visible) !== null && _a !== void 0 ? _a : true) === true; });
    if (visibleFills.length === 0)
        return false;
    // If all visible fills are IMAGE, consider OK
    const hasNonImageVisibleFill = visibleFills.some((p) => p.type !== "IMAGE");
    if (!hasNonImageVisibleFill)
        return false;
    // Variable-bound paints are OK
    if (hasBoundPaintVariable(node, "fills"))
        return false;
    return !fillStyleId || fillStyleId === "" || isMixed(fillStyleId);
}
function hasRogueStroke(node) {
    if (!("strokes" in node))
        return false;
    const paintHolder = node;
    const strokes = paintHolder.strokes;
    if (isMixed(strokes) || !Array.isArray(strokes) || strokes.length === 0)
        return false;
    const strokeStyleId = paintHolder.strokeStyleId;
    const visibleStrokes = strokes.filter((p) => { var _a; return ((_a = p.visible) !== null && _a !== void 0 ? _a : true) === true; });
    if (visibleStrokes.length === 0)
        return false;
    // If all visible strokes are IMAGE, consider OK
    const hasNonImageVisibleStroke = visibleStrokes.some((p) => p.type !== "IMAGE");
    if (!hasNonImageVisibleStroke)
        return false;
    // Variable-bound paints are OK
    if (hasBoundPaintVariable(node, "strokes"))
        return false;
    return !strokeStyleId || strokeStyleId === "" || isMixed(strokeStyleId);
}
function hasUnstyledText(node) {
    if (node.type !== "TEXT")
        return false;
    const textStyleId = node.textStyleId;
    return textStyleId === "" || isMixed(textStyleId);
}
function isMixedTextProps(node) {
    return (isMixed(node.fontName) ||
        isMixed(node.fontSize) ||
        isMixed(node.lineHeight) ||
        isMixed(node.letterSpacing));
}
function textLineHeightToPx(lineHeight, fontSize) {
    if (!lineHeight)
        return null;
    if (lineHeight.unit === "AUTO")
        return null;
    const value = lineHeight.value;
    if (typeof value !== "number")
        return null;
    if (lineHeight.unit === "PIXELS")
        return value;
    if (lineHeight.unit === "PERCENT")
        return fontSize * (value / 100);
    return null;
}
function letterSpacingToPx(letterSpacing, fontSize) {
    if (!letterSpacing)
        return null;
    const value = letterSpacing.value;
    if (typeof value !== "number")
        return null;
    if (letterSpacing.unit === "PIXELS")
        return value;
    if (letterSpacing.unit === "PERCENT")
        return fontSize * (value / 100);
    return null;
}
function normalizeTextProps(node) {
    const hasChars = typeof node.characters === "string" && node.characters.length > 0;
    const rangeStart = 0;
    const rangeEnd = hasChars ? 1 : 0;
    const fontName = isMixed(node.fontName) && hasChars ? node.getRangeFontName(rangeStart, rangeEnd) : node.fontName;
    const fontSize = isMixed(node.fontSize) && hasChars ? node.getRangeFontSize(rangeStart, rangeEnd) : node.fontSize;
    const lineHeight = isMixed(node.lineHeight) && hasChars ? node.getRangeLineHeight(rangeStart, rangeEnd) : node.lineHeight;
    const letterSpacing = isMixed(node.letterSpacing) && hasChars ? node.getRangeLetterSpacing(rangeStart, rangeEnd) : node.letterSpacing;
    const lineHeightAuto = !!(lineHeight && lineHeight.unit === "AUTO");
    const lineHeightPx = fontSize ? textLineHeightToPx(lineHeight, fontSize) : null;
    const letterSpacingPx = fontSize ? letterSpacingToPx(letterSpacing, fontSize) : null;
    return {
        fontName: fontName || null,
        fontSize: typeof fontSize === "number" ? fontSize : null,
        lineHeightPx,
        lineHeightAuto,
        letterSpacingPx,
    };
}
function round4(n) {
    return Math.round(n * 10000) / 10000;
}
function rgbaToKey(color) {
    return `${round4(color.r)}|${round4(color.g)}|${round4(color.b)}|${round4(color.a)}`;
}
function rgbaToCss(color) {
    const r = Math.round(color.r * 255);
    const g = Math.round(color.g * 255);
    const b = Math.round(color.b * 255);
    const a = Math.max(0, Math.min(1, typeof color.a === "number" ? color.a : 1));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}
function alphaDiffOk(a, b) {
    const alphaA = typeof a.a === "number" ? a.a : 1;
    const alphaB = typeof b.a === "number" ? b.a : 1;
    return Math.abs(alphaA - alphaB) <= 0.05;
}
function layerKeywordsForNode(node, kind) {
    if (kind === "strokes")
        return ["border", "stroke", "outline", "separator", "divider"];
    if (node.type === "TEXT")
        return ["text", "fg", "foreground", "font", "label", "typo"];
    if (node.type === "VECTOR" ||
        node.type === "BOOLEAN_OPERATION" ||
        node.type === "LINE" ||
        node.type === "STAR" ||
        node.type === "ELLIPSE" ||
        node.type === "POLYGON") {
        return ["icon", "glyph", "symbol", "graphic", "vector"];
    }
    return ["bg", "background", "surface", "fill", "container", "card"];
}
function nameMatchesKeywords(name, keywords) {
    const lower = name.toLowerCase();
    return keywords.some((k) => {
        const re = new RegExp(`(^|[\\s/_-])${k}($|[\\s/_-])`);
        return re.test(lower);
    });
}
function shouldExcludeForStroke(name) {
    const strokeKeywords = ["border", "stroke", "outline", "separator", "divider"];
    const backgroundKeywords = ["bg", "background", "surface", "fill", "container", "card"];
    const isStroke = nameMatchesKeywords(name, strokeKeywords);
    const isBackground = nameMatchesKeywords(name, backgroundKeywords);
    return !isStroke && isBackground;
}
const TEXT_SEMANTIC_GROUPS = {
    headings: ["h1", "h2", "h3", "heading", "title", "display"],
    body: ["body", "paragraph", "text", "main", "copy"],
    interface: ["label", "button", "input", "caption", "small"],
    code: ["mono", "code", "monospace", "technical"],
};
function textSemanticKeywordsForNode(node) {
    const content = `${node.name || ""} ${node.characters || ""}`.toLowerCase();
    const out = [];
    for (const key of Object.keys(TEXT_SEMANTIC_GROUPS)) {
        const group = TEXT_SEMANTIC_GROUPS[key];
        if (group.some((k) => content.includes(k))) {
            out.push(...group);
        }
    }
    return out;
}
function textSemanticScore(styleName, keywords) {
    if (!keywords.length)
        return 0;
    const lower = styleName.toLowerCase();
    return keywords.some((k) => lower.includes(k)) ? 1 : 0;
}
function textStyleHasVariableBindings(style) {
    const bound = style.boundVariables;
    if (!bound)
        return false;
    return Object.keys(bound).some((k) => !!bound[k]);
}
function findTextCandidates(node) {
    return __awaiter(this, void 0, void 0, function* () {
        const mixed = isMixedTextProps(node);
        const props = normalizeTextProps(node);
        if (!props.fontName || !props.fontSize) {
            return { candidates: [], recommendedId: null, mixed };
        }
        const styles = yield getTextStylesForMatching();
        const candidates = [];
        const keywords = textSemanticKeywordsForNode(node);
        for (const style of styles) {
            const styleFont = style.fontName;
            if (!styleFont)
                continue;
            if (styleFont.family !== props.fontName.family)
                continue;
            if (styleFont.style !== props.fontName.style)
                continue;
            const sizeDiff = Math.abs(style.fontSize - props.fontSize);
            const styleLineHeight = style.lineHeight;
            const styleLineAuto = !!(styleLineHeight && styleLineHeight.unit === "AUTO");
            const styleLinePx = textLineHeightToPx(styleLineHeight, style.fontSize);
            const lineDiff = (props.lineHeightAuto && styleLineAuto)
                ? 0
                : (props.lineHeightPx != null && styleLinePx != null ? Math.abs(styleLinePx - props.lineHeightPx) : null);
            const styleLetterSpacing = style.letterSpacing;
            const styleLetterPx = letterSpacingToPx(styleLetterSpacing, style.fontSize);
            const letterDiff = (props.letterSpacingPx != null && styleLetterPx != null)
                ? Math.abs(styleLetterPx - props.letterSpacingPx)
                : null;
            let matchLevel = null;
            const exactLine = (props.lineHeightAuto && styleLineAuto) || (lineDiff != null && lineDiff <= 0.01);
            const exactLetter = letterDiff != null && letterDiff <= 0.01;
            if (sizeDiff <= 0.01 && exactLine && exactLetter) {
                matchLevel = "perfect";
            }
            else if (sizeDiff <= 1 && (lineDiff != null && lineDiff <= 2)) {
                matchLevel = "near";
            }
            else {
                matchLevel = "partial";
            }
            const variableBound = textStyleHasVariableBindings(style);
            const semanticScore = textSemanticScore(style.name, keywords);
            const matchScore = matchLevel === "perfect" ? 3 : matchLevel === "near" ? 2 : 1;
            const score = (variableBound ? 4 : 0) + matchScore + semanticScore;
            const note = matchLevel === "near" ? "Similar" : undefined;
            candidates.push({
                id: `textstyle:${style.id}`,
                name: style.name,
                displayName: style.name,
                source: "style",
                collectionName: "Text Styles",
                score,
                matchLevel,
                note,
            });
        }
        // Match quality first: a variable-bound partial match must never outrank a perfect one.
        const levelRank = (c) => (c.matchLevel === "perfect" ? 3 : c.matchLevel === "near" ? 2 : 1);
        const sorted = candidates.sort((a, b) => {
            const dl = levelRank(b) - levelRank(a);
            if (dl !== 0)
                return dl;
            const ds = (b.score || 0) - (a.score || 0);
            if (ds !== 0)
                return ds;
            return (a.displayName || a.name).localeCompare(b.displayName || b.name);
        });
        const perfect = sorted.find((c) => c.matchLevel === "perfect");
        const near = sorted.find((c) => c.matchLevel === "near");
        const recommended = perfect || near || null;
        return { candidates: sorted, recommendedId: recommended ? recommended.id : null, mixed };
    });
}
function nodeScopeForVariable(node, kind) {
    const scopes = ["ALL_SCOPES"];
    if (kind === "strokes") {
        scopes.push("STROKE_COLOR");
        return scopes;
    }
    scopes.push("ALL_FILLS");
    if (node.type === "TEXT") {
        scopes.push("TEXT_FILL");
        return scopes;
    }
    if (node.type === "FRAME" ||
        node.type === "COMPONENT" ||
        node.type === "COMPONENT_SET" ||
        node.type === "INSTANCE") {
        scopes.push("FRAME_FILL");
        scopes.push("SHAPE_FILL");
        return scopes;
    }
    scopes.push("SHAPE_FILL");
    return scopes;
}
function variableMatchesScope(variable, node, kind) {
    const scopes = Array.isArray(variable.scopes) ? variable.scopes.map(String) : [];
    if (scopes.length === 0)
        return true;
    if (scopes.indexOf("ALL_SCOPES") >= 0)
        return true;
    const targetScopes = nodeScopeForVariable(node, kind);
    return targetScopes.some((s) => scopes.indexOf(s) >= 0);
}
function nameIntentScore(name) {
    const lower = String(name || "").toLowerCase();
    const token = (t) => new RegExp(`(^|[\\s/_-])${t}(?=$|[\\s/_-])`, "i").test(lower);
    let score = 0;
    if (token("primary"))
        score += 1.5;
    else if (token("secondary"))
        score += 1;
    else if (token("tertiary"))
        score += 0.5;
    if (token("inverse"))
        score -= 0.5;
    if (token("disabled"))
        score -= 0.5;
    return score;
}
function getModeIdForCollection(node, collection) {
    var _a;
    if (!collection || !collection.id)
        return null;
    const modes = node;
    const resolved = modes.resolvedVariableModes;
    if (resolved && resolved[collection.id])
        return resolved[collection.id];
    const explicit = modes.explicitVariableModes;
    if (explicit && explicit[collection.id])
        return explicit[collection.id];
    if (collection.defaultModeId)
        return collection.defaultModeId;
    if (Array.isArray(collection.modes) && ((_a = collection.modes[0]) === null || _a === void 0 ? void 0 : _a.modeId))
        return collection.modes[0].modeId;
    return null;
}
function srgbToLinear(c) {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function rgbToLab(color) {
    const r = srgbToLinear(color.r);
    const g = srgbToLinear(color.g);
    const b = srgbToLinear(color.b);
    // sRGB D65
    const x = r * 0.4124 + g * 0.3576 + b * 0.1805;
    const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const z = r * 0.0193 + g * 0.1192 + b * 0.9505;
    const xn = 0.95047;
    const yn = 1.0;
    const zn = 1.08883;
    const fx = xyzToLabHelper(x / xn);
    const fy = xyzToLabHelper(y / yn);
    const fz = xyzToLabHelper(z / zn);
    return {
        l: 116 * fy - 16,
        a: 500 * (fx - fy),
        b: 200 * (fy - fz),
    };
}
function xyzToLabHelper(t) {
    const delta = 6 / 29;
    return t > Math.pow(delta, 3) ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}
function deg2rad(deg) {
    return (deg * Math.PI) / 180;
}
function rad2deg(rad) {
    return (rad * 180) / Math.PI;
}
function deltaE2000(lab1, lab2) {
    const L1 = lab1.l;
    const a1 = lab1.a;
    const b1 = lab1.b;
    const L2 = lab2.l;
    const a2 = lab2.a;
    const b2 = lab2.b;
    const avgLp = (L1 + L2) / 2;
    const C1 = Math.sqrt(a1 * a1 + b1 * b1);
    const C2 = Math.sqrt(a2 * a2 + b2 * b2);
    const avgC = (C1 + C2) / 2;
    const G = 0.5 * (1 - Math.sqrt(Math.pow(avgC, 7) / (Math.pow(avgC, 7) + Math.pow(25, 7))));
    const a1p = (1 + G) * a1;
    const a2p = (1 + G) * a2;
    const C1p = Math.sqrt(a1p * a1p + b1 * b1);
    const C2p = Math.sqrt(a2p * a2p + b2 * b2);
    const avgCp = (C1p + C2p) / 2;
    const h1p = C1p === 0 ? 0 : (rad2deg(Math.atan2(b1, a1p)) + 360) % 360;
    const h2p = C2p === 0 ? 0 : (rad2deg(Math.atan2(b2, a2p)) + 360) % 360;
    let dhp = h2p - h1p;
    if (C1p * C2p === 0) {
        dhp = 0;
    }
    else if (dhp > 180) {
        dhp -= 360;
    }
    else if (dhp < -180) {
        dhp += 360;
    }
    const dLp = L2 - L1;
    const dCp = C2p - C1p;
    const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg2rad(dhp / 2));
    let avgHp = h1p + h2p;
    if (C1p * C2p === 0) {
        avgHp = h1p + h2p;
    }
    else if (Math.abs(h1p - h2p) > 180) {
        avgHp = h1p + h2p + (h1p + h2p < 360 ? 360 : -360);
    }
    avgHp /= 2;
    const T = 1 -
        0.17 * Math.cos(deg2rad(avgHp - 30)) +
        0.24 * Math.cos(deg2rad(2 * avgHp)) +
        0.32 * Math.cos(deg2rad(3 * avgHp + 6)) -
        0.2 * Math.cos(deg2rad(4 * avgHp - 63));
    const deltaTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
    const RC = 2 * Math.sqrt(Math.pow(avgCp, 7) / (Math.pow(avgCp, 7) + Math.pow(25, 7)));
    const SL = 1 + (0.015 * Math.pow(avgLp - 50, 2)) / Math.sqrt(20 + Math.pow(avgLp - 50, 2));
    const SC = 1 + 0.045 * avgCp;
    const SH = 1 + 0.015 * avgCp * T;
    const RT = -Math.sin(deg2rad(2 * deltaTheta)) * RC;
    const dE = Math.sqrt(Math.pow(dLp / SL, 2) +
        Math.pow(dCp / SC, 2) +
        Math.pow(dHp / SH, 2) +
        RT * (dCp / SC) * (dHp / SH));
    return dE;
}
function paintToRgba(paint) {
    if (!paint || paint.type !== "SOLID")
        return null;
    const opacity = typeof paint.opacity === "number" ? paint.opacity : 1;
    return {
        r: paint.color.r,
        g: paint.color.g,
        b: paint.color.b,
        a: opacity,
    };
}
function getSolidPaintColor(node, kind) {
    const paints = node[kind];
    if (!paints || paints === figma.mixed || !Array.isArray(paints))
        return null;
    // Same paint the bind step targets: the first visible SOLID paint.
    const paint = paints.find((p) => p && p.type === "SOLID" && p.visible !== false);
    if (!paint)
        return null;
    return paintToRgba(paint);
}
function isVariableAlias(value) {
    const v = value;
    return !!v && typeof v === "object" && v.type === "VARIABLE_ALIAS" && typeof v.id === "string";
}
function pickModeIdForVariable(variable, preferredModeId) {
    if (!variable)
        return null;
    const valuesByMode = variable.valuesByMode || {};
    if (preferredModeId && valuesByMode[preferredModeId] != null)
        return preferredModeId;
    const keys = Object.keys(valuesByMode);
    return keys.length ? keys[0] : null;
}
function resolveVariableColor(variable, modeId, seen) {
    return __awaiter(this, void 0, void 0, function* () {
        if (!variable)
            return null;
        if (seen.has(variable.id))
            return null;
        seen.add(variable.id);
        const preferredModeId = modeId || null;
        const valuesByMode = variable.valuesByMode || {};
        const resolvedModeId = pickModeIdForVariable(variable, preferredModeId);
        if (!resolvedModeId)
            return null;
        const value = valuesByMode[resolvedModeId];
        if (!value)
            return null;
        if (isVariableAlias(value)) {
            const aliasVar = yield figma.variables.getVariableByIdAsync(value.id);
            if (!aliasVar)
                return null;
            const aliasModeId = pickModeIdForVariable(aliasVar, resolvedModeId);
            return resolveVariableColor(aliasVar, aliasModeId || resolvedModeId, seen);
        }
        if (typeof value === "object" && value && "r" in value && "g" in value && "b" in value) {
            const rgba = value;
            const alpha = typeof rgba.a === "number" ? rgba.a : 1;
            return { r: rgba.r, g: rgba.g, b: rgba.b, a: alpha };
        }
        return null;
    });
}
function getLocalColorVariablesCached() {
    return __awaiter(this, void 0, void 0, function* () {
        const now = Date.now();
        if (localColorVariablesCache && now - localColorVariablesCache.ts < LOCAL_COLOR_VARS_CACHE_TTL_MS) {
            return { collections: localColorVariablesCache.collections, vars: localColorVariablesCache.vars };
        }
        // A fetch is already in flight: share it instead of racing several concurrent candidate
        // requests (maxConcurrent=3 on the UI side) into duplicate Figma API calls before the first
        // one has a chance to populate the cache above.
        if (localColorVariablesLoadPromise)
            return localColorVariablesLoadPromise;
        localColorVariablesLoadPromise = (() => __awaiter(this, void 0, void 0, function* () {
            try {
                const collections = yield figma.variables.getLocalVariableCollectionsAsync();
                const vars = yield figma.variables.getLocalVariablesAsync("COLOR");
                localColorVariablesCache = { collections, vars, ts: Date.now() };
                return { collections, vars };
            }
            finally {
                localColorVariablesLoadPromise = null;
            }
        }))();
        return localColorVariablesLoadPromise;
    });
}
function findColorCandidates(target, consumer, kind) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const candidates = [];
        const targetKey = rgbaToKey(target);
        const varsApi = figma.variables;
        const { collections, vars: localVars } = yield getLocalColorVariablesCached();
        // Throttled (5s) when nothing is cached yet, so an empty or failing library isn't re-imported per row.
        const libraryVars = yield loadLibraryVariables(varsApi);
        const variableMap = new Map();
        for (const v of localVars)
            variableMap.set(v.id, v);
        for (const v of libraryVars)
            variableMap.set(v.id, v);
        const variables = Array.from(variableMap.values());
        const collectionById = new Map();
        for (const c of collections)
            collectionById.set(c.id, c);
        for (const v of variables) {
            const variable = v;
            if (variable.resolvedType !== "COLOR")
                continue;
            const name = String(variable.name || "");
            const isHidden = name.startsWith(".") || name.startsWith("-");
            if (name.startsWith("_"))
                continue;
            if (kind === "strokes" && shouldExcludeForStroke(name))
                continue;
            let collection = collectionById.get(variable.variableCollectionId);
            if (!collection && variable.variableCollectionId) {
                try {
                    collection = yield figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
                }
                catch (_b) {
                    collection = null;
                }
            }
            const valuesByMode = variable.valuesByMode || {};
            let modeId = getModeIdForCollection(consumer, collection);
            if (!modeId) {
                const modeKeys = Object.keys(valuesByMode);
                modeId = modeKeys.length ? modeKeys[0] : null;
            }
            let matched = false;
            let aliasHit = false;
            let resolvedColor = null;
            let deltaE = null;
            let layerScore = 0;
            let resolvedForConsumer = false;
            const keywords = layerKeywordsForNode(consumer, kind);
            try {
                const resolved = variable.resolveForConsumer(consumer);
                if (resolved && resolved.resolvedType === "COLOR" && typeof resolved.value === "object" && resolved.value) {
                    resolvedForConsumer = true;
                    const v = resolved.value;
                    resolvedColor = {
                        r: v.r,
                        g: v.g,
                        b: v.b,
                        a: typeof v.a === "number" ? v.a : 1,
                    };
                    if (alphaDiffOk(target, resolvedColor)) {
                        const computed = deltaE2000(rgbToLab(target), rgbToLab(resolvedColor));
                        deltaE = computed;
                        if (computed < 5) {
                            matched = true;
                            const raw = modeId ? valuesByMode[modeId] : null;
                            aliasHit = isVariableAlias(raw);
                            layerScore = nameMatchesKeywords(name, keywords) ? 3 : 0;
                        }
                    }
                }
            }
            catch (_e) {
                // fallback below
            }
            // resolveForConsumer already gave a definitive color: a miss is a miss, no async re-resolution.
            if (!matched && resolvedForConsumer)
                continue;
            if (!matched) {
                const rawValue = modeId ? valuesByMode[modeId] : null;
                if (rawValue && isVariableAlias(rawValue))
                    aliasHit = true;
                const cacheKey = `${variable.id}|${modeId || ""}`;
                let resolved;
                if (variableColorCache.has(cacheKey)) {
                    resolved = (_a = variableColorCache.get(cacheKey)) !== null && _a !== void 0 ? _a : null;
                }
                else {
                    resolved = yield resolveVariableColor(variable, modeId || "", new Set());
                    variableColorCache.set(cacheKey, resolved);
                }
                if (!resolved)
                    continue;
                if (!alphaDiffOk(target, resolved))
                    continue;
                const d = deltaE2000(rgbToLab(target), rgbToLab(resolved));
                if (d >= 5)
                    continue;
                matched = true;
                resolvedColor = resolved;
                deltaE = d;
                layerScore = nameMatchesKeywords(name, keywords) ? 3 : 0;
            }
            if (!matched)
                continue;
            const collectionName = String((collection === null || collection === void 0 ? void 0 : collection.name) || "Variables");
            const isSemantic = /semantic|ui|theme|token/i.test(collectionName);
            const isLocal = !((collection === null || collection === void 0 ? void 0 : collection.remote) === true) && !(variable.remote === true);
            const score = (aliasHit ? 2 : 0) + (isSemantic ? 1 : 0) + (isLocal ? 0.5 : 0) + layerScore + nameIntentScore(name);
            const isHiddenCollection = collectionName.startsWith(".") || collectionName.startsWith("-");
            candidates.push({
                id: variable.id,
                name,
                displayName: `${collectionName} / ${name}`,
                collectionName,
                isAlias: aliasHit,
                score,
                source: "variable",
                color: resolvedColor ? rgbaToCss(resolvedColor) : undefined,
                deltaE: deltaE == null ? undefined : Math.round(deltaE * 100) / 100,
                disabled: isHidden || isHiddenCollection,
            });
        }
        if (candidates.length === 0) {
            const styles = yield figma.getLocalPaintStylesAsync();
            for (const style of styles) {
                const paints = style.paints || [];
                const paint = paints.find((p) => p && p.visible !== false) || paints[0];
                const color = paintToRgba(paint);
                if (!color)
                    continue;
                if (rgbaToKey(color) !== targetKey)
                    continue;
                candidates.push({
                    id: `style:${style.id}`,
                    name: style.name,
                    displayName: `Style / ${style.name}`,
                    source: "style",
                    score: 0,
                    color: rgbaToCss(color),
                    // Styles are only offered on an exact color match, so they count as a perfect (recommendable) match.
                    deltaE: 0,
                });
            }
        }
        const scoped = candidates.filter((c) => {
            if (c.source !== "variable")
                return true;
            const variable = variables.find((v) => v.id === c.id);
            if (!variable)
                return true;
            return variableMatchesScope(variable, consumer, kind);
        });
        const activeList = scoped.length > 0 ? scoped : (kind === "strokes" ? [] : candidates);
        activeList.sort((a, b) => {
            const deltaA = typeof a.deltaE === "number" ? a.deltaE : 999;
            const deltaB = typeof b.deltaE === "number" ? b.deltaE : 999;
            if (deltaA !== deltaB)
                return deltaA - deltaB;
            const scoreDelta = (b.score || 0) - (a.score || 0);
            if (scoreDelta !== 0)
                return scoreDelta;
            return (a.displayName || a.name).localeCompare(b.displayName || b.name);
        });
        const recommended = activeList
            .filter((c) => typeof c.deltaE === "number" && c.deltaE < 2)
            .sort((a, b) => (b.score || 0) - (a.score || 0))[0];
        return {
            candidates: activeList,
            recommendedId: recommended ? recommended.id : null,
            debug: {
                totalVariables: variables.length,
                totalCollections: collections.length,
                localVariables: localVars.length,
                libraryVariables: libraryVariableCache.size,
                libraryCollections: libraryCollectionsCount,
                libraryImportErrors,
                libraryImporting: libraryVariablesLoading,
                targetKey,
            },
        };
    });
}
function getOrCreateInstanceId() {
    return __awaiter(this, void 0, void 0, function* () {
        const existing = yield figma.clientStorage.getAsync(INSTANCE_ID_STORAGE_KEY);
        if (existing && typeof existing === "string")
            return existing;
        // Stable per-machine (plugin install) id, no PII
        const id = "inst_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
        yield figma.clientStorage.setAsync(INSTANCE_ID_STORAGE_KEY, id);
        return id;
    });
}
function makeProFeaturesAllEnabled() {
    return ALL_PRO_FEATURES.reduce((acc, f) => {
        acc[f] = true;
        return acc;
    }, {});
}
function makeLicenseEntitlements(licenseKey) {
    return Object.assign(Object.assign({}, makeDefaultEntitlements()), { pro: true, source: "license", features: makeProFeaturesAllEnabled(), expiresAt: undefined, licenseKeyLast4: licenseKey.slice(-4) });
}
const MAX_SERVER_MESSAGE_LENGTH = 200;
function callLicenseEndpoint(url, licenseKey, instanceId) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        if (DEV_FORCE_LICENSE_STATUS) {
            if (DEV_FORCE_LICENSE_STATUS === "trial") {
                return {
                    ok: true,
                    valid: true,
                    status: "trial",
                    daysLeft: 5,
                    entitlements: { pro: true },
                };
            }
            if (DEV_FORCE_LICENSE_STATUS === "pro") {
                return {
                    ok: true,
                    valid: true,
                    status: "pro",
                    entitlements: { pro: true },
                };
            }
            return {
                ok: true,
                valid: false,
                status: "expired",
                daysLeft: 0,
                entitlements: { pro: false },
            };
        }
        // Worker response example:
        // { ok:true, valid:true, status:"active", entitlements:{pro:true} }
        let res;
        try {
            res = yield fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Systemic-Token": SYSTEMIC_TOKEN,
                },
                body: JSON.stringify({ licenseKey, installationId: instanceId }),
            });
        }
        catch (e) {
            return {
                ok: false,
                entitlements: { pro: false },
                transient: true,
                error: `Could not reach the license server: ${stringifyMessage(e) || "network error"}`,
            };
        }
        const rawText = yield res.text();
        let data = null;
        try {
            data = rawText ? JSON.parse(rawText) : null;
        }
        catch (_b) {
            data = null;
        }
        // Provide a readable message for UI (a proxy error page must not flood the toast)
        let serverMessage = stringifyMessage(data && (data.error || data.message)) ||
            (typeof rawText === "string" && rawText.trim() ? rawText.trim() : null) ||
            `HTTP ${res.status}`;
        if (serverMessage.length > MAX_SERVER_MESSAGE_LENGTH) {
            serverMessage = serverMessage.slice(0, MAX_SERVER_MESSAGE_LENGTH) + "…";
        }
        if (!res.ok) {
            return {
                ok: false,
                entitlements: { pro: false },
                transient: res.status >= 500 || res.status === 429,
                error: `Verify failed (${res.status}): ${serverMessage}`,
            };
        }
        if (!data) {
            return { ok: false, entitlements: { pro: false }, error: "Verify failed: empty response." };
        }
        const isPro = !!((_a = data.entitlements) === null || _a === void 0 ? void 0 : _a.pro);
        const activated = typeof data.activated === "boolean" ? data.activated : undefined;
        const valid = typeof data.valid === "boolean" ? data.valid : undefined;
        const daysLeft = typeof data.daysLeft === "number" ? data.daysLeft : undefined;
        return {
            ok: !!data.ok,
            valid,
            status: typeof data.status === "string" ? data.status : null,
            daysLeft,
            activated,
            entitlements: { pro: isPro },
            error: stringifyMessage(data.error) || stringifyMessage(data.message) || undefined,
        };
    });
}
function verifyLicenseWithWorker(licenseKey, instanceId) {
    return __awaiter(this, void 0, void 0, function* () {
        return callLicenseEndpoint(WORKER_VERIFY_URL, licenseKey, instanceId);
    });
}
function activateLicenseWithWorker(licenseKey, instanceId) {
    return __awaiter(this, void 0, void 0, function* () {
        return callLicenseEndpoint(WORKER_ACTIVATE_URL, licenseKey, instanceId);
    });
}
function runAudit(selection, options) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a;
        const nodes = collectNodes(selection, options.scanChildren);
        const issues = [];
        const totalNodes = nodes.length;
        let processed = 0;
        let lastProgress = 0;
        let canceled = false;
        const YIELD_EVERY = 200;
        const auditedElementIds = new Set();
        const elementsWithIssuesSet = new Set();
        const markAudited = (n) => {
            auditedElementIds.add(n.id);
        };
        let scannedElements = 0;
        let rogueFills = 0;
        let rogueStrokes = 0;
        let unstyledText = 0;
        let detached = 0;
        let ignored = 0;
        const addIssue = (node, type, extra = {}) => {
            if (isIssueIgnored(node, type)) {
                ignored++;
                return;
            }
            issues.push(Object.assign({ id: node.id, name: node.name, type, path: getNodePath(node) }, extra));
            elementsWithIssuesSet.add(node.id);
        };
        for (const node of nodes) {
            if (scanCancelRequested) {
                canceled = true;
                break;
            }
            try {
                if (options.checkDetached && canCheckDetachedInfo(node)) {
                    markAudited(node);
                    if (isDetachedInstanceLike(node)) {
                        const info = (_a = node.detachedInfo) !== null && _a !== void 0 ? _a : null;
                        const label = info ? yield getDetachedComponentName(info) : undefined;
                        const before = issues.length;
                        addIssue(node, "DETACHED_INSTANCE", { detachedComponentName: label });
                        if (issues.length > before)
                            detached++;
                    }
                }
                if (options.checkTextStyles && node.type === "TEXT") {
                    markAudited(node);
                    if (hasUnstyledText(node)) {
                        const mixedText = isMixedTextProps(node);
                        const before = issues.length;
                        addIssue(node, "UNSTYLED_TEXT", { mixedText });
                        if (issues.length > before)
                            unstyledText++;
                    }
                }
                if (options.checkRogueFills && ("fills" in node)) {
                    markAudited(node);
                    if (hasRogueFill(node)) {
                        const before = issues.length;
                        addIssue(node, "ROGUE_FILL");
                        if (issues.length > before)
                            rogueFills++;
                    }
                }
                if (options.checkRogueStrokes && ("strokes" in node)) {
                    markAudited(node);
                    if (hasRogueStroke(node)) {
                        const before = issues.length;
                        addIssue(node, "ROGUE_STROKE");
                        if (issues.length > before)
                            rogueStrokes++;
                    }
                }
            }
            catch (_b) {
                // ignore per-node errors to keep scan going
            }
            processed += 1;
            const now = Date.now();
            if (now - lastProgress > 120 || processed % 25 === 0 || processed === totalNodes) {
                figma.ui.postMessage({
                    type: "audit:progress",
                    processed,
                    total: totalNodes,
                    name: node.name || "",
                });
                lastProgress = now;
            }
            if (processed % YIELD_EVERY === 0) {
                yield new Promise((resolve) => setTimeout(resolve, 0));
            }
        }
        scannedElements = auditedElementIds.size;
        const elementsWithIssues = elementsWithIssuesSet.size;
        const summary = {
            total: issues.length,
            rogueFills,
            rogueStrokes,
            unstyledText,
            detached,
            ignored,
            scannedElements,
            elementsWithIssues,
        };
        return { issues, summary, canceled };
    });
}
// Nodes the last scan covered, so a re-audit keeps its scope even if the user has since
// clicked a row (which selects that single layer). Falls back to the current selection.
function resolveAuditTargets() {
    return __awaiter(this, void 0, void 0, function* () {
        const restored = [];
        for (const id of lastAuditSelectionIds) {
            const node = yield figma.getNodeByIdAsync(id);
            if (!node || !("id" in node))
                continue;
            if (node.type === "PAGE" || node.type === "DOCUMENT")
                continue;
            if (!("x" in node))
                continue;
            restored.push(node);
        }
        if (restored.length > 0)
            return restored;
        return Array.from(figma.currentPage.selection);
    });
}
let resizeSaveTimer = null;
let optionsSaveTimer = null;
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    try {
        yield handleMessage(msg);
    }
    catch (e) {
        figma.notify("Something went wrong: " + (stringifyMessage(e) || "unknown error"));
    }
});
function handleMessage(msg) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d;
        if (!msg || typeof msg !== "object")
            return;
        if (msg.type === "resize") {
            const w = Math.max(MIN_W, Math.round(Number(msg.width) || DEFAULT_W));
            const h = Math.max(MIN_H, Math.round(Number(msg.height) || DEFAULT_H));
            figma.ui.resize(w, h);
            // Dragging the window edge sends a resize per pointer move: persist only the final size.
            if (resizeSaveTimer)
                clearTimeout(resizeSaveTimer);
            resizeSaveTimer = setTimeout(() => {
                resizeSaveTimer = null;
                figma.clientStorage.setAsync("uiSize", { width: w, height: h }).catch(() => {
                    /* ignore storage failures */
                });
            }, 300);
            return;
        }
        if (msg.type === "options:save") {
            const options = msg.options;
            if (options && typeof options === "object") {
                if (optionsSaveTimer)
                    clearTimeout(optionsSaveTimer);
                optionsSaveTimer = setTimeout(() => {
                    optionsSaveTimer = null;
                    figma.clientStorage.setAsync(SCANNER_OPTIONS_STORAGE_KEY, {
                        scanChildren: !!options.scanChildren,
                        checkRogueFills: !!options.checkRogueFills,
                        checkRogueStrokes: !!options.checkRogueStrokes,
                        checkDetached: !!options.checkDetached,
                        checkTextStyles: !!options.checkTextStyles,
                    }).catch(() => {
                        /* ignore storage failures */
                    });
                }, 300);
            }
            return;
        }
        if (msg.type === "get-saved-options") {
            const saved = yield figma.clientStorage.getAsync(SCANNER_OPTIONS_STORAGE_KEY);
            figma.ui.postMessage({ type: "saved-options", options: saved && typeof saved === "object" ? saved : null });
            return;
        }
        // -----------------------
        // PRO / LICENSE messages
        // -----------------------
        if (msg.type === "pro:get-entitlements") {
            figma.ui.postMessage(buildEntitlementsMessage());
            return;
        }
        if (msg.type === "pro:clearLicense") {
            entitlements = makeDefaultEntitlements();
            licenseInfo = { status: null };
            yield figma.clientStorage.deleteAsync(ENTITLEMENTS_STORAGE_KEY);
            yield figma.clientStorage.deleteAsync(DEBUG_PRO_STORAGE_KEY);
            yield forgetLastVerified();
            yield clearStoredLicenseKey();
            figma.ui.postMessage(buildEntitlementsMessage());
            return;
        }
        if (msg.type === "pro:debug:set") {
            if (!DEV_PRO)
                return;
            const isPro = !!msg.isPro;
            yield figma.clientStorage.setAsync(DEBUG_PRO_STORAGE_KEY, isPro);
            entitlements = makeDebugEntitlements(isPro);
            figma.ui.postMessage(buildEntitlementsMessage());
            return;
        }
        if (msg.type === "pro:autofix") {
            // Pro-only feature: UI sends this when Pro is verified.
            const allowed = hasFeature(entitlements, "autofix");
            const skipped = msg.skipped || {};
            if (autofixRunning)
                return;
            autofixCancelRequested = false;
            if (!allowed) {
                figma.notify("Auto-fix is a Pro feature. Please activate Systemic Pro.");
                // Tell the UI so it leaves its "fixing" state instead of waiting forever.
                figma.ui.postMessage({ type: "pro:autofix:done", total: 0, resolved: 0, failed: 0, skipped, resolvedItems: [] });
                return;
            }
            const items = Array.isArray(msg.items) ? msg.items : [];
            if (!items.length) {
                figma.ui.postMessage({ type: "pro:autofix:done", total: 0, resolved: 0, failed: 0, skipped, resolvedItems: [] });
                return;
            }
            autofixRunning = true;
            const ordered = items.slice().sort((a, b) => {
                const rank = (i) => (i.issueType === "DETACHED_INSTANCE" || i.kind === "detached") ? 2 : 1;
                return rank(a) - rank(b);
            });
            const total = ordered.length;
            let resolved = 0;
            let failed = 0;
            let processed = 0;
            let canceled = false;
            const resolvedItems = [];
            figma.ui.postMessage({ type: "pro:autofix:progress", phase: "start", total });
            yield new Promise((r) => setTimeout(r, 0));
            figma.ui.postMessage({ type: "pro:autofix:progress", phase: "batch", processed, total, resolved, failed });
            try {
                batchLoop: for (let i = 0; i < ordered.length; i += 50) {
                    if (autofixCancelRequested) {
                        canceled = true;
                        break;
                    }
                    const batch = ordered.slice(i, i + 50);
                    for (let j = 0; j < batch.length; j++) {
                        if (autofixCancelRequested) {
                            canceled = true;
                            break batchLoop;
                        }
                        const item = batch[j];
                        try {
                            const result = yield applyAutofixItem(item);
                            if (result.ok) {
                                resolved += 1;
                                resolvedItems.push({ id: item.id, issueType: item.issueType });
                            }
                            else {
                                failed += 1;
                            }
                        }
                        catch (_f) {
                            failed += 1;
                        }
                        processed += 1;
                        if (processed % 10 === 0) {
                            figma.ui.postMessage({ type: "pro:autofix:progress", phase: "batch", processed, total, resolved, failed });
                            yield new Promise((r) => setTimeout(r, 0));
                        }
                    }
                    figma.ui.postMessage({ type: "pro:autofix:progress", phase: "batch", processed, total, resolved, failed });
                    yield new Promise((r) => setTimeout(r, 20));
                }
            }
            catch (_g) {
                failed += Math.max(0, total - processed);
            }
            finally {
                figma.ui.postMessage({ type: "pro:autofix:done", total, resolved, failed, skipped, resolvedItems, canceled });
                if (canceled) {
                    figma.notify("Auto-fix canceled. Press Cmd+Z to undo any changes.");
                }
                autofixCancelRequested = false;
                autofixRunning = false;
                // Re-audit the area the user originally scanned, not whatever "locate" last selected.
                const auditTargets = yield resolveAuditTargets();
                if (lastAuditOptions && auditTargets.length > 0) {
                    const { issues, summary } = yield runAudit(auditTargets, lastAuditOptions);
                    figma.ui.postMessage({ type: "audit-result", issues, summary });
                }
                else if (lastAuditOptions && lastAuditSelectionIds.length > 0) {
                    figma.ui.postMessage({
                        type: "audit-result",
                        issues: [],
                        summary: {
                            total: 0,
                            detached: 0,
                            unstyledText: 0,
                            rogueFills: 0,
                            rogueStrokes: 0,
                            scannedElements: 0,
                            elementsWithIssues: 0,
                        },
                    });
                }
            }
            return;
        }
        if (msg.type === "pro:autofix:cancel") {
            autofixCancelRequested = true;
            return;
        }
        if (msg.type === "run-audit:cancel") {
            scanCancelRequested = true;
            return;
        }
        if (msg.type === "pro:autofix:candidates") {
            // Computing candidates is read-only (nothing is mutated), so free users get them too —
            // as a preview of what Pro would do. Only the actual apply (below) stays gated.
            const allowed = hasFeature(entitlements, "autofix");
            const id = String(msg.id || "");
            const kind = msg.kind === "stroke" ? "strokes" : (msg.kind === "text" ? "text" : "fills");
            const key = String(msg.key || "");
            const reply = (extra) => figma.ui.postMessage(Object.assign({ type: "pro:autofix:candidates", key, locked: !allowed }, extra));
            if (!id) {
                reply({ candidates: [], recommendedId: null });
                return;
            }
            try {
                const varsApi = figma.variables;
                if (!varsApi || typeof varsApi.getLocalVariablesAsync !== "function") {
                    reply({ candidates: [], recommendedId: null });
                    return;
                }
                const node = yield figma.getNodeByIdAsync(id);
                if (!node || !("id" in node)) {
                    reply({ candidates: [], recommendedId: null });
                    return;
                }
                if (kind === "text") {
                    if (node.type !== "TEXT") {
                        reply({ candidates: [], recommendedId: null });
                        return;
                    }
                    const { candidates, recommendedId, mixed } = yield findTextCandidates(node);
                    reply({ candidates, recommendedId, mixed });
                    return;
                }
                const color = getSolidPaintColor(node, kind);
                if (!color) {
                    reply({ candidates: [], recommendedId: null });
                    return;
                }
                const { candidates, recommendedId, debug } = yield findColorCandidates(color, node, kind);
                reply({ candidates, recommendedId, debug });
            }
            catch (_h) {
                reply({ candidates: [], recommendedId: null });
            }
            return;
        }
        if (msg.type === "pro:autofix:apply") {
            const allowed = hasFeature(entitlements, "autofix");
            const id = String(msg.id || "");
            const rawKind = String(msg.kind || "");
            const kind = ["fill", "stroke", "text", "detached"].indexOf(rawKind) >= 0 ? rawKind : "fill";
            const candidateId = String(msg.candidateId || "");
            const issueType = String(msg.issueType || "");
            const reply = (ok, error) => figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, kind, ok, error });
            if (!allowed || !id || (!candidateId && issueType !== "DETACHED_INSTANCE")) {
                reply(false, "Auto-fix is not available.");
                return;
            }
            // Same code path as "Fix all", so a single fix also restores detached-instance overrides.
            try {
                const result = yield applyAutofixItem({
                    id,
                    issueType: issueType,
                    kind: kind,
                    candidateId,
                });
                reply(result.ok, result.error);
            }
            catch (e) {
                reply(false, stringifyMessage(e) || "Auto-fix failed.");
            }
            return;
        }
        if (msg.type === "pro:verify" || msg.type === "pro:activate") {
            const activating = msg.type === "pro:activate";
            const licenseKey = String(msg.key || "").trim();
            const failText = activating
                ? "Could not activate license. Please try again."
                : "Could not verify license. Please try again.";
            if (!licenseKey) {
                figma.ui.postMessage({
                    type: "pro:verify:result",
                    ok: false,
                    entitlements: { pro: false },
                    error: "Please enter a license key.",
                });
                return;
            }
            // Notify UI that verification is in progress
            figma.ui.postMessage({ type: "pro:verify:state", state: "verifying" });
            try {
                const instanceId = yield getOrCreateInstanceId();
                const result = activating
                    ? yield activateLicenseWithWorker(licenseKey, instanceId)
                    : yield verifyLicenseWithWorker(licenseKey, instanceId);
                const isPro = !!((_a = result.entitlements) === null || _a === void 0 ? void 0 : _a.pro) && !!result.ok && result.activated !== false;
                if (!isPro) {
                    // A failed attempt must not change what the plugin already granted (e.g. a running trial).
                    figma.ui.postMessage({
                        type: "pro:verify:result",
                        ok: false,
                        entitlements: { pro: false },
                        status: (_b = result.status) !== null && _b !== void 0 ? _b : null,
                        valid: typeof result.valid === "boolean" ? result.valid : undefined,
                        daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
                        error: result.error || failText,
                    });
                    return;
                }
                entitlements = makeLicenseEntitlements(licenseKey);
                licenseInfo = {
                    status: (_c = result.status) !== null && _c !== void 0 ? _c : null,
                    valid: typeof result.valid === "boolean" ? result.valid : undefined,
                    daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
                };
                yield saveStoredLicenseKey(licenseKey);
                if (licenseInfo.status !== "trial")
                    yield rememberSuccessfulVerify(licenseInfo.status);
                figma.ui.postMessage(buildEntitlementsMessage());
                figma.ui.postMessage({
                    type: "pro:verify:result",
                    ok: true,
                    isPro: true,
                    entitlements: { pro: true },
                    status: licenseInfo.status,
                    valid: licenseInfo.valid,
                    daysLeft: licenseInfo.daysLeft,
                    licenseKey: storedLicenseKey,
                });
            }
            catch (e) {
                const message = stringifyMessage(e);
                figma.ui.postMessage({
                    type: "pro:verify:result",
                    ok: false,
                    entitlements: { pro: false },
                    error: message && message.trim() ? message : failText,
                });
            }
            return;
        }
        if (msg.type === "run-audit") {
            if (autofixRunning) {
                figma.ui.postMessage({ type: "audit-error", message: "Auto-fix is still running." });
                figma.notify("Auto-fix is still running. Try again when it finishes.");
                return;
            }
            textStyleCache = null;
            variableColorCache.clear();
            localColorVariablesCache = null;
            const varsApi = figma.variables;
            if (varsApi && typeof varsApi.importVariableByKeyAsync === "function") {
                // Fire and forget: candidates are matched lazily, and a failure here must not surface as an unhandled rejection.
                loadLibraryVariables(varsApi, true).catch(() => {
                    /* library variables are optional */
                });
            }
            const selection = figma.currentPage.selection;
            if (selection.length === 0) {
                figma.ui.postMessage({ type: "no-selection" });
                figma.notify("Nothing selected. Choose a frame, layer, or element, then scan again.");
                return;
            }
            const options = (_d = msg.options) !== null && _d !== void 0 ? _d : {
                scanChildren: true,
                checkRogueFills: true,
                checkRogueStrokes: true,
                checkDetached: true,
                checkTextStyles: true,
            };
            lastAuditOptions = options;
            lastAuditSelectionIds = selection.map((node) => node.id);
            // Reset here, not inside runAudit itself — runAudit is also called from the autofix
            // finally block to re-run the last audit, and that re-audit must never inherit a
            // cancellation meant for this user-initiated scan.
            scanCancelRequested = false;
            try {
                const { issues, summary, canceled } = yield runAudit(selection, options);
                figma.ui.postMessage({ type: "audit-result", issues, summary, canceled });
                if (canceled) {
                    figma.notify("Scan canceled.");
                }
                else {
                    figma.notify(`Audit complete: ${summary.total} issue${summary.total === 1 ? "" : "s"} found.`);
                }
            }
            catch (e) {
                // Without this the UI would sit on "Scanning..." forever.
                const message = stringifyMessage(e) || "Scan failed.";
                figma.ui.postMessage({ type: "audit-error", message });
                figma.notify("Scan failed: " + message);
            }
            return;
        }
        if (msg.type === "select-node") {
            const id = String(msg.id || "");
            figma.ui.postMessage({ type: "locate-status", status: "received", id });
            try {
                if (!id) {
                    figma.notify("No node id received.");
                    figma.ui.postMessage({ type: "locate-status", status: "error", id, message: "No node id received" });
                    return;
                }
                const found = yield figma.getNodeByIdAsync(id);
                if (!found) {
                    figma.notify("Couldn’t find that layer (it may have been deleted or is in another file).");
                    figma.ui.postMessage({ type: "locate-status", status: "error", id, message: "Node not found" });
                    return;
                }
                // Switch to the page containing the node
                let p = found;
                while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
                    p = p.parent;
                }
                if (p && p.type === "PAGE") {
                    yield figma.setCurrentPageAsync(p);
                }
                if (!("x" in found)) {
                    figma.notify("That item isn’t a canvas layer I can zoom to.");
                    figma.ui.postMessage({ type: "locate-status", status: "error", id, message: "Not a canvas node" });
                    return;
                }
                const node = found;
                figma.currentPage.selection = [node];
                figma.viewport.scrollAndZoomIntoView([node]);
                figma.ui.postMessage({
                    type: "locate-status",
                    status: "done",
                    id,
                    name: node.name,
                    page: figma.currentPage.name,
                });
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                figma.notify("Locate failed: " + message);
                figma.ui.postMessage({ type: "locate-status", status: "error", id, message });
            }
            return;
        }
        if (msg.type === "select-nodes") {
            const ids = Array.isArray(msg.ids) ? msg.ids.map((v) => String(v)).filter(Boolean) : [];
            if (!ids.length) {
                figma.ui.postMessage({ type: "select-nodes:status", status: "error", count: 0, message: "No node ids received" });
                return;
            }
            try {
                // A single scan is always scoped to one selection, so every node should share a page.
                // Resolve nodes and their page in one pass; the first node found decides the target page,
                // and anything on a different page (shouldn't normally happen) is skipped.
                const found = [];
                let targetPageId = null;
                for (const id of ids) {
                    const node = yield figma.getNodeByIdAsync(id);
                    if (!node || !("x" in node))
                        continue;
                    let p = node;
                    while (p && p.type !== "PAGE" && p.type !== "DOCUMENT")
                        p = p.parent;
                    const pageId = p && p.type === "PAGE" ? p.id : null;
                    if (targetPageId === null)
                        targetPageId = pageId;
                    else if (pageId !== targetPageId)
                        continue;
                    found.push(node);
                }
                if (!found.length) {
                    figma.notify("Couldn’t find any of those layers (they may have been deleted).");
                    figma.ui.postMessage({ type: "select-nodes:status", status: "error", count: 0, message: "No nodes found" });
                    return;
                }
                if (targetPageId) {
                    const targetPage = yield figma.getNodeByIdAsync(targetPageId);
                    if (targetPage && targetPage.type === "PAGE") {
                        yield figma.setCurrentPageAsync(targetPage);
                    }
                }
                figma.currentPage.selection = found;
                figma.viewport.scrollAndZoomIntoView(found);
                figma.ui.postMessage({ type: "select-nodes:status", status: "done", count: found.length });
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                figma.notify("Select failed: " + message);
                figma.ui.postMessage({ type: "select-nodes:status", status: "error", count: 0, message });
            }
            return;
        }
        if (msg.type === "issues:validate") {
            const items = Array.isArray(msg.items) ? msg.items : [];
            const resolvedIds = [];
            for (const item of items) {
                const id = String((item === null || item === void 0 ? void 0 : item.id) || "");
                const issueType = String((item === null || item === void 0 ? void 0 : item.issueType) || "");
                if (!id || !issueType)
                    continue;
                try {
                    const node = yield figma.getNodeByIdAsync(id);
                    if (!node || !("id" in node)) {
                        resolvedIds.push(id);
                        continue;
                    }
                    const scene = node;
                    if (issueType === "DETACHED_INSTANCE" && !isDetachedInstanceLike(scene)) {
                        resolvedIds.push(id);
                        continue;
                    }
                    if (issueType === "UNSTYLED_TEXT" && !hasUnstyledText(scene)) {
                        resolvedIds.push(id);
                        continue;
                    }
                    if (issueType === "ROGUE_FILL" && !hasRogueFill(scene)) {
                        resolvedIds.push(id);
                        continue;
                    }
                    if (issueType === "ROGUE_STROKE" && !hasRogueStroke(scene)) {
                        resolvedIds.push(id);
                        continue;
                    }
                }
                catch (_j) {
                    resolvedIds.push(id);
                }
            }
            figma.ui.postMessage({ type: "issues:resolved", resolvedIds });
            return;
        }
        if (msg.type === "issue:ignore") {
            const id = String(msg.id || "");
            const issueType = String(msg.issueType || "");
            if (!id || !issueType)
                return;
            try {
                const node = yield figma.getNodeByIdAsync(id);
                if (node && "setPluginData" in node) {
                    node.setPluginData(ignoreDataKey(issueType), "1");
                }
            }
            catch (_k) {
                // ignore — worst case the issue just isn't marked and reappears next scan
            }
            // Reuse the UI's existing issues:resolved handling to drop the row without a full re-scan.
            figma.ui.postMessage({ type: "issues:resolved", resolvedIds: [id], ignoredDelta: 1 });
            return;
        }
        if (msg.type === "issue:unignoreAll") {
            try {
                const targets = yield resolveAuditTargets();
                const nodes = collectNodes(targets, true);
                const types = ["ROGUE_FILL", "ROGUE_STROKE", "UNSTYLED_TEXT", "DETACHED_INSTANCE"];
                for (const node of nodes) {
                    for (const type of types) {
                        try {
                            node.setPluginData(ignoreDataKey(type), "");
                        }
                        catch (_l) {
                            /* ignore */
                        }
                    }
                }
                if (lastAuditOptions && targets.length > 0) {
                    const { issues, summary, canceled } = yield runAudit(targets, lastAuditOptions);
                    figma.ui.postMessage({ type: "audit-result", issues, summary, canceled });
                }
            }
            catch (e) {
                figma.notify("Couldn't clear ignored issues: " + (stringifyMessage(e) || "unknown error"));
            }
            return;
        }
        if (msg.type === "open-external") {
            const url = String(msg.url || "").trim();
            if (!url) {
                figma.notify("No URL provided.");
                return;
            }
            if (!/^https?:\/\//i.test(url)) {
                figma.notify("Blocked: invalid URL.");
                return;
            }
            try {
                figma.openExternal(url);
            }
            catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                figma.notify("Couldn’t open link: " + message);
            }
            return;
        }
        if (msg.type === "close") {
            figma.closePlugin();
        }
    });
}
