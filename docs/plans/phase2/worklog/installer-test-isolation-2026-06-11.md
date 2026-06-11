# Installer test isolation fix — opencode env-var sandbox escape (2026-06-11)

**Status**: complete — 1 finding fixed and verified.
**Date**: 2026-06-11
**Source**: deferred item #2 from [phase2-full-review-2026-06-11.md](phase2-full-review-2026-06-11.md). Pre-existing (present since the initial commit), surfaced because the phase-2 review ran the full suite on a Windows machine. Not phase-2 code — but the suite is the 0.7.x installer contract suite the house rules lean on, so the gap was masking 8 contract tests on Windows.

## Finding — `setHome` didn't sandbox opencode's global config resolution

`__tests__/installer-targets.test.ts` redirects the mock home via `HOME` / `USERPROFILE` (the env vars `os.homedir()` reads). But the opencode target ([src/installer/targets/opencode.ts](../../../src/installer/targets/opencode.ts) `globalConfigDir`) resolves its global dir from **`APPDATA`** on Windows and **`XDG_CONFIG_HOME`** on POSIX (when set) — neither was redirected. Every opencode `location=global` test therefore escaped the tmpdir sandbox and operated on the developer's **real** `%APPDATA%\opencode` (or `$XDG_CONFIG_HOME/opencode` on a POSIX machine with custom XDG).

**The leak was destructive, not just flaky:**

- The sibling-preservation contract test **seeds (overwrites)** whatever config file `target.describePaths()` resolves — clobbering the real `opencode.jsonc` with `{ "mcp": { "other": { "command": ["x"] … } } }`.
- The uninstall contract test **removes** `mcp.codegraph` from the real config.
- `install` wrote a real `AGENTS.md` into the real config dir.

On this machine the suite had created the entire `%APPDATA%\opencode\` directory (junk `"other"` server + codegraph entry + AGENTS.md). Directory **creation** time matched the test run and opencode is not installed here, so no genuine user config was lost; the fallout directory was deleted as cleanup. On a machine where opencode IS configured, the same suite would have corrupted the real config — this is the strongest argument for the fix beyond the 8 red tests.

Secondary issues exposed once the sandbox held:

- Seven opencode tests hardcoded the POSIX layout `path.join(tmpHome, '.config', 'opencode')`, which is not where the (correct) Windows resolution points.
- The local-install test asserted `/`-separated path suffixes (`p.endsWith('/opencode.jsonc')`), failing against Windows backslashes.

## Fix (test-only — `src/installer` untouched; `%APPDATA%` IS opencode's correct Windows location)

| Change | Detail |
|---|---|
| `setHome` extended | Also sets `APPDATA = <tmpHome>\AppData\Roaming` and `XDG_CONFIG_HOME = <tmpHome>/.config`; restore handles all four vars uniformly. Comment documents the destructive-leak rationale |
| `opencodeGlobalDir(home)` helper | Mirrors the target's platform logic (`AppData/Roaming/opencode` on win32, `.config/opencode` elsewhere). All 8 hardcoded `.config/opencode` sites replaced — tests now exercise the real per-platform resolution instead of assuming POSIX |
| `toPosix(p)` normalizer | Backslash→slash before suffix assertions in the local-install test |

## Verification

- `installer-targets.test.ts`: **56/56** on Windows (was 48/56). Legacy `installer.test.ts` 8/8 (it never touched opencode global paths — audited).
- Post-run leak check: real `%APPDATA%\opencode` is **not recreated** by the suite.
- Full suite: **809 passed / 6 failed** (was 802/14). The remaining 6 are the previously-baselined wasm-adapter (`VACUUM`, double-`close()`) and Windows temp-dir EPERM issues — all verified pre-existing on the initial commit (see deferred item #3 in the full-review worklog).

## Files changed

| File | Change |
|---|---|
| `__tests__/installer-targets.test.ts` | `setHome` env coverage (+`APPDATA`, +`XDG_CONFIG_HOME`); `opencodeGlobalDir` + `toPosix` helpers; 8 path sites + 2 suffix assertions made platform-aware |

## Pattern note

Same shape as the P1 plan's "detection timing" bug (R1-F2): a mock that covers the *common* resolution path (`os.homedir()`) silently misses a target that resolves through a *different* channel (`process.env.APPDATA`). When a target class gains a new config-location mechanism, the test harness's sandbox must be audited against every env var / API the resolution chain reads — not just the one the other targets use. If a future target reads e.g. `LOCALAPPDATA` or a registry key, `setHome` needs a matching extension.

## Effort

~45 min AI-paced: root-cause + fix + real-AppData damage audit/cleanup + full-suite re-baseline + worklog.
