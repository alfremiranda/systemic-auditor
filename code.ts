const DEFAULT_W = 480;
const DEFAULT_H = 640;

// Show the plugin window
figma.showUI(__html__, { width: DEFAULT_W, height: DEFAULT_H, title: "Systemic Auditor" });

// Restore last window size (if available)
(async () => {
  const saved = await figma.clientStorage.getAsync("uiSize");
  if (saved && typeof saved.width === "number" && typeof saved.height === "number") {
    figma.ui.resize(saved.width, saved.height);
  }
})();

type IssueType = "ROGUE_FILL" | "ROGUE_STROKE" | "UNSTYLED_TEXT" | "DETACHED_INSTANCE";

type Issue = {
  id: string;
  name: string;
  type: IssueType;
  path: string;
};

type AuditOptions = {
  scanChildren: boolean;
  checkRogueFills: boolean;
  checkRogueStrokes: boolean;
  checkDetached: boolean;
  checkTextStyles: boolean;
};

function isMixed(value: unknown): value is typeof figma.mixed {
  return value === figma.mixed;
}

function getNodePath(node: SceneNode): string {
  const parts: string[] = [];
  let current: BaseNode | null = node;
  while (current && current.type !== "PAGE" && current.type !== "DOCUMENT") {
    if ("name" in current) parts.unshift((current as any).name || current.type);
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
  const di = (node as any).detachedInfo;
  return di != null;
}

function canCheckDetachedInfo(node: SceneNode): boolean {
  return (node as any).detachedInfo !== undefined;
}

function hasBoundPaintVariable(node: SceneNode, kind: "fills" | "strokes"): boolean {
  const anyNode = node as any;

  // Node-level bindings
  const bv = anyNode.boundVariables;
  if (bv && bv[kind]) return true;

  // Paint-level bindings
  if (kind in anyNode) {
    const paints = anyNode[kind] as readonly any[] | typeof figma.mixed;
    if (!isMixed(paints) && Array.isArray(paints)) {
      for (const p of paints) {
        const pbv = p?.boundVariables as any;
        if (pbv && typeof pbv === "object") {
          if (pbv.color || pbv.opacity) return true;
          for (const k of Object.keys(pbv)) {
            if (pbv[k]) return true;
          }
        }

        const stops = (p as any).gradientStops as any[] | undefined;
        if (Array.isArray(stops)) {
          for (const s of stops) {
            const sbv = s?.boundVariables as any;
            if (sbv && typeof sbv === "object") {
              if (sbv.color || sbv.opacity) return true;
              for (const k of Object.keys(sbv)) {
                if (sbv[k]) return true;
              }
            }
          }
        }
      }
    }
  }

  return false;
}

function hasRogueFill(node: SceneNode): boolean {
  if (!("fills" in node)) return false;

  const fills = (node as any).fills as readonly Paint[] | typeof figma.mixed;
  if (isMixed(fills) || !Array.isArray(fills) || fills.length === 0) return false;

  const fillStyleId = (node as any).fillStyleId as string | typeof figma.mixed | undefined;

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

  const strokes = (node as any).strokes as readonly Paint[] | typeof figma.mixed;
  if (isMixed(strokes) || !Array.isArray(strokes) || strokes.length === 0) return false;

  const strokeStyleId = (node as any).strokeStyleId as string | typeof figma.mixed | undefined;

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

function runAudit(selection: readonly SceneNode[], options: AuditOptions) {
  const nodes = collectNodes(selection, options.scanChildren);
  const issues: Issue[] = [];

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

  const addIssue = (node: SceneNode, type: IssueType) => {
    issues.push({ id: node.id, name: node.name, type, path: getNodePath(node) });
    elementsWithIssuesSet.add(node.id);
  };

  for (const node of nodes) {
    if (options.checkDetached && canCheckDetachedInfo(node)) {
      markAudited(node);
      if (isDetachedInstanceLike(node)) {
        addIssue(node, "DETACHED_INSTANCE");
        detached++;
      }
    }

    if (options.checkTextStyles && node.type === "TEXT") {
      markAudited(node);
      if (hasUnstyledText(node)) {
        addIssue(node, "UNSTYLED_TEXT");
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
}

figma.ui.onmessage = async (msg) => {
  if (msg.type === "resize") {
    const MIN_W = 320;
    const MIN_H = 360;

    const w = Math.max(MIN_W, Math.round(Number(msg.width) || DEFAULT_W));
    const h = Math.max(MIN_H, Math.round(Number(msg.height) || DEFAULT_H));

    figma.ui.resize(w, h);
    await figma.clientStorage.setAsync("uiSize", { width: w, height: h });
    return;
  }

  if (msg.type === "run-audit") {
    const selection = figma.currentPage.selection;

    if (selection.length === 0) {
      figma.ui.postMessage({ type: "no-selection" });
      figma.notify("Nothing selected. Choose a frame, layer, or element, then scan again.");
      return;
    }

    const options: AuditOptions = msg.options ?? {
      scanChildren: true,
      checkRogueFills: true,
      checkRogueStrokes: true,
      checkDetached: true,
      checkTextStyles: true,
    };

    const { issues, summary } = runAudit(selection, options);

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

      if (!("x" in (found as any))) {
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
};