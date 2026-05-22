# P0 — Review Round 1 — Work Log

**Status:** Done — all 6 review findings resolved.
**Date:** 2026-05-20

A close review of the completed P0 work surfaced 6 findings (2 High, 3 Medium, 1 Low).
This log records the resolution of each.

## F1 (High) — Multi-`.scip` ingestion was not atomic across one `indexAll`

**Finding:** `runScipPrePass` ingested explicit `--scip` paths one at a time; the persister
mutates per-`.scip` in STAGE B. With `--scip a.scip --scip b.scip` overlapping, `a.scip`
could already be committed before `b.scip`'s STAGE A threw — violating ship gate 5's "DB
completely unchanged". The same structure also missed explicit-over-auto precedence:
auto indexers were spawned, then a conflict was fatal instead of skipping the auto one.

**Fix** — `src/index.ts` `runScipPrePass`:

- A **batch pre-scan** now runs before *any* ingestion. It streams every explicit `.scip`
  (`iterateScipDocuments`) building a coverage map; streaming also throws on a corrupt
  file. A `MultiIndexConflictError` (vs another explicit path or vs an existing
  `scip_documents` row owned by a different index) or a corrupt explicit path therefore
  aborts **before any STAGE B mutation** — DB byte-for-byte unchanged (gates 5 + 12a).
- **Explicit-over-auto precedence:** each auto-spawned `.scip` is pre-scanned; if its
  files are already covered by an explicit path it is **skipped** (logged, not a failure),
  not treated as a fatal conflict.
- Auto-path ingestion failures (including a late conflict) degrade to the failure ledger.

**Test:** new case in `p06-dual-backend.test.ts` — two overlapping explicit `--scip` paths
-> `success:false` with **0 nodes / 0 edges** (neither index committed).

## F2 (High) — VB.NET Tier 0 produced no relationship edges

**Finding:** the P0 ship gate requires file-local `Inherits` / `Implements` / call edges;
the VB suite skipped inheritance, and probing showed file-local **calls** were missing
too — Tier-0 VB emitted only symbol nodes + `contains`.

**Fix** — two parts, both options the review accepted:

- *Implemented — file-local calls.* Root cause: VB `method_declaration` has no `body`
  field, and `extractMethod` skips a body-less method (unlike `extractClass`, which falls
  back to the node). Added `resolveBody: (node) => node` to `vbnetExtractor`, so a
  method's statements — and the `invocation` calls in them — are walked.
  `tier0-vbnet.test.ts` now asserts `Sub Main` -> `Helper`.
- *Ship gate rewritten — Inherits/Implements.* The pinned community grammar (`cfca210`)
  misparses `Inherits`/`Implements`; no available VB tree-sitter grammar parses them
  reliably. Ship gate 1 in `codegraph-scip-ingestion.md` is rewritten to scope VB
  inheritance edges as **SCIP-only (Tier 1)**. `extractInheritance` stays wired for an
  `inherits_clause` so a future grammar fix needs no code change. `worklog/P0.6b.md`
  updated.

## F3 (Medium) — `cg.optimize()` failure attributed to the open-time cleanup

**Finding:** suspected that the P0.4b open-time SCIP cleanup leaves a prepared statement
open on the WASM backend, breaking `VACUUM`.

**Resolution — verified pre-existing, no change.** `git stash`-ing **all** P0 changes and
running `foundation.test.ts -t optimize` on the clean checkout reproduces the identical
`cannot VACUUM - SQL statements in progress` error. The `optimize` test also uses
`initSync`, which never runs `cleanupIncompleteIngestions`. It is the pre-existing
WASM-SQLite VACUUM quirk (node-sqlite3-wasm keeps every prepared statement un-finalized
until `close()`), not introduced by P0.

## F4 (Medium) — Tier 0 install hints implemented but never surfaced

**Finding:** `formatUninstalledIndexerHints` existed but the CLI never called it (ship
gate 3).

**Fix** — `src/bin/codegraph.ts`: new `printScipUpgradeHints` helper, called after a
successful **Tier 0** index (no `--scip` / `--scip-auto` / `--no-scip`). It detects
installed indexers, narrows hints to the repo's languages, and prints a clack note.
Verified end-to-end: `codegraph index` on a `.cs` repo prints *"Compiler-grade precision
available — csharp/vbnet: install scip-dotnet…"*. (`formatUninstalledIndexerHints`'s
second parameter was widened to `ReadonlySet<string>` so the CLI need not import
`Language`.)

## F5 (Medium) — New config fields dropped during merge

**Finding:** `CodeGraphConfig` gained `scipSources` / `emptyFallbackThresholdBytes` /
`scipAuto` / `disabledScipIndexers`, but `mergeConfig` only carried the older fields, so
SCIP defaults in `.codegraph/config.json` were silently lost on load.

**Fix** — `src/config.ts` `mergeConfig` now carries all four new fields through.

## F6 (Low) — `validateEdgeLineColumn` checked only `line`

**Finding:** the three-tier invariant says positioned `calls` / direct `references`
require line **and** column; the validator checked only `line`.

**Fix** — `src/types.ts`: positioned kinds now require **both** line and column
(`edgeHasLineAndColumn`); forbidden kinds reject **either** (`edgeHasAnyPosition`, which
`coerceEdgePosition` also uses). `p04-edge-infra.test.ts` updated — a `calls` edge with a
line but no column is now correctly a violation.

## Verification

- `npx tsc --noEmit` — clean. `npm run build` — succeeds.
- 16 test files run targeted (`--pool=forks`, single-fork): **151 passed, 2 skipped,
  1 failed**. The single failure is `foundation > optimize` — the pre-existing WASM
  VACUUM quirk confirmed under F3, not a P0 regression.
- The broader `npm test` red (installer / MCP / watcher failures, worker OOMs) is outside
  the SCIP surface — P0 changes touch none of those modules — and is the known
  WASM-SQLite environment issue.
