# Systemic Auditor

A Figma plugin that audits a selection for design-system drift and fixes it against your variables and styles:

- **Detached instances**: relinked to their original component, replaying layout, text, fills, strokes, effects, radius, visibility, opacity and nested component swaps.
- **Unstyled text**: matched to local text styles.
- **Rogue fills and strokes**: matched to local and team-library color variables (CIEDE2000, with a recommended match under ΔE 2).

Scanning, the candidate preview, ignore-list, filters/sort and CSV export are available to everyone; applying fixes (including "Fix all") is a Pro feature gated by a license key. See [CLAUDE.md](CLAUDE.md) for the architecture, message protocol, domain logic and known issues.

## Develop

```bash
npm install
npm run build      # compile code.ts -> code.js (code.js is committed; manifest.json points at it)
npm run watch      # rebuild on change
npm run typecheck  # tsc --noEmit
npm run lint
npm test           # Node tests for code.js against a stubbed figma API
```

`ui.html` is a single hand-written file with no build step. To run the plugin: in Figma desktop, **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`.

### Tests

- `npm test` runs `tests/backend.test.js` and `tests/cache.test.js`, which load the compiled `code.js` into a Node `vm` with a fake `figma` object. Run `npm run build` first.
- `tests/ui-harness.html` drives `ui.html` in an iframe with a fake backend. Serve the repo root (`python3 -m http.server 8790`), open `http://localhost:8790/tests/ui-harness.html` in a **visible, foreground** browser tab (a hidden tab throttles `requestAnimationFrame` and gives false failures), then run `await load(); await T.all();` in the console and inspect `results`. The harness stubs the export button's anchor click, so running it never downloads a file.

## Notes

- `documentAccess` is `dynamic-page`, so only the async Plugin APIs work (`getNodeByIdAsync`, `setFillStyleIdAsync`, ...); the sync variants throw.
- Network access is limited to the domains in `manifest.json` (`networkAccess.allowedDomains`).
