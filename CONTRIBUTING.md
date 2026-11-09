# Contributing

Thanks for your interest in Clash Tester. This page covers how to report a
problem, how to build and test the project, and what a good pull request
looks like.

This project is maintained on a best-effort basis. We welcome issues and
PRs, but cannot guarantee response times.

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Security problems: please don't open
a public issue — see [SECURITY.md](SECURITY.md).

## Reporting a bug or asking for a feature

Use [GitHub Issues](https://github.com/glasshouse-sprouts/sprout-clash-tester/issues) (the
templates ask for the details below). For a bug, please include:

- what you ran (CLI command, desktop steps or MCP tool call) and the
  `.clashproj` if you can share it;
- what you expected and what happened — the CLI summary or the warnings
  are often enough;
- versions: Clash Tester commit, OS, Node, Rust;
- if the problem is in the geometry, the smallest IFC that shows it. Only
  share models you are allowed to share.

## Build from source

You need Rust 1.89 or newer, Node.js 20.19 or newer (22 recommended), and
git.

```bash
git clone https://github.com/glasshouse-sprouts/sprout-clash-tester.git
cd sprout-clash-tester
cd engine && cargo build --release && cd ..
npm install
npm run build
```

Then try the example:
`node packages/cli/dist/index.js run examples/tiny-project/sample.clashproj`.
The desktop app runs with `npm run dev` in `packages/desktop`.

`npm run build` builds the TypeScript packages the CLI and the MCP server
need (clash-core, cli, mcp-server). **Stale build?** If the CLI or tests
fail with "Cannot find module …/dist/index.js" (typically after copying
or moving the repository), run `npm run clean` and then `npm run build`:
`tsc -b` trusts its `*.tsbuildinfo` files and skips a rebuild otherwise.

## Tests and checks

```bash
cd engine && cargo test --release && cd ..
CLASH_BINARY="$PWD/engine/target/release/clash" npm test
npm run typecheck
npm run lint
```

- `cargo test` covers the engine; the test models are in
  `engine/tests/models/`.
- `npm test` runs the Vitest suites of all packages. With `CLASH_BINARY`
  set it also runs the end-to-end tests against the real engine; without
  it those are skipped.
- **Desktop payload tests** (`App.payload.test.tsx`) drive the real
  controls in a simulated browser and check what the app sends to its
  main process with Run and Save. A new control that changes the project
  needs a case there. Everything else in the UI (layout, drag and drop
  from the OS, dialogs) is checked by hand with
  [`docs/CLICK-LIST.md`](docs/CLICK-LIST.md): say in the PR what you
  clicked.
- **CI** ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all
  of the above on Linux and macOS for every push and pull request, plus a
  secret scan (gitleaks) and the licence check (`npm run licenses`).

## Pull requests

- **Small and focused.** One change per PR, ideally under ~500 lines.
  Open an issue first for anything large, so we can agree on the
  approach before you spend time on it.
- **Tests are required** for new or changed behaviour: Rust tests in
  `engine/tests/`, Vitest tests next to the TypeScript code. If a test
  isn't possible, say why in the PR.
- **All checks green:** the commands above, and CI on the pull request.
- **Docs current:** if you change behaviour, update the matching file in
  [`docs/`](docs) and add a line under _Unreleased_ in
  [`CHANGELOG.md`](CHANGELOG.md).
- **Commit messages** say what changed and why.

### Code style

- Prettier settings are in `.prettierrc.json`; keep lines to about 100
  characters.
- Keep files small: past ~300 lines, split by responsibility.
- Clear names, no duplicated logic — reuse what `clash-core` already has.
  The CLI, the desktop app and the MCP servers stay thin; shared logic
  goes in `packages/clash-core`, geometry in `engine/`.
- Don't add things "for later": build what the change needs.

### Where things are

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) has the components and the
repository layout; [`docs/HOW-IT-WORKS.md`](docs/HOW-IT-WORKS.md) explains
the detection pipeline. The engine started as a copy of Clashero's;
[`engine/VENDORED.md`](engine/VENDORED.md) says how that copy is
maintained.

## Licence

By contributing you agree that your contribution is licensed under the
Apache License, Version 2.0, the same as the project. There is no
separate contributor licence agreement.
