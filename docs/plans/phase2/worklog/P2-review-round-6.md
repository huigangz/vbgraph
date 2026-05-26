# P2 — Post-ship review round 6 (2026-05-26)

**Status**: complete — 2 findings, both fixed and tested.
**Date**: 2026-05-26
**Source review**: 2 findings (1 Medium, 1 Low) against the state at end of [round 5](P2-review-round-5.md).

## Findings + resolutions

### Finding #1 (Medium) — Log-stream errors during final flush were never re-checked

The round-5 fix attached the `'error'` listener synchronously and re-checked `logStreamError` BEFORE calling `logStream.end()`. But the subsequent flush-wait `await new Promise(...)` resolves on either `'finish'` or `'error'`, and the captured `logStreamError` was never re-inspected after that wait.

A pending write that fails after the child closes — ENOSPC during the final buffer drain, EIO on the device when closing the fd, an EDQUOT quota violation that fires only at flush — would set `logStreamError` via the still-in-scope listener but refresh would happily proceed to ingest and return `phase: 'ok'`, despite the per-run log being silently incomplete or truncated. That's exactly the failure mode that makes scheduled-refresh diagnosis impossible.

The round-5 regression test ([p2-review-fixes.test.ts](../../../__tests__/p2-review-fixes.test.ts)) covered immediate open-failure only — a quiet child with an immediately-erroring stream. Flush-time timing was untested.

**Fix:** added a `logStreamError` re-check immediately after the flush-wait promise resolves. If set, refresh returns `phase: 'spawn-failed'` with `"Refresh log file flush failed (...); refresh aborted before ingest"`. Ingest never runs.

```ts
// src/index.ts (in refreshScip, post-spawn, post-flush-wait)
await new Promise<void>((resolve) => {
  logStream.once('finish', resolve);
  logStream.once('error', () => resolve());
  logStream.end();
});

// Re-check AFTER the flush wait: an error event during final
// buffer drain or fd close would have populated logStreamError
// post-spawn-promise. If we let refresh continue here, ingest
// proceeds and `phase: 'ok'` would be returned despite the per-run
// log being silently incomplete — exactly the failure mode that
// makes scheduled-refresh diagnosis impossible.
if (logStreamError) {
  const lse: Error = logStreamError;
  return {
    phase: 'spawn-failed',
    error: `Refresh log file flush failed (${lse.message}); refresh aborted before ingest`,
    spawnExitCode: exitCode,
    scipPath: null,
    filesCovered: 0,
    durationMs: Date.now() - startedAt,
    logPath,
  };
}
```

**Regression test** (`__tests__/p2-review-fixes.test.ts` — "refreshScip returns spawn-failed when the log stream errors during final flush"):

Uses the round-5 `createRefreshLogStream` test seam to inject a custom Writable whose `final()` callback defers an `'error'` emit to `process.nextTick`. The `final()` callback never invokes its `cb` — so the stream stays unfinished, `'finish'` never fires, only `'error'` resolves the flush-wait. This is the exact shape of an ENOSPC at fd close / EIO on the trailing buffer drain. Without the fix, refresh returns `'ok'` (silently broken log). With the fix, refresh returns `'spawn-failed'` and never reaches ingest.

### Finding #2 (Low) — Consolidated worklogs corrected, but sub-task docs still stated obsolete contract

[P2.3.3.md](P2.3.3.md) line 17 `ScipRefreshResult.phase` union still listed `'ok' | 'spawn-failed' | 'ingest-failed'` (no `'lock-failed'`); the flow steps 30-40 still described mutex-only refresh without FileLock, fallback recreation, cache invalidation, resolution + Phase 3 rerun, or `lastError`. [P2.4.0.md](P2.4.0.md) `ScipLastRefresh` interface still had 5 fields without `lastError`.

These sub-task worklogs were now inconsistent with the amended consolidated records (P2.3.md, P2.4.md, P2.6.md) and the source code.

**Fix:**
- [P2.3.3.md](P2.3.3.md): `phase` union updated with round-4 annotation; flow rewritten as a 15-step lifecycle covering every behavioral round (1-6), each step annotated with the round that introduced it.
- [P2.4.0.md](P2.4.0.md): `lastError: string | null` added with round-3 annotation noting legacy-sidecar normalization.

## Files changed

| File | Change |
|---|---|
| `src/index.ts` | Post-flush-wait `logStreamError` re-check (finding #1). |
| `__tests__/p2-review-fixes.test.ts` | + flush-time regression test under the `Round-5 — log stream error handling` block (finding #1). |
| `docs/plans/phase2/worklog/P2.3.3.md`, `P2.4.0.md` | Stale phase union + sidecar field-count updates (finding #2). |

## Tests

```
$ npx vitest run __tests__/p2-review-fixes.test.ts
Test Files  1 passed (1)
     Tests  16 passed (16)
```

(was 15 in round 5; +1 for the new flush-time regression).

Full P2 + security sweep: **111/111 green** across `p21-no-bypass`, `p22-stale-sync`, `p23-scip-refresh`, `p24-status`, `p2-review-fixes`, `p26-perf-edge-visibility`, `p26-semantic-regressions`, `security`.

## Behavior changes (CHANGELOG-worthy)

- **Refresh now fails closed on flush-time log-stream errors.** Previously a refresh whose log file ran out of disk space during final drain would return `'ok'` with a silently truncated log; it now returns `'spawn-failed'` with a clear message and skips ingest.

## Risk callouts

- **`logStreamError` semantics now span three timing windows:**
  - Open (round 5): error during `createWriteStream`'s lazy `open()` microtask.
  - Mid-run (round 5): error during a pipe write while the child is alive — pre-`end()` re-check catches it.
  - Flush (round 6): error during `end()`'s final buffer drain / fd close.
  Any future refactor of refresh's spawn/log path must preserve all three re-check sites.

## Effort

- Estimated: not budgeted — review-driven follow-up.
- Actual (AI-paced): ~1.5h including audit + 1 implementation fix + 1 regression test + 2 sub-task doc fixes + targeted regression sweep. Most of the time went into hunting down the right cross-platform technique to inject a flush-time stream error — landed on the instance-method test seam introduced in round 5.
