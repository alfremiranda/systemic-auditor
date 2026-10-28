# Systemic Auditor

A free, open-source Figma plugin that audits a selection for design-system drift and fixes it against your variables and styles.

- **Detached instances**: relinked to their original component, replaying layout, text, fills, strokes, effects, radius, visibility, opacity and nested component swaps.
- **Unstyled text**: matched to local text styles.
- **Rogue fills and strokes**: matched to local and team-library color variables (CIEDE2000, with a recommended match under ΔE 2).

Everything is included: scanning, the health score, filters/sort, per-issue fixes, "Fix all", an ignore-list, CSV export, and bulk selection on the canvas. There is no license, account or network call beyond loading the UI font.

Install it from the [Figma Community](https://www.figma.com/community/plugin/1588257751230049347) or run it from source (below). If it saves you time, the "Support" button in the plugin header goes to [ko-fi.com/alfremiranda](https://ko-fi.com/alfremiranda).

See [CLAUDE.md](CLAUDE.md) for the architecture, message protocol, domain logic and known issues.

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

The "Support" button's target is `SUPPORT_URL` near the top of the `<script>` in `ui.html`; set it to an empty string to hide the button.

### Tests

- `npm test` runs `tests/backend.test.js` and `tests/cache.test.js`, which load the compiled `code.js` into a Node `vm` with a fake `figma` object. Run `npm run build` first.
- `tests/ui-harness.html` drives `ui.html` in an iframe with a fake backend. Serve the repo root (`python3 -m http.server 8790`), open `http://localhost:8790/tests/ui-harness.html` in a browser tab, then run `await load(); await T.all();` in the console and inspect `results`. The harness stubs `requestAnimationFrame`, CSS motion and the export download so it runs the same in a hidden tab and never saves a file.

## Notes

- `documentAccess` is `dynamic-page`, so only the async Plugin APIs work (`getNodeByIdAsync`, `setFillStyleIdAsync`, ...); the sync variants throw.
- Network access is limited to Google Fonts (`manifest.json`, `networkAccess.allowedDomains`).

## License

MIT, see [LICENSE](LICENSE).
