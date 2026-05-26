# P2 — Post-ship review round 1 (2026-05-25)

**Status**: complete — 5 findings, all fixed and tested.
**Date**: 2026-05-25
**Source review**: 5 findings (3 High, 2 Medium) against P2 ship state at the end of 2026-05-24.

## Findings + resolutions

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **High** | `scip-refresh` deletes empty-document fallback graphs and does not recreate them. `refreshScip` invoked `ingestScipFile` without `extractFallback`; `supersedeTreeSitter` (P2.3.1's wider predicate) wiped fallback rows; STAGE E's `maybeEmptyFallback` skipped recreation because no callback was provided. | Extracted the existing `buildEmptyDocFallback` logic from `runScipPrePass` into a shared private method on `CodeGraph`. `refreshScip` pre-scans the `.scip` for covered languages, builds the fallback callback, and passes it to `ingestScipFile`. |
| 2 | **High** | `refreshScip` performs raw node DELETE / INSERT (STAGE B + STAGE E) but does NOT invalidate the `QueryBuilder.nodeCache`. A `getNodeById` call that warmed the cache before refresh could be served the pre-refresh cached value after refresh. | Added `this.queries.invalidatePhase3Caches()` call immediately after `ingestScipFile` returns successfully (before the post-ingest assertion runs). |
| 3 | **High** | `refreshScip` stopped after sidecar reporting; did NOT rerun resolution or Phase 3. SCIP node replacement leaves dependent derived rows (framework tags, scope-resolved edges) inconsistent. Once fallback recreation was restored (fix #1), the new unresolved refs would also stay unprocessed. | After the post-ingest assertion succeeds, refresh now runs `resolveReferencesBatched()` (when unresolved refs exist) and `new Phase3Orchestrator(...).run()` — same shape as `indexAll` / `sync` post-extraction. Errors from either are appended to `result.error` as a semicolon-joined string (without demoting `phase` to `'ingest-failed'` — the SCIP data is fresh; only derived state failed). |
| 4 | **Medium** | Decision 7's required `*IncludingDanglingEndpoints` query siblings + status dangling-edge reporting were deferred in P2.1.6 / P2.6 worklogs, contradicting design scope. | Added three sibling methods on `QueryBuilder`: `getOutgoingEdgesIncludingDanglingEndpoints`, `getIncomingEdgesIncludingDanglingEndpoints`, `findEdgesBetweenNodesIncludingDanglingEndpoints`. They bypass `visibleNodeIdPredicate` but still apply `freshPredicate`. Added `countDanglingEdgesAgainstHiddenStale()` for the status diagnostic. Exposed on `CodeGraph`. Status command renders a new "Dangling against stale" line when count > 0 + a `danglingEdges` field in JSON output. CI guard allowlisted with rationale. |
| 5 | **Medium** | Task Scheduler template declared `encoding="UTF-16"` while stored as UTF-8 bytes. Direct import would fail on older `schtasks` versions before the user reached the documented conversion step. | Changed XML declaration to `encoding="UTF-8"`. Header now explains the optional UTF-16 conversion path (PowerShell `Set-Content -Encoding Unicode`) and what to change in the converted file's declaration. |

## Files changed

| File | Change |
|---|---|
| `src/index.ts` | Extracted `buildEmptyDocFallback` private method. `refreshScip` pre-scans `.scip` for languages, builds fallback, passes through to `ingestScipFile`. Added cache invalidation post-ingest. Added resolution + Phase 3 rerun after assertion. New public method `countDanglingEdgesAgainstHiddenStale`. |
| `src/db/queries.ts` | Three new `*IncludingDanglingEndpoints` sibling methods. New `countDanglingEdgesAgainstHiddenStale` helper. |
| `src/bin/codegraph.ts` | Status command reads `cg.countDanglingEdgesAgainstHiddenStale()`. New "Dangling against stale" text line; new `danglingEdges` JSON field. Staleness section now also renders if `danglingEdges > 0` (was: only when stale files > 0). |
| `docs/scheduling/task-scheduler.xml.template` | Encoding declaration `UTF-16` → `UTF-8`. Header rewritten with UTF-16 conversion notes. |
| `__tests__/p21-no-bypass.test.ts` | Three allowlist entries for the new sibling SQL + one for the count. |
| `__tests__/p2-review-fixes.test.ts` (NEW) | 8 tests: 6 for fix #4 (siblings + count), 1 end-to-end for #1+#2+#3, 1 for #5. |

## Tests

```
$ npx vitest run __tests__/p2-review-fixes.test.ts
Test Files  1 passed (1)
     Tests  8 passed (8)
```

End-to-end test for fixes #1/#2/#3 runs the real `cg.refreshScip()` codepath with a no-op spawn (`node -e ""`) and a pre-staged synthetic `.scip` fixture. Validates:
- Empty-doc fallback row recreated (fix #1).
- Pre-warmed cache entry returns null after refresh (fix #2).
- Phase 3 + resolution ran without exception, `result.error` is null (fix #3).

## Full regression

All P0/P1/P2 suites green after the fixes:

| Suite | Tests |
|---|---|
| `p2-review-fixes` (NEW) | 8/8 |
| P2 suites total (incl. review-fixes, perf, semantic, status, scip-refresh, stale-sync, no-bypass) | **67/67** |
| P0/P1 schema + scip + phase3 (p09, p1-node-tags, scip-ingester, p08, p1-phase3-orchestrator) | **58/58** |
| P1 frameworks + graph (frameworks, frameworks-integration, p1-spring-di, graph) | **79/79** |

**Total: 204 P2-relevant tests passing**, unchanged from P2.6 baseline plus 8 new.

Pre-existing failures (NOT caused by these fixes) unchanged: foundation VACUUM, name-matcher kind-bias WIPs.

## Behavior changes (CHANGELOG-worthy)

These should appear in the 0.9.0 CHANGELOG as additions to the existing block (the user can fold them in before publishing):

- **`codegraph scip-refresh` now reruns resolution + Phase 3 after re-ingest**, so framework tags and resolved-reference edges stay consistent with the refreshed SCIP graph. Previously refresh only re-ingested SCIP rows and left derived data orphaned.
- **`codegraph scip-refresh` now recreates empty-document fallback rows** for SCIP documents with zero occurrences. Previously these were wiped by `supersedeTreeSitter` without recreation.
- **`CodeGraph.countDanglingEdgesAgainstHiddenStale()`** — new public method counting edges hidden ONLY because at least one endpoint is hidden-stale.
- **`QueryBuilder.getOutgoingEdgesIncludingDanglingEndpoints`** + two siblings — diagnostic alternatives that bypass endpoint visibility but still respect edge-row freshness.
- **`codegraph status` now reports dangling-against-stale edge count** when the visibility filter is actively suppressing edges. JSON output includes `danglingEdges: number`.

## Risk callouts

- **Refresh-time Phase 3 + resolution add latency** to `scip-refresh` proportional to graph size. On a 200k-node project, expect +2-10s per refresh. Acceptable for a daily-cron operation; user-visible via `result.durationMs`.
- **Phase 3 / resolution errors do NOT fail the refresh** (`phase` stays `'ok'`, error appended to `result.error`). Rationale: the SCIP data is correct after STAGE B/E; only derived state may be partially broken. The error string surfaces the issue without rolling back the SCIP work. If a stricter contract is wanted, escalate `phase` to `'ingest-failed'` in a follow-up.
- **`*IncludingDanglingEndpoints` siblings have no `kinds` filter parameter**. Default queries do. Added the bare-minimum needed for status / parity diagnostics. Adding `kinds` is one parameter when a real caller needs it.
- **Task Scheduler `encoding="UTF-8"` may still fail on Windows Server 2012 or older**. Documented conversion path in the header.

## Effort

- Estimated (this round): not budgeted in P2 plan — review-driven follow-up.
- Actual (AI-paced): ~2h including the audit + 5 fixes + 8 tests + worklog.
