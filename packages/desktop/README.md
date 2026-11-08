# @clash-tester/desktop

Electron desktop app for Clash Tester (electron-vite + React + Tailwind).
Three views: **Files** (drop IFC files, set disciplines), **Rules**
(presets, self checks, custom rules, engine options) and **Results**
(groups, per-rule counts, clashes, output files). All clash logic comes
from `@clash-tester/core`.

```bash
npm run dev
```

It also runs an MCP server for the open app (`clash-tester-ui`, see
[`docs/MCP.md`](../../docs/MCP.md)). Packaged installers are not
built yet.
