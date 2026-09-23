# Systemic Auditor — Figma plugin

Context for any agent working on this plugin. Read this before touching code.

## What this is

**Systemic Auditor** scans the current Figma selection for design-system debt, shows a health score, and (Pro) auto-fixes what it finds. It was originally built with ChatGPT and Gemini, so expect large, repetitive, defensively-written code. The owner (Alfre Miranda) plans a **revamp**: new UI (see "Redesign mock"), cleanup, possibly new checks and a reworked licensing flow.

Published plugin: manifest `id` `1588257751230049347`, `editorType: ["figma"]`, `documentAccess: "dynamic-page"`, permission `teamlibrary`, `networkAccess` limited to Google Fonts, `systemicauditor.com`, `shop.systemicauditor.com` and the license Worker (`systemic-license.im-94e.workers.dev`).

Free vs Pro: scanning, stats, filters, sort, "locate layer", "select all shown on canvas" and candidate **preview** (read-only — free users now see the actual recommended variable/style name, just disabled) are free. Everything that modifies the file (per-issue fix, Fix all, relink detached) plus CSV export is Pro. `ProFeature` is now just `"autofix" | "export"` — `rules`/`themes`/`reports` were removed (dead, never implemented or gated).

## Where things live

This folder was migrated from `~/Library/CloudStorage/OneDrive-Personal/alfremiranda/Figma/Plugin/Systemic/` to `/Users/alfremiranda/Projects/systemic/plugin/` (verify the migration happened before assuming). The old parent folder also contains, and these are NOT part of this repo:

| Old sibling | What it is |
|---|---|
| `systemic backup/` | Dated snapshots (v1.0, 2.0 Beta, 4.0, Pro v1.0, backups 2025-01-02 … 2026-01-12), plus `worker.js` (Cloudflare Worker source, **saved as RTF, not valid JS**) and `Cloudfare Worker.xlsx`. |
| `Redesign Systemic App/` | Figma Make export (Vite + React + Tailwind + shadcn/ui + motion). **Visual mock only**: hardcoded results, fake 2s scan timer, no Figma API, no licensing, only 4 scanner options (no strokes). Design source: figma.com/design/RWhXPGJ262RYrJUqdSkkAI/Redesign-Systemic-App. Meant as the target look for the revamp. |
| `Systemic Assets/` | Marketing thumbnail and demo videos. |

In this folder:

```
code.ts            plugin backend (source of truth)      ~2,630 lines
code.js            compiled output, COMMITTED, loaded by Figma. Byte-identical to `tsc` output of code.ts (verified).
ui.html            entire UI: CSS + markup + JS in one file  ~5,400 lines
manifest.json      Figma manifest (main: code.js, ui: ui.html)
package.json       scripts: build (tsc), watch, lint. Name/description are still template defaults.
tsconfig.json      target es6, lib es6, strict. No outDir/include -> emits code.js next to code.ts.
globals.d.ts       empty file
assets/fonts/      Manrope .ttf files (duplicated in git history). ui.html actually loads fonts from Google Fonts.
Favicon.png/.svg
```

Git: one real commit ("project uploaded", 2026-04-15) plus an earlier backup commit. `.gitignore` excludes node_modules, dist, build, *.log, .DS_Store.

## Build / run

```bash
npm install
npm run build      # tsc -p tsconfig.json  -> code.js
npm run watch
npm run lint       # eslint config lives inside package.json (figma-plugins recommended rules)
```

Load in Figma desktop: Plugins → Development → Import plugin from manifest → `manifest.json`. There is no bundler and no test suite. `ui.html` is loaded as-is (no build step), so it must stay a single self-contained file unless the build is changed. Always rebuild `code.js` after editing `code.ts` — Figma runs `code.js`.

## Architecture

Two contexts, as in every Figma plugin: `code.ts` runs in the Figma sandbox (has the scene graph, no DOM); `ui.html` runs in an iframe (DOM, no scene graph). They communicate only via `postMessage` (`parent.postMessage({pluginMessage})` from UI, `figma.ui.postMessage` from backend).

### Message protocol

UI → backend (handled in `handleMessage`, wrapped by `figma.ui.onmessage`, `code.ts` ~line 1930; an uncaught error is caught and shown with `figma.notify`):

| type | payload | effect |
|---|---|---|
| `run-audit` | `options: AuditOptions` | scan selection; replies `audit-result` (+ many `audit:progress`); replies `no-selection` if empty, `audit-error{message}` if the scan throws or an auto-fix is running |
| `select-node` | `id` | switch to node's page, select it, zoom to it; replies `locate-status` |
| `issues:validate` | `items[{id,issueType}]` | re-check issues; replies `issues:resolved{resolvedIds}` |
| `pro:get-entitlements` | — | replies `pro:entitlements` |
| `pro:verify` / `pro:activate` | `key` | license check / activation via Worker; replies `pro:verify:state`, `pro:verify:result`, `pro:entitlements` |
| `pro:clearLicense` | — | wipes stored key + entitlements |
| `pro:autofix:candidates` | `id, kind(fill|stroke|text), key` | replies `pro:autofix:candidates{key,candidates,recommendedId,debug|mixed}` |
| `pro:autofix:apply` | `id, issueType, candidateId, kind` | single fix (same code path as Fix all, `applyAutofixItem`); replies `pro:autofix:result{id, issueType, kind, ok, error?}` |
| `pro:autofix` | `items[AutofixAllItem], skipped` | bulk fix in batches of 50; streams `pro:autofix:progress`, ends with `pro:autofix:done`, then re-runs the last audit and sends a fresh `audit-result` |
| `pro:autofix:cancel` | — | sets cancel flag (no rollback; user is told to Cmd+Z) |
| `pro:debug:set` | `isPro` | only honored when `DEV_PRO` is true |
| `resize` | `width,height` | resize window (min 360x360), persisted in `clientStorage["uiSize"]` |
| `open-external` | `url` | `figma.openExternal`, http(s) only |
| `close` | — | `figma.closePlugin()` |
| `run-audit:cancel` | — | sets `scanCancelRequested`; `runAudit`'s loop checks it and returns `canceled:true` on the result. Reset only at the top of the `run-audit` handler, not inside `runAudit` itself, so it can't leak into the autofix `finally` block's re-audit call |
| `select-nodes` | `ids: string[]` | multi-node version of `select-node`: resolves every id, keeps only those on the first resolved node's page, selects + zooms to all of them; replies `select-nodes:status{status,count}` |
| `options:save` | `options: AuditOptions` | debounced (300ms, mirrors `resize`) write to `clientStorage["systemic_scanner_options_v1"]` |
| `get-saved-options` | — | replies `saved-options{options}` (`null` if nothing was ever saved) |
| `issue:ignore` | `id, issueType` | `node.setPluginData("systemic:ignore:<TYPE>", "1")`, then replies via the existing `issues:resolved{resolvedIds, ignoredDelta:1}` so the UI's normal row-removal path handles it — no separate ack message |
| `issue:unignoreAll` | — | clears the ignore flag for all 4 types across `lastAuditSelectionIds`' subtree, then re-runs `runAudit` and posts a fresh `audit-result` |

`pro:autofix:candidates` now computes candidates **regardless of entitlement** (it's read-only) and adds `locked: !allowed` to every reply — only `pro:autofix:apply`/`pro:autofix` (the mutations) stay hard-gated by `hasFeature`. `audit-result` gained `canceled?: boolean` and `summary.ignored`.

### code.ts map (line numbers approximate)

- 1–17: window constants, `showUI` (440x540 default, min 360x360, title "Systemic Auditor"), restore saved size.
- 19–278: **licensing/entitlements** state, `DEV_PRO`, `DEV_FORCE_LICENSE_STATUS`, startup verification IIFE. Entitlements are **in-memory only, re-verified against the Worker on every launch**; only the license key and an `inst_…` instance id persist in `clientStorage`.
- 128–177: `loadLibraryVariables` — imports **every COLOR variable from every enabled team library** via `importVariableByKeyAsync` into `libraryVariableCache`. Slow on big libraries; fired (unawaited) on each `run-audit`.
- 280–320: types `Issue`, `AutofixCandidate`, `AutofixAllItem`, `AuditOptions`.
- 324–439: path/collection helpers, `detachedInfo` helpers (`getDetachedComponentName`, `createInstanceFromDetachedInfo`).
- `collectInstanceOverrides` / `applyInstanceOverridesToInstance` — snapshot layout/text overrides of a detached frame by path (`name#index > …`) and replay them onto the fresh instance. Long, repetitive try/catch per property. Now also captures/replays `fills`/`strokes`/`effects`/`cornerRadius`/per-corner radii/`visible`/`opacity` per descendant via shared `captureVisualOverride`/`applyVisualOverride` helpers, and best-effort replays a nested `INSTANCE`'s component swap (`getMainComponentAsync`/`swapComponent`) when it differs from the fresh instance's default. All confirmed live against a real file (see "What has NOT been verified").
- `isIssueIgnored(node, type)` / `ignoreDataKey(type)` — the ignore-list check, `node.getPluginData("systemic:ignore:<TYPE>") === "1"`. `runAudit`'s single `addIssue` helper (all 4 issue types now funnel through it) skips ignored issues and counts them in `summary.ignored` instead of pushing them.
- `scanCancelRequested` (module flag, mirrors `autofixCancelRequested`) and the `canceled` local inside `runAudit`'s loop.
- 689–785: `applyAutofixItem` (bulk path).
- 787–841: text style cache (local styles + styles referenced on the page, cached per page id).
- 843–937: **detection**: `hasRogueFill`, `hasRogueStroke`, `hasUnstyledText`, `hasBoundPaintVariable`.
- 939–1151: text matching (`findTextCandidates`).
- 1153–1559: color matching (`findColorCandidates`) and ΔE2000 math.
- 1561–1697: license Worker client (`callLicenseEndpoint`, verify, activate).
- 1699–1810: `runAudit`.
- 1812–2471: message handler.

### ui.html map

- Lines 12–1972 `<style>` (dark theme, Manrope, tokens: `--bg #05080a`, `--lime #A3E635`, orange/cyan/red/violet accents). ~1,900 lines of CSS I have not read line by line.
- 1975–2297 markup: header + license button, trial banner, scan/reset, collapsible "Scanner Options" (5 switches), `#results` (status card with health gauge SVG, 5 stat cards that double as filters, issues list, inline auto-fix progress, "Auto-fix all N issues" button), 8 resize handles, Pro license modal.
- `<script>` (vanilla JS): global `state`, `proState`, `autofixState`, `autofixQueue`; `renderList()` builds rows imperatively with `document.createElement`; `updateAutofixRow` builds the variable/style dropdown per row (menus are re-parented to `document.body` when open); `onmessage` handler; auto-resize-to-content logic (`requestResizeToFit`, measures via a temporary natural-height reflow, `measureNaturalHeight()`) posts `resize` to the host.
- Auto-fix candidates are fetched **lazily per visible row** (`rebuildAutofixQueue`, 3 concurrent) for everyone now, Pro and free — the request-side `!proState.verified` gates were removed; only the actual apply (`fixBtn`, `handleAutofixAll`) stays Pro-gated. All up front for "Fix all" (`startAutofixPreload`, still Pro-only since it's preparing a bulk mutation). Candidate cache keys are `"<nodeId>:<fill|stroke|text|detached>"` (parse with `parseKey()`, splits on the **last** colon — node ids contain one themselves).
- `state.activeFilter` is a `Set<string>` of active issue types (empty = "all"); several can be active together. `state.sortMode` (`scan|type|name`) is applied by `sortIssues()`, composed after `filteredIssues()`.
- New `.issuesToolbar` above the list: Sort (small popover reusing `.fixMenu`/`.fixOption` CSS but its own open/close JS, not `closeAllFixDropdowns`), "Select all shown on canvas" (`select-nodes`), Export CSV (client-side `Blob`/`ObjectURL` + hidden `<a download>`, Pro-gated; falls back to `navigator.clipboard.writeText` on failure — **not verified inside a real plugin iframe**, see below), and the "N ignored — show all" link (`issue:unignoreAll`).
- Each row has a small `.ignoreBtn` (circle-x icon) next to Fix/Relink, sending `issue:ignore`.
- `#scanCancelBtn` inside `#statusLoading` (visible while `state.isScanning`), sends `run-audit:cancel`; mirrors `#autofixInlineCancel`'s pattern.
- `#healthLabelWrap`/`#healthInfoBtn`: a small "ⓘ" next to "Health Score" with a static CSS hover/focus tooltip explaining the formula.
- URLs in the UI: `PRO_BUY_URL` = https://www.systemicauditor.com/, `PRO_CHECKOUT_URL` = the Lemon Squeezy checkout on shop.systemicauditor.com.

## Domain logic

**Scan** (`runAudit`): flattens the selection (recursive if "Include children"), then per node: detached check (`node.detachedInfo != null`), text without style (`textStyleId` empty or mixed), rogue fill/stroke. Yields to the event loop every 200 nodes, posts progress every ~120ms.

**Rogue fill/stroke** = has a visible non-image paint, no variable binding on the node or any paint/gradient stop, and no paint style id (or mixed). Image-only paints are ignored.

**Health score** (UI): `(scannedElements - elementsWithIssues) / scannedElements * 100`. Fallback if scanned = 0: `100 - 3*issues`. The gauge shows the percent; `scoreToGrade()` (A+…F) exists but the grade is only used for the "perfect" celebration (100% and zero issues hides the issues list and fires confetti). `elementsWithIssues` now includes unstyled-text issues (they used to be missing, so text-only results scored 100%). The UI also requires `summary.total === 0` before it celebrates.

**Color candidates** (`findColorCandidates`): every COLOR variable (local + imported library) is resolved for the consumer node's mode (`resolveForConsumer`, fallback manual alias resolution), alpha within 0.05, ΔE2000 < 5 = candidate. Skipped: names starting `_`; for strokes, names that look like backgrounds. Names starting `.`/`-` are shown disabled. Score = alias(+2) + semantic collection name(+1) + local(+0.5) + layer-keyword match(+3) + primary/secondary/tertiary intent − inverse/disabled. Filtered by variable `scopes` vs node type. Sorted by ΔE then score. **Recommended** = ΔE < 2 with highest score. Falls back to local paint styles (exact match only) if no variable matches. Only the first solid paint is considered.

**Text candidates** (`findTextCandidates`): same font family + style required; size/line-height/letter-spacing decide perfect/near/partial; bonus for styles with variable bindings and semantic name keywords (heading/body/label/code). Recommended = perfect else near. Mixed-property text is flagged and skipped in Fix all.

**Fix all**: UI builds the plan (`buildAutofixAllPlan`): detached items go last, nodes that are detached are skipped for other fixes, mixed text skipped. Backend applies in batches of 50, then re-audits.

**Detached fix**: create instance from `detachedInfo` (local component/set default variant, or imported library component), insert at the same index, copy name/position/rotation/opacity/size, replay overrides (now including fills/strokes/effects/corner-radius/visible/opacity and best-effort nested component swaps, not just layout/text — see code.ts map), delete the original. If anything after insertion throws, the new instance is removed and the original is kept (no duplicate left behind). Destructive; cancellation cannot roll back.

**Ignore list**: per-(node, issueType), stored as `node.setPluginData("systemic:ignore:<TYPE>", "1")` — travels with the file, not the device. `runAudit` skips ignored issues (still counts the node as scanned) and reports them in `summary.ignored`. v1 is all-or-nothing: there's no per-issue "un-ignore" or a list of what's currently ignored, only "un-ignore everything in the last-scanned selection" (`issue:unignoreAll`). A per-issue manage view is a reasonable follow-up, not built.

**Scan cancel**: mirrors auto-fix cancel. `run-audit:cancel` sets a flag `runAudit`'s loop checks every iteration; a canceled scan still returns whatever issues were found before the break, with `canceled:true`. The UI shows partial results and skips the celebration/confetti path on a canceled result.

## Licensing / Pro

- Client: `code.ts` `callLicenseEndpoint` POSTs `{licenseKey, installationId}` to `<worker>/verify` or `/activate` with header `X-Systemic-Token`.
- Worker (source only as RTF in the old `systemic backup/worker.js`; I read only its first ~80 lines): Cloudflare Worker fronting **Lemon Squeezy** license API, KV namespace `LICENSES` keyed `ACT:<licenseKey>:<installationId>`, routes `/verify`, `/activate`, `/webhook`, CORS reflects `Origin`. Responses look like `{ok, valid, status, daysLeft?, entitlements:{pro}}`. UI understands statuses `trial`, `active`/`pro`, `expired`. How the 7-day trial is issued is not visible in this repo.
- Dev switches in `code.ts`: `DEV_PRO` (all Pro on + UI debug toggle, currently `false`), `DEV_FORCE_LICENSE_STATUS` (`"trial" | "expired" | "pro" | null`, currently `null`). Both must be off in a release build. `SIMULATE_AUDIT` in ui.html is `false`.
- **Offline grace:** a successful non-trial verify stores `{at, status}` in `clientStorage` (`systemic_last_verified_v1`). If the Worker is unreachable or answers 5xx/429 at startup and that stamp is under 7 days old, Pro is kept (`offline: true` on the entitlements message). An explicit 4xx/`valid:false` answer downgrades immediately and clears the stamp; trial statuses never get grace. Every `pro:entitlements` message is built by `buildEntitlementsMessage()` and carries `status`/`valid`/`daysLeft`.
- **Security note:** `SYSTEMIC_TOKEN` (the Worker's shared secret) is hardcoded in `code.ts` (`~line 50`) and therefore in shipped `code.js` and in git history. It is not a real secret. Do not print it in logs or docs; rotate it and redesign auth if licensing is reworked. Pro gating is also enforced client-side only (`hasFeature`), which is inherent to plugins but worth remembering.

## Known issues and tech debt

Fixed in the QA pass (2026-09): paint-style setters and `getLocalPaintStyles` (both throw under `dynamic-page`), the health score ignoring text issues, the Fix-all preload hang and node-id colon parsing, duplicate single/bulk auto-fix paths, license state handling, window-resize ratchet, keyboard/ARIA gaps, and the backup files. A later pass (same month) condensed `ui.html`'s spacing and made the `@media (max-width: 420px/380px)` rules do real work; `MIN_H`/`UI_MIN_H` dropped from 540 to 360. A third pass (same month) built 10 functionality/UX items: ignore-list, CSV export (the only surviving Pro feature besides autofix — `rules`/`themes`/`reports` removed as dead), extended detached-relink override replay, persisted Scanner Options, "select all shown on canvas", free-tier read-only candidate preview, scan cancel, multi-select filter chips, sort (scan/type/name), and a Health Score tooltip; confirmed live in the real plugin by the owner, including CSV export end to end. A fourth pass (same month, found via a 450-node stress-test scan built for timing) fixed two things: **`.row`'s entrance animation-delay scaled unboundedly with list size** (`calc(var(--i,0) * 18ms)`, uncapped — a 150-row filtered list put its last row's delay at 2.68s, so a sort-then-filter on a large scan looked like "the list won't change" when most rows were just sitting at `opacity:0` waiting their turn; capped at `min(…, 260ms)`). And added a small `#matchingIndicator` ("Matching N…") in the issues toolbar, driven by the already-tracked `autofixState.pendingCount` — the *existing* aggregate loading affordance (`#dataLoading`/`body[data-loading]`) turned out to be permanently dead code (gated on `state.isScanning`, which is always false by the time candidates are being fetched) and, worse, hides the entire stat grid + issues list, so it was deliberately left alone rather than repurposed. Confirmed live in the real plugin by the owner. A fifth pass (same month, three bugs reported after live use on the heavy stress-test canvas) fixed: (a) **the `#matchingIndicator` spinner getting stuck** — `rebuildAutofixQueue()` sorted purely by on-screen row position, so when a handful of early rows hit the "library still importing" retry path (`pro:autofix:candidates` replying with `debug.libraryImporting`), they kept re-winning the front of the queue on every rebuild and fully starved every other row from ever being requested until they burned through their 5-retry budget — reproduced directly (a 120-issue scan with 15 permanently-"importing" rows never got past `pendingCount: 6`, 0 of 120 resolved, for the life of the test) and fixed by sorting already-retried keys behind never-yet-tried ones in `rebuildAutofixQueue()`; (b) **the issues toolbar staying visible after collapsing "Issues found"** — `.issuesToolbar` was a DOM sibling of `.sectionBody`, not a child, so the `.section[data-open="false"] .sectionBody` collapse rule never touched it; fixed by moving the toolbar markup inside `.sectionBody`; (c) **the sort menu closing right after opening** — `#sortMenu` reused the shared `.fixMenu` class for styling, which the pre-existing `closeAllFixDropdowns()` sweep (bound to `window` resize/scroll and outside clicks via `bindFixDropdownClose()`) closes whenever it's not inside a `.fixDropdown` — real Figma's frequent `figma.ui.resize()` calls fire genuine `resize` DOM events on the plugin iframe, closing it almost as soon as it opened; reproduced directly (dispatching a synthetic `resize` event closed the open menu pre-fix, left it open post-fix) and fixed by tagging `#sortMenu` with a `.toolbarMenu` marker class and excluding `.toolbarMenu` from that sweep. All three verified via the browser harness (28/28 checks passing). The owner then re-tested (c) live on the 580-issue heavy stress-test canvas and confirmed the queue-starvation fix works — it no longer hangs forever — but "Matching N…" still ground through the whole scan slowly (oscillating 3→2→3→2… for a long time before stopping), because `findColorCandidates()` re-fetched `getLocalVariableCollectionsAsync()`/`getLocalVariablesAsync("COLOR")` from Figma on *every single* candidate request — the dominant cost, paid again per issue even though nothing about the local variable set changes between requests in the same matching pass. Fixed by caching both for 5s (mirroring `loadLibraryVariables`'s existing throttle pattern) behind a shared in-flight promise (`getLocalColorVariablesCached()`, `code.ts`) — the promise-sharing part matters: a naive TTL cache alone still let the UI's 3 concurrent requests race past the empty-cache check before the first fetch resolved, triplicating the fetch; verified via the Node harness (`cache_test.js`, not committed) that 20 concurrent candidate requests now share exactly one `getLocalVariableCollectionsAsync`/`getLocalVariablesAsync` call instead of 20, and that a new `run-audit` still invalidates the cache correctly. Not yet re-confirmed live in Figma by the owner. Still open:

1. `ui.html` is one ~5.3k-line file with tightly coupled imperative state (pending keys, retry timers, preload queue, re-parented dropdown menus). Fragile; a component-based rewrite is the likely direction.
2. `code.ts` casts to `any` heavily (160 `no-explicit-any` warnings; the rule is set to `warn`) and repeats near-identical try/catch blocks (override copying).
3. Fix all can still change colors slightly: recommended matches are ΔE < 2.
4. The window now hugs its content (deterministic natural height, capped at 1800); confirm the feel in Figma, since the old code ratcheted taller on every pass.
5. `SYSTEMIC_TOKEN` is hardcoded and in git history (see Licensing). `chroma-js` is a dependency but never imported. `package.json` metadata is template text, `README.md` is the stock template, dev tooling has `npm audit` findings, and `@figma/*` dev dependencies are pinned to `*`.
6. `assets/fonts/` has nested duplicates. `tsconfig.json` has no `outDir`/`include`; `code.js` is committed next to source.
7. No test suite in the repo. Both QA passes used throwaway harnesses (a Node `vm` harness with a stubbed `figma` API for `code.js`, and an iframe harness with a fake backend for `ui.html`, extended this pass to cover all 10 new features — 16 backend + 28 UI checks passing); none of it is committed. **Testing-methodology gotcha**, discovered while chasing the animation-delay bug: checking `getComputedStyle`/DOM state via `await sleep(N)` *inside one continuous* automated-browser script often reads stale values (CSS animations and `requestAnimationFrame`-gated code don't reliably progress within a single scripted call chain in this environment) — a real, deterministic value like `animationDelay` is trustworthy either way, but anything gated on paint/rAF needs a check from a **separate** tool call (or a fresh page) to be trusted. A long-lived, heavily-reused browser tab also degraded and produced flaky results after hours of reuse; a fresh tab fixed it. **Second gotcha, found chasing the fifth-pass bugs**: a browser-pane tab opened/left in the *background* (`tabs_create`'s default) throttles `requestAnimationFrame` — since `audit-result`'s render path is `requestAnimationFrame`-gated, a background tab can leave `#list` at 0 rows well past when a foreground tab would've rendered, producing failures (e.g. "ignore button exists on the row") that look like a real regression but are purely a tab-visibility artifact; front the tab (`tabs_select`) before trusting any timing-sensitive harness result.
8. Ignore-list is all-or-nothing (see Domain logic) — no per-issue un-ignore or "what's currently ignored" view.
9. The `use_figma` MCP bridge (used for live checks against the real file this session) cannot call `setPluginData`/`getPluginData` — its own host runtime rejects them ("only private plugins on web can use it"), even though they're a completely standard, unrestricted Plugin API (confirmed via `@figma/plugin-typings`, no `dynamic-page` warning). Don't take that error as evidence the ignore-list is broken; it's a limitation of that specific tool, not of the real plugin.

**CSV export is confirmed end-to-end in the real plugin** (2026-09-22): the owner ran "Export CSV" from the actual installed plugin in Figma desktop and got a real, well-formed download (`docs/systemic-audit-2026-09-22.csv` — 7 rows of real node ids/types/paths from the `Test` page, counts matching the plugin's own stat cards exactly). A screenshot from the same session also confirms the toolbar (Sort/Select-all/Export icons), the per-row ignore button, and the Health Score info tooltip icon all render correctly inside the real plugin panel. Still not confirmed by that screenshot alone: actually clicking through ignore/sort/select-all/scan-cancel, Scanner Options surviving a reopen, and the detached-relink override replay end to end (the individual Plugin API calls it uses were confirmed live earlier, not the full `applyAutofixItem` path via the real UI).

## Conventions and gotchas

- Target is ES6 (`tsconfig`), so the Figma sandbox gets transpiled output; keep `lib: es6` unless you change the build.
- `documentAccess: "dynamic-page"` means use the **async** APIs (`getNodeByIdAsync`, `setCurrentPageAsync`, `getLocalTextStylesAsync`, `variables.getVariableByIdAsync`, `setTextStyleIdAsync`, …). Sync variants throw, including the style setters: use `setFillStyleIdAsync` / `setStrokeStyleIdAsync` / `setTextStyleIdAsync` and `getLocalPaintStylesAsync`. `npm run lint` flags the deprecated sync methods.
- Text edits require `figma.loadFontAsync` first.
- UI network access is restricted by `manifest.networkAccess`; adding any new domain (analytics, fonts, API) requires updating it.
- Issue-type colors are consistent on screen: Detached = violet, Strokes = orange, Text = cyan, Fills = red (stat cards and row icons). The old `typeToPill` color fields were never rendered and are gone (`typeToLabel` remains).
- Figma node ids contain a colon (`12:34`). UI issue keys are `<nodeId>:<kind>`; always parse them with `parseKey()` (splits on the last colon).
- `window.confirm` is unreliable in the plugin iframe; confirmations are inline (see the >1000-layer Fix all).
- The UI minimum window size is `UI_MIN_W`/`UI_MIN_H` in `ui.html` and `MIN_W`/`MIN_H` in `code.ts`; keep them equal.
- Do not commit secrets. Do not run destructive Figma operations in tests against real files; auto-fix modifies and deletes nodes.

## What has NOT been verified

- Most of the CSS and the gauge/animation JS were not read line by line (only the parts touched by the QA fixes).
- The Worker beyond its first ~80 lines, and how trials/webhooks work end to end. There is still no "Start Free Trial" flow in the plugin — `pro:verify`/`pro:activate` both require an existing license key; building one needs a Worker endpoint this repo doesn't have.
- The actual compiled plugin's UI panel running inside real Figma desktop was **not** driven by anything here (no automation for a plugin's own window) — but the owner has since run it by hand and confirmed CSV export, the new toolbar, the per-row ignore button, and the Health Score tooltip icon all render and work in the real plugin (see Known issues, CSV export note). Everything else verified live *by this agent* this session went through the `figma` MCP bridge (`use_figma`), which runs real `code.ts`-equivalent Plugin API calls against the actual file, not the `ui.html` iframe.
- Still to check by hand in the real plugin: applying a paint style, a detached relink with real components (including the new fills/strokes/effects/corner-radius/component-swap replay — the individual Plugin API calls are confirmed live, but not the full `applyAutofixItem` path end to end in Figma), a scan on a file with team libraries, the real license activate/clear/offline flow, the window auto-resize, Scanner Options actually persisting across a real plugin close/reopen, and actually clicking through ignore/sort/select-all/scan-cancel (confirmed rendered correctly, not yet confirmed interactively).
