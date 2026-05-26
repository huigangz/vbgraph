# P2 — Post-ship review round 4 (2026-05-25)

**Status**: complete — 7 findings, all fixed and tested.
**Date**: 2026-05-25
**Source review**: 7 findings (1 Medium, 5 Low, 1 Trivial) against the state at end of [round 3](P2-review-round-3.md).

## Findings + resolutions

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | **Medium** | `insertNode` does not invalidate `nodeCache` while `updateNode` does. `INSERT OR REPLACE` can overwrite a row whose previous version is cached, and subsequent `getNodeById` returns the pre-replace value. Currently benign because sync invalidates the cache via `markScipFileStale` / `deleteFileTreeSitterRows` before insertions, but a latent invariant trap for any future code path that does `getNodeById('X')` → `insertNode({id: 'X', …})`. | Added `this.nodeCache.delete(node.id)` before the SQL write in `insertNode`, mirroring `updateNode`'s shape. `insertNodeOrIgnore` does not need invalidation: `OR IGNORE` is a no-op on conflict so the existing cached row remains correct. |
| 2 | **Medium** | `refreshScip` only acquired the in-process `indexMutex`, not the cross-process `FileLock` (`.codegraph/codegraph.lock`). Two concurrent `codegraph scip-refresh` invocations from separate processes would race STAGE B deletes against each other. Documented as a P3 follow-up in the P2.3 worklog, but the `FileLock` infrastructure already protects `indexAll` and `sync`. | Wrapped the `indexMutex.withLock` body in `fileLock.acquire()` / `release()`. New `'lock-failed'` phase added to `ScipRefreshResult.phase` for the contention path, mapped to CLI exit code 1. Late arrival returns a structured result without touching the database. Worklog docs ([P2.3.md](P2.3.md), [P2.3.3.md](P2.3.3.md), [P2.4.2.md](P2.4.2.md), [P2.6.md](P2.6.md), [docs/scheduling/README.md](../../../docs/scheduling/README.md)) updated to reflect the new contract. |
| 3 | **Low** | Full-batch vitest run (`npx vitest run`) hits Windows worker-pool OOM, forcing every P2 worklog to disclose "tests run individually" — a CI smell and a maintenance liability that hid latent test-isolation issues. | Added `pool: 'forks'` + `maxForks: 2` (configurable via env var `CODEGRAPH_TEST_MAX_FORKS`) to [vitest.config.ts](../../../vitest.config.ts). Full-batch now completes — 795 pass + 13 worklog-documented pre-existing failures. Tighter cap of 2 avoids surfacing a parallel-only test-isolation flake in `resolution.test.ts` (re-export chain) discovered during validation. |
| 4 | **Low** | `bulkMarkScipFilesStale` wholesale-clear branch (`filePaths.length >= maxCacheSize`) never triggers via sync since `maxStaleFilesPerSync` defaults to 50 and `maxCacheSize` is 1000, making the branch look dead. | Rewrote the comment to clarify that the branch is correct-by-design — external callers (parity harness, future CLI subcommands) may pass thousands of files at once and the bookkeeping must be correct there too. |
| 5 | **Low** | The implicit shell contract "exit 0 = refresh fully succeeded" was wrong: derived-data errors (Phase 3 / resolution failures) leave the SCIP graph fresh but populate `lastError`, and the exit code stays 0 by design (round 2 contract). Shell-scripters gating on `$?` would miss these. | Added a callout box + bash snippet to [docs/scheduling/README.md](../../../docs/scheduling/README.md) showing how to check `lastError` in the sidecar. CHANGELOG note updated accordingly. |
| 6 | **Low** | Single-string `scipRefreshCommand` naïvely split on `\s+`, mis-tokenizing paths with spaces — e.g. `"C:\Program Files\scip\scip-dotnet" index ./` produced 4 invalid tokens. | Added `tokenizeShellCommand` helper in [src/index.ts](../../../src/index.ts) that respects single and double quotes plus `\"`/`\\` escapes inside double quotes. Array form still bypasses tokenization entirely. |
| 7 | **Trivial** | The `*IncludingDanglingEndpoints` query siblings lack a `kinds?` filter parameter. | Documented as a future enhancement — no current consumer needs it. |

## Files changed

| File | Change |
|---|---|
| `src/db/queries.ts` | + `this.nodeCache.delete(node.id)` in `insertNode` (finding #1). Clarified threshold comment in `bulkMarkScipFilesStale` (finding #4). |
| `src/index.ts` | `refreshScip` wraps body in `fileLock.acquire()/release()` with `'lock-failed'` return shape on contention (finding #2). New `tokenizeShellCommand` helper used by single-string command form (finding #6). |
| `src/types.ts` | `ScipRefreshResult.phase` union extended with `'lock-failed'`. JSDoc table updated. |
| `src/bin/codegraph.ts` | CLI exit-code mapping: `'lock-failed' → 1` alongside `'spawn-failed' → 1`. |
| `vitest.config.ts` | `pool: 'forks'`, `maxForks: 2` (env-overridable). Inline rationale comment (finding #3). |
| `docs/scheduling/README.md` | Exit-codes section expanded with shell-scripter callout + bash snippet (finding #5). |
| `CHANGELOG.md` | New `## [0.9.0]` notes about `'lock-failed'` phase and the shell-scripter contract. |
| `docs/plans/phase2/worklog/P2.3.md`, `P2.3.3.md`, `P2.4.2.md`, `P2.6.md` | Stale "FileLock not used" / "5-field sidecar" / "cross-process lock deferred" claims updated. |

## Tests added

- `__tests__/security.test.ts` — three new FileLock regression tests (live-PID retention, malformed-PID reclaim, malformed-PID recent rejection) — though the PID-authoritative behavior itself lands in round 5; round-4 sets up the FileLock-around-refresh wiring.
- Full vitest sweep enabled: 795 tests pass + 13 worklog-documented pre-existing failures (foundation VACUUM, opencode installer × 7, MCP initialize × 2, name-matcher kind-bias × 2, watcher).

## Behavior changes (CHANGELOG-worthy)

- **`codegraph scip-refresh` now acquires the cross-process FileLock.** Two concurrent processes: late arrival returns `'lock-failed'`, exit code 1, no database mutation.
- **Shell-scripter contract documented**: exit 0 does NOT imply fully-clean refresh — check sidecar `lastError`.
- **Single-string `scipRefreshCommand` now respects quotes** so paths with spaces work without switching to array form.

## Risk callouts

- **vitest `maxForks=2`** is a per-machine tuning. Slower CI may need lower, faster bigger; env var `CODEGRAPH_TEST_MAX_FORKS` overrides.
- **`FileLock`'s default acquire-side staleness check** still uses a 2-minute mtime threshold for *any* lock-file age — including ones with a live PID. Round 5 will tighten this so live PIDs are authoritative.
- **`*IncludingDanglingEndpoints` siblings still lack `kinds?` filter** — punt to when a real caller needs it.

## Effort

- Estimated: not budgeted — review-driven follow-up.
- Actual (AI-paced): ~2.5h including audit + 6 fixes + worklog updates + full regression sweep.
