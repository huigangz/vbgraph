# P1 — review round 1 patch pass

## Round 1.1 — tag filter pushed into the DB (supersedes F3 fix)

The first-round F3 fix (over-fetch + post-filter, capped at 500 candidates)
still false-negatived on large repos with >500 high-ranking untagged
matches. The original regression test also didn't actually seed untagged
FTS noise — the comment claimed it did, but the seed only added tagged
nodes, so the bug wasn't actually exercised.

**Fix**: pushed the tag filter into the candidate SQL.
- New `SearchOptions.tag?: string` ([src/types.ts:565](src/types.ts#L565)).
- Plumbed through `searchNodes` → all four candidate methods
  (`searchNodesFTS`, `searchNodesLike`, `searchNodesFuzzy`,
  `searchAllByFilters`) AND the exact-name supplement step.
  Each adds `INNER JOIN node_tags ON node_tags.node_id = nodes.id
  AND node_tags.tag = ?` to the candidate query. The DB returns at
  most `limit` already-tagged rows; no candidate cap can drop a
  ranked-below match.
- MCP `handleSearch` simplified — drops the over-fetch hack and just
  passes `tag` straight through to `searchNodes`
  ([src/mcp/tools.ts:591](src/mcp/tools.ts#L591)).

**Test rewrite**: `__tests__/p1-mcp-tag-filter.test.ts` now seeds 1000
untagged nodes (5× the old fix's 500-cap, well past it) PLUS 5 tagged
nodes. Pre-fix this would have false-negatived; post-fix the 5 tagged
matches surface. Added a negative test (tag with empty intersection) and
a no-tag baseline.

**Verification**: full P1 regression (12 test files including
`p1-mcp-tag-filter`, `symbol-lookup`, `search-query-parser`) →
151 passing, 9 pre-existing skips, no regressions.

---

## Round 1 — original findings

**Status**: complete
**Date**: 2026-05-23

Four findings (2 High, 2 Medium) against the PR-16 / P1 cleanup state.
All applied inline.

## Findings

### F1 (High) — `getFrameworkEdgeContributionCounts` SQL: ambiguous `id` column

**Symptom**: `codegraph status` errors at runtime with
`ambiguous column name: id`. `json_each` exposes its own `id` column, so
`COUNT(DISTINCT id)` in the join is ambiguous. Since status calls this
unconditionally on any initialized DB, the command breaks just by
opening the project.

**Fix**: qualify with `edges.id` in
[src/db/queries.ts:1298](src/db/queries.ts#L1298).

**Test**: `__tests__/p1-pr16-cleanup.test.ts` —
"PR-16 — getFrameworkEdgeContributionCounts SQL" describe block with
three cases (empty DB, multi-framework, SCIP-primary merged edge).
Catches future regressions in the SQL shape.

## F2 (High) — STAGE 0 drops lower-rank non-framework contributors when primary is framework

**Symptom**: `framework:*` rank (60) outranks `heuristic` (50) and
`tree-sitter (scip-empty-fallback)` (40). Merged edges of the form
`[heuristic, framework:x]` had framework as primary because of the
rank. The old STAGE 0 only ran SQL 0.1 (strip+demote) when primary was
non-framework, then SQL 0.3 deleted every framework-primary edge
unconditionally — losing the load-bearing heuristic contribution.

**Fix**: rewrote `stripFrameworkContributionsFromMergedEdges` →
`stripFrameworkContributionsFromEdges` in
[src/db/queries.ts](src/db/queries.ts#L1243).
The new method walks every edge with `framework:` in `provenances[]`
(LIKE-narrowed) and:
  - If at least one non-framework provenance survives → strip framework,
    recompute primary via `pickPrimaryProvenance`, recompute confidence
    via `max(defaultConfidence(p))`. Row is preserved (demoted).
  - If no non-framework provenance survives → delete the edge.

Implemented in TypeScript because computing the survivor primary in pure
SQL would require duplicating `pickPrimaryProvenance`'s rank ladder in
SQL and risk drift. Real workloads have framework contributors on a
small fraction of edges, so the row-by-row pass is bounded.

`deleteFrameworkPrimaryEdges` is retained as a safety net for malformed
rows (NULL or empty `provenances[]` with `framework:` primary — possible
from legacy migrations, impossible via the upsert path). Phase 3's
STAGE 0 sequence in [src/resolution/phase3.ts](src/resolution/phase3.ts#L101)
still calls both, now with comments explaining why.

**Tests**: two new cases in `p1-phase3-orchestrator.test.ts`:
  - "preserves merged edge where framework is PRIMARY but a lower-rank
    static contributor survives" — `[heuristic, framework:react]` →
    demoted to heuristic primary.
  - "deletes edges whose only contributor is framework" — pure-framework
    edge → row gone.
Plus the same demote-not-delete case in `p1-pr16-cleanup.test.ts` so
the bug is covered from two angles.

## F3 (Medium) — MCP `codegraph_search` tag filter applied after `limit` cut

**Symptom**: `handleSearch` fetched only `limit` (default 10) FTS hits,
then post-filtered by `tag`. Tagged matches ranked below the top 10
disappeared silently — `tag: 'spring:service'` could return "No
results" even with plenty of matching tagged nodes in the index.

**Fix**: when `tag` is set, over-fetch the FTS results to
`clamp(limit * 50, limit, 500)` and then post-filter + slice down to
`limit`. 50× is heuristic — large enough to surface the long tail of
tagged matches in real projects, bounded at 500 so pathological
queries don't pull the whole graph.
[src/mcp/tools.ts:601](src/mcp/tools.ts#L601).

The alternative (pushing the tag filter into the FTS DB query) would
require restructuring `searchNodes` to JOIN `node_tags` — bigger
surface, more places to break the existing ranking. The over-fetch is
small enough to be free in practice.

**Test**: new file `__tests__/p1-mcp-tag-filter.test.ts` with two cases:
  - Seeds 50 `Service*` classes all carrying `spring:service`, asks
    for `query: 'Service', tag: 'spring:service', limit: 5`. Without
    the over-fetch fix, this would return "No results" because the 5
    top FTS hits don't contain any service that the tag filter actually
    matches (after FTS ranking). With the fix, returns the 5
    highest-ranked tagged matches.
  - Negative case: `tag: 'react:hook'` against `spring:service`-tagged
    nodes returns "No results" — confirms the filter doesn't leak.

## F4 (Medium) — `CodeGraph.indexFiles()` doesn't run Phase 3

**Symptom**: `indexFiles()` delegated straight to
`ExtractionOrchestrator.indexFiles` without invoking Phase 3. After PR-16
removed the legacy per-file `extract` hook, any direct caller of
`indexFiles()` lost routes / components / tags / DI bindings on the
touched files. `indexAll` and `sync` were covered; `indexFiles` was
overlooked.

**Fix**: wrap `orchestrator.indexFiles` in the same `if (result.success)
{ … phase3.run() … }` block used by `indexAll`. Phase 3 STAGE 0 purge
handles the re-derive correctly across calls.
[src/index.ts:738](src/index.ts#L738).

**Test**: new file `__tests__/p1-indexfiles-phase3.test.ts`. Registers
a fake resolver that synthesizes a single `route` node, calls
`cg.indexFiles(['app.ts'])`, and asserts the node appears via
`cg.getNodesByKind('route')`. Requires `initGrammars` + `loadAllGrammars`
in `beforeAll` (matches the pattern from
`frameworks-integration.test.ts`) so the extraction pass succeeds and
the `result.success` gate fires.

## Renames

- `stripFrameworkContributionsFromMergedEdges` →
  `stripFrameworkContributionsFromEdges` (the "merged" qualifier is no
  longer accurate — the new method handles BOTH merged and
  framework-only edges).
- One existing test in `p1-phase3-orchestrator.test.ts` updated to the
  new method name; the worklog files at `P1.1.md` /
  `P1-session-summary.md` reference the old name and aren't worth
  rewriting (historical record).

## Test result after fixes

```
$ npx vitest run \
    __tests__/frameworks.test.ts __tests__/frameworks-integration.test.ts \
    __tests__/p1-node-tags-and-graphview.test.ts \
    __tests__/p1-phase3-orchestrator.test.ts \
    __tests__/p1-spring-di.test.ts \
    __tests__/p1-pr16-cleanup.test.ts \
    __tests__/p1-mcp-tag-filter.test.ts \
    __tests__/p1-indexfiles-phase3.test.ts \
    __tests__/p09-schema-migration.test.ts \
    __tests__/p08-node-provenance-roundtrip.test.ts \
    __tests__/scip-ingester.test.ts

Test Files  11 passed (11)
     Tests   127 passed (127)
```

## Patterns

- **F1 + F4** are both "the wiring path I forgot to test." F1 is a SQL
  bug that any execution would have caught; F4 is a wiring omission
  that only `indexFiles`-direct-callers experience. Both are now pinned
  by tests that exercise the path end-to-end, not just the unit.
- **F2** is a logic bug in the priority ladder — the rank table
  ([src/types.ts:269](src/types.ts#L269)) has framework outranking some
  static provenances, but STAGE 0's assumption (frameworks are always
  primary-or-NULL contributors that can be cleanly stripped) didn't
  account for that. The fix aligns STAGE 0 with the rank ladder.
- **F3** is the classic "post-filter on paginated results" trap. The
  over-fetch heuristic is the lightweight fix; the structurally clean
  fix (push tag into the SQL) is deferred until there's a measured
  perf concern.
