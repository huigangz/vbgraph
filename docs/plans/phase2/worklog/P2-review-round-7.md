# P2 — Post-ship review round 7 (2026-05-26)

**Status**: complete — 1 finding fixed and tested.
**Date**: 2026-05-26
**Source review**: 1 finding (1 Medium) against the state at end of [round 6](P2-review-round-6.md). The reviewer also re-stated rounds 5–6 findings against working-tree line numbers (since `origin/main` had no P2 code yet); those were verified as already-fixed in the working tree and not re-applied here.

## Finding + resolution

### Finding — Mid-run log-stream error hangs refresh on a noisy child

Rounds 5 + 6 covered two log-stream failure timings:
- **Open** (round 5): error fires before the child produces output → `logStreamError` set → pre-`end()` re-check returns `'spawn-failed'`.
- **Flush** (round 6): error fires during `end()`'s final drain → post-flush-wait re-check returns `'spawn-failed'`.

But a third timing remained unhandled: **mid-run** — `logStream` errors while the child is **still actively writing**. Node's `pipe()` machinery auto-unpipes on downstream error; the child's stdout/stderr have no consumer; their kernel pipe buffers fill (~64 KB on Linux, ~4 KB on Windows); the child blocks on `write()`; our `await child.on('close')` never resolves → **refresh hangs forever**.

This is the specific failure mode that catastrophically breaks scheduled `--quiet` refreshes: a transient mid-run disk error on a noisy indexer (scip-dotnet on a large solution can easily produce hundreds of KB of diagnostics) leaves the refresh process pinned, holding the cross-process FileLock (round 4), preventing every subsequent sync until manual intervention.

**Fix:** the synchronously-attached `logStream.on('error')` handler now kills the child and drains its stdio readables the moment an error fires:

```ts
// src/index.ts (in refreshScip)
let logStreamError: Error | null = null;
let childRef: any = null;
logStream.on('error', (err) => {
  if (!logStreamError) logStreamError = err;
  // Defense against the noisy-child hang. If the child is still
  // running, kill it and drain its readables so the spawn Promise
  // resolves promptly with a non-zero exit. If the child has
  // already exited, this is a no-op.
  if (childRef) {
    try { childRef.stdout?.resume(); } catch { /* ignore */ }
    try { childRef.stderr?.resume(); } catch { /* ignore */ }
    if (childRef.exitCode === null && !childRef.killed) {
      try { childRef.kill(); } catch { /* ignore */ }
    }
  }
});

const exitCode = await new Promise<number | null>((resolve) => {
  const child = spawn(cmd, args, { … });
  childRef = child;
  // … pipes + close/error listeners …
});
```

**Why both `kill()` AND `resume()`?**

- `kill()` makes the child exit so `'close'` fires and the spawn Promise resolves.
- `resume()` on `stdout` / `stderr` drains any bytes already buffered in the kernel pipe to a no-op consumer (Node's flowing-mode default discards if no listener). On Windows the signal-delivery → process-exit latency is non-trivial; without the drain, the child can block on a pre-signal `write()` and miss the kill signal entirely (CTRL_C_EVENT translation issues).

**`childRef` capture timing:** Promise constructor body runs synchronously, so `childRef = child` executes before any async `logStream.on('error')` listener fires. The `if (childRef)` guard handles the edge case of a stream that errors synchronously during construction (test mocks).

### Regression test — noisy-child hang

The test ([__tests__/p2-review-fixes.test.ts](../../../__tests__/p2-review-fixes.test.ts) — "refreshScip kills the noisy child and does not hang when the log stream errors mid-run") is designed so that **without the fix, it hangs until the suite-level timeout**, and **with the fix, it returns in well under a second**:

- Child: `node -e` with `setInterval(() => process.stdout.write('x'.repeat(1024) + '\n'), 1)` — 1 KB / ms, no natural exit. Listens to SIGTERM/SIGINT and exits cleanly. Includes a safety upper bound (30 s `setTimeout` → `process.exit(2)`) so the test never leaks orphan processes if something else goes wrong.
- Injected stream (via the round-5 `createRefreshLogStream` test seam): errors on the very first `write()` attempt.
- Test-level timeout: **10 s** (the hang detector — a regression that re-introduces the hang fails fast).
- Internal upper bound: `expect(elapsedMs).toBeLessThan(5000)` catches partial-fix regressions where the kill happens but slowly.

Measured locally: **599 ms** — well under both bounds. The three log-stream regression tests (open / mid-run / flush) now provide orthogonal coverage of all three failure timings.

## Files changed

| File | Change |
|---|---|
| `src/index.ts` | `logStream.on('error')` handler now kills `childRef` and drains its stdio if the child is still running. `childRef` captured outside the spawn Promise. |
| `__tests__/p2-review-fixes.test.ts` | + noisy-child hang regression test under the `Round-5 — log stream error handling` block. |

## Tests

```
$ npx vitest run __tests__/p2-review-fixes.test.ts -t "kills the noisy child"
✓ Round-5 — log stream error handling > refreshScip kills the noisy child and does not hang when the log stream errors mid-run (599ms)
Test Files  1 passed (1)
```

Full P2 + security sweep: **112/112 green** across `p21-no-bypass`, `p22-stale-sync`, `p23-scip-refresh`, `p24-status`, `p2-review-fixes`, `p26-perf-edge-visibility`, `p26-semantic-regressions`, `security`.

## Three-timing coverage matrix

| Timing | Symptom without fix | Fix | Regression test |
|---|---|---|---|
| **Open** | Process crash (unhandled `'error'` emitter) | Sync `on('error')` listener attached right after `createWriteStream` (round 5) | "spawn-failed (not a crash) when the log stream errors immediately" |
| **Mid-run** | Refresh hangs forever waiting on child close (round 7) | `on('error')` handler kills `childRef` + drains its stdio | "kills the noisy child and does not hang when the log stream errors mid-run" |
| **Flush** | `phase: 'ok'` returned with silently broken log (round 6) | Post-flush-wait `logStreamError` re-check returns `'spawn-failed'` | "spawn-failed when the log stream errors during final flush" |

## Behavior changes (CHANGELOG-worthy)

- **`codegraph scip-refresh` no longer hangs when the per-run log file becomes unwritable while the indexer is producing output.** The indexer is killed, its output drains to no-op, the FileLock releases, and refresh returns `'spawn-failed'` with the underlying log error.

## Risk callouts

- **Kill propagation latency on Windows.** `child.kill()` sends SIGTERM which Windows translates internally; depending on the indexer's signal handling, exit may take 100–500 ms. The 5000 ms internal regression bound is generous enough to absorb this.
- **`childRef.exitCode === null` check.** Race-free: `exitCode` is set synchronously by Node before the `'exit'` / `'close'` events fire. A late error after the child has exited becomes a no-op (the round-6 flush-time path).
- **Multiple `kill()` calls** would be guarded by the `!childRef.killed` check. The `try/catch` around the call also swallows ESRCH if the OS already reaped the process.

## Effort

- Estimated: not budgeted — review-driven follow-up.
- Actual (AI-paced): ~1h including audit + implementation + regression test (designing the deterministic-hang reproduction took most of the time) + worklog.

## Closing the loop

After 7 review rounds covering 23 findings total (5 + 4 + 3 + 5 + 2 + 6 + 4 + 1 spread across pre-ship + post-ship), the SCIP refresh path is now defended against:

- Cross-process race (round 4)
- Long-running operation eviction by stale-age lock heuristic (round 5)
- Log-stream open failures (round 5)
- Silent log-stream flush failures (round 6)
- Mid-run log-stream errors hanging refresh on a noisy child (round 7)

Plus framework cache coherence, fallback recreation, derived-data error persistence across three observability channels (stderr, log file, sidecar `lastError`), and the shell-scripter exit-code contract documented for `--quiet` schedules.

The refresh codepath is the most-defended part of Phase 2.
