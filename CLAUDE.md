# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

vbgraph is a local-first code intelligence library + CLI + MCP server, with first-class VB.NET and Delphi support. It parses any supported codebase with tree-sitter (plus optional SCIP compiler-grade indexes), stores symbols/edges/files in SQLite (FTS5), and exposes a knowledge graph to AI agents (Claude Code, Cursor, Codex CLI, opencode) over MCP. Per-project data lives in `.vbgraph/`. Extraction is deterministic — derived from AST, not LLM-summarized.

Distributed as `vbgraph` on npm; same binary serves as installer, indexer, and MCP server.

**Provenance**: fork of [codegraph](https://github.com/colbymchenry/codegraph) by Colby Mchenry (MIT; the `upstream` git remote). Full upstream history is retained in this repo — regression tests named after upstream PRs/incidents (`pr19-improvements.test.ts`, `frameworks-integration.test.ts`, the `p*`-prefixed phase tests) anchor to that history; don't rename them. Upstream-era plans and worklogs under `docs/plans/` are historical records — leave their codegraph references as-is.

## Build, Test, Run

```bash
npm run build           # tsc + copy schema.sql and *.wasm into dist/; chmods dist/bin/vbgraph.js
npm run dev             # tsc --watch
npm run clean           # rm -rf dist

npm test                # vitest run (all)
npm run test:watch
npm run test:eval       # only __tests__/evaluation/
npm run eval            # build then run __tests__/evaluation/runner.ts via tsx

npm run cli             # build then run the local dist binary

# Single test file / pattern
npx vitest run __tests__/installer-targets.test.ts
npx vitest run __tests__/extraction.test.ts -t "TypeScript"
```

`copy-assets` (called from `build`) copies `src/db/schema.sql`, all `src/extraction/wasm/*.wasm`, and `src/extraction/scip/scip.proto` into `dist/`. **Any new SQL, grammar wasm, or proto must be copied or it won't ship.**

Node engines: `>=18.0.0 <25.0.0`. There is a hard exit on Node 25.x (see `src/bin/node-version-check.ts`).

Known test-run quirk on Windows: after all tests pass, tinypool may log one "Worker exited unexpectedly" unhandled error, which makes `npm test` exit 1 with 0 failures. Judge runs by the pass/fail counts, not the exit code.

## Architecture

### Layered pipeline

```
files → ExtractionOrchestrator (tree-sitter) → DB (nodes/edges/files)
              ↓                    ↑ SCIP ingestion (compiler-grade, optional)
       ReferenceResolver (imports, name-matching, framework patterns)
              ↓
       GraphQueryManager / GraphTraverser (callers, callees, impact)
              ↓
       ContextBuilder (markdown/JSON for AI consumption)
```

The public API surface is `src/index.ts` — the `VBGraph` class wires all the layers and re-exports types. Library users only touch this file; the MCP server and CLI also drive it.

### Module layout

- `src/index.ts` — `VBGraph` class: `init`/`open`/`close`, `indexAll`, `sync`, `searchNodes`, `getCallers`/`getCallees`, `getImpactRadius`, `buildContext`, `watch`/`unwatch`, `refreshScip`.
- `src/db/` — `DatabaseConnection`, `QueryBuilder` (prepared statements), `schema.sql`, `migrations.ts` (bump `CURRENT_SCHEMA_VERSION` and the stale-guard in `pr19-improvements.test.ts` together). Backed by `better-sqlite3` (native) when available, transparently falls back to `node-sqlite3-wasm`. `vbgraph status` surfaces which backend is live; wasm is the slow path. Note: some tests are `skipIf(!HAS_SQLITE)` — they only run where the native module built.
- `src/extraction/` — `ExtractionOrchestrator`, tree-sitter wrappers, per-language extractors under `languages/` (one file per language: `vbnet.ts`, `pascal.ts`, …), standalone extractors for non-tree-sitter formats (`svelte-extractor.ts`, `vue-extractor.ts`, `liquid-extractor.ts`, `dfm-extractor.ts` for Delphi forms), and `scip/` (SCIP ingestion: auto-detect indexers, spawn, ingest, parity checks). `parse-worker.ts` runs heavy parsing off the main thread. Self-hosted grammar wasms (no `tree-sitter-wasms` upstream entry): `pascal`, `scala`, `vbnet` — see `SELF_HOSTED_WASM_LANGUAGES` in `grammars.ts`.
- `src/resolution/` — `ReferenceResolver` orchestrates `import-resolver.ts` (with `path-aliases.ts`), `name-matcher.ts`, `scope-index.ts` (P0.5b scope pass), and `frameworks/`. Frameworks emit `route` nodes and `references` edges.
- `src/graph/` — `GraphTraverser` (BFS/DFS, impact radius, path finding) and `GraphQueryManager`.
- `src/context/` — `ContextBuilder` + formatter for markdown/JSON output.
- `src/search/` — full-text query parser and helpers for FTS5.
- `src/sync/` — `FileWatcher` (native FSEvents/inotify/RDCW) with debounce + filter, and git-hook helpers.
- `src/mcp/` — MCP server (`MCPServer`, `tools.ts`, `transport.ts`). `server-instructions.ts` is what the server returns in the MCP `initialize` response — keep it in sync with the user-facing tool guidance.
- `src/installer/` — see below.
- `src/bin/vbgraph.ts` — CLI (commander). Subcommands: `install`, `init`, `uninit`, `index` (`--scip`, `--scip-auto`), `sync`, `scip-refresh`, `status`, `query`, `files`, `context`, `affected`, `parity`, `serve --mcp`.
- `src/ui/` — terminal UI (shimmer progress, worker).

### NodeKind / EdgeKind

Defined in `src/types.ts`. Both extractors and resolvers must use these exact strings.

- **NodeKind**: `file`, `module`, `class`, `struct`, `interface`, `trait`, `protocol`, `function`, `method`, `property`, `field`, `variable`, `constant`, `enum`, `enum_member`, `type_alias`, `namespace`, `parameter`, `import`, `export`, `route`, `component`.
- **EdgeKind**: `contains`, `calls`, `imports`, `exports`, `extends`, `implements`, `references`, `type_of`, `returns`, `instantiates`, `overrides`, `decorates`.

### Multi-agent installer

`src/installer/` is the entry point for `vbgraph install` (and the bare `vbgraph`/`npx vbgraph` invocation). Architecture:

- `targets/registry.ts` lists every supported agent.
- `targets/types.ts` defines the `AgentTarget` interface — adding a 5th agent (Continue, Zed, Windsurf…) is **one new file in `targets/` + one entry in `registry.ts`**. Each target owns its config-file location, MCP-server JSON/TOML/JSONC writing, and instructions-file path.
- Current targets: `claude.ts`, `cursor.ts`, `codex.ts`, `opencode.ts`.
- `targets/toml.ts` is a hand-rolled TOML serializer scoped to `[mcp_servers.vbgraph]` (used by Codex). Sibling tables and `[[array_of_tables]]` are preserved verbatim. No new dependency.
- opencode reads `opencode.jsonc` by default; the installer prefers existing `.jsonc`, falls back to `.json`, and creates `.jsonc` for greenfield installs. Edits are surgical via `jsonc-parser` so user comments and formatting survive install/re-install/uninstall round-trips.
- `instructions-template.ts` is the agent-agnostic instructions file written to each target (e.g. `CLAUDE.md`, `.cursor/rules/vbgraph.mdc`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`). It explicitly says "trust vbgraph results, don't re-verify with grep".
- `claude-md-template.ts` is the legacy Claude-only template, retained for compatibility paths.
- Installer sections written into user files are delimited by `VBGRAPH_SECTION_START/END` markers. **Machines with an old codegraph-era install must run the old binary's uninstall first** — this installer does not recognize the old `CODEGRAPH_SECTION_*` markers or MCP entries.
- All installer changes need matching coverage in `__tests__/installer-targets.test.ts` — parameterized contract tests covering install idempotency, sibling preservation, uninstall reverses install, byte-equal re-runs returning `unchanged`, and partial-state recovery for Codex.

### Cursor MCP working-directory quirk

Cursor launches MCP subprocesses with the wrong cwd and doesn't pass `rootUri` in `initialize`. The installer injects `--path` into Cursor's MCP args — absolute path for local installs, `${workspaceFolder}` for global installs. If you touch Cursor wiring, preserve this.

### MCP server instructions

`src/mcp/server-instructions.ts` is sent back to the agent in the MCP `initialize` response. This is the *first* thing every agent sees about how to use the tools — treat it as the authoritative tool guidance and keep it in sync with `instructions-template.ts` and `.cursor/rules/vbgraph.mdc`.

## Tests

Tests live in `__tests__/` and mirror the module they cover. Notable ones beyond the obvious:

- `installer-targets.test.ts` — parameterized contract suite across all 4 agent targets (see installer notes above).
- `evaluation/` — `runner.ts` + `test-cases.ts` exercise vbgraph against synthetic projects and score the results; run via `npm run eval` (builds first). Not part of `npm test`.
- `sqlite-backend.test.ts` — covers native + wasm backend selection and fallback.
- `pr19-improvements.test.ts`, `frameworks-integration.test.ts`, `p*-*.test.ts` — regression coverage anchored to upstream codegraph history and phase-2 work; don't rename these.

Tests create temp dirs with `fs.mkdtempSync` and clean up in `afterEach`. They write real files and exercise real SQLite — there is no DB mocking. **Data boundary: test fixtures are synthetic or from public open-source projects only — never company or private code.**

## Documentation layout

- `docs/plans/<topic>/` — one directory per plan/initiative; the plan document lives there and its execution logs go in a `worklog/` subdirectory. Do not scatter plan or log markdown at the repo root.
- `docs/plans/rebrand/` — the codegraph→vbgraph migration plan and its baseline records.
- `docs/reference/` — long-lived reference docs (architecture reference, Delphi support notes, search quality loop).
- `docs/plans/phase2/` and other upstream-era plans are historical; read-only context.

## Releases

Released to public npm as `vbgraph` and mirrored as GitHub Releases on this repo. `CHANGELOG.md` is the source of truth; GitHub Release notes are extracted from it. The upstream-era changelog is archived as `CHANGELOG-upstream.md`.

### Writing changelog entries

1. Add a new `## [X.Y.Z] - YYYY-MM-DD` block at the **top** of `CHANGELOG.md` (under the intro, above the previous version).
2. Group under `### Added`, `### Changed`, `### Fixed`, `### Removed`, `### Deprecated`, `### Security` — omit empty sections.
3. Write from the **user's perspective**, not the implementation's.
4. Add the link reference at the bottom: `[X.Y.Z]: https://github.com/huigangz/vbgraph/releases/tag/vX.Y.Z`.

### Release flow (the user runs these)

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: X.Y.Z (<one-line summary>)"
git push
npm publish            # rc pilots: npm publish --tag next
./scripts/release.sh   # idempotent: tags vX.Y.Z, pushes, creates GitHub Release with notes from CHANGELOG.md
```

**Do not run `npm publish`, `git push`, `git tag`, or `./scripts/release.sh` yourself** — these are publish actions on shared state. Write the file, hand the user the commands. Additional gate: nothing goes public (repo visibility, npm publish) until the approval checklist in `docs/plans/rebrand/PLAN-clean-fork-rebrand.md` §Phase 1 is satisfied.

## House rules

- Any change to `src/installer/` (especially `targets/`) needs corresponding test coverage and a CHANGELOG entry — installer regressions break every new install silently.
- When changing what the MCP tools do or how agents should use them, update **all three** of `src/mcp/server-instructions.ts`, `src/installer/instructions-template.ts`, and `.cursor/rules/vbgraph.mdc` — they're written to different places but say the same thing.
- vbgraph provides **code context**, not product requirements. For new features, ask the user about UX, edge cases, and acceptance criteria — the graph won't tell you.
- VB.NET and Delphi are the flagship languages: changes to their extractors (`languages/vbnet.ts`, `languages/pascal.ts`, `dfm-extractor.ts`) or the scip-dotnet path get extra scrutiny and must keep `__tests__/fixtures/vbnet-sample` parity green.
