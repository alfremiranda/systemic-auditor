const DEFAULT_W = 440;
const DEFAULT_H = 540;
const MIN_W = 360;
const MIN_H = 360; // the condensed empty/no-selection state fits well under this

// Show the plugin window
figma.showUI(__html__, { width: DEFAULT_W, height: DEFAULT_H, title: "Systemic Auditor" });

// Restore last window size (if available)
(async () => {
  const saved = await figma.clientStorage.getAsync("uiSize");
  if (saved && typeof saved.width === "number" && typeof saved.height === "number") {
    const width = Math.max(MIN_W, Math.round(saved.width));
    const height = Math.max(MIN_H, Math.round(saved.height));
    figma.ui.resize(width, height);
  }
})();

// =======================
// PRO / LICENSE GATING
// =======================

type ProFeature = "autofix" | "export";

type Entitlements = {
  pro: boolean;
  source: "none" | "dev" | "license";
  features: Record<ProFeature, boolean>;
  expiresAt?: number; // epoch ms
  licenseKeyLast4?: string;
};

const ENTITLEMENTS_STORAGE_KEY = "systemic_entitlements_v1";
const LICENSE_KEY_STORAGE_KEY = "systemic_license_key_v1";
const INSTANCE_ID_STORAGE_KEY = "systemic_instance_id";
const DEBUG_PRO_STORAGE_KEY = "systemic_debug_pro_override";
const SCANNER_OPTIONS_STORAGE_KEY = "systemic_scanner_options_v1";

// ✅ DEV OVERRIDE (set true locally when testing Pro features)
const DEV_PRO = false;
// ✅ DEV license state override for UI testing ("expired" | "trial" | "pro" | null)
const DEV_FORCE_LICENSE_STATUS: "expired" | "trial" | "pro" | null = null;

// ✅ Cloudflare Worker (License server)
const LICENSE_WORKER_BASE = "https://systemic-license.im-94e.workers.dev";
const WORKER_VERIFY_URL = `${LICENSE_WORKER_BASE}/verify`;
const WORKER_ACTIVATE_URL = `${LICENSE_WORKER_BASE}/activate`;

// ✅ Secret header to protect the Worker (matches env.SYSTEMIC_TOKEN)
// NOTE: This is still visible in the plugin bundle; later we can harden this.
const SYSTEMIC_TOKEN = "rK8pVt_3Qm7nZx2Lh6YbW9cD1sF4aJ0uN5gHkP2eT8vXqM3iR7wS1yU6oC9lB4d";

const ALL_PRO_FEATURES: ProFeature[] = ["autofix", "export"];

function stringifyMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error && value.message) return value.message;
  if (value == null) return "";
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (val && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

function makeDefaultEntitlements(): Entitlements {
  return {
    pro: false,
    source: "none",
    features: {
      autofix: false,
      export: false,
    },
  };
}

function makeDevEntitlements(): Entitlements {
  const features = ALL_PRO_FEATURES.reduce((acc, f) => {
    acc[f] = true;
    return acc;
  }, {} as Record<ProFeature, boolean>);
  return { pro: true, source: "dev", features };
}

function makeDebugEntitlements(isPro: boolean): Entitlements {
  if (!isPro) return makeDefaultEntitlements();
  const features = ALL_PRO_FEATURES.reduce((acc, f) => {
    acc[f] = true;
    return acc;
  }, {} as Record<ProFeature, boolean>);
  return { pro: true, source: "dev", features };
}

async function loadDebugProOverride(): Promise<boolean | null> {
  const saved = await figma.clientStorage.getAsync(DEBUG_PRO_STORAGE_KEY);
  return typeof saved === "boolean" ? saved : null;
}

function isExpired(ent: Entitlements): boolean {
  if (!ent.expiresAt) return false;
  return Date.now() > ent.expiresAt;
}

async function loadEntitlements(): Promise<Entitlements> {
  if (DEV_PRO) return makeDevEntitlements();
  // Always start fresh each launch; do not persist Pro status across sessions.
  return makeDefaultEntitlements();
}

function hasFeature(ent: Entitlements, feature: ProFeature): boolean {
  return !!ent.pro && !!ent.features?.[feature] && !isExpired(ent);
}

async function loadLibraryVariables(varsApi: typeof figma.variables, force = false): Promise<Variable[]> {
  if (!figma.teamLibrary || typeof figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync !== "function") {
    return [];
  }
  if (!varsApi || typeof varsApi.importVariableByKeyAsync !== "function") {
    return [];
  }
  // A load is already running: share it instead of importing the same variables twice.
  if (libraryLoadPromise) return libraryLoadPromise;
  const now = Date.now();
  if (!force && libraryVariablesLoaded) {
    return Array.from(libraryVariableCache.values());
  }
  if (!force && libraryVariableCache.size === 0 && now - libraryVariablesLastAttempt < 5000) {
    return [];
  }
  libraryVariablesLastAttempt = now;
  libraryLoadPromise = (async () => {
    try {
      return await importLibraryVariables(varsApi);
    } finally {
      libraryLoadPromise = null;
    }
  })();
  return libraryLoadPromise;
}

async function importLibraryVariables(varsApi: typeof figma.variables): Promise<Variable[]> {
  libraryVariablesLoading = true;
  try {
    const collections = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    libraryCollectionsCount = collections.length;
    for (const collection of collections) {
      const variables = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(collection.key);
      for (const variable of variables) {
        if (variable.resolvedType !== "COLOR") continue;
        if (libraryVariableCache.has(variable.key)) continue;
        try {
          const imported = await varsApi.importVariableByKeyAsync(variable.key);
          if (imported) {
            let hydrated = imported as Variable;
            try {
              if (typeof varsApi.getVariableByIdAsync === "function") {
                const fetched = await varsApi.getVariableByIdAsync(imported.id);
                if (fetched) hydrated = fetched as Variable;
              }
            } catch {
              // ignore hydration failures
            }
            libraryVariableCache.set(variable.key, hydrated);
          }
        } catch {
          libraryImportErrors += 1;
          // ignore import failures
        }
      }
    }
  } finally {
    libraryVariablesLoaded = libraryVariableCache.size > 0;
    libraryVariablesLoading = false;
  }
  return Array.from(libraryVariableCache.values());
}

let entitlements: Entitlements = makeDefaultEntitlements();
let autofixCancelRequested = false;
let scanCancelRequested = false;

// Ignore-list: stored on each node itself (travels with the file, visible to teammates),
// not in clientStorage (which is per-device). Keyed "<ISSUE_TYPE>", one pluginData entry per type.
function ignoreDataKey(issueType: IssueType): string {
  return `systemic:ignore:${issueType}`;
}
function isIssueIgnored(node: SceneNode, issueType: IssueType): boolean {
  try {
    return node.getPluginData(ignoreDataKey(issueType)) === "1";
  } catch {
    return false;
  }
}
const libraryVariableCache = new Map<string, Variable>();
let libraryVariablesLoaded = false;
let libraryVariablesLastAttempt = 0;
let libraryCollectionsCount = 0;
let libraryImportErrors = 0;
let libraryVariablesLoading = false;
let libraryLoadPromise: Promise<Variable[]> | null = null;
// Variable id + mode id -> resolved color. Cleared at the start of every scan.
const variableColorCache = new Map<string, RGBA | null>();
// Local variable collections + color variables are identical across every candidate-matching
// request in a batch (nothing changes the document while the user watches the spinner), but
// findColorCandidates() re-fetched them from Figma on every single call — the dominant cost under
// a heavy scan (many rogue-fill/-stroke issues fire one candidate request each). Cache them for a
// few seconds so a batch of requests shares one fetch instead of re-fetching per issue.
let localColorVariablesCache: { collections: VariableCollection[]; vars: Variable[]; ts: number } | null = null;
let localColorVariablesLoadPromise: Promise<{ collections: VariableCollection[]; vars: Variable[] }> | null = null;
const LOCAL_COLOR_VARS_CACHE_TTL_MS = 5000;
let storedLicenseKey = "";
let autofixRunning = false;

// Last license answer from the Worker. Kept in memory so every "pro:entitlements"
// reply carries the same status/valid/daysLeft fields.
type LicenseInfo = { status: string | null; valid?: boolean; daysLeft?: number; offline?: boolean };
let licenseInfo: LicenseInfo = { status: null };

const LAST_VERIFIED_STORAGE_KEY = "systemic_last_verified_v1";
const OFFLINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function buildEntitlementsMessage(extra: Record<string, unknown> = {}) {
  const isPro = !!entitlements.pro && !isExpired(entitlements);
  return {
    type: "pro:entitlements",
    isPro,
    entitlements: { pro: isPro },
    source: entitlements.source,
    expiresAt: entitlements.expiresAt,
    licenseKeyLast4: entitlements.licenseKeyLast4,
    licenseKey: storedLicenseKey,
    status: licenseInfo.status,
    valid: licenseInfo.valid,
    daysLeft: licenseInfo.daysLeft,
    offline: licenseInfo.offline,
    ...extra,
  };
}

async function rememberSuccessfulVerify(status: string | null): Promise<void> {
  try {
    await figma.clientStorage.setAsync(LAST_VERIFIED_STORAGE_KEY, { at: Date.now(), status });
  } catch {
    /* ignore storage failures */
  }
}

async function forgetLastVerified(): Promise<void> {
  try {
    await figma.clientStorage.deleteAsync(LAST_VERIFIED_STORAGE_KEY);
  } catch {
    /* ignore storage failures */
  }
}

// Returns true when a previous non-trial verification is recent enough to keep Pro offline.
async function withinOfflineGrace(): Promise<{ ok: boolean; status: string | null }> {
  try {
    const saved = await figma.clientStorage.getAsync(LAST_VERIFIED_STORAGE_KEY);
    if (!saved || typeof saved.at !== "number") return { ok: false, status: null };
    const status = typeof saved.status === "string" ? saved.status : null;
    if (status === "trial") return { ok: false, status };
    return { ok: Date.now() - saved.at < OFFLINE_GRACE_MS, status };
  } catch {
    return { ok: false, status: null };
  }
}

async function loadStoredLicenseKey(): Promise<string> {
  const key = await figma.clientStorage.getAsync(LICENSE_KEY_STORAGE_KEY);
  storedLicenseKey = typeof key === "string" ? key : "";
  return storedLicenseKey;
}

async function saveStoredLicenseKey(key: string): Promise<void> {
  storedLicenseKey = key;
  await figma.clientStorage.setAsync(LICENSE_KEY_STORAGE_KEY, key);
}

async function clearStoredLicenseKey(): Promise<void> {
  storedLicenseKey = "";
  await figma.clientStorage.deleteAsync(LICENSE_KEY_STORAGE_KEY);
}


// Initialize entitlements and send to UI
(async () => {
  entitlements = await loadEntitlements();
  await loadStoredLicenseKey();

  if (DEV_PRO) {
    const debugOverride = await loadDebugProOverride();
    if (debugOverride !== null) {
      entitlements = makeDebugEntitlements(debugOverride);
    }
  }

  if (storedLicenseKey) {
    figma.ui.postMessage({ type: "pro:verify:state", state: "verifying", source: "startup" });
    // Network failures and 5xx answers are "transient": a paying user who is offline keeps Pro
    // for OFFLINE_GRACE_MS after their last successful (non-trial) verification. An explicit
    // denial from the Worker downgrades immediately.
    let result: LicenseResult | null = null;
    let failure = "";
    try {
      const instanceId = await getOrCreateInstanceId();
      result = await verifyLicenseWithWorker(storedLicenseKey, instanceId);
    } catch (e) {
      failure = stringifyMessage(e) || "Verify failed.";
    }

    if (result && !result.transient) {
      const isPro = !!result.entitlements?.pro && !!result.ok;
      licenseInfo = {
        status: result.status ?? null,
        valid: typeof result.valid === "boolean" ? result.valid : undefined,
        daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
      };
      if (isPro) {
        entitlements = makeLicenseEntitlements(storedLicenseKey);
        if (licenseInfo.status !== "trial") await rememberSuccessfulVerify(licenseInfo.status);
      } else {
        entitlements = makeDefaultEntitlements();
        await forgetLastVerified();
      }
      figma.ui.postMessage(buildEntitlementsMessage({ error: result.error }));
    } else {
      // Could not reach the Worker (fetch threw, or HTTP 5xx/429).
      const grace = await withinOfflineGrace();
      const error = (result && result.error) || failure || "Verify failed.";
      if (grace.ok) {
        entitlements = makeLicenseEntitlements(storedLicenseKey);
        licenseInfo = { status: grace.status, offline: true };
      } else {
        entitlements = makeDefaultEntitlements();
        licenseInfo = { status: null };
      }
      figma.ui.postMessage(buildEntitlementsMessage({ error }));
    }
  } else {
    figma.ui.postMessage(buildEntitlementsMessage());
  }
})();

type IssueType = "ROGUE_FILL" | "ROGUE_STROKE" | "UNSTYLED_TEXT" | "DETACHED_INSTANCE";

const ISSUE_TYPES: readonly IssueType[] = ["ROGUE_FILL", "ROGUE_STROKE", "UNSTYLED_TEXT", "DETACHED_INSTANCE"];
function isIssueType(value: string): value is IssueType {
  return (ISSUE_TYPES as readonly string[]).indexOf(value) >= 0;
}

type Issue = {
  id: string;
  name: string;
  type: IssueType;
  path: string;
  detachedComponentName?: string;
  mixedText?: boolean;
};

type AutofixCandidate = {
  id: string;
  name: string;
  displayName: string;
  source: "variable" | "style";
  collectionName?: string;
  isAlias?: boolean;
  score?: number;
  color?: string;
  deltaE?: number;
  disabled?: boolean;
  matchLevel?: "perfect" | "near" | "partial";
  note?: string;
};

type AutofixAllItem = {
  id: string;
  issueType: IssueType;
  kind: "fill" | "stroke" | "text" | "detached";
  candidateId: string;
};

type AuditOptions = {
  scanChildren: boolean;
  checkRogueFills: boolean;
  checkRogueStrokes: boolean;
  checkDetached: boolean;
  checkTextStyles: boolean;
};

let lastAuditOptions: AuditOptions | null = null;
let lastAuditSelectionIds: string[] = [];

function isMixed(value: unknown): value is typeof figma.mixed {
  return value === figma.mixed;
}

// Structural views over SceneNode for properties the typings don't expose on the union (or that
// only exist on some node types). Callers narrow these instead of trusting `any`.
type DetachedInfoHolder = { detachedInfo?: DetachedInfo | null };
type PaintHolder = {
  fills?: ReadonlyArray<Paint> | typeof figma.mixed;
  strokes?: ReadonlyArray<Paint> | typeof figma.mixed;
  fillStyleId?: string | typeof figma.mixed;
  strokeStyleId?: string | typeof figma.mixed;
  boundVariables?: Record<string, unknown>;
  setFillStyleIdAsync?: (styleId: string) => Promise<void>;
  setStrokeStyleIdAsync?: (styleId: string) => Promise<void>;
};

function findAllNodes(root: SceneNode): SceneNode[] {
  return "findAll" in root ? root.findAll(() => true) : [];
}

function getNodePath(node: SceneNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    parts.unshift(current.name || current.type);
    current = current.parent;
  }
  if (parts.length > 4) return "… / " + parts.slice(-4).join(" / ");
  return parts.join(" / ");
}

function hasChildren(node: SceneNode): node is SceneNode & ChildrenMixin {
  return "children" in node;
}

function collectNodes(start: readonly SceneNode[], scanChildren: boolean): SceneNode[] {
  const out: SceneNode[] = [];
  const visit = (n: SceneNode) => {
    out.push(n);
    if (scanChildren && hasChildren(n)) {
      for (const child of n.children) visit(child);
    }
  };
  for (const n of start) visit(n);
  return out;
}

function isDetachedInstanceLike(node: SceneNode): boolean {
  return (node as unknown as DetachedInfoHolder).detachedInfo != null;
}

function canCheckDetachedInfo(node: SceneNode): boolean {
  return (node as unknown as DetachedInfoHolder).detachedInfo !== undefined;
}

const detachedLabelCache = new Map<string, string>();

async function getDetachedComponentName(info: DetachedInfo): Promise<string> {
  const key = info.type === "local" ? `local:${info.componentId}` : `lib:${info.componentKey}`;
  const cached = detachedLabelCache.get(key);
  if (cached) return cached;

  let label = info.type === "library" ? "Library component" : "Component";
  try {
    if (info.type === "local") {
      const comp = await figma.getNodeByIdAsync(info.componentId);
      if (comp && "name" in comp) {
        if (comp.type === "COMPONENT" && comp.parent && comp.parent.type === "COMPONENT_SET") {
          label = comp.parent.name || comp.name || label;
        } else {
          label = comp.name || label;
        }
      }
    } else {
      const comp = await figma.importComponentByKeyAsync(info.componentKey);
      if (comp && "name" in comp) {
        if (comp.parent && comp.parent.type === "COMPONENT_SET") {
          label = comp.parent.name || comp.name || label;
        } else {
          label = comp.name || label;
        }
      }
    }
  } catch {
    // keep fallback label
  }

  detachedLabelCache.set(key, label);
  return label;
}

async function createInstanceFromDetachedInfo(info: DetachedInfo): Promise<InstanceNode | null> {
  try {
    if (info.type === "local") {
      const comp = await figma.getNodeByIdAsync(info.componentId);
      if (!comp) return null;
      if (comp.type === "COMPONENT") {
        return (comp as ComponentNode).createInstance();
      }
      if (comp.type === "COMPONENT_SET") {
        return (comp as ComponentSetNode).defaultVariant.createInstance();
      }
      return null;
    }

    if (info.type === "library") {
      const comp = await figma.importComponentByKeyAsync(info.componentKey);
      if (!comp) return null;
      return comp.createInstance();
    }
  } catch {
    return null;
  }
  return null;
}

function buildNodePath(node: SceneNode, root: SceneNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.id !== root.id && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    let indexSuffix = "";
    if (current.parent && "children" in current.parent) {
      const siblings = current.parent.children;
      const idx = siblings.indexOf(current as SceneNode);
      if (idx >= 0) indexSuffix = `#${idx}`;
    }
    parts.unshift(`${current.name || "unnamed"}${indexSuffix}`);
    current = current.parent;
  }
  return parts.join(" > ");
}

type LayoutAlign = LayoutMixin["layoutAlign"];
type LayoutGrow = LayoutMixin["layoutGrow"];
type LayoutSizingMode = "FIXED" | "HUG" | "FILL" | "AUTO";

type InstanceOverride = {
  text?: string;
  textAlignHorizontal?: TextNode["textAlignHorizontal"];
  textAlignVertical?: TextNode["textAlignVertical"];
  textAutoResize?: TextNode["textAutoResize"];
  layoutAlign?: LayoutAlign;
  layoutGrow?: LayoutGrow;
  layoutSizingHorizontal?: LayoutSizingMode;
  layoutSizingVertical?: LayoutSizingMode;
  constraints?: Constraints;
  width?: number;
  height?: number;
  layoutMode?: FrameNode["layoutMode"];
  primaryAxisAlignItems?: FrameNode["primaryAxisAlignItems"];
  counterAxisAlignItems?: FrameNode["counterAxisAlignItems"];
  primaryAxisSizingMode?: FrameNode["primaryAxisSizingMode"];
  counterAxisSizingMode?: FrameNode["counterAxisSizingMode"];
  itemSpacing?: number;
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  layoutWrap?: FrameNode["layoutWrap"];
  fills?: readonly Paint[];
  strokes?: readonly Paint[];
  effects?: readonly Effect[];
  visible?: boolean;
  opacity?: number;
  cornerRadius?: number;
  topLeftRadius?: number;
  topRightRadius?: number;
  bottomLeftRadius?: number;
  bottomRightRadius?: number;
  // Only set for a nested INSTANCE inside the detached subtree (not the detached root itself).
  mainComponentId?: string;
};

// Override properties are copied by name through these tables instead of one hand-written
// if/try block per property. The Figma node types are a union of many shapes, so the property
// bag is typed as Record<string, unknown> rather than `any`.
type PropBag = Record<string, unknown>;
type OverrideKey = keyof InstanceOverride;
// How a stored value is validated before it's written back: "truthy" (enums/objects), "number",
// "boolean", or "paints" (an array that is copied with .slice() so the stored one isn't aliased).
type PropKind = "truthy" | "number" | "boolean" | "paints";
type PropSpec = readonly [OverrideKey, PropKind];

// Order matters when writing back: sizing/constraints before the auto-layout block, which
// (for the root) is separated by the resize call.
const LAYOUT_PRE_PROPS: readonly PropSpec[] = [
  ["layoutAlign", "truthy"],
  ["layoutGrow", "number"],
  ["layoutSizingHorizontal", "truthy"],
  ["layoutSizingVertical", "truthy"],
  ["constraints", "truthy"],
];
const LAYOUT_POST_PROPS: readonly PropSpec[] = [
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
const VISUAL_PROPS: readonly PropSpec[] = [
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

function captureProps(node: SceneNode, override: InstanceOverride, specs: readonly PropSpec[]): void {
  const src = node as unknown as PropBag;
  const dst = override as unknown as PropBag;
  for (const [key] of specs) {
    if (!(key in node)) continue;
    // cornerRadius is figma.mixed when the corners differ; the per-corner props carry that case.
    if (key === "cornerRadius" && isMixed(src[key])) continue;
    dst[key] = src[key];
  }
}

function applyProps(node: SceneNode, override: InstanceOverride, specs: readonly PropSpec[]): void {
  const target = node as unknown as PropBag;
  const stored = override as unknown as PropBag;
  for (const [key, kind] of specs) {
    if (!(key in node)) continue;
    const value = stored[key];
    const valid = kind === "number" ? typeof value === "number" : kind === "boolean" ? typeof value === "boolean" : !!value;
    if (!valid) continue;
    try {
      target[key] = kind === "paints" ? (value as readonly unknown[]).slice() : value;
    } catch {
      /* ignore */
    }
  }
}

// Fills/strokes/effects/corner-radius/visible/opacity: shared between the root node and every
// descendant, so a detached relink also restores an instance's own paint/effect/radius tweaks,
// not just its layout and text. All synchronous — no font loading or async API involved.
function captureVisualOverride(node: SceneNode, override: InstanceOverride): void {
  captureProps(node, override, VISUAL_PROPS);
}

function applyVisualOverride(node: SceneNode, override: InstanceOverride): void {
  applyProps(node, override, VISUAL_PROPS);
}

// Plain-bag access for size changes, so the call stays a real method call (keeps `this`).
type Resizable = {
  resizeWithoutConstraints?: (width: number, height: number) => void;
  resize?: (width: number, height: number) => void;
};
function resizeNode(node: SceneNode, width: number, height: number): void {
  const r = node as unknown as Resizable;
  if (typeof r.resizeWithoutConstraints === "function") r.resizeWithoutConstraints(width, height);
  else if (typeof r.resize === "function") r.resize(width, height);
}

async function collectInstanceOverrides(root: SceneNode): Promise<Map<string, InstanceOverride>> {
  const map = new Map<string, InstanceOverride>();
  const rootOverride: InstanceOverride = {};
  captureProps(root, rootOverride, LAYOUT_PRE_PROPS);
  if ("width" in root) rootOverride.width = root.width;
  if ("height" in root) rootOverride.height = root.height;
  captureProps(root, rootOverride, LAYOUT_POST_PROPS);
  captureVisualOverride(root, rootOverride);
  if (Object.keys(rootOverride).length > 0) {
    map.set("__root__", rootOverride);
  }
  const nodes = findAllNodes(root);
  for (const node of nodes) {
    const path = buildNodePath(node, root);
    if (!path) continue;
    const override: InstanceOverride = {};
    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      override.text = textNode.characters;
      override.textAlignHorizontal = textNode.textAlignHorizontal;
      override.textAlignVertical = textNode.textAlignVertical;
      override.textAutoResize = textNode.textAutoResize;
    }
    if (node.type === "INSTANCE") {
      // Best-effort: a nested instance (unrelated to the outer detach) may have been swapped to
      // a different component. mainComponent is write-only under dynamic-page — read via the async getter.
      try {
        const main = await (node as InstanceNode).getMainComponentAsync();
        if (main) override.mainComponentId = main.id;
      } catch {
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
}

async function loadTextNodeFonts(node: TextNode): Promise<void> {
  try {
    if (node.fontName !== figma.mixed) {
      await figma.loadFontAsync(node.fontName as FontName);
      return;
    }
    const fontNames = node.getRangeAllFontNames(0, node.characters.length);
    for (const fontName of fontNames) {
      await figma.loadFontAsync(fontName);
    }
  } catch {
    // ignore font load errors; we'll skip applying text if loading fails
  }
}

async function applyInstanceOverridesToInstance(instance: InstanceNode, overrides: Map<string, InstanceOverride>): Promise<void> {
  if (!overrides.size) return;
  const rootOverride = overrides.get("__root__");
  if (rootOverride) {
    applyProps(instance, rootOverride, LAYOUT_PRE_PROPS);
    if (typeof rootOverride.width === "number" && typeof rootOverride.height === "number") {
      try {
        resizeNode(instance, rootOverride.width, rootOverride.height);
      } catch {
        // ignore resize errors on auto-layout instances
      }
    }
    applyProps(instance, rootOverride, LAYOUT_POST_PROPS);
    applyVisualOverride(instance, rootOverride);
  }
  const nodes = findAllNodes(instance);
  for (const node of nodes) {
    const path = buildNodePath(node, instance);
    if (!path || !overrides.has(path)) continue;
    const override = overrides.get(path);
    if (!override) continue;
    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      if (typeof override.text === "string" && textNode.characters !== override.text) {
        await loadTextNodeFonts(textNode);
        try {
          textNode.characters = override.text;
        } catch {
          // ignore if fonts failed to load or text is read-only
        }
      }
      if (override.textAlignHorizontal) {
        try { textNode.textAlignHorizontal = override.textAlignHorizontal; } catch { /* ignore */ }
      }
      if (override.textAlignVertical) {
        try { textNode.textAlignVertical = override.textAlignVertical; } catch { /* ignore */ }
      }
      if (override.textAutoResize) {
        try { textNode.textAutoResize = override.textAutoResize; } catch { /* ignore */ }
      }
    }
    applyProps(node, override, LAYOUT_PRE_PROPS);
    applyProps(node, override, LAYOUT_POST_PROPS);
    applyVisualOverride(node, override);
    if (node.type === "INSTANCE" && override.mainComponentId) {
      // Best-effort nested instance-swap replay: only touch it if the fresh instance's
      // corresponding node actually resolved to a different component than before.
      try {
        const inst = node as InstanceNode;
        const current = await inst.getMainComponentAsync();
        if (!current || current.id !== override.mainComponentId) {
          const target = await figma.getNodeByIdAsync(override.mainComponentId);
          if (target && target.type === "COMPONENT") {
            inst.swapComponent(target as ComponentNode);
          }
        }
      } catch {
        /* ignore — not critical, layout/text/paint overrides above already applied */
      }
    }
  }
}

async function applyAutofixItem(item: AutofixAllItem): Promise<{ ok: boolean; error?: string }> {
  const id = String(item.id || "");
  if (!id) return { ok: false, error: "Missing node id." };

  const node = await figma.getNodeByIdAsync(id);
  if (!node || !("id" in node)) return { ok: false, error: "Node not found." };

  if (item.issueType === "DETACHED_INSTANCE" || item.kind === "detached") {
    const info = (node as unknown as DetachedInfoHolder).detachedInfo ?? null;
    if (!info) return { ok: false, error: "Node is not detached." };
    const overrides = await collectInstanceOverrides(node as SceneNode);
    const instance = await createInstanceFromDetachedInfo(info);
    if (!instance) return { ok: false, error: "Component not found or unavailable." };
    try {
      const parent = (node as SceneNode).parent;
      if (parent && "insertChild" in parent) {
        const idx = parent.children.indexOf(node as SceneNode);
        parent.insertChild(Math.max(0, idx), instance);
      } else {
        figma.currentPage.appendChild(instance);
      }
      instance.name = (node as SceneNode).name;
      instance.x = (node as SceneNode).x;
      instance.y = (node as SceneNode).y;
      const original = node as unknown as { rotation?: number; opacity?: number; visible?: boolean; locked?: boolean; width?: number; height?: number };
      if ("rotation" in instance) instance.rotation = original.rotation || 0;
      if ("opacity" in instance) instance.opacity = original.opacity ?? 1;
      if ("visible" in instance) instance.visible = original.visible ?? true;
      if ("locked" in instance) instance.locked = original.locked ?? false;
      if (typeof original.width === "number" && typeof original.height === "number") {
        resizeNode(instance, original.width, original.height);
      }
      await applyInstanceOverridesToInstance(instance, overrides);
    } catch (e) {
      // Roll back: never leave a second instance next to the untouched original.
      try {
        instance.remove();
      } catch {
        /* already removed */
      }
      return { ok: false, error: stringifyMessage(e) || "Relink failed." };
    }
    (node as SceneNode).remove();
    return { ok: true };
  }

  if (item.issueType === "UNSTYLED_TEXT" || item.kind === "text") {
    if (node.type !== "TEXT") return { ok: false, error: "Unsupported node." };
    let candidateId = item.candidateId || "";
    if (!candidateId) {
      if (isMixedTextProps(node as TextNode)) {
        return { ok: false, error: "Mixed text styles." };
      }
      const { recommendedId } = await findTextCandidates(node as TextNode);
      candidateId = recommendedId || "";
      if (!candidateId) return { ok: false, error: "No high-confidence match." };
    }
    if (!candidateId || !candidateId.startsWith("textstyle:")) {
      return { ok: false, error: "Text style not found." };
    }
    const styleId = candidateId.replace("textstyle:", "");
    const style = await figma.getStyleByIdAsync(styleId);
    if (!style || style.type !== "TEXT") return { ok: false, error: "Text style not found." };
    await figma.loadFontAsync((style as TextStyle).fontName);
    await (node as TextNode).setTextStyleIdAsync(styleId);
    return { ok: true };
  }

  let candidateId = item.candidateId || "";

  const kind = item.kind === "stroke" ? "strokes" : "fills";
  if (!candidateId) {
    const color = getSolidPaintColor(node as SceneNode, kind);
    if (!color) return { ok: false, error: "No paint to match." };
    const { recommendedId } = await findColorCandidates(color, node as SceneNode, kind);
    candidateId = recommendedId || "";
  }

  if (!candidateId) return { ok: false, error: "No high-confidence match." };

  if (candidateId.startsWith("style:")) {
    const styleId = candidateId.replace("style:", "");
    // documentAccess is "dynamic-page": the sync fillStyleId/strokeStyleId setters throw.
    const styleHolder = node as unknown as PaintHolder;
    if (kind === "fills" && styleHolder.setFillStyleIdAsync) {
      await styleHolder.setFillStyleIdAsync(styleId);
    } else if (kind === "strokes" && styleHolder.setStrokeStyleIdAsync) {
      await styleHolder.setStrokeStyleIdAsync(styleId);
    } else {
      return { ok: false, error: "Unsupported node." };
    }
    return { ok: true };
  }

  const variable = await figma.variables.getVariableByIdAsync(candidateId);
  if (!variable) return { ok: false, error: "Variable not found." };
  const paintHolder = node as unknown as PaintHolder;
  const paints = paintHolder[kind];
  if (!paints || paints === figma.mixed || !Array.isArray(paints) || paints.length === 0) {
    return { ok: false, error: "No paint to bind." };
  }
  const next = paints.slice();
  const idx = next.findIndex((p) => p && p.type === "SOLID" && p.visible !== false);
  const paintIndex = idx >= 0 ? idx : 0;
  const paint = next[paintIndex] as SolidPaint;
  if (!paint || paint.type !== "SOLID") return { ok: false, error: "Unsupported paint type." };
  next[paintIndex] = figma.variables.setBoundVariableForPaint(paint, "color", variable);
  paintHolder[kind] = next;
  return { ok: true };
}

let textStyleCache: { pageId: string; styles: TextStyle[] } | null = null;

async function collectTextStyleIdsFromPage(page: PageNode): Promise<Set<string>> {
  const ids = new Set<string>();
  const stack: SceneNode[] = [...page.children];
  while (stack.length) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "TEXT") {
      const textNode = node as TextNode;
      const styleId = textNode.textStyleId;
      if (typeof styleId === "string" && styleId) {
        ids.add(styleId);
      } else if (isMixed(styleId) && textNode.characters && textNode.characters.length > 0) {
        const segments = textNode.getStyledTextSegments(["fontName"]);
        for (const seg of segments) {
          const segStyleId = textNode.getRangeTextStyleId(seg.start, seg.end);
          if (typeof segStyleId === "string" && segStyleId) ids.add(segStyleId);
        }
      }
    }
    if (hasChildren(node)) {
      for (const child of node.children) stack.push(child);
    }
  }
  return ids;
}

async function getTextStylesForMatching(): Promise<TextStyle[]> {
  const page = figma.currentPage;
  if (textStyleCache && textStyleCache.pageId === page.id) {
    return textStyleCache.styles;
  }

  const locals = await figma.getLocalTextStylesAsync();
  const styleById = new Map<string, TextStyle>();
  for (const style of locals) styleById.set(style.id, style);

  const ids = await collectTextStyleIdsFromPage(page);
  for (const id of ids) {
    if (styleById.has(id)) continue;
    try {
      const style = await figma.getStyleByIdAsync(id);
      if (style && style.type === "TEXT") {
        styleById.set(style.id, style as TextStyle);
      }
    } catch {
      // ignore missing styles (e.g., removed library)
    }
  }

  const styles = Array.from(styleById.values());
  textStyleCache = { pageId: page.id, styles };
  return styles;
}

// Any truthy entry in a boundVariables map (color, opacity, gradient-stop fields, ...) counts.
function hasTruthyBinding(bindings: unknown): boolean {
  if (!bindings || typeof bindings !== "object") return false;
  const map = bindings as Record<string, unknown>;
  return Object.keys(map).some((k) => !!map[k]);
}

function hasBoundPaintVariable(node: SceneNode, kind: "fills" | "strokes"): boolean {
  const holder = node as unknown as PaintHolder;

  // Node-level bindings
  const bv = holder.boundVariables;
  if (bv && bv[kind]) return true;

  // Paint-level bindings
  if (kind in node) {
    const paints = holder[kind];
    if (!isMixed(paints) && Array.isArray(paints)) {
      for (const paint of paints as ReadonlyArray<Paint>) {
        const p = paint as unknown as { boundVariables?: unknown; gradientStops?: ReadonlyArray<{ boundVariables?: unknown } | undefined> } | undefined;
        if (hasTruthyBinding(p?.boundVariables)) return true;
        const stops = p?.gradientStops;
        if (Array.isArray(stops)) {
          for (const stop of stops) {
            if (hasTruthyBinding(stop?.boundVariables)) return true;
          }
        }
      }
    }
  }

  return false;
}

function hasRogueFill(node: SceneNode): boolean {
  if (!("fills" in node)) return false;

  const paintHolder = node as unknown as PaintHolder;
  const fills = paintHolder.fills;
  if (isMixed(fills) || !Array.isArray(fills) || fills.length === 0) return false;

  const fillStyleId = paintHolder.fillStyleId;

  const visibleFills = fills.filter((p) => (p.visible ?? true) === true);
  if (visibleFills.length === 0) return false;

  // If all visible fills are IMAGE, consider OK
  const hasNonImageVisibleFill = visibleFills.some((p) => p.type !== "IMAGE");
  if (!hasNonImageVisibleFill) return false;

  // Variable-bound paints are OK
  if (hasBoundPaintVariable(node, "fills")) return false;

  return !fillStyleId || fillStyleId === "" || isMixed(fillStyleId);
}

function hasRogueStroke(node: SceneNode): boolean {
  if (!("strokes" in node)) return false;

  const paintHolder = node as unknown as PaintHolder;
  const strokes = paintHolder.strokes;
  if (isMixed(strokes) || !Array.isArray(strokes) || strokes.length === 0) return false;

  const strokeStyleId = paintHolder.strokeStyleId;

  const visibleStrokes = strokes.filter((p) => (p.visible ?? true) === true);
  if (visibleStrokes.length === 0) return false;

  // If all visible strokes are IMAGE, consider OK
  const hasNonImageVisibleStroke = visibleStrokes.some((p) => p.type !== "IMAGE");
  if (!hasNonImageVisibleStroke) return false;

  // Variable-bound paints are OK
  if (hasBoundPaintVariable(node, "strokes")) return false;

  return !strokeStyleId || strokeStyleId === "" || isMixed(strokeStyleId);
}

function hasUnstyledText(node: SceneNode): boolean {
  if (node.type !== "TEXT") return false;
  const textStyleId = (node as TextNode).textStyleId as string | typeof figma.mixed;
  return textStyleId === "" || isMixed(textStyleId);
}

function isMixedTextProps(node: TextNode): boolean {
  return (
    isMixed(node.fontName) ||
    isMixed(node.fontSize) ||
    isMixed(node.lineHeight) ||
    isMixed(node.letterSpacing)
  );
}

function textLineHeightToPx(lineHeight: LineHeight, fontSize: number): number | null {
  if (!lineHeight) return null;
  if (lineHeight.unit === "AUTO") return null;
  const value = lineHeight.value;
  if (typeof value !== "number") return null;
  if (lineHeight.unit === "PIXELS") return value;
  if (lineHeight.unit === "PERCENT") return fontSize * (value / 100);
  return null;
}

function letterSpacingToPx(letterSpacing: LetterSpacing, fontSize: number): number | null {
  if (!letterSpacing) return null;
  const value = letterSpacing.value;
  if (typeof value !== "number") return null;
  if (letterSpacing.unit === "PIXELS") return value;
  if (letterSpacing.unit === "PERCENT") return fontSize * (value / 100);
  return null;
}

function normalizeTextProps(node: TextNode): {
  fontName: FontName | null;
  fontSize: number | null;
  lineHeightPx: number | null;
  lineHeightAuto: boolean;
  letterSpacingPx: number | null;
} {
  const hasChars = typeof node.characters === "string" && node.characters.length > 0;
  const rangeStart = 0;
  const rangeEnd = hasChars ? 1 : 0;
  const fontName = isMixed(node.fontName) && hasChars ? node.getRangeFontName(rangeStart, rangeEnd) as FontName : node.fontName as FontName;
  const fontSize = isMixed(node.fontSize) && hasChars ? node.getRangeFontSize(rangeStart, rangeEnd) as number : node.fontSize as number;
  const lineHeight = isMixed(node.lineHeight) && hasChars ? node.getRangeLineHeight(rangeStart, rangeEnd) as LineHeight : node.lineHeight as LineHeight;
  const letterSpacing = isMixed(node.letterSpacing) && hasChars ? node.getRangeLetterSpacing(rangeStart, rangeEnd) as LetterSpacing : node.letterSpacing as LetterSpacing;

  const lineHeightAuto = !!(lineHeight && lineHeight.unit === "AUTO");
  const lineHeightPx = fontSize ? textLineHeightToPx(lineHeight as LineHeight, fontSize) : null;
  const letterSpacingPx = fontSize ? letterSpacingToPx(letterSpacing as LetterSpacing, fontSize) : null;

  return {
    fontName: fontName || null,
    fontSize: typeof fontSize === "number" ? fontSize : null,
    lineHeightPx,
    lineHeightAuto,
    letterSpacingPx,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function rgbaToKey(color: RGBA): string {
  return `${round4(color.r)}|${round4(color.g)}|${round4(color.b)}|${round4(color.a)}`;
}

function rgbaToCss(color: RGBA): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const a = Math.max(0, Math.min(1, typeof color.a === "number" ? color.a : 1));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function alphaDiffOk(a: RGBA, b: RGBA): boolean {
  const alphaA = typeof a.a === "number" ? a.a : 1;
  const alphaB = typeof b.a === "number" ? b.a : 1;
  return Math.abs(alphaA - alphaB) <= 0.05;
}

function layerKeywordsForNode(node: SceneNode, kind: "fills" | "strokes"): string[] {
  if (kind === "strokes") return ["border", "stroke", "outline", "separator", "divider"];
  if (node.type === "TEXT") return ["text", "fg", "foreground", "font", "label", "typo"];
  if (
    node.type === "VECTOR" ||
    node.type === "BOOLEAN_OPERATION" ||
    node.type === "LINE" ||
    node.type === "STAR" ||
    node.type === "ELLIPSE" ||
    node.type === "POLYGON"
  ) {
    return ["icon", "glyph", "symbol", "graphic", "vector"];
  }
  return ["bg", "background", "surface", "fill", "container", "card"];
}

function nameMatchesKeywords(name: string, keywords: string[]): boolean {
  const lower = name.toLowerCase();
  return keywords.some((k) => {
    const re = new RegExp(`(^|[\\s/_-])${k}($|[\\s/_-])`);
    return re.test(lower);
  });
}

function shouldExcludeForStroke(name: string): boolean {
  const strokeKeywords = ["border", "stroke", "outline", "separator", "divider"];
  const backgroundKeywords = ["bg", "background", "surface", "fill", "container", "card"];
  const isStroke = nameMatchesKeywords(name, strokeKeywords);
  const isBackground = nameMatchesKeywords(name, backgroundKeywords);
  return !isStroke && isBackground;
}

const TEXT_SEMANTIC_GROUPS: Record<string, string[]> = {
  headings: ["h1", "h2", "h3", "heading", "title", "display"],
  body: ["body", "paragraph", "text", "main", "copy"],
  interface: ["label", "button", "input", "caption", "small"],
  code: ["mono", "code", "monospace", "technical"],
};

function textSemanticKeywordsForNode(node: TextNode): string[] {
  const content = `${node.name || ""} ${node.characters || ""}`.toLowerCase();
  const out: string[] = [];
  for (const key of Object.keys(TEXT_SEMANTIC_GROUPS)) {
    const group = TEXT_SEMANTIC_GROUPS[key];
    if (group.some((k) => content.includes(k))) {
      out.push(...group);
    }
  }
  return out;
}

function textSemanticScore(styleName: string, keywords: string[]): number {
  if (!keywords.length) return 0;
  const lower = styleName.toLowerCase();
  return keywords.some((k) => lower.includes(k)) ? 1 : 0;
}

function textStyleHasVariableBindings(style: TextStyle): boolean {
  const bound = style.boundVariables as Record<string, unknown> | undefined;
  if (!bound) return false;
  return Object.keys(bound).some((k) => !!bound[k]);
}

async function findTextCandidates(node: TextNode): Promise<{
  candidates: AutofixCandidate[];
  recommendedId: string | null;
  mixed: boolean;
}> {
  const mixed = isMixedTextProps(node);
  const props = normalizeTextProps(node);
  if (!props.fontName || !props.fontSize) {
    return { candidates: [], recommendedId: null, mixed };
  }

  const styles = await getTextStylesForMatching();
  const candidates: AutofixCandidate[] = [];
  const keywords = textSemanticKeywordsForNode(node);

  for (const style of styles) {
    const styleFont = style.fontName;
    if (!styleFont) continue;
    if (styleFont.family !== props.fontName.family) continue;
    if (styleFont.style !== props.fontName.style) continue;

    const sizeDiff = Math.abs(style.fontSize - props.fontSize);

    const styleLineHeight = style.lineHeight as LineHeight;
    const styleLineAuto = !!(styleLineHeight && styleLineHeight.unit === "AUTO");
    const styleLinePx = textLineHeightToPx(styleLineHeight, style.fontSize);

    const lineDiff = (props.lineHeightAuto && styleLineAuto)
      ? 0
      : (props.lineHeightPx != null && styleLinePx != null ? Math.abs(styleLinePx - props.lineHeightPx) : null);

    const styleLetterSpacing = style.letterSpacing as LetterSpacing;
    const styleLetterPx = letterSpacingToPx(styleLetterSpacing, style.fontSize);
    const letterDiff = (props.letterSpacingPx != null && styleLetterPx != null)
      ? Math.abs(styleLetterPx - props.letterSpacingPx)
      : null;

    let matchLevel: "perfect" | "near" | "partial" | null = null;

    const exactLine = (props.lineHeightAuto && styleLineAuto) || (lineDiff != null && lineDiff <= 0.01);
    const exactLetter = letterDiff != null && letterDiff <= 0.01;
    if (sizeDiff <= 0.01 && exactLine && exactLetter) {
      matchLevel = "perfect";
    } else if (sizeDiff <= 1 && (lineDiff != null && lineDiff <= 2)) {
      matchLevel = "near";
    } else {
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
  const levelRank = (c: AutofixCandidate) => (c.matchLevel === "perfect" ? 3 : c.matchLevel === "near" ? 2 : 1);
  const sorted = candidates.sort((a, b) => {
    const dl = levelRank(b) - levelRank(a);
    if (dl !== 0) return dl;
    const ds = (b.score || 0) - (a.score || 0);
    if (ds !== 0) return ds;
    return (a.displayName || a.name).localeCompare(b.displayName || b.name);
  });

  const perfect = sorted.find((c) => c.matchLevel === "perfect");
  const near = sorted.find((c) => c.matchLevel === "near");
  const recommended = perfect || near || null;

  return { candidates: sorted, recommendedId: recommended ? recommended.id : null, mixed };
}

type Lab = { l: number; a: number; b: number };

function nodeScopeForVariable(node: SceneNode, kind: "fills" | "strokes"): string[] {
  const scopes: string[] = ["ALL_SCOPES"];
  if (kind === "strokes") {
    scopes.push("STROKE_COLOR");
    return scopes;
  }

  scopes.push("ALL_FILLS");
  if (node.type === "TEXT") {
    scopes.push("TEXT_FILL");
    return scopes;
  }
  if (
    node.type === "FRAME" ||
    node.type === "COMPONENT" ||
    node.type === "COMPONENT_SET" ||
    node.type === "INSTANCE"
  ) {
    scopes.push("FRAME_FILL");
    scopes.push("SHAPE_FILL");
    return scopes;
  }
  scopes.push("SHAPE_FILL");
  return scopes;
}

function variableMatchesScope(variable: Variable, node: SceneNode, kind: "fills" | "strokes"): boolean {
  const scopes: string[] = Array.isArray(variable.scopes) ? variable.scopes.map(String) : [];
  if (scopes.length === 0) return true;
  if (scopes.indexOf("ALL_SCOPES") >= 0) return true;
  const targetScopes = nodeScopeForVariable(node, kind);
  return targetScopes.some((s) => scopes.indexOf(s) >= 0);
}

function nameIntentScore(name: string): number {
  const lower = String(name || "").toLowerCase();
  const token = (t: string) => new RegExp(`(^|[\\s/_-])${t}(?=$|[\\s/_-])`, "i").test(lower);
  let score = 0;
  if (token("primary")) score += 1.5;
  else if (token("secondary")) score += 1;
  else if (token("tertiary")) score += 0.5;
  if (token("inverse")) score -= 0.5;
  if (token("disabled")) score -= 0.5;
  return score;
}

function getModeIdForCollection(node: SceneNode, collection: VariableCollection | null | undefined): string | null {
  if (!collection || !collection.id) return null;
  const modes = node as unknown as { resolvedVariableModes?: Record<string, string>; explicitVariableModes?: Record<string, string> };
  const resolved = modes.resolvedVariableModes;
  if (resolved && resolved[collection.id]) return resolved[collection.id];
  const explicit = modes.explicitVariableModes;
  if (explicit && explicit[collection.id]) return explicit[collection.id];
  if (collection.defaultModeId) return collection.defaultModeId;
  if (Array.isArray(collection.modes) && collection.modes[0]?.modeId) return collection.modes[0].modeId;
  return null;
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToLab(color: RGBA): Lab {
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

function xyzToLabHelper(t: number): number {
  const delta = 6 / 29;
  return t > Math.pow(delta, 3) ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function rad2deg(rad: number): number {
  return (rad * 180) / Math.PI;
}

function deltaE2000(lab1: Lab, lab2: Lab): number {
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
  } else if (dhp > 180) {
    dhp -= 360;
  } else if (dhp < -180) {
    dhp += 360;
  }

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(deg2rad(dhp / 2));

  let avgHp = h1p + h2p;
  if (C1p * C2p === 0) {
    avgHp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) > 180) {
    avgHp = h1p + h2p + (h1p + h2p < 360 ? 360 : -360);
  }
  avgHp /= 2;

  const T =
    1 -
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

  const dE = Math.sqrt(
    Math.pow(dLp / SL, 2) +
      Math.pow(dCp / SC, 2) +
      Math.pow(dHp / SH, 2) +
      RT * (dCp / SC) * (dHp / SH)
  );
  return dE;
}

function paintToRgba(paint: Paint): RGBA | null {
  if (!paint || paint.type !== "SOLID") return null;
  const opacity = typeof paint.opacity === "number" ? paint.opacity : 1;
  return {
    r: paint.color.r,
    g: paint.color.g,
    b: paint.color.b,
    a: opacity,
  };
}

function getSolidPaintColor(node: SceneNode, kind: "fills" | "strokes"): RGBA | null {
  const paints = (node as unknown as PaintHolder)[kind];
  if (!paints || paints === figma.mixed || !Array.isArray(paints)) return null;
  // Same paint the bind step targets: the first visible SOLID paint.
  const paint = paints.find((p) => p && p.type === "SOLID" && p.visible !== false);
  if (!paint) return null;
  return paintToRgba(paint);
}

function isVariableAlias(value: unknown): value is { type: "VARIABLE_ALIAS"; id: string } {
  const v = value as { type?: unknown; id?: unknown } | null | undefined;
  return !!v && typeof v === "object" && v.type === "VARIABLE_ALIAS" && typeof v.id === "string";
}

function pickModeIdForVariable(variable: Variable | null | undefined, preferredModeId?: string | null): string | null {
  if (!variable) return null;
  const valuesByMode = variable.valuesByMode || {};
  if (preferredModeId && valuesByMode[preferredModeId] != null) return preferredModeId;
  const keys = Object.keys(valuesByMode);
  return keys.length ? keys[0] : null;
}

async function resolveVariableColor(variable: Variable | null | undefined, modeId: string, seen: Set<string>): Promise<RGBA | null> {
  if (!variable) return null;
  if (seen.has(variable.id)) return null;
  seen.add(variable.id);

  const preferredModeId = modeId || null;
  const valuesByMode = variable.valuesByMode || {};
  const resolvedModeId = pickModeIdForVariable(variable, preferredModeId);
  if (!resolvedModeId) return null;

  const value = valuesByMode[resolvedModeId];
  if (!value) return null;

  if (isVariableAlias(value)) {
    const aliasVar = await figma.variables.getVariableByIdAsync(value.id);
    if (!aliasVar) return null;
    const aliasModeId = pickModeIdForVariable(aliasVar, resolvedModeId);
    return resolveVariableColor(aliasVar, aliasModeId || resolvedModeId, seen);
  }

  if (typeof value === "object" && value && "r" in value && "g" in value && "b" in value) {
    const rgba = value as RGBA;
    const alpha = typeof rgba.a === "number" ? rgba.a : 1;
    return { r: rgba.r, g: rgba.g, b: rgba.b, a: alpha };
  }

  return null;
}

async function getLocalColorVariablesCached(): Promise<{ collections: VariableCollection[]; vars: Variable[] }> {
  const now = Date.now();
  if (localColorVariablesCache && now - localColorVariablesCache.ts < LOCAL_COLOR_VARS_CACHE_TTL_MS) {
    return { collections: localColorVariablesCache.collections, vars: localColorVariablesCache.vars };
  }
  // A fetch is already in flight: share it instead of racing several concurrent candidate
  // requests (maxConcurrent=3 on the UI side) into duplicate Figma API calls before the first
  // one has a chance to populate the cache above.
  if (localColorVariablesLoadPromise) return localColorVariablesLoadPromise;
  localColorVariablesLoadPromise = (async () => {
    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const vars = await figma.variables.getLocalVariablesAsync("COLOR");
      localColorVariablesCache = { collections, vars, ts: Date.now() };
      return { collections, vars };
    } finally {
      localColorVariablesLoadPromise = null;
    }
  })();
  return localColorVariablesLoadPromise;
}

async function findColorCandidates(target: RGBA, consumer: SceneNode, kind: "fills" | "strokes"): Promise<{
  candidates: AutofixCandidate[];
  recommendedId: string | null;
  debug: {
    totalVariables: number;
    totalCollections: number;
    localVariables: number;
    libraryVariables: number;
    libraryCollections: number;
    libraryImportErrors: number;
    libraryImporting: boolean;
    targetKey: string;
  };
}> {
  const candidates: AutofixCandidate[] = [];
  const targetKey = rgbaToKey(target);

  const varsApi = figma.variables;
  const { collections, vars: localVars } = await getLocalColorVariablesCached();
  // Throttled (5s) when nothing is cached yet, so an empty or failing library isn't re-imported per row.
  const libraryVars = await loadLibraryVariables(varsApi);
  const variableMap = new Map<string, Variable>();
  for (const v of localVars) variableMap.set(v.id, v);
  for (const v of libraryVars) variableMap.set(v.id, v);
  const variables = Array.from(variableMap.values());
  const collectionById = new Map<string, VariableCollection>();
  for (const c of collections) collectionById.set(c.id, c);

  for (const v of variables) {
    const variable = v;
    if (variable.resolvedType !== "COLOR") continue;
    const name = String(variable.name || "");
    const isHidden = name.startsWith(".") || name.startsWith("-");
    if (name.startsWith("_")) continue;
    if (kind === "strokes" && shouldExcludeForStroke(name)) continue;

    let collection: VariableCollection | null | undefined = collectionById.get(variable.variableCollectionId);
    if (!collection && variable.variableCollectionId) {
      try {
        collection = await figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId);
      } catch {
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
    let resolvedColor: RGBA | null = null;
    let deltaE: number | null = null;
    let layerScore = 0;
    let resolvedForConsumer = false;
    const keywords = layerKeywordsForNode(consumer, kind);
    try {
      const resolved = (variable as Variable).resolveForConsumer(consumer);
      if (resolved && resolved.resolvedType === "COLOR" && typeof resolved.value === "object" && resolved.value) {
        resolvedForConsumer = true;
        const v = resolved.value as RGBA;
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
    } catch (_e) {
      // fallback below
    }
    // resolveForConsumer already gave a definitive color: a miss is a miss, no async re-resolution.
    if (!matched && resolvedForConsumer) continue;
    if (!matched) {
      const rawValue = modeId ? valuesByMode[modeId] : null;
      if (rawValue && isVariableAlias(rawValue)) aliasHit = true;
      const cacheKey = `${variable.id}|${modeId || ""}`;
      let resolved: RGBA | null;
      if (variableColorCache.has(cacheKey)) {
        resolved = variableColorCache.get(cacheKey) ?? null;
      } else {
        resolved = await resolveVariableColor(variable, modeId || "", new Set<string>());
        variableColorCache.set(cacheKey, resolved);
      }
      if (!resolved) continue;
      if (!alphaDiffOk(target, resolved)) continue;
      const d = deltaE2000(rgbToLab(target), rgbToLab(resolved));
      if (d >= 5) continue;
      matched = true;
      resolvedColor = resolved;
      deltaE = d;
      layerScore = nameMatchesKeywords(name, keywords) ? 3 : 0;
    }
    if (!matched) continue;

    const collectionName = String(collection?.name || "Variables");
    const isSemantic = /semantic|ui|theme|token/i.test(collectionName);
    const isLocal = !(collection?.remote === true) && !(variable.remote === true);
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
    const styles = await figma.getLocalPaintStylesAsync();
    for (const style of styles) {
      const paints = style.paints || [];
      const paint = paints.find((p) => p && p.visible !== false) || paints[0];
      const color = paintToRgba(paint as Paint);
      if (!color) continue;
      if (rgbaToKey(color) !== targetKey) continue;
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
    if (c.source !== "variable") return true;
    const variable = variables.find((v) => v.id === c.id);
    if (!variable) return true;
    return variableMatchesScope(variable, consumer, kind);
  });

  const activeList = scoped.length > 0 ? scoped : (kind === "strokes" ? [] : candidates);

  activeList.sort((a, b) => {
    const deltaA = typeof a.deltaE === "number" ? a.deltaE : 999;
    const deltaB = typeof b.deltaE === "number" ? b.deltaE : 999;
    if (deltaA !== deltaB) return deltaA - deltaB;
    const scoreDelta = (b.score || 0) - (a.score || 0);
    if (scoreDelta !== 0) return scoreDelta;
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
}

async function getOrCreateInstanceId(): Promise<string> {
  const existing = await figma.clientStorage.getAsync(INSTANCE_ID_STORAGE_KEY);
  if (existing && typeof existing === "string") return existing;

  // Stable per-machine (plugin install) id, no PII
  const id = "inst_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  await figma.clientStorage.setAsync(INSTANCE_ID_STORAGE_KEY, id);
  return id;
}

function makeProFeaturesAllEnabled(): Record<ProFeature, boolean> {
  return ALL_PRO_FEATURES.reduce((acc, f) => {
    acc[f] = true;
    return acc;
  }, {} as Record<ProFeature, boolean>);
}

function makeLicenseEntitlements(licenseKey: string): Entitlements {
  return {
    ...makeDefaultEntitlements(),
    pro: true,
    source: "license",
    features: makeProFeaturesAllEnabled(),
    expiresAt: undefined,
    licenseKeyLast4: licenseKey.slice(-4),
  };
}

type LicenseResult = {
  ok: boolean;
  valid?: boolean;
  status?: string | null;
  daysLeft?: number;
  activated?: boolean;
  entitlements: { pro: boolean };
  error?: string;
  // True when the Worker could not be reached or answered 5xx/429, as opposed to an explicit denial.
  transient?: boolean;
};

const MAX_SERVER_MESSAGE_LENGTH = 200;

// Fields read from the Worker's JSON reply; everything is `unknown` and narrowed where used.
type LicenseResponseBody = {
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  status?: unknown;
  valid?: unknown;
  activated?: unknown;
  daysLeft?: unknown;
  entitlements?: { pro?: unknown };
};

async function callLicenseEndpoint(
  url: string,
  licenseKey: string,
  instanceId: string
): Promise<LicenseResult> {
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
  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Systemic-Token": SYSTEMIC_TOKEN,
      },
      body: JSON.stringify({ licenseKey, installationId: instanceId }),
    });
  } catch (e) {
    return {
      ok: false,
      entitlements: { pro: false },
      transient: true,
      error: `Could not reach the license server: ${stringifyMessage(e) || "network error"}`,
    };
  }

  const rawText = await res.text();
  let data: LicenseResponseBody | null = null;
  try {
    data = rawText ? JSON.parse(rawText) : null;
  } catch {
    data = null;
  }

  // Provide a readable message for UI (a proxy error page must not flood the toast)
  let serverMessage =
    stringifyMessage(data && (data.error || data.message)) ||
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

  const isPro = !!data.entitlements?.pro;
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
}

async function verifyLicenseWithWorker(licenseKey: string, instanceId: string): Promise<LicenseResult> {
  return callLicenseEndpoint(WORKER_VERIFY_URL, licenseKey, instanceId);
}

async function activateLicenseWithWorker(licenseKey: string, instanceId: string): Promise<LicenseResult> {
  return callLicenseEndpoint(WORKER_ACTIVATE_URL, licenseKey, instanceId);
}

async function runAudit(selection: readonly SceneNode[], options: AuditOptions) {
  const nodes = collectNodes(selection, options.scanChildren);
  const issues: Issue[] = [];
  // Issues the user marked "not a problem": kept (not counted) so the UI can list and restore them.
  const ignoredIssues: Issue[] = [];
  const totalNodes = nodes.length;
  let processed = 0;
  let lastProgress = 0;
  let canceled = false;
  const YIELD_EVERY = 200;

  const auditedElementIds = new Set<string>();
  const elementsWithIssuesSet = new Set<string>();

  const markAudited = (n: SceneNode) => {
    auditedElementIds.add(n.id);
  };

  let scannedElements = 0;

  let rogueFills = 0;
  let rogueStrokes = 0;
  let unstyledText = 0;
  let detached = 0;
  let ignored = 0;

  const addIssue = (node: SceneNode, type: IssueType, extra: Partial<Issue> = {}) => {
    const issue: Issue = { id: node.id, name: node.name, type, path: getNodePath(node), ...extra };
    if (isIssueIgnored(node, type)) {
      ignored++;
      ignoredIssues.push(issue);
      return;
    }
    issues.push(issue);
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
          const info = (node as unknown as DetachedInfoHolder).detachedInfo ?? null;
          const label = info ? await getDetachedComponentName(info) : undefined;
          const before = issues.length;
          addIssue(node, "DETACHED_INSTANCE", { detachedComponentName: label });
          if (issues.length > before) detached++;
        }
      }

      if (options.checkTextStyles && node.type === "TEXT") {
        markAudited(node);
        if (hasUnstyledText(node)) {
          const mixedText = isMixedTextProps(node as TextNode);
          const before = issues.length;
          addIssue(node, "UNSTYLED_TEXT", { mixedText });
          if (issues.length > before) unstyledText++;
        }
      }

      if (options.checkRogueFills && ("fills" in node)) {
        markAudited(node);
        if (hasRogueFill(node)) {
          const before = issues.length;
          addIssue(node, "ROGUE_FILL");
          if (issues.length > before) rogueFills++;
        }
      }

      if (options.checkRogueStrokes && ("strokes" in node)) {
        markAudited(node);
        if (hasRogueStroke(node)) {
          const before = issues.length;
          addIssue(node, "ROGUE_STROKE");
          if (issues.length > before) rogueStrokes++;
        }
      }
    } catch {
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
      await new Promise((resolve) => setTimeout(resolve, 0));
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

  return { issues, ignoredIssues, summary, canceled };
}

// Nodes the last scan covered, so a re-audit keeps its scope even if the user has since
// clicked a row (which selects that single layer). Falls back to the current selection.
async function resolveAuditTargets(): Promise<SceneNode[]> {
  const restored: SceneNode[] = [];
  for (const id of lastAuditSelectionIds) {
    const node = await figma.getNodeByIdAsync(id);
    if (!node || !("id" in node)) continue;
    if (node.type === "PAGE" || node.type === "DOCUMENT") continue;
    if (!("x" in node)) continue;
    restored.push(node as SceneNode);
  }
  if (restored.length > 0) return restored;
  return Array.from(figma.currentPage.selection);
}

let resizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
let optionsSaveTimer: ReturnType<typeof setTimeout> | null = null;

figma.ui.onmessage = async (msg) => {
  try {
    await handleMessage(msg);
  } catch (e) {
    figma.notify("Something went wrong: " + (stringifyMessage(e) || "unknown error"));
  }
};

// Messages from ui.html: fields are untyped on the wire, so each handler narrows what it reads.
type UiMessage = { type?: string; [field: string]: unknown };

async function handleMessage(msg: UiMessage): Promise<void> {
  if (!msg || typeof msg !== "object") return;

  if (msg.type === "resize") {
    const w = Math.max(MIN_W, Math.round(Number(msg.width) || DEFAULT_W));
    const h = Math.max(MIN_H, Math.round(Number(msg.height) || DEFAULT_H));

    figma.ui.resize(w, h);
    // Dragging the window edge sends a resize per pointer move: persist only the final size.
    if (resizeSaveTimer) clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      resizeSaveTimer = null;
      figma.clientStorage.setAsync("uiSize", { width: w, height: h }).catch(() => {
        /* ignore storage failures */
      });
    }, 300);
    return;
  }

  if (msg.type === "options:save") {
    const options = msg.options as Partial<AuditOptions> | null | undefined;
    if (options && typeof options === "object") {
      if (optionsSaveTimer) clearTimeout(optionsSaveTimer);
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
    const saved = await figma.clientStorage.getAsync(SCANNER_OPTIONS_STORAGE_KEY);
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
    await figma.clientStorage.deleteAsync(ENTITLEMENTS_STORAGE_KEY);
    await figma.clientStorage.deleteAsync(DEBUG_PRO_STORAGE_KEY);
    await forgetLastVerified();
    await clearStoredLicenseKey();
    figma.ui.postMessage(buildEntitlementsMessage());
    return;
  }

  if (msg.type === "pro:debug:set") {
    if (!DEV_PRO) return;
    const isPro = !!msg.isPro;
    await figma.clientStorage.setAsync(DEBUG_PRO_STORAGE_KEY, isPro);
    entitlements = makeDebugEntitlements(isPro);
    figma.ui.postMessage(buildEntitlementsMessage());
    return;
  }

  if (msg.type === "pro:autofix") {
    // Pro-only feature: UI sends this when Pro is verified.
    const allowed = hasFeature(entitlements, "autofix");
    const skipped = msg.skipped || {};
    if (autofixRunning) return;
    autofixCancelRequested = false;

    if (!allowed) {
      figma.notify("Auto-fix is a Pro feature. Please activate Systemic Pro.");
      // Tell the UI so it leaves its "fixing" state instead of waiting forever.
      figma.ui.postMessage({ type: "pro:autofix:done", total: 0, resolved: 0, failed: 0, skipped, resolvedItems: [] });
      return;
    }

    const items = Array.isArray(msg.items) ? msg.items as AutofixAllItem[] : [];
    if (!items.length) {
      figma.ui.postMessage({ type: "pro:autofix:done", total: 0, resolved: 0, failed: 0, skipped, resolvedItems: [] });
      return;
    }
    autofixRunning = true;

    const ordered = items.slice().sort((a, b) => {
      const rank = (i: AutofixAllItem) => (i.issueType === "DETACHED_INSTANCE" || i.kind === "detached") ? 2 : 1;
      return rank(a) - rank(b);
    });

    const total = ordered.length;
    let resolved = 0;
    let failed = 0;
    let processed = 0;
    let canceled = false;
    const resolvedItems: Array<{ id: string; issueType: IssueType }> = [];

    figma.ui.postMessage({ type: "pro:autofix:progress", phase: "start", total });
    await new Promise((r) => setTimeout(r, 0));
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
            const result = await applyAutofixItem(item);
            if (result.ok) {
              resolved += 1;
              resolvedItems.push({ id: item.id, issueType: item.issueType });
            } else {
              failed += 1;
            }
          } catch {
            failed += 1;
          }
          processed += 1;
          if (processed % 10 === 0) {
            figma.ui.postMessage({ type: "pro:autofix:progress", phase: "batch", processed, total, resolved, failed });
            await new Promise((r) => setTimeout(r, 0));
          }
        }
        figma.ui.postMessage({ type: "pro:autofix:progress", phase: "batch", processed, total, resolved, failed });
        await new Promise((r) => setTimeout(r, 20));
      }
    } catch {
      failed += Math.max(0, total - processed);
    } finally {
      figma.ui.postMessage({ type: "pro:autofix:done", total, resolved, failed, skipped, resolvedItems, canceled });
      if (canceled) {
        figma.notify("Auto-fix canceled. Press Cmd+Z to undo any changes.");
      }
      autofixCancelRequested = false;
      autofixRunning = false;
      // Re-audit the area the user originally scanned, not whatever "locate" last selected.
      const auditTargets = await resolveAuditTargets();
      if (lastAuditOptions && auditTargets.length > 0) {
        const { issues, ignoredIssues, summary } = await runAudit(auditTargets, lastAuditOptions);
        figma.ui.postMessage({ type: "audit-result", issues, ignoredIssues, summary });
      } else if (lastAuditOptions && lastAuditSelectionIds.length > 0) {
        figma.ui.postMessage({
          type: "audit-result",
          issues: [],
          ignoredIssues: [],
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
    const reply = (extra: Record<string, unknown>) =>
      figma.ui.postMessage({ type: "pro:autofix:candidates", key, locked: !allowed, ...extra });

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

      const node = await figma.getNodeByIdAsync(id);
      if (!node || !("id" in node)) {
        reply({ candidates: [], recommendedId: null });
        return;
      }

      if (kind === "text") {
        if (node.type !== "TEXT") {
          reply({ candidates: [], recommendedId: null });
          return;
        }
        const { candidates, recommendedId, mixed } = await findTextCandidates(node as TextNode);
        reply({ candidates, recommendedId, mixed });
        return;
      }

      const color = getSolidPaintColor(node as SceneNode, kind as "fills" | "strokes");
      if (!color) {
        reply({ candidates: [], recommendedId: null });
        return;
      }

      const { candidates, recommendedId, debug } = await findColorCandidates(color, node as SceneNode, kind as "fills" | "strokes");
      reply({ candidates, recommendedId, debug });
    } catch {
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
    const reply = (ok: boolean, error?: string) =>
      figma.ui.postMessage({ type: "pro:autofix:result", id, issueType, kind, ok, error });

    if (!allowed || !id || (!candidateId && issueType !== "DETACHED_INSTANCE")) {
      reply(false, "Auto-fix is not available.");
      return;
    }

    // Same code path as "Fix all", so a single fix also restores detached-instance overrides.
    try {
      const result = await applyAutofixItem({
        id,
        issueType: issueType as IssueType,
        kind: kind as AutofixAllItem["kind"],
        candidateId,
      });
      reply(result.ok, result.error);
    } catch (e) {
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
      const instanceId = await getOrCreateInstanceId();
      const result = activating
        ? await activateLicenseWithWorker(licenseKey, instanceId)
        : await verifyLicenseWithWorker(licenseKey, instanceId);
      const isPro = !!result.entitlements?.pro && !!result.ok && result.activated !== false;

      if (!isPro) {
        // A failed attempt must not change what the plugin already granted (e.g. a running trial).
        figma.ui.postMessage({
          type: "pro:verify:result",
          ok: false,
          entitlements: { pro: false },
          status: result.status ?? null,
          valid: typeof result.valid === "boolean" ? result.valid : undefined,
          daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
          error: result.error || failText,
        });
        return;
      }

      entitlements = makeLicenseEntitlements(licenseKey);
      licenseInfo = {
        status: result.status ?? null,
        valid: typeof result.valid === "boolean" ? result.valid : undefined,
        daysLeft: typeof result.daysLeft === "number" ? result.daysLeft : undefined,
      };
      await saveStoredLicenseKey(licenseKey);
      if (licenseInfo.status !== "trial") await rememberSuccessfulVerify(licenseInfo.status);

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
    } catch (e) {
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

    const options: AuditOptions = (msg.options as AuditOptions | undefined) ?? {
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
      const { issues, ignoredIssues, summary, canceled } = await runAudit(selection, options);
      figma.ui.postMessage({ type: "audit-result", issues, ignoredIssues, summary, canceled });
      if (canceled) {
        figma.notify("Scan canceled.");
      } else {
        figma.notify(`Audit complete: ${summary.total} issue${summary.total === 1 ? "" : "s"} found.`);
      }
    } catch (e) {
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

      const found = await figma.getNodeByIdAsync(id);
      if (!found) {
        figma.notify("Couldn’t find that layer (it may have been deleted or is in another file).");
        figma.ui.postMessage({ type: "locate-status", status: "error", id, message: "Node not found" });
        return;
      }

      // Switch to the page containing the node
      let p: BaseNode | null = found;
      while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") {
        p = p.parent;
      }
      if (p && p.type === "PAGE") {
        await figma.setCurrentPageAsync(p as PageNode);
      }

      if (!("x" in found)) {
        figma.notify("That item isn’t a canvas layer I can zoom to.");
        figma.ui.postMessage({ type: "locate-status", status: "error", id, message: "Not a canvas node" });
        return;
      }

      const node = found as SceneNode;
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);

      figma.ui.postMessage({
        type: "locate-status",
        status: "done",
        id,
        name: node.name,
        page: figma.currentPage.name,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      figma.notify("Locate failed: " + message);
      figma.ui.postMessage({ type: "locate-status", status: "error", id, message });
    }

    return;
  }

  if (msg.type === "select-nodes") {
    const ids = Array.isArray(msg.ids) ? msg.ids.map((v: unknown) => String(v)).filter(Boolean) : [];
    if (!ids.length) {
      figma.ui.postMessage({ type: "select-nodes:status", status: "error", count: 0, message: "No node ids received" });
      return;
    }

    try {
      // A single scan is always scoped to one selection, so every node should share a page.
      // Resolve nodes and their page in one pass; the first node found decides the target page,
      // and anything on a different page (shouldn't normally happen) is skipped.
      const found: SceneNode[] = [];
      let targetPageId: string | null = null;
      for (const id of ids) {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || !("x" in node)) continue;
        let p: BaseNode | null = node;
        while (p && p.type !== "PAGE" && p.type !== "DOCUMENT") p = p.parent;
        const pageId = p && p.type === "PAGE" ? p.id : null;
        if (targetPageId === null) targetPageId = pageId;
        else if (pageId !== targetPageId) continue;
        found.push(node as SceneNode);
      }
      if (!found.length) {
        figma.notify("Couldn’t find any of those layers (they may have been deleted).");
        figma.ui.postMessage({ type: "select-nodes:status", status: "error", count: 0, message: "No nodes found" });
        return;
      }

      if (targetPageId) {
        const targetPage = await figma.getNodeByIdAsync(targetPageId);
        if (targetPage && targetPage.type === "PAGE") {
          await figma.setCurrentPageAsync(targetPage as PageNode);
        }
      }

      figma.currentPage.selection = found;
      figma.viewport.scrollAndZoomIntoView(found);

      figma.ui.postMessage({ type: "select-nodes:status", status: "done", count: found.length });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      figma.notify("Select failed: " + message);
      figma.ui.postMessage({ type: "select-nodes:status", status: "error", count: 0, message });
    }

    return;
  }

  if (msg.type === "issues:validate") {
    const items = Array.isArray(msg.items) ? msg.items : [];
    const resolvedIds: string[] = [];
    for (const item of items) {
      const id = String(item?.id || "");
      const issueType = String(item?.issueType || "");
      if (!id || !issueType) continue;
      try {
        const node = await figma.getNodeByIdAsync(id);
        if (!node || !("id" in node)) {
          resolvedIds.push(id);
          continue;
        }
        const scene = node as SceneNode;
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
      } catch {
        resolvedIds.push(id);
      }
    }
    figma.ui.postMessage({ type: "issues:resolved", resolvedIds });
    return;
  }

  if (msg.type === "issue:ignore") {
    const id = String(msg.id || "");
    const issueType = String(msg.issueType || "");
    if (!id || !isIssueType(issueType)) return;
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (node && "setPluginData" in node) {
        (node as SceneNode).setPluginData(ignoreDataKey(issueType), "1");
      }
    } catch {
      // ignore — worst case the issue just isn't marked and reappears next scan
    }
    // Reuse the UI's existing issues:resolved handling to drop the row without a full re-scan.
    // issueType scopes the removal to this one issue (a node can carry a fill AND a stroke issue).
    figma.ui.postMessage({ type: "issues:resolved", resolvedIds: [id], ignoredDelta: 1, issueType });
    return;
  }

  if (msg.type === "issue:unignore") {
    const id = String(msg.id || "");
    const issueType = String(msg.issueType || "");
    if (!id || !isIssueType(issueType)) return;
    let ok = false;
    try {
      const node = await figma.getNodeByIdAsync(id);
      if (node && "setPluginData" in node) {
        (node as SceneNode).setPluginData(ignoreDataKey(issueType), "");
        ok = true;
      }
    } catch {
      ok = false;
    }
    figma.ui.postMessage({ type: "issue:unignored", id, issueType, ok });
    return;
  }

  if (msg.type === "issue:unignoreAll") {
    try {
      const targets = await resolveAuditTargets();
      const nodes = collectNodes(targets, true);
      for (const node of nodes) {
        for (const type of ISSUE_TYPES) {
          try {
            node.setPluginData(ignoreDataKey(type), "");
          } catch {
            /* ignore */
          }
        }
      }
      if (lastAuditOptions && targets.length > 0) {
        const { issues, ignoredIssues, summary, canceled } = await runAudit(targets, lastAuditOptions);
        figma.ui.postMessage({ type: "audit-result", issues, ignoredIssues, summary, canceled });
      }
    } catch (e) {
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
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      figma.notify("Couldn’t open link: " + message);
    }

    return;
  }

  if (msg.type === "close") {
    figma.closePlugin();
  }
}
