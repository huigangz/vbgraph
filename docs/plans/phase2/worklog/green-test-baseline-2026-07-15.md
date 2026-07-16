# Green test baseline — Windows wasm/teardown fixes (2026-07-15)

**Status**: complete — implemented, verified, and merged locally into `main`.
**Date**: 2026-07-15.
**Source**: `PLAN-green-test-baseline.md` from the primary workspace.
**Branch**: `fix/green-test-baseline`.
**Worktree**: `C:\Users\zuohg\.config\superpowers\worktrees\VBCodeGraph\green-test-baseline`.

## Step 0 — Isolated environment

- Confirmed the primary workspace is on `main` with unrelated untracked plan/reference files; none were modified.
- Created a repository-external worktree from `521369e` on branch `fix/green-test-baseline`.
- Ran `npm install`: 114 packages installed from the existing lockfile; npm reported 9 existing audit findings (4 moderate, 4 high, 1 critical). Dependency remediation is outside this plan.
- Next gate: run the unchanged full suite and confirm the planned six-failure baseline before editing tests or production code.

### Baseline attempt 1 — environment mismatch; implementation paused

- The sandboxed `npm test` could not start because esbuild process creation returned `spawn EPERM`; reran the identical command outside the sandbox after approval.
- The fresh install included the optional native `better-sqlite3` backend, unlike the plan's wasm-only reference machine. Consequently the planned wasm `VACUUM` and repeated-`close()` failures did not reproduce: `foundation`, `resolution`, and `watcher` were green.
- `mcp-initialize.test.ts` failed twice because a fresh worktree has no `dist/bin/codegraph.js`; the reference workspace had prebuilt `dist`. A build is required before the next baseline run.
- Native-backend execution also surfaced a pre-existing `pr19-improvements.test.ts` assertion (`CURRENT_SCHEMA_VERSION`: expected 4, received 7) that the wasm reference baseline skips.
- Vitest reported 839 passed / 3 failed / 3 skipped plus one unexpected worker exit, followed by a V8 `Fatal process out of memory: Zone`; this run is not an acceptable comparison baseline.
- `npm install` mechanically synchronized the root version fields in `package-lock.json` from 0.7.12 to `package.json`'s existing 0.9.0. Those two out-of-scope lines were restored exactly; neither package version is part of this plan.
- Gate decision needed: reproduce the plan's environment without optional native dependencies, build, and rerun the unchanged suite before implementation.

### Baseline attempt 2 — planned wasm baseline reproduced

- With approval, temporarily renamed only `node_modules/better-sqlite3` to `node_modules/.better-sqlite3.disabled`; both resolved paths were verified inside the isolated worktree. This is reversible test-environment setup, not a tracked repository change.
- Ran `npm run build` so the MCP child-process tests had the same built CLI prerequisite as the reference workspace.
- Reran unchanged `npm test` on the wasm backend. All six planned failures reproduced with the expected error shapes: `foundation` VACUUM cursor failure; `resolution` repeated close ×2; `watcher` repeated close; `mcp-initialize` Windows `EPERM` ×2.
- Vitest again reported an unexpected worker exit at the end. No pool/force-exit configuration workaround will be added; final verification will determine whether it is persistent after the target failures are removed.
- Gate passed: the implementation now starts from the intended failing product/test baseline.

## Step 1 — Forced-wasm regression tests (RED)

- Exported `WasmDatabaseAdapter` solely to provide the plan's direct forced-backend regression seam; no adapter behavior changed yet.
- Added two real-file SQLite tests in `sqlite-backend.test.ts`: repeated `close()` parity and `.get()` followed by `VACUUM`.
- Next gate: both new tests must fail for their exact intended reasons before adapter behavior changes.

### RED verification

- `npx vitest run __tests__/sqlite-backend.test.ts`: 6 passed / 2 failed.
- Repeated close failed with `SQLite3Error: Database already closed`.
- `.get()` then VACUUM failed with `SQLite3Error: cannot VACUUM - SQL statements in progress`.
- Both failures are assertion failures caused by the missing behaviors, not setup/type/import errors. RED gate passed.

## Step 2 — Idempotent wasm `close()`

- Added the minimal first-line guard `if (!this._db.isOpen) return;` to `WasmDatabaseAdapter.close()`.
- Kept the existing ordering for an open database: finalize tracked statements, clear the set, then close the underlying database.
- Next gate: repeated close must pass while the independent VACUUM regression remains red.

### Close GREEN verification

- `npx vitest run __tests__/sqlite-backend.test.ts`: 7 passed / 1 failed.
- The repeated-close regression passed.
- The only failure remained `.get()` then VACUUM with the unchanged suspended-statement error, proving the first fix did not accidentally mask the second behavior.

## Step 3 — Reset wasm cursor after `get()`

- Preserved named/positional parameter resolution and wrapped only the raw `stmt.get(...)` call in `try/finally`.
- The `finally` block optional-calls private `_reset()` and documents the backend-parity reason: wasm leaves a suspended cursor that blocks VACUUM.
- The optional call tolerates package API drift at runtime; the forced-wasm VACUUM test remains the loud drift detector.
- Next gate: all eight `sqlite-backend` tests must pass.

### Cursor-reset GREEN verification

- `npx vitest run __tests__/sqlite-backend.test.ts`: 8/8 passed.
- Both forced-wasm regressions now pass alongside the existing backend-reporting tests.

## Step 4 — `resolution.test.ts` state hygiene

- After `cg.destroy()`, set the module-scoped `cg` handle to `null as any`, matching its existing typing.
- Kept the alternate temp-directory cleanup branch unchanged.
- This prevents later pure unit tests from inheriting and destroying a stale prior-test handle even though adapter close is now idempotent.

## Step 5 — Windows-safe MCP child teardown

- Added `spawnTracked()` so the child's `close` promise is captured immediately at spawn time, eliminating the missed-event race.
- Made `afterEach` async: send SIGKILL, await `close` with a referenced and cleared 5-second timeout, then clear tracked child state.
- Cleanup now uses `fs.rmSync` built-in Windows retries (`maxRetries: 5`, `retryDelay: 100`).
- If the child does not close, the timeout error includes pid/tempDir and the directory is intentionally retained for diagnosis instead of masking the failure with `EPERM`.
- Next gate: `resolution.test.ts` and `mcp-initialize.test.ts` must both pass.

### Test-hygiene/teardown verification

- `npx vitest run __tests__/resolution.test.ts __tests__/mcp-initialize.test.ts`: both files passed; 23 passed / 2 skipped.
- Both MCP tests completed without `EPERM`, and both stale-handle resolution failures are gone.

## Step 6 — CHANGELOG

- Added a new undated `## [Unreleased]` block above 0.9.0 with two user-facing `### Fixed` entries: repeated wasm close and wasm `optimize()`/VACUUM.
- Did not change `package.json`, `package-lock.json`, version tags, or release links; no publish/tag/push command was run.

## Step 7 — Acceptance and side-effect audit

### Required checks

- `npm run build`: exit 0; TypeScript and asset copy completed.
- Five affected suites from the plan: 5/5 files passed; 74 passed / 2 skipped.
- Direct built-output wasm smoke ran `optimize(); close(); close()` and printed `ok`.
  Repository safety rules prohibit recursive directory deletion, so the example's final recursive `rmSync` was omitted and the single diagnostic directory was retained at `C:\Users\zuohg\AppData\Local\Temp\cg-accept-rlXH5w`.
- MCP leak snapshot: 43 existing `codegraph-mcp-init-*` directories before final verification and the identical 43 names afterward. The fixed suite created no new MCP temp directories.
- `git diff --check`: clean.
- `git diff -- package.json package-lock.json`: empty.
- `git diff -- src/installer`: empty.
- The temporarily renamed optional `better-sqlite3` dependency directory was restored to its original name after wasm verification.

### Full-suite runtime finding

- The machine now runs Node 24.15.0. On that runtime, unchanged baseline and fixed-tree full runs both crash the `extraction.test.ts` fork with V8 `Fatal process out of memory: Zone`; running that file alone also stops after 188/233 tests. One fork and an 8 GB old-space limit do not change the failure point.
- This is independent of the adapter fix: a temporary npx-cached Node 22.23.1 runs the same `extraction.test.ts` 233/233 green.
- Full wasm suite under Node 22.23.1 (`node node_modules/vitest/vitest.mjs run`): exit 0; all 863 runnable tests passed and 29 intentional skips remained. No repository dependency or runtime version was changed.
- No Vitest pool/force-exit workaround was added, per the plan.

### Review gate

- Independent code review found no Critical or Important issues. It confirmed the implementation follows the plan, the diff is surgically scoped, and the adapter/MCP teardown behavior is covered by the required tests.
- The only Minor finding was that this worklog still said `in progress` / review pending; both status lines were updated as the review recommended.
- Assessment: ready to merge.

## Step 8 — Local integration (2026-07-16)

- User selected finishing option 1: merge `fix/green-test-baseline` locally into `main`.
- Main-worktree `.gitignore` has an unrelated user edit; it is explicitly preserved and excluded from this task's commits.
- Fetched `origin`; `main` and `origin/main` were already identical. `git pull --ff-only` made no changes because the local `pull.rebase` policy rejects a pull with the unrelated unstaged `.gitignore` edit.
- Created feature commit `1f9be41` and merged it into `main` without conflicts using a no-commit merge so verification could run before the merge commit was finalized.
- Post-merge `npm run build`: exit 0.
- Post-merge five affected suites: 5/5 files passed; 74 passed / 2 skipped.
- Post-merge full wasm suite under Node 22.23.1: exit 0; all runnable tests passed with the same 29 intentional skips.
- MCP temp-directory count stayed at 43 before and after the post-merge full suite; no leak was introduced.
- This final worklog update is included in the merge commit. Feature-branch/worktree cleanup follows after the commit.
