# P2 — Post-ship review round 3 (2026-05-25)

**Status**: complete — 1 finding, fixed via three persistent channels.
**Date**: 2026-05-25
**Source review**: 1 High against the state at end of [round 2](P2-review-round-2.md).

## Finding — scheduled `scip-refresh --quiet` can still lose Phase 3 warnings

Round 2 routed `phase3Result.errors` into `result.error` and made the CLI print a warning on the success path. But the CLI's `warn()` function writes to **stdout** (`console.log`), not stderr. Schedulers preserve different streams:

| Scheduler | stdout | stderr | exit code | persistent log |
|---|---|---|---|---|
| launchd | `StandardOutPath` | `StandardErrorPath` | yes | optional |
| systemd | journald (default) | journald (default) | yes | no |
| Task Scheduler (default XML) | dropped | dropped | yes | none |

The exit code stays 0 for derived-data errors (the SCIP data IS fresh; this is by design). So a Task Scheduler-driven `--quiet` refresh that hit a Phase 3 failure would record "success" with no warning surface anywhere. Round 2's CLI warning would print to stdout and vanish.

## Three persistent channels

| Channel | Covers | Implementation |
|---|---|---|
| **stderr** | launchd `StandardErrorPath`, systemd journald, Task Scheduler when wrapped with `cmd.exe /c ... 2>>` | CLI uses `process.stderr.write` instead of `warn()` for the derived-error line |
| **Per-run log file append** | All schedulers — the file at `result.logPath` persists in `.codegraph/logs/` regardless of capture | `refreshScip` appends `\n[codegraph derived-data warning <iso>]\n<message>\n` to its own log file when derived errors exist |
| **Sidecar `lastError` field** | All schedulers + status command + polling tools | `refreshScip` writes `lastError: errorString \| null` into `.codegraph/scip-last-refresh.json`. `codegraph status` surfaces it inline with the last-refresh line |

Each channel covers a different failure mode of scheduler capture. Defense in depth.

## Files changed

| File | Change |
|---|---|
| `src/index.ts` | `refreshScip` extracts the joined `errorString` into a local, uses it for: (a) sidecar `lastError`, (b) `fs.appendFileSync(logPath, ...)` per-run log append, (c) return value. Existing throw/catch path unchanged. |
| `src/types.ts` | `ScipLastRefresh.lastError: string \| null` added — REQUIRED field (with null for clean refresh) so consumers must handle it. |
| `src/bin/codegraph.ts` | `scip-refresh` success-path warning uses `process.stderr.write(...)` directly with chalk colors, not `warn()`. Surfaces `info` line for log path on stderr too so all error-related context lands in the same stream. `codegraph status` SCIP section prints a "Last refresh had derived-data issues: ..." line when `lastRefresh.lastError` is non-null. |
| `docs/scheduling/task-scheduler.xml.template` | Header comment expanded: "WARNINGS ON EXIT 0" section documents the three persistent channels + an `cmd.exe /c "... 2>> ..."` snippet for users who want stderr capture parity with launchd/journald. |
| `docs/scheduling/README.md` | New "Warnings on exit 0 (derived-data issues)" section explaining the three channels and how to monitor each. |
| `__tests__/p24-status.test.ts` | Sidecar fixture in "parses a valid sidecar" test now includes `lastError: null` to match the updated required field. |
| `__tests__/p2-review-fixes.test.ts` | + 4 new tests for round-3 channels |

## Tests added (4 new in `p2-review-fixes.test.ts`)

1. **`refreshScip writes derived errors to the sidecar lastError field and the log file`** — plants a synthetic framework resolver that throws in `synthesize`; runs `cg.refreshScip` with a no-op spawn; asserts `result.error` non-null AND log file contains `[codegraph derived-data warning` AND sidecar `lastError` contains the resolver name. **Validates channels (b) and (c).**

2. **`sidecar lastError is null on a clean refresh`** — same scenario WITHOUT the planted resolver; asserts sidecar `lastError` is null. Prevents future regression where empty errors get serialized as `""` or `undefined`.

3. **`CodeGraph.getLastScipRefresh exposes lastError (and tolerates legacy sidecars without it)`** — writes two sidecar JSON variants (one with `lastError`, one without) and asserts the reader exposes the field correctly. Legacy compat: no `lastError` → `null`.

4. **`CLI source routes derived-error warning to stderr (not stdout)`** — source-grep check that `src/bin/codegraph.ts` contains `process.stderr.write` near the derived-error message AND does NOT pass that message through `warn()`. **Validates channel (a)** without subprocess spawning.

```
$ npx vitest run __tests__/p2-review-fixes.test.ts
Test Files  1 passed (1)
     Tests  13 passed (13)
```

## Full regression

| Suite | Tests |
|---|---|
| `p2-review-fixes` | 13/13 (was 9 in round 2, +4) |
| All P2 suites total | **86/86** (was 67 after round 1, 68 after round 2, 86 after round 3) |
| P0/P1 (schema, scip, phase3, frameworks, graph) | **109/109** |

Pre-existing failures unchanged.

## Updated CLI output contract (success path)

| Condition | Output channel(s) | What appears |
|---|---|---|
| `phase=ok`, `error=null`, `--quiet` | none | (silent) |
| `phase=ok`, `error=null`, interactive | stdout | `✓ Refreshed N file(s) in Xs` + `ℹ Log: ...` |
| `phase=ok`, `error=non-null`, `--quiet` | **stderr** + log file + sidecar | `⚠ scip-refresh completed with derived-data issues: ...` + `ℹ Log: ...` on stderr; same message appended to per-run log + persisted in sidecar `lastError` |
| `phase=ok`, `error=non-null`, interactive | stderr + stdout + log + sidecar | warn on stderr; success on stdout; persistence to file + sidecar |

## `codegraph status` surfaces persisted warnings

```
SCIP:
  Last refresh:  2h ago — 1,234 file(s) in 5.6s
  ⚠ Last refresh had derived-data issues: phase 3 warning: framework:foo …
  csharp       Tier 1 SCIP (scip-dotnet)
  ...
```

So even a user who never saw the original scheduler output can run `codegraph status` and discover the most recent refresh had Phase 3 issues. The warning persists across runs until the next refresh overwrites the sidecar (clean refresh = `lastError: null`).

## Risk callouts

- **`ScipLastRefresh.lastError` is required** (not optional). External consumers reading the sidecar JSON via the public type must handle `null`. Backward-compat handled inside `getLastScipRefresh` (older sidecars without `lastError` get normalized to `null`).
- **Task Scheduler XML still doesn't redirect stderr by default**. The template header now includes the `cmd.exe /c "... 2>>"` snippet but does NOT change the default XML. Users wanting stderr capture parity opt in by editing the template. The log + sidecar channels work regardless.
- **Stderr capture on launchd/systemd was implicit before** — the warning was going to stdout, which launchd captures via `StandardOutPath` and journald captures by default. So those schedulers WOULD have caught the warning even before round 3. The fix is specifically the Task Scheduler gap; round 3 also unifies all schedulers under "stderr is the warning channel". Documented in the README.
- **Source-grep test** is brittle in the long-term sense — a refactor of the message string would break the test without breaking the behavior. Acceptable: the regex-free `toContain` check is loose enough to survive minor wording changes, and the test's intent is documented inline.

## Effort

- Estimated: not budgeted — review-driven follow-up.
- Actual (AI-paced): ~1h including audit + 3 fixes + scheduler doc updates + 4 tests + worklog.
