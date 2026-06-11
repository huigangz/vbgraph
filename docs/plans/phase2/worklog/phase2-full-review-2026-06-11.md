# Phase 2 — Full plan-conformance review (2026-06-11)

**Status**: complete — 4 findings, all fixed and tested.
**Date**: 2026-06-11
**Scope**: whole-repo review of the three landed phase-2 commits (`6307968` P0, `3a763e9` P1, `0b724da` P2) against their plan documents:

- [codegraph-scip-ingestion.md](../codegraph-scip-ingestion.md) (P0 + P2 outline)
- [codegraph-framework-synthesize-augment.md](../codegraph-framework-synthesize-augment.md) (P1, incl. review rounds R1–R6)
- [P2.0-design.md](../P2.0-design.md) (P2 Decisions 1–7, incl. review rounds 1–5)

Unlike rounds 1–7 (which reviewed plans/patches in flight), this round audited the **final implementation** against every load-bearing invariant in the plans.

## Verdict

The implementation is a faithful realization of all three plans. No correctness bugs found. Every traced invariant holds:

- **P0**: schema v5 columns/tables/indexes; `upsertGraphEdge` as the single edge-write path (only one `INSERT INTO edges` in `src/`, legacy `insertEdge` delegates); six-stage persister (with the documented STAGE-D deviation — internal nodes inserted in Pass 1 for FK integrity); per-endpoint external-node GC; `--scip` / `--scip-auto` / `--no-scip` / `--languages` / `parity` CLI surface; versioned failure ledger; `.scip-auto.lock`; vbnet WASM + `.sha256` (hash + pinned upstream `cfca210`); `SELF_HOSTED_WASM_LANGUAGES`; `validateConfig` deriving from `LANGUAGES`.
- **P1**: `Phase3Orchestrator` in its final R5/R6-corrected shape (STAGE 0 purge first, view1 after purge, single transaction, single-row writes, per-resolver isolation, all pre-flights); unconditional Phase 3 on `indexAll` / `indexFiles` / `sync` with fresh post-extraction detection; `node_tags`; `GraphView` per-instance caches; ship-gate-9 status counts via `getEdgesByContributingProvenance`; spring split + temporal resolvers; PR-16 cleanup complete; `tag` parameter documented in all three instruction surfaces.
  - One **improvement over plan**: STAGE 0's contribution strip is row-by-row TypeScript (`stripFrameworkContributionsFromEdges`) instead of the planned inline SQL CASE, and correctly preserves merged edges where `framework:*` was primary over a surviving `heuristic` contributor — a case the plan's SQL (`WHERE provenance NOT LIKE 'framework:%'`) would have deleted. Rationale documented in the method comment; the plan's drift-defense test #24 is moot under this shape.
- **P2**: all seven Decisions implemented as specified — `SCIP_FILE_PROVENANCES`, `deleteFileTreeSitterRows` (`LIKE 'tree-sitter%'`), source-only edge staleness, explicit `stale=0` on inserts, `freshPredicate(alias?)` + `visibleNodeIdPredicate()` across the query inventory, `stale?: boolean` derivation, three-surface stats model, branch-switch bulk path (`visible=1`), inline cache invalidation, narrow `countShadowRowsForFile` assertion, `*IncludingDanglingEndpoints` siblings, `p21-no-bypass` CI guard, `scip-refresh` with the three log-stream failure timings hardened, cron templates. `supersedeTreeSitter` predicate broadened per P2.3.1.

### Test baseline

`npm test`: 802 passed, 14 failed, 29 skipped. All 14 failures are **pre-existing / environmental**, verified by running the failing suites against the initial commit (`3add790`) in a throwaway worktree — `foundation` (wasm VACUUM), `resolution` ×2 + `watcher` (wasm double-close in cleanup) fail identically there. `installer-targets` ×8 read the real `%APPDATA%\opencode` config instead of the mocked temp home (Windows test-isolation gap in a module phase 2 never touched); `mcp-initialize` ×2 are Windows EPERM on temp-dir cleanup. **Zero phase-2 regressions.**

## Findings + resolutions

| # | Severity | Finding | Resolution |
|---|---|---|---|
| F1 | Medium | **`deriveConfidenceTier` (P0.4d) was dead code** — defined in `src/types.ts` and unit-tested, but none of the three planned usage sites (MCP serialization boundary, `codegraph status` per-tier counts, `codegraph_context` detail-level handling) was wired | Wired the two real sites (see below). The third site is **moot**: the plan's "`codegraph_context` when `detail_level !== 'verbose'`" refers to a parameter that was never built, and context output carries no numeric confidence to omit |
| F2 | Low | **Literal NUL bytes in `persister.ts`** — `descriptorPathKey` embedded two raw `\0` chars in a template literal as join separators. Compiles fine, but grep/ripgrep/git treated the whole file as binary: code search silently missed it, diffs degraded | Replaced with `\x00` escape sequences (identical runtime value; same convention as `graph-view.ts` cache keys) |
| F3 | Low | **Stale doc comment** at `tree-sitter.ts:2504` still described the `frameworkNames` parameter that PR-16 removed from `extractFromSource` — the "stale text outlives the design decision" pattern the P1 plan's own R5/R6 appendices warn about | Comment rewritten to point at the Phase 3 pass (`src/resolution/phase3.ts`) |
| F4 | Trivial | **Stray empty file `x`** at the repo root (untracked, 0 bytes — shell-redirect accident) | Deleted |

## P0.4d wiring (F1 fix detail)

**MCP boundary** — `codegraph_callers` / `codegraph_callees` previously discarded the edge half of `getCallers()`' `{node, edge}` pairs. They now keep it, and each result line ends with the connecting edge's tier:

```
- handleRequest (method) - src/api/router.ts:42 [compiler]
- legacyDispatch (function) - src/old/dispatch.ts:7 [inferred]
```

Implemented as a new `formatCallList` in `src/mcp/tools.ts`; the now-unused `formatNodeList` was removed. Tier values: `[compiler]` (SCIP) > `[scope-resolved]` > `[syntactic]` (tree-sitter) > `[inferred]` (heuristic / framework convention).

**`codegraph status`** — new line under Index Statistics plus an `edgesByConfidenceTier` field in `--json`:

```
Edge confidence: compiler: 12,345; syntactic: 3,456; scope-resolved: 210
```

Plumbing:

- `QueryBuilder.getEdgeCountsByProvenance()` — groups edges by primary `provenance` under the default freshness + endpoint-visibility contract, so the tier counts **sum to `getStats().edgeCount`**. Because it composes `freshPredicate()` + `visibleNodeIdPredicate()`, it passes the `p21-no-bypass` CI guard with **no allowlist entry**.
- `CodeGraph.getEdgeConfidenceTierCounts(): Record<ConfidenceTier, number>` — maps provenance → tier via `deriveConfidenceTier`; NULL provenance (legacy pre-v5 rows) → `ambiguous`.

**House rule** — all three agent-instruction surfaces updated to document the tier annotation: `src/mcp/server-instructions.ts`, `src/installer/instructions-template.ts`, `.cursor/rules/codegraph.mdc`.

## Files changed

| File | Change |
|---|---|
| `src/extraction/scip/persister.ts` | NUL bytes → `\x00` escapes in `descriptorPathKey` (F2) |
| `src/extraction/tree-sitter.ts` | `extractFromSource` doc comment updated (F3) |
| `x` | deleted (F4) |
| `src/db/queries.ts` | + `getEdgeCountsByProvenance()` |
| `src/index.ts` | + `getEdgeConfidenceTierCounts()`; imports `ConfidenceTier` / `GraphProvenance` / `deriveConfidenceTier` |
| `src/bin/codegraph.ts` | status: `Edge confidence:` line + `edgesByConfidenceTier` JSON field |
| `src/mcp/tools.ts` | callers/callees keep `{node, edge}`; + `formatCallList` with `[tier]` suffix; − dead `formatNodeList` |
| `src/mcp/server-instructions.ts` | tier annotation documented |
| `src/installer/instructions-template.ts` | tier annotation documented |
| `.cursor/rules/codegraph.mdc` | tier annotation documented |

## Verification

- `npm run build` clean.
- Targeted suites green: `p24-status`, `p21-no-bypass`, `p1-mcp-tag-filter`, `security`, `p04-edge-infra` (70/70).
- Full suite after changes: **802 passed / 14 failed** — byte-identical failure set to the pre-change baseline (all pre-existing/environmental, see above). Zero new failures.
- Live smoke on a scratch project (wasm backend): `getEdgeConfidenceTierCounts()` → `{syntactic: 2, scope-resolved: 1, …}` reconciling exactly with `getStats().edgeCount = 3`; the scope-resolved edge confirms the P0.5b resolver contributes in practice.

## Deferred / follow-ups

1. **CHANGELOG entry** for the tier annotation (`codegraph_callers`/`codegraph_callees` output) and the status `Edge confidence` line + `edgesByConfidenceTier` JSON field — belongs in the next version block when it's cut (0.9.0 is already published; per CLAUDE.md the entry is written at release time).
2. **`installer-targets.test.ts` Windows isolation gap** (pre-existing, not phase 2): the opencode target resolves the real `%APPDATA%\opencode` config instead of the mocked temp home, so 8 contract tests fail on any Windows machine with opencode installed. Worth fixing separately — this is the 0.7.x contract suite the house rules lean on.
3. **wasm-backend test flakes** (pre-existing): `cg.optimize()` VACUUM failure and the double-`close()` `SQLite3Error: Database already closed` in `foundation` / `resolution` / `watcher` cleanup paths reproduce on the initial commit; they are wasm-adapter lifecycle issues, not phase-2 code.

## Effort

- Review (3 plan docs ≈ 4.6k lines + implementation audit + baseline bisect): ~2.5h AI-paced.
- Fixes + wiring + verification: ~1h.
