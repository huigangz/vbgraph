# P2 — Post-ship review round 2 (2026-05-25)

**Status**: complete — 3 findings, all fixed and tested.
**Date**: 2026-05-25
**Source review**: 3 findings (1 High, 1 Medium, 1 Low) against the state at end of [round 1](P2-review-round-1.md).

## Findings + resolutions

### Finding #1 (High) — `refreshScip` silently drops Phase 3 errors

`Phase3Orchestrator.run()` returns recoverable per-resolver errors in `result.errors` rather than throwing — that's the intentional design so one bad resolver doesn't take down the whole framework synthesis pass. Round 1's fix for "refresh reruns Phase 3" only caught **thrown** exceptions; the returned `phase3Result.errors` array was discarded.

Compounding the issue: even when `result.error` WAS populated (from a throw), the CLI's success-path printed only "Refreshed N file(s) in Xs" and never looked at `result.error`. A scheduled `--quiet` refresh that dropped framework contributions would exit 0 with no warning.

**Fix:**
- `refreshScip` reads `phase3Result.errors` and appends each as `"phase 3 <severity>: <message> (<code>)"` to `derivedErrors`.
- CLI's `phase === 'ok'` branch now checks `result.error` and prints a `warn()` line BEFORE the success message when non-null. Quiet mode still surfaces it — the warning is unconditional.
- The "no error" path retains the unchanged "Refreshed N file(s)" output.

### Finding #2 (Medium) — CHANGELOG missing review-round-1 changes

Round 1 added: refresh rebuilds derived data, fallback recreation, dangling-edge API + CLI, three new query siblings. CHANGELOG 0.9.0 block had not been updated.

**Fix:** updated three CHANGELOG sections:
- **`codegraph scip-refresh`** description now explains: empty-doc fallback recreation, resolution + Phase 3 rerun, recoverable error surfacing on success path.
- **`codegraph status` enhancements** now lists the "Dangling against stale" section + the 6th JSON field (`danglingEdges`, was 5).
- **Public API** section adds `countDanglingEdgesAgainstHiddenStale` plus the three `*IncludingDanglingEndpoints` `QueryBuilder` siblings.

### Finding #3 (Low) — Stale audit records in consolidated worklogs

Round 1's fixes changed behavior that earlier consolidated worklogs described as "unfixed":
- `P2.5.md` claimed "Task Scheduler: UTF-16 encoding — required by the scheduler itself" — Task Scheduler template was corrected to UTF-8 with optional UTF-16 conversion documented.
- `P2.6.md` listed `*IncludingDanglingEndpoints` siblings as "deferred until a real consumer needs them" — they were delivered in round 1.

**Fix:**
- `P2.5.md`: rewrote the Task Scheduler line to describe the actual UTF-8 declaration + cross-reference round 1 finding #5.
- `P2.6.md`: struck through the `*IncludingDanglingEndpoints` line in the "does NOT deliver" section + replaced with the "delivered in 2026-05-25 review round 1" cross-reference. Also updated the "End-to-end refreshScip" line to reflect that round 1 added the no-op-spawn integration test.

## Files changed

| File | Change |
|---|---|
| `src/index.ts` | `refreshScip` captures `phase3Result.errors` into `derivedErrors`; throw-only branch renamed to "phase 3 threw" |
| `src/bin/codegraph.ts` | `scip-refresh` CLI's `phase === 'ok'` branch prints `warn()` line when `result.error` is non-null, even in `--quiet` mode |
| `CHANGELOG.md` | Three sections updated to reflect round 1 + round 2 behavior |
| `docs/plans/phase2/worklog/P2.5.md` | UTF-16 → UTF-8 audit update with cross-reference |
| `docs/plans/phase2/worklog/P2.6.md` | Two "deferred" items updated to reflect round 1 delivery |
| `__tests__/p2-review-fixes.test.ts` | + Phase 3 error-surfacing test (synthetic resolver throws → assert `result.error` non-null) |

## Tests

New test in `p2-review-fixes.test.ts`:

> `Round-2 fix #1 — Phase 3 recoverable errors surface in refresh result.error`
> Plants a synthetic framework resolver via `registerFrameworkResolver` whose `synthesize` throws. Runs `cg.refreshScip` against a no-op-spawn + pre-staged `.scip` fixture. Asserts `result.phase === 'ok'` (SCIP data is fresh) AND `result.error` is non-null and contains the resolver name. Without the fix, `result.error` would be `null`.

```
$ npx vitest run __tests__/p2-review-fixes.test.ts
Test Files  1 passed (1)
     Tests  9 passed (9)
```

## Full regression

| Suite | Tests |
|---|---|
| `p2-review-fixes` | 9/9 (was 8 in round 1, +1) |
| All P2 suites (perf, semantic, status, scip-refresh, stale-sync, no-bypass, review-fixes) | **68/68** |
| P0/P1 (schema, scip, phase3, frameworks, graph, etc.) | **123/123** (combined batch) |

Pre-existing failures unchanged from baseline.

## CLI output contract — refresh success path

| Condition | Output |
|---|---|
| `phase=ok`, `error=null`, `--quiet` | Silent. |
| `phase=ok`, `error=null`, interactive | `✓ Refreshed N file(s) in Xs` + `ℹ Log: ...` |
| `phase=ok`, `error=non-null`, `--quiet` | `⚠ scip-refresh completed with derived-data issues: ...` + `ℹ Log: ...`. NO success line. |
| `phase=ok`, `error=non-null`, interactive | `⚠ scip-refresh completed with derived-data issues: ...` + `ℹ Log: ...` + `✓ Refreshed N file(s) in Xs` |
| `phase=spawn-failed` | `✗ scip-refresh spawn-failed: ...` → exit 1 |
| `phase=ingest-failed` | `✗ scip-refresh ingest-failed: ...` → exit 2 |

The key invariant: **derived-data errors are NEVER silent**, regardless of `--quiet`. Scheduled refresh cannot exit 0 without the user hearing about framework drops.

## Risk callouts

- **Derived errors still don't fail the exit code.** Phase stays `ok`, exit is 0. Rationale: SCIP data IS fresh; partial framework state is recoverable on the next sync or refresh. The warning surfaces the issue without making refresh exit non-zero (which would interrupt cron sequences). If a stricter contract is wanted in P3 — e.g. exit code 3 = "ok with derived warnings" — it can be added without breaking existing 0/1/2 consumers.
- **Phase 3's resolver-isolation contract is implicit in this fix.** If `Phase3Orchestrator` ever stops returning errors in `result.errors` (e.g. switches back to throwing on per-resolver failure), this fix becomes silent. The new test plants a synthetic resolver that exercises the per-resolver isolation path; if the orchestrator changes, the test changes too.
- **CHANGELOG note about pre-publish review** — the user should fold these round-2 additions into the published 0.9.0 entry if they haven't released yet. If 0.9.0 was already published, these become 0.9.1 notes.

## Effort

- Estimated: not budgeted — review-driven follow-up.
- Actual (AI-paced): ~1h including audit + 3 fixes + 1 test + worklog.
