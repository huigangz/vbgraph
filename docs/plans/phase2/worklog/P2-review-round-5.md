# P2 — Post-ship review round 5 (2026-05-25)

**Status**: complete — 4 findings, all fixed and tested.
**Date**: 2026-05-25
**Source review**: 4 findings (1 High, 1 Medium, 2 Low) against the state at end of [round 4](P2-review-round-4.md).

## Findings + resolutions

### Finding #1 (High) — FileLock 2-minute timeout could free a live lock during a long refresh

The newly added cross-process protection for scip-refresh was load-bearing, but `FileLock.acquire()` treated *any* lock older than two minutes as stale, even when its PID was still alive. The worklog itself acknowledged refreshes may run for minutes ([P2.3.3.md](P2.3.3.md) — "long refresh (minutes for large projects)"). After 120 seconds, a second sync or `scip-refresh` would delete the still-held lock file and modify the same graph concurrently with ingestion / Phase 3 rebuild — re-opening exactly the race the round-4 patch was meant to close.

**Fix:** live PID is now authoritative.

- `FileLock.acquire()` now checks `isProcessAlive(pid)` first. **If alive → throw, regardless of lock-file age.** Long-running refresh / indexAll passes cannot be evicted by a wall-clock heuristic.
- The age threshold (renamed `UNPARSEABLE_LOCK_TIMEOUT_MS` to make its remaining role explicit) now only applies when the recorded PID is unparseable — a corrupt-lock-file fallback for the rare case where liveness cannot be checked at all.
- Dead PIDs are reclaimed regardless of age (no point waiting on an abandoned lock).

**Regression tests** (`__tests__/security.test.ts`):
1. Backdated 10-minute lock with this process's live PID must NOT be deleted; acquire must throw `/locked by another process/`.
2. Malformed PID + old mtime IS reclaimed.
3. Malformed PID + recent mtime IS rejected without deletion.

### Finding #2 (Medium) — Per-run log file open or write error crashes the parent process

`fs.createWriteStream(logPath)` started receiving child output immediately, but its `'error'` listener was only registered after the child closed (inside the post-spawn `await new Promise(... once('error', ...))`). If the log file could not be opened (EACCES on a read-only logs dir, EROFS on a read-only filesystem, EISDIR if the path were a directory) or a write failed mid-run, the stream emitted an unhandled `'error'` event, bypassing the documented `ScipRefreshResult` failure contract and potentially crashing a scheduled `--quiet` refresh entirely.

**Fix:**

- `logStream.on('error', …)` listener attached **synchronously** right after `createWriteStream`, capturing the first error into a `logStreamError` local.
- Pipe-source errors absorbed (`child.stdout.on('error', () => {})` / `child.stderr.on('error', () => {})`) so they don't bubble up when the destination dies.
- After the spawn promise resolves, if `logStreamError` is non-null, refresh returns `phase: 'spawn-failed'` with `"Refresh log file unwritable (...); refresh aborted before ingest"` and bails before ingest runs.

**Regression test** (`__tests__/p2-review-fixes.test.ts` — "spawn-failed (not a crash) when the log stream errors immediately"): injects a Writable that emits `'error'` on `process.nextTick` after construction, simulating the open-failure shape cross-platform without depending on per-OS ACL behavior. Without the fix Node would crash with an unhandled emitter error before the test could assert anything. To make injection possible without per-OS gymnastics, log-stream creation was refactored into a private instance method `createRefreshLogStream(logPath)` (see "Implementation notes").

### Finding #3 (Low) — `ScipLastRefresh.lastError` is required but one typed fixture omitted it

[src/types.ts](../../../src/types.ts) defines `lastError: string | null` as required (round 3), but [p24-status.test.ts](../../../__tests__/p24-status.test.ts) — the "parses a valid sidecar" test — used a `ScipLastRefresh`-typed object literal without `lastError`. A strict tsc check on test sources flagged TS2741: "Property 'lastError' is missing".

**Fix:** added `lastError: null` to the fixture.

### Finding #4 (Low) — Worklog docs out of date with FileLock changes

[P2.3.md](P2.3.md) and [P2.3.3.md](P2.3.3.md) still said refresh uses only `indexMutex` and listed cross-process serialization as a P3 follow-up — directly contradicting the round-4 implementation and the CHANGELOG.

**Fix:** rewrote the Risk callouts sections in both files with strike-through + "Updated 2026-05-25 (post-ship review round 4)" annotations linking to the relevant src files.

## Implementation notes

### `createRefreshLogStream` instance test seam

The round-2 finding needed a regression test that injects a failing log stream. Approaches considered and rejected:

| Approach | Why it failed |
|---|---|
| `vi.spyOn(fs, 'createWriteStream')` | "Cannot redefine property" — vitest's ESM namespace handling makes `import * as fs` a frozen object. |
| `(fs as any).createWriteStream = mock` on the namespace | Same issue — namespace is non-extensible. |
| Mutate `require('fs').createWriteStream` | `import * as fs` and `require('fs')` return DIFFERENT objects under vitest; mutations don't propagate. Verified empirically. |
| Pre-create a directory at the predictable log path + fake timers to pin the timestamp | Brittle on Windows ACLs; mocks the global Date in a way that affects other timers. |
| Refactor log-stream creation into a private instance method, monkey-patch on a single CodeGraph instance | ✓ Clean, scoped, cross-platform, no production-API impact. |

The chosen approach adds [src/index.ts](../../../src/index.ts) `private createRefreshLogStream(logPath: string): fs.WriteStream { return fs.createWriteStream(logPath, { flags: 'w' }); }`. Production callers never touch it; behavior is identical to the inline call. Tests do `(cg as any).createRefreshLogStream = ...` to inject synthetic streams.

## Files changed

| File | Change |
|---|---|
| `src/utils.ts` | `FileLock.acquire()` reorders liveness check to be authoritative; age threshold renamed and scoped to unparseable-PID case (finding #1). |
| `src/index.ts` | Synchronous `logStream.on('error')` listener + `logStreamError` capture; `createRefreshLogStream` test seam (finding #2). |
| `__tests__/security.test.ts` | + 3 FileLock regression tests (finding #1). |
| `__tests__/p2-review-fixes.test.ts` | + log-stream open-error regression test under new `Round-5 — log stream error handling` block (finding #2). |
| `__tests__/p24-status.test.ts` | + `lastError: null` in `ScipLastRefresh` fixture (finding #3). |
| `docs/plans/phase2/worklog/P2.3.md`, `P2.3.3.md` | Stale cross-process-lock claims updated with round-4 cross-references (finding #4). |

## Tests

```
$ npx vitest run __tests__/security.test.ts __tests__/p2-review-fixes.test.ts __tests__/p21-no-bypass.test.ts __tests__/p22-stale-sync.test.ts __tests__/p23-scip-refresh.test.ts __tests__/p24-status.test.ts __tests__/p26-perf-edge-visibility.test.ts __tests__/p26-semantic-regressions.test.ts
Test Files  8 passed (8)
     Tests  110 passed (110)
```

## Behavior changes (CHANGELOG-worthy)

- **Long-running refreshes / indexAll passes can no longer be killed by a stale-age FileLock timeout.** Live PID is authoritative.
- **Failed log-file opens or writes no longer crash the refresh process.** A structured `'spawn-failed'` result is returned and the FileLock releases cleanly.

## Risk callouts

- **`isProcessAlive` returns `false` for EPERM** (process exists but not signalable by current user). Pre-existing limitation; for same-user processes (the dominant case) it's fine.
- **`createRefreshLogStream` test seam** is undocumented private API. Future internal refactors must keep it as an instance method (or migrate the test to a new seam).

## Effort

- Estimated: not budgeted — review-driven follow-up.
- Actual (AI-paced): ~2h including audit + 4 fixes + 4 regression tests + doc updates + targeted regression sweep.
