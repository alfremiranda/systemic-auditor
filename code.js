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
const MIN_H = 540;
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
const ALL_PRO_FEATURES = ["autofix", "export", "rules", "themes", "reports"];
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
            rules: false,
            themes: false,
            reports: false,
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
function saveEntitlements(ent) {
    return __awaiter(this, void 0, void 0, function* () {
        // Intentionally no-op: Pro status is kept in-memory only per session.
        void ent;
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
        const now = Date.now();
        if (!force && libraryVariablesLoaded) {
            return Array.from(libraryVariableCache.values());
        }
        if (!force && libraryVariableCache.size === 0 && now - libraryVariablesLastAttempt < 5000) {
            return [];
        }
        libraryVariablesLastAttempt = now;
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
const libraryVariableCache = new Map();
let libraryVariablesLoaded = false;
let libraryVariablesLastAttempt = 0;
let libraryCollectionsCount = 0;
let libraryImportErrors = 0;
let libraryVariablesLoading = false;
let storedLicenseKey = "";
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
        try {
            const instanceId = yield getOrCreateInstanceId();
            const result = yield verifyLicenseWithWorker(storedLicenseKey, instanceId);
            const isPro = !!((_a = result.entitlements) === null || _a === void 0 ? void 0 : _a.pro) && !!result.ok;
            if (isPro) {
                entitlements = Object.assign(Object.assign({}, makeDefaultEntitlements()), { pro: true, source: "license", features: makeProFeaturesAllEnabled(), expiresAt: undefined, licenseKeyLast4: storedLicenseKey.slice(-4) });
            }
            else {
                entitlements = makeDefaultEntitlements();
            }
            figma.ui.postMessage({
                type: "pro:entitlements",
                isPro,
                entitlements: { pro: isPro },
                source: entitlements.source,
                expiresAt: entitlements.expiresAt,
                licenseKeyLast4: entitlements.licenseKeyLast4,
                licenseKey: storedLicenseKey,
                status: (_b = result.status) !== null && _b !== void 0 ? _b : null,
                valid: typeof result.valid === "boolean" ? result.valid : undefined,
                daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
                error: result.error,
            });
        }
        catch (e) {
            entitlements = makeDefaultEntitlements();
            figma.ui.postMessage({
                type: "pro:entitlements",
                isPro: false,
                entitlements: { pro: false },
                source: entitlements.source,
                expiresAt: entitlements.expiresAt,
                licenseKeyLast4: entitlements.licenseKeyLast4,
                licenseKey: storedLicenseKey,
                error: stringifyMessage(e) || "Verify failed.",
            });
        }
    }
    else {
        figma.ui.postMessage({
            type: "pro:entitlements",
            isPro: false,
            entitlements: { pro: false },
            source: entitlements.source,
            expiresAt: entitlements.expiresAt,
            licenseKeyLast4: entitlements.licenseKeyLast4,
            licenseKey: storedLicenseKey,
            status: null,
            valid: false,
            daysLeft: 0,
        });
    }
}))();
let lastAuditOptions = null;
let lastAuditSelectionIds = [];
function isMixed(value) {
    return value === figma.mixed;
}
function getNodePath(node) {
    const parts = [];
    let current = node;
    while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
        if ("name" in current)
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
    const di = node.detachedInfo;
    return di != null;
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
function collectInstanceOverrides(root) {
    const map = new Map();
    const rootOverride = {};
    if ("layoutAlign" in root)
        rootOverride.layoutAlign = root.layoutAlign;
    if ("layoutGrow" in root)
        rootOverride.layoutGrow = root.layoutGrow;
    if ("layoutSizingHorizontal" in root)
        rootOverride.layoutSizingHorizontal = root.layoutSizingHorizontal;
    if ("layoutSizingVertical" in root)
        rootOverride.layoutSizingVertical = root.layoutSizingVertical;
    if ("constraints" in root)
        rootOverride.constraints = root.constraints;
    if ("width" in root)
        rootOverride.width = root.width;
    if ("height" in root)
        rootOverride.height = root.height;
    if ("layoutMode" in root)
        rootOverride.layoutMode = root.layoutMode;
    if ("primaryAxisAlignItems" in root)
        rootOverride.primaryAxisAlignItems = root.primaryAxisAlignItems;
    if ("counterAxisAlignItems" in root)
        rootOverride.counterAxisAlignItems = root.counterAxisAlignItems;
    if ("primaryAxisSizingMode" in root)
        rootOverride.primaryAxisSizingMode = root.primaryAxisSizingMode;
    if ("counterAxisSizingMode" in root)
        rootOverride.counterAxisSizingMode = root.counterAxisSizingMode;
    if ("itemSpacing" in root)
        rootOverride.itemSpacing = root.itemSpacing;
    if ("paddingLeft" in root)
        rootOverride.paddingLeft = root.paddingLeft;
    if ("paddingRight" in root)
        rootOverride.paddingRight = root.paddingRight;
    if ("paddingTop" in root)
        rootOverride.paddingTop = root.paddingTop;
    if ("paddingBottom" in root)
        rootOverride.paddingBottom = root.paddingBottom;
    if ("layoutWrap" in root)
        rootOverride.layoutWrap = root.layoutWrap;
    if (Object.keys(rootOverride).length > 0) {
        map.set("__root__", rootOverride);
    }
    const nodes = typeof root.findAll === "function"
        ? root.findAll(() => true)
        : [];
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
        if ("layoutAlign" in node)
            override.layoutAlign = node.layoutAlign;
        if ("layoutGrow" in node)
            override.layoutGrow = node.layoutGrow;
        if ("layoutSizingHorizontal" in node)
            override.layoutSizingHorizontal = node.layoutSizingHorizontal;
        if ("layoutSizingVertical" in node)
            override.layoutSizingVertical = node.layoutSizingVertical;
        if ("constraints" in node)
            override.constraints = node.constraints;
        if ("layoutMode" in node)
            override.layoutMode = node.layoutMode;
        if ("primaryAxisAlignItems" in node)
            override.primaryAxisAlignItems = node.primaryAxisAlignItems;
        if ("counterAxisAlignItems" in node)
            override.counterAxisAlignItems = node.counterAxisAlignItems;
        if ("primaryAxisSizingMode" in node)
            override.primaryAxisSizingMode = node.primaryAxisSizingMode;
        if ("counterAxisSizingMode" in node)
            override.counterAxisSizingMode = node.counterAxisSizingMode;
        if ("itemSpacing" in node)
            override.itemSpacing = node.itemSpacing;
        if ("paddingLeft" in node)
            override.paddingLeft = node.paddingLeft;
        if ("paddingRight" in node)
            override.paddingRight = node.paddingRight;
        if ("paddingTop" in node)
            override.paddingTop = node.paddingTop;
        if ("paddingBottom" in node)
            override.paddingBottom = node.paddingBottom;
        if ("layoutWrap" in node)
            override.layoutWrap = node.layoutWrap;
        if (Object.keys(override).length > 0) {
            map.set(path, override);
        }
    }
    return map;
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
            if ("layoutAlign" in instance && rootOverride.layoutAlign) {
                try {
                    instance.layoutAlign = rootOverride.layoutAlign;
                }
                catch (_a) { }
            }
            if ("layoutGrow" in instance && typeof rootOverride.layoutGrow === "number") {
                try {
                    instance.layoutGrow = rootOverride.layoutGrow;
                }
                catch (_b) { }
            }
            if ("layoutSizingHorizontal" in instance && rootOverride.layoutSizingHorizontal) {
                try {
                    instance.layoutSizingHorizontal = rootOverride.layoutSizingHorizontal;
                }
                catch (_c) { }
            }
            if ("layoutSizingVertical" in instance && rootOverride.layoutSizingVertical) {
                try {
                    instance.layoutSizingVertical = rootOverride.layoutSizingVertical;
                }
                catch (_d) { }
            }
            if ("constraints" in instance && rootOverride.constraints) {
                try {
                    instance.constraints = rootOverride.constraints;
                }
                catch (_f) { }
            }
            if (typeof rootOverride.width === "number" && typeof rootOverride.height === "number") {
                try {
                    if ("resizeWithoutConstraints" in instance) {
                        instance.resizeWithoutConstraints(rootOverride.width, rootOverride.height);
                    }
                    else if ("resize" in instance) {
                        instance.resize(rootOverride.width, rootOverride.height);
                    }
                }
                catch (_g) {
                    // ignore resize errors on auto-layout instances
                }
            }
            if ("layoutMode" in instance && rootOverride.layoutMode) {
                try {
                    instance.layoutMode = rootOverride.layoutMode;
                }
                catch (_h) { }
            }
            if ("primaryAxisAlignItems" in instance && rootOverride.primaryAxisAlignItems) {
                try {
                    instance.primaryAxisAlignItems = rootOverride.primaryAxisAlignItems;
                }
                catch (_j) { }
            }
            if ("counterAxisAlignItems" in instance && rootOverride.counterAxisAlignItems) {
                try {
                    instance.counterAxisAlignItems = rootOverride.counterAxisAlignItems;
                }
                catch (_k) { }
            }
            if ("primaryAxisSizingMode" in instance && rootOverride.primaryAxisSizingMode) {
                try {
                    instance.primaryAxisSizingMode = rootOverride.primaryAxisSizingMode;
                }
                catch (_l) { }
            }
            if ("counterAxisSizingMode" in instance && rootOverride.counterAxisSizingMode) {
                try {
                    instance.counterAxisSizingMode = rootOverride.counterAxisSizingMode;
                }
                catch (_m) { }
            }
            if ("itemSpacing" in instance && typeof rootOverride.itemSpacing === "number") {
                try {
                    instance.itemSpacing = rootOverride.itemSpacing;
                }
                catch (_o) { }
            }
            if ("paddingLeft" in instance && typeof rootOverride.paddingLeft === "number") {
                try {
                    instance.paddingLeft = rootOverride.paddingLeft;
                }
                catch (_p) { }
            }
            if ("paddingRight" in instance && typeof rootOverride.paddingRight === "number") {
                try {
                    instance.paddingRight = rootOverride.paddingRight;
                }
                catch (_q) { }
            }
            if ("paddingTop" in instance && typeof rootOverride.paddingTop === "number") {
                try {
                    instance.paddingTop = rootOverride.paddingTop;
                }
                catch (_r) { }
            }
            if ("paddingBottom" in instance && typeof rootOverride.paddingBottom === "number") {
                try {
                    instance.paddingBottom = rootOverride.paddingBottom;
                }
                catch (_s) { }
            }
            if ("layoutWrap" in instance && rootOverride.layoutWrap) {
                try {
                    instance.layoutWrap = rootOverride.layoutWrap;
                }
                catch (_t) { }
            }
        }
        const nodes = typeof instance.findAll === "function"
            ? instance.findAll(() => true)
            : [];
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
                    catch (_u) {
                        // ignore if fonts failed to load or text is read-only
                    }
                }
                if (override.textAlignHorizontal) {
                    try {
                        textNode.textAlignHorizontal = override.textAlignHorizontal;
                    }
                    catch (_v) { }
                }
                if (override.textAlignVertical) {
                    try {
                        textNode.textAlignVertical = override.textAlignVertical;
                    }
                    catch (_w) { }
                }
                if (override.textAutoResize) {
                    try {
                        textNode.textAutoResize = override.textAutoResize;
                    }
                    catch (_x) { }
                }
            }
            if ("layoutAlign" in node && override.layoutAlign) {
                try {
                    node.layoutAlign = override.layoutAlign;
                }
                catch (_y) { }
            }
            if ("layoutGrow" in node && typeof override.layoutGrow === "number") {
                try {
                    node.layoutGrow = override.layoutGrow;
                }
                catch (_z) { }
            }
            if ("layoutSizingHorizontal" in node && override.layoutSizingHorizontal) {
                try {
                    node.layoutSizingHorizontal = override.layoutSizingHorizontal;
                }
                catch (_0) { }
            }
            if ("layoutSizingVertical" in node && override.layoutSizingVertical) {
                try {
                    node.layoutSizingVertical = override.layoutSizingVertical;
                }
                catch (_1) { }
            }
            if ("constraints" in node && override.constraints) {
                try {
                    node.constraints = override.constraints;
                }
                catch (_2) { }
            }
            if ("layoutMode" in node && override.layoutMode) {
                try {
                    node.layoutMode = override.layoutMode;
                }
                catch (_3) { }
            }
            if ("primaryAxisAlignItems" in node && override.primaryAxisAlignItems) {
                try {
                    node.primaryAxisAlignItems = override.primaryAxisAlignItems;
                }
                catch (_4) { }
            }
            if ("counterAxisAlignItems" in node && override.counterAxisAlignItems) {
                try {
                    node.counterAxisAlignItems = override.counterAxisAlignItems;
                }
                catch (_5) { }
            }
            if ("primaryAxisSizingMode" in node && override.primaryAxisSizingMode) {
                try {
                    node.primaryAxisSizingMode = override.primaryAxisSizingMode;
                }
                catch (_6) { }
            }
            if ("counterAxisSizingMode" in node && override.counterAxisSizingMode) {
                try {
                    node.counterAxisSizingMode = override.counterAxisSizingMode;
                }
                catch (_7) { }
            }
            if ("itemSpacing" in node && typeof override.itemSpacing === "number") {
                try {
                    node.itemSpacing = override.itemSpacing;
                }
                catch (_8) { }
            }
            if ("paddingLeft" in node && typeof override.paddingLeft === "number") {
                try {
                    node.paddingLeft = override.paddingLeft;
                }
                catch (_9) { }
            }
            if ("paddingRight" in node && typeof override.paddingRight === "number") {
                try {
                    node.paddingRight = override.paddingRight;
                }
                catch (_10) { }
            }
            if ("paddingTop" in node && typeof override.paddingTop === "number") {
                try {
                    node.paddingTop = override.paddingTop;
                }
                catch (_11) { }
            }
            if ("paddingBottom" in node && typeof override.paddingBottom === "number") {
                try {
                    node.paddingBottom = override.paddingBottom;
                }
                catch (_12) { }
            }
            if ("layoutWrap" in node && override.layoutWrap) {
                try {
                    node.layoutWrap = override.layoutWrap;
                }
                catch (_13) { }
            }
        }
    });
}
function applyAutofixItem(item) {
    return __awaiter(this, void 0, void 0, function* () {
        var _a, _b, _c, _d, _f;
        const id = String(item.id || "");
        if (!id)
            return { ok: false, error: "Missing node id." };
        const node = yield figma.getNodeByIdAsync(id);
        if (!node || !("id" in node))
            return { ok: false, error: "Node not found." };
        if (item.issueType === "DETACHED_INSTANCE" || item.kind === "detached") {
            const info = node.detachedInfo;
            if (!info)
                return { ok: false, error: "Node is not detached." };
            const overrides = collectInstanceOverrides(node);
            const instance = yield createInstanceFromDetachedInfo(info);
            if (!instance)
                return { ok: false, error: "Component not found or unavailable." };
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
            if ("rotation" in instance)
                instance.rotation = node.rotation || 0;
            if ("opacity" in instance)
                instance.opacity = (_a = node.opacity) !== null && _a !== void 0 ? _a : 1;
            if ("visible" in instance)
                instance.visible = (_b = node.visible) !== null && _b !== void 0 ? _b : true;
            if ("locked" in instance)
                instance.locked = (_c = node.locked) !== null && _c !== void 0 ? _c : false;
            if ("resizeWithoutConstraints" in instance && "width" in node && "height" in node) {
                instance.resizeWithoutConstraints(node.width, node.height);
            }
            else if ("resize" in instance && "width" in node && "height" in node) {
                instance.resize(node.width, node.height);
            }
            yield applyInstanceOverridesToInstance(instance, overrides);
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
                const { candidates, recommendedId } = yield findTextCandidates(node);
                candidateId = recommendedId || (((_d = candidates[0]) === null || _d === void 0 ? void 0 : _d.id) || "");
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
            const { candidates, recommendedId } = yield findColorCandidates(color, node, kind);
            candidateId = recommendedId || (((_f = candidates[0]) === null || _f === void 0 ? void 0 : _f.id) || "");
        }
        if (!candidateId)
            return { ok: false, error: "Missing candidate." };
        if (candidateId.startsWith("style:")) {
            const styleId = candidateId.replace("style:", "");
            if (kind === "fills" && "fillStyleId" in node) {
                node.fillStyleId = styleId;
            }
            else if (kind === "strokes" && "strokeStyleId" in node) {
                node.strokeStyleId = styleId;
            }
            else {
                return { ok: false, error: "Unsupported node." };
            }
            return { ok: true };
        }
        const variable = yield figma.variables.getVariableByIdAsync(candidateId);
        if (!variable)
            return { ok: false, error: "Variable not found." };
        const paints = node[kind];
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
        node[kind] = next;
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
function hasBoundPaintVariable(node, kind) {
    const anyNode = node;
    // Node-level bindings
    const bv = anyNode.boundVariables;
    if (bv && bv[kind])
        return true;
    // Paint-level bindings
    if (kind in anyNode) {
        const paints = anyNode[kind];
        if (!isMixed(paints) && Array.isArray(paints)) {
            for (const p of paints) {
                const pbv = p === null || p === void 0 ? void 0 : p.boundVariables;
                if (pbv && typeof pbv === "object") {
                    if (pbv.color || pbv.opacity)
                        return true;
                    for (const k of Object.keys(pbv)) {
                        if (pbv[k])
                            return true;
                    }
                }
                const stops = p.gradientStops;
                if (Array.isArray(stops)) {
                    for (const s of stops) {
                        const sbv = s === null || s === void 0 ? void 0 : s.boundVariables;
                        if (sbv && typeof sbv === "object") {
                            if (sbv.color || sbv.opacity)
                                return true;
                            for (const k of Object.keys(sbv)) {
                                if (sbv[k])
                                    return true;
                            }
                        }
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
    const fills = node.fills;
    if (isMixed(fills) || !Array.isArray(fills) || fills.length === 0)
        return false;
    const fillStyleId = node.fillStyleId;
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
    const strokes = node.strokes;
    if (isMixed(strokes) || !Array.isArray(strokes) || strokes.length === 0)
        return false;
    const strokeStyleId = node.strokeStyleId;
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
    if ("unit" in lineHeight && lineHeight.unit === "AUTO")
        return null;
    const unit = lineHeight.unit;
    const value = lineHeight.value;
    if (typeof value !== "number")
        return null;
    if (unit === "PIXELS")
        return value;
    if (unit === "PERCENT")
        return fontSize * (value / 100);
    return null;
}
function letterSpacingToPx(letterSpacing, fontSize) {
    if (!letterSpacing)
        return null;
    const unit = letterSpacing.unit;
    const value = letterSpacing.value;
    if (typeof value !== "number")
        return null;
    if (unit === "PIXELS")
        return value;
    if (unit === "PERCENT")
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
    const lineHeightAuto = !!(lineHeight && "unit" in lineHeight && lineHeight.unit === "AUTO");
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
    return Object.keys(bound).some((k) => bound[k]);
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
            const styleLineAuto = !!(styleLineHeight && "unit" in styleLineHeight && styleLineHeight.unit === "AUTO");
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
        const sorted = candidates.sort((a, b) => {
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
    if (scopes.includes("ALL_SCOPES"))
        return true;
    const targetScopes = nodeScopeForVariable(node, kind);
    return targetScopes.some((s) => scopes.includes(s));
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
    const resolved = node.resolvedVariableModes;
    if (resolved && resolved[collection.id])
        return resolved[collection.id];
    const explicit = node.explicitVariableModes;
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
    const paint = paints.find((p) => p && p.visible !== false) || paints[0];
    if (!paint)
        return null;
    return paintToRgba(paint);
}
function isVariableAlias(value) {
    return !!value && typeof value === "object" && value.type === "VARIABLE_ALIAS" && typeof value.id === "string";
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
function findColorCandidates(target, consumer, kind) {
    return __awaiter(this, void 0, void 0, function* () {
        const candidates = [];
        const targetKey = rgbaToKey(target);
        const varsApi = figma.variables;
        const collections = yield (typeof varsApi.getVariableCollectionsAsync === "function"
            ? varsApi.getVariableCollectionsAsync()
            : varsApi.getLocalVariableCollectionsAsync());
        const localVars = yield (typeof varsApi.getVariablesAsync === "function"
            ? varsApi.getVariablesAsync()
            : varsApi.getLocalVariablesAsync());
        let libraryVars = yield loadLibraryVariables(varsApi);
        if (libraryVars.length === 0 && libraryVariableCache.size === 0) {
            libraryVars = yield loadLibraryVariables(varsApi, true);
        }
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
                catch (_a) {
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
            const keywords = layerKeywordsForNode(consumer, kind);
            try {
                const resolved = variable.resolveForConsumer(consumer);
                if (resolved && resolved.resolvedType === "COLOR" && typeof resolved.value === "object" && resolved.value) {
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
            if (!matched) {
                const rawValue = modeId ? valuesByMode[modeId] : null;
                if (rawValue && isVariableAlias(rawValue))
                    aliasHit = true;
                const resolved = yield resolveVariableColor(variable, modeId || "", new Set());
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
            const isLocal = !((collection === null || collection === void 0 ? void 0 : collection.remote) === true) && !((variable === null || variable === void 0 ? void 0 : variable.remote) === true);
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
            const styles = figma.getLocalPaintStyles();
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
        const res = yield fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Systemic-Token": SYSTEMIC_TOKEN,
            },
            body: JSON.stringify({ licenseKey, installationId: instanceId }),
        });
        const rawText = yield res.text();
        let data = null;
        try {
            data = rawText ? JSON.parse(rawText) : null;
        }
        catch (_b) {
            data = null;
        }
        // Provide a readable message for UI
        const serverMessage = stringifyMessage(data && (data.error || data.message)) ||
            (typeof rawText === "string" && rawText.trim() ? rawText.trim() : null) ||
            `HTTP ${res.status}`;
        if (!res.ok) {
            return {
                ok: false,
                entitlements: { pro: false },
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
        const nodes = collectNodes(selection, options.scanChildren);
        const issues = [];
        const totalNodes = nodes.length;
        let processed = 0;
        let lastProgress = 0;
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
        const addIssue = (node, type) => {
            issues.push({ id: node.id, name: node.name, type, path: getNodePath(node) });
            elementsWithIssuesSet.add(node.id);
        };
        for (const node of nodes) {
            try {
                if (options.checkDetached && canCheckDetachedInfo(node)) {
                    markAudited(node);
                    if (isDetachedInstanceLike(node)) {
                        const info = node.detachedInfo;
                        const label = info ? yield getDetachedComponentName(info) : undefined;
                        issues.push({
                            id: node.id,
                            name: node.name,
                            type: "DETACHED_INSTANCE",
                            path: getNodePath(node),
                            detachedComponentName: label,
                        });
                        elementsWithIssuesSet.add(node.id);
                        detached++;
                    }
                }
                if (options.checkTextStyles && node.type === "TEXT") {
                    markAudited(node);
                    if (hasUnstyledText(node)) {
                        const mixedText = isMixedTextProps(node);
                        issues.push({
                            id: node.id,
                            name: node.name,
                            type: "UNSTYLED_TEXT",
                            path: getNodePath(node),
                            mixedText,
                        });
                        unstyledText++;
                    }
                }
                if (options.checkRogueFills && ("fills" in node)) {
                    markAudited(node);
                    if (hasRogueFill(node)) {
                        addIssue(node, "ROGUE_FILL");
                        rogueFills++;
                    }
                }
                if (options.checkRogueStrokes && ("strokes" in node)) {
                    markAudited(node);
                    if (hasRogueStroke(node)) {
                        addIssue(node, "ROGUE_STROKE");
                        rogueStrokes++;
                    }
                }
            }
            catch (_a) {
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
            scannedElements,
            elementsWithIssues,
        };
        return { issues, summary };
    });
}
figma.ui.onmessage = (msg) => __awaiter(void 0, void 0, void 0, function* () {
    var _a, _b, _c, _d, _f, _g, _h, _j, _k, _l, _m, _o;
    if (msg.type === "resize") {
        const w = Math.max(MIN_W, Math.round(Number(msg.width) || DEFAULT_W));
        const h = Math.max(MIN_H, Math.round(Number(msg.height) || DEFAULT_H));
        figma.ui.resize(w, h);
        yield figma.clientStorage.setAsync("uiSize", { width: w, height: h });
        return;
    }
    // -----------------------
    // PRO / LICENSE messages
    // -----------------------
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:get-entitlements") {
        const isPro = !!entitlements.pro && !isExpired(entitlements);
        figma.ui.postMessage({
            type: "pro:entitlements",
            isPro,
            entitlements: { pro: isPro },
            source: entitlements.source,
            expiresAt: entitlements.expiresAt,
            licenseKeyLast4: entitlements.licenseKeyLast4,
        });
        return;
    }
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:clearLicense") {
        entitlements = makeDefaultEntitlements();
        yield figma.clientStorage.deleteAsync(ENTITLEMENTS_STORAGE_KEY);
        yield figma.clientStorage.deleteAsync(DEBUG_PRO_STORAGE_KEY);
        yield clearStoredLicenseKey();
        const isPro = !!entitlements.pro && !isExpired(entitlements);
        figma.ui.postMessage({
            type: "pro:entitlements",
            isPro,
            entitlements: { pro: isPro },
            source: entitlements.source,
            expiresAt: entitlements.expiresAt,
            licenseKeyLast4: entitlements.licenseKeyLast4,
            licenseKey: storedLicenseKey,
        });
        return;
    }
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:debug:set") {
        if (!DEV_PRO)
            return;
        const isPro = !!msg.isPro;
        yield figma.clientStorage.setAsync(DEBUG_PRO_STORAGE_KEY, isPro);
        entitlements = makeDebugEntitlements(isPro);
        const proFlag = !!entitlements.pro && !isExpired(entitlements);
        figma.ui.postMessage({
            type: "pro:entitlements",
            isPro: proFlag,
            entitlements: { pro: proFlag },
            source: entitlements.source,
            expiresAt: entitlements.expiresAt,
            licenseKeyLast4: entitlements.licenseKeyLast4,
            licenseKey: storedLicenseKey,
        });
        return;
    }
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:autofix") {
        // Pro-only feature: UI sends this when Pro is verified.
        // For now we just confirm whether the user has the entitlement.
        const allowed = hasFeature(entitlements, "autofix");
        autofixCancelRequested = false;
        if (!allowed) {
            figma.notify("Auto-fix is a Pro feature. Please activate Systemic Pro.");
            return;
        }
        const items = Array.isArray(msg.items) ? msg.items : [];
        const skipped = msg.skipped || {};
        if (!items.length) {
            figma.ui.postMessage({ type: "pro:autofix:done", total: 0, resolved: 0, failed: 0, skipped, resolvedItems: [] });
            return;
        }
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
                    catch (_p) {
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
        catch (_q) {
            failed += Math.max(0, total - processed);
        }
        finally {
            figma.ui.postMessage({ type: "pro:autofix:done", total, resolved, failed, skipped, resolvedItems, canceled });
            if (canceled) {
                figma.notify("Auto-fix canceled. Press Cmd+Z to undo any changes.");
            }
            autofixCancelRequested = false;
            const selection = figma.currentPage.selection;
            let auditTargets = selection;
            if ((!auditTargets || auditTargets.length === 0) && lastAuditSelectionIds.length > 0) {
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
                auditTargets = restored;
            }
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
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:autofix:cancel") {
        autofixCancelRequested = true;
        return;
    }
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:autofix:candidates") {
        const allowed = hasFeature(entitlements, "autofix");
        const id = String(msg.id || "");
        const kind = msg.kind === "stroke" ? "strokes" : (msg.kind === "text" ? "text" : "fills");
        const key = String(msg.key || "");
        if (!allowed || !id) {
            figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates: [], recommendedId: null });
            return;
        }
        try {
            const varsApi = figma.variables;
            if (!varsApi || (typeof varsApi.getVariablesAsync !== "function" && typeof varsApi.getLocalVariablesAsync !== "function")) {
                figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates: [], recommendedId: null });
                return;
            }
            const node = yield figma.getNodeByIdAsync(id);
            if (!node || !("id" in node)) {
                figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates: [], recommendedId: null });
                return;
            }
            if (kind === "text") {
                if (node.type !== "TEXT") {
                    figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates: [], recommendedId: null });
                    return;
                }
                const { candidates, recommendedId, mixed } = yield findTextCandidates(node);
                figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates, recommendedId, mixed });
                return;
            }
            const color = getSolidPaintColor(node, kind);
            if (!color) {
                figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates: [], recommendedId: null });
                return;
            }
            const { candidates, recommendedId, debug } = yield findColorCandidates(color, node, kind);
            figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates, recommendedId, debug });
        }
        catch (e) {
            figma.ui.postMessage({ type: "pro:autofix:candidates", key, candidates: [], recommendedId: null });
        }
        return;
    }
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:autofix:apply") {
        const allowed = hasFeature(entitlements, "autofix");
        const id = String(msg.id || "");
        const kind = msg.kind === "stroke" ? "strokes" : (msg.kind === "text" ? "text" : "fills");
        const candidateId = String(msg.candidateId || "");
        const issueType = String(msg.issueType || "");
        if (!allowed || !id || (!candidateId && issueType !== "DETACHED_INSTANCE")) {
            figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Auto-fix is not available." });
            return;
        }
        try {
            const node = yield figma.getNodeByIdAsync(id);
            if (!node || !("id" in node)) {
                figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Node not found." });
                return;
            }
            if (issueType === "DETACHED_INSTANCE") {
                const info = node.detachedInfo;
                if (!info) {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Node is not detached." });
                    return;
                }
                const instance = yield createInstanceFromDetachedInfo(info);
                if (!instance) {
                    figma.ui.postMessage({
                        type: "pro:autofix:result",
                        id,
                        issueType,
                        ok: false,
                        error: "Component not found or unavailable.",
                    });
                    return;
                }
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
                if ("rotation" in instance)
                    instance.rotation = node.rotation || 0;
                if ("opacity" in instance)
                    instance.opacity = (_a = node.opacity) !== null && _a !== void 0 ? _a : 1;
                if ("visible" in instance)
                    instance.visible = (_b = node.visible) !== null && _b !== void 0 ? _b : true;
                if ("locked" in instance)
                    instance.locked = (_c = node.locked) !== null && _c !== void 0 ? _c : false;
                if ("resizeWithoutConstraints" in instance && "width" in node && "height" in node) {
                    instance.resizeWithoutConstraints(node.width, node.height);
                }
                else if ("resize" in instance && "width" in node && "height" in node) {
                    instance.resize(node.width, node.height);
                }
                node.remove();
                figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: true });
                return;
            }
            if (issueType === "UNSTYLED_TEXT" || kind === "text") {
                if (node.type !== "TEXT") {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Unsupported node." });
                    return;
                }
                if (!candidateId.startsWith("textstyle:")) {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Text style not found." });
                    return;
                }
                const styleId = candidateId.replace("textstyle:", "");
                const style = yield figma.getStyleByIdAsync(styleId);
                if (!style || style.type !== "TEXT") {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Text style not found." });
                    return;
                }
                yield figma.loadFontAsync(style.fontName);
                yield node.setTextStyleIdAsync(styleId);
                figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: true });
                return;
            }
            if (candidateId.startsWith("style:")) {
                const styleId = candidateId.replace("style:", "");
                if (kind === "fills" && "fillStyleId" in node) {
                    node.fillStyleId = styleId;
                }
                else if (kind === "strokes" && "strokeStyleId" in node) {
                    node.strokeStyleId = styleId;
                }
                else {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Unsupported node." });
                    return;
                }
            }
            else {
                const variable = yield figma.variables.getVariableByIdAsync(candidateId);
                if (!variable) {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Variable not found." });
                    return;
                }
                const paints = node[kind];
                if (!paints || paints === figma.mixed || !Array.isArray(paints) || paints.length === 0) {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "No paint to bind." });
                    return;
                }
                const next = paints.slice();
                const idx = next.findIndex((p) => p && p.type === "SOLID" && p.visible !== false);
                const paintIndex = idx >= 0 ? idx : 0;
                const paint = next[paintIndex];
                if (!paint || paint.type !== "SOLID") {
                    figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: "Unsupported paint type." });
                    return;
                }
                next[paintIndex] = figma.variables.setBoundVariableForPaint(paint, "color", variable);
                node[kind] = next;
            }
            figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: true });
        }
        catch (e) {
            const message = stringifyMessage(e) || "Auto-fix failed.";
            figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, ok: false, error: message });
        }
        return;
    }
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:verify") {
        const licenseKey = String(msg.key || "").trim();
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
            const result = yield verifyLicenseWithWorker(licenseKey, instanceId);
            const isPro = !!((_d = result.entitlements) === null || _d === void 0 ? void 0 : _d.pro);
            if (!result.ok || !isPro) {
                figma.ui.postMessage({
                    type: "pro:verify:result",
                    ok: false,
                    entitlements: { pro: false },
                    status: (_f = result.status) !== null && _f !== void 0 ? _f : null,
                    valid: typeof result.valid === "boolean" ? result.valid : undefined,
                    daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
                    error: result.error || "Could not verify license. Please try again.",
                });
                return;
            }
            const base = makeDefaultEntitlements();
            entitlements = Object.assign(Object.assign({}, base), { pro: true, source: "license", features: makeProFeaturesAllEnabled(), expiresAt: undefined, licenseKeyLast4: licenseKey.slice(-4) });
            yield saveStoredLicenseKey(licenseKey);
            figma.ui.postMessage({
                type: "pro:entitlements",
                isPro: true,
                entitlements: { pro: true },
                source: entitlements.source,
                expiresAt: entitlements.expiresAt,
                licenseKeyLast4: entitlements.licenseKeyLast4,
                licenseKey: storedLicenseKey,
                status: (_g = result.status) !== null && _g !== void 0 ? _g : null,
                valid: typeof result.valid === "boolean" ? result.valid : undefined,
                daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
            });
            figma.ui.postMessage({
                type: "pro:verify:result",
                ok: true,
                isPro: true,
                entitlements: { pro: true },
                status: (_h = result.status) !== null && _h !== void 0 ? _h : null,
                valid: typeof result.valid === "boolean" ? result.valid : undefined,
                daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
                licenseKey: storedLicenseKey,
            });
        }
        catch (e) {
            const message = stringifyMessage(e);
            figma.ui.postMessage({
                type: "pro:verify:result",
                ok: false,
                entitlements: { pro: false },
                error: message && message.trim() ? message : "Could not verify license. Please try again.",
            });
        }
        return;
    }
    if ((msg === null || msg === void 0 ? void 0 : msg.type) === "pro:activate") {
        const licenseKey = String(msg.key || "").trim();
        if (!licenseKey) {
            figma.ui.postMessage({
                type: "pro:verify:result",
                ok: false,
                entitlements: { pro: false },
                error: "Please enter a license key.",
            });
            return;
        }
        figma.ui.postMessage({ type: "pro:verify:state", state: "verifying" });
        try {
            const instanceId = yield getOrCreateInstanceId();
            const result = yield activateLicenseWithWorker(licenseKey, instanceId);
            const isPro = !!((_j = result.entitlements) === null || _j === void 0 ? void 0 : _j.pro) || result.activated === true;
            if (!result.ok || result.activated === false || !isPro) {
                figma.ui.postMessage({
                    type: "pro:verify:result",
                    ok: false,
                    entitlements: { pro: false },
                    status: (_k = result.status) !== null && _k !== void 0 ? _k : null,
                    valid: typeof result.valid === "boolean" ? result.valid : undefined,
                    daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
                    error: result.error || "Could not activate license. Please try again.",
                });
                return;
            }
            const base = makeDefaultEntitlements();
            entitlements = Object.assign(Object.assign({}, base), { pro: true, source: "license", features: makeProFeaturesAllEnabled(), expiresAt: undefined, licenseKeyLast4: licenseKey.slice(-4) });
            yield figma.clientStorage.setAsync(INSTANCE_ID_STORAGE_KEY, instanceId);
            yield saveStoredLicenseKey(licenseKey);
            figma.ui.postMessage({
                type: "pro:entitlements",
                isPro: true,
                entitlements: { pro: true },
                source: entitlements.source,
                expiresAt: entitlements.expiresAt,
                licenseKeyLast4: entitlements.licenseKeyLast4,
                licenseKey: storedLicenseKey,
                status: (_l = result.status) !== null && _l !== void 0 ? _l : null,
                valid: typeof result.valid === "boolean" ? result.valid : undefined,
                daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
            });
            figma.ui.postMessage({
                type: "pro:verify:result",
                ok: true,
                isPro: true,
                entitlements: { pro: true },
                status: (_m = result.status) !== null && _m !== void 0 ? _m : null,
                valid: typeof result.valid === "boolean" ? result.valid : undefined,
                daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
                licenseKey: storedLicenseKey,
            });
        }
        catch (e) {
            const message = stringifyMessage(e);
            figma.ui.postMessage({
                type: "pro:verify:result",
                ok: false,
                entitlements: { pro: false },
                error: message && message.trim() ? message : "Could not activate license. Please try again.",
            });
        }
        return;
    }
    if (msg.type === "run-audit") {
        textStyleCache = null;
        const varsApi = figma.variables;
        if (varsApi && typeof varsApi.importVariableByKeyAsync === "function") {
            loadLibraryVariables(varsApi, true);
        }
        const selection = figma.currentPage.selection;
        if (selection.length === 0) {
            figma.ui.postMessage({ type: "no-selection" });
            figma.notify("Nothing selected. Choose a frame, layer, or element, then scan again.");
            return;
        }
        const options = (_o = msg.options) !== null && _o !== void 0 ? _o : {
            scanChildren: true,
            checkRogueFills: true,
            checkRogueStrokes: true,
            checkDetached: true,
            checkTextStyles: true,
        };
        lastAuditOptions = options;
        lastAuditSelectionIds = selection.map((node) => node.id);
        const { issues, summary } = yield runAudit(selection, options);
        figma.ui.postMessage({ type: "audit-result", issues, summary });
        figma.notify(`Audit complete: ${summary.total} issue(s) found.`);
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
            catch (_r) {
                resolvedIds.push(id);
            }
        }
        figma.ui.postMessage({ type: "issues:resolved", resolvedIds });
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
