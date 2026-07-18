# VBGraph SCIP-refresh scheduling templates

Templates for running `vbgraph scip-refresh` on a schedule. One template per
host OS — pick the one that matches your machine, customize the placeholders,
and install per the instructions in the template's own header.

## Why schedule a refresh

When you edit a SCIP-covered file, [P2.2's stale-aware sync](../plans/phase2/worklog/P2.2.md)
marks the SCIP rows hidden-stale and runs tree-sitter as a shadow. Queries
keep working — they just see tree-sitter precision instead of compiler-grade
precision until the next refresh.

A nightly refresh keeps the stale window bounded to roughly one day. Without
scheduling, you'd run `vbgraph scip-refresh` manually whenever your
agent's results start to feel imprecise.

## Templates

| OS | File | Install command (after editing placeholders) |
|---|---|---|
| macOS | [launchd.plist.template](launchd.plist.template) | `launchctl load -w ~/Library/LaunchAgents/com.vbgraph.scip-refresh.plist` |
| Linux | [systemd.service.template](systemd.service.template) + [systemd.timer.template](systemd.timer.template) | `systemctl --user enable --now vbgraph-scip-refresh.timer` |
| Windows | [task-scheduler.xml.template](task-scheduler.xml.template) | `schtasks /Create /XML vbgraph-scip-refresh.xml /TN "VBGraphScipRefresh"` |

All three default to **daily at 03:00 local time**. Change the schedule in the
template's calendar / trigger section if that doesn't fit.

## What the refresh does

1. Acquires the cross-process `FileLock` at `.vbgraph/vbgraph.lock`. If
   another `vbgraph` process is indexing or refreshing, returns the
   `lock-failed` phase (exit code 1) without touching the database.
2. Spawns `config.scipRefreshCommand` (default `'scip-dotnet index ./'`).
3. Captures stdout/stderr to `.vbgraph/logs/scip-refresh-<timestamp>.log`.
4. Re-ingests the produced `.scip` file via P0's STAGE B pipeline — scoped
   delete of prior SCIP-owned rows, recreates empty-document fallback rows
   for SCIP docs with zero occurrences, then re-inserts fresh ones.
5. Runs a narrow post-ingest assertion: each refreshed file must have zero
   `provenance = 'tree-sitter'` rows (sync's shadow leftovers).
6. Reruns reference resolution and Phase 3 framework synthesis so derived
   data (framework tags, scope-resolved edges) stays consistent with the
   refreshed SCIP graph. Recoverable per-resolver errors are captured —
   they do NOT fail the exit code (SCIP data is still fresh), but they
   are surfaced via stderr, the per-run log, and the sidecar `lastError`.
7. Writes `.vbgraph/scip-last-refresh.json` with `refreshedAt`,
   `scipPath`, `command`, `filesCovered`, `durationMs`, and `lastError`
   (string when derived rebuild had issues; `null` on a fully clean run).

See [P2.3 worklog](../plans/phase2/worklog/P2.3.md) for the full lifecycle
(including post-ship review-round-4 updates) and
[design Decision 1](../plans/phase2/P2.0-design.md) for the refresh-purges-shadow
invariant.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Refresh succeeded and post-ingest assertion passed. |
| 1 | Indexer failed (non-zero exit, crash, or missing output file) OR another `vbgraph` process is holding the cross-process file lock. |
| 2 | Ingest failed (corrupt `.scip`, persister error, or assertion caught a leaked shadow row). |

> **Shell-scripter gotcha**: exit 0 is **not** sufficient to claim "the refresh
> fully succeeded." Phase 3 / resolution can drop framework tags or
> scope-resolved edges on a refresh that nonetheless produces fresh SCIP
> data — the exit code stays 0 because the SCIP graph IS correct; only
> derived state is broken. If you script around `vbgraph scip-refresh`
> with `&& …` or `$?`-based logic, also check the sidecar's `lastError`
> field (it is `null` on a fully-clean refresh and a non-empty string
> otherwise). Example:
>
> ```bash
> vbgraph scip-refresh --quiet
> rc=$?
> if [ "$rc" -ne 0 ]; then
>   echo "refresh failed with exit $rc"; exit "$rc"
> fi
> if [ "$(jq -r .lastError .vbgraph/scip-last-refresh.json)" != "null" ]; then
>   echo "refresh produced fresh SCIP but derived data partially failed — see log"
>   # decision: page, alert, or just continue — derived state self-heals on next sync
> fi
> ```
>
> The three persistence channels (stderr, per-run log, sidecar) below let you
> pick the one that best fits your monitoring stack.

All three OS schedulers surface non-zero exit codes:

- **launchd** — write to `StandardErrorPath` and visible via `launchctl list`.
- **systemd** — `systemctl --user status vbgraph-scip-refresh` shows "failed";
  `journalctl --user -u vbgraph-scip-refresh -e` has the captured stderr.
- **Task Scheduler** — Task Scheduler History pane; "Last Run Result" column.

## Warnings on exit 0 (derived-data issues)

Phase 3 / resolution failures during refresh leave the SCIP data fresh
but partially break framework tags or scope-resolved edges. These DO NOT
fail the exit code (refresh stays 0). To surface the warning under
`--quiet` scheduling, VBGraph writes the same message to three places:

1. **stderr** — captured by launchd (`StandardErrorPath`), journald
   (systemd), and Task Scheduler when wrapped with `cmd.exe /c ... 2>>`
   per the template comment.
2. **Per-run log file** — `.vbgraph/logs/scip-refresh-<timestamp>.log`
   gets a `[vbgraph derived-data warning <iso>]` section appended.
   Persistent across runs.
3. **Sidecar** — `.vbgraph/scip-last-refresh.json` includes a
   `lastError` field (string or null). `vbgraph status` surfaces it
   inline with the last-refresh line.

Pollers can monitor either the per-run log or the sidecar regardless of
scheduler stdout/stderr capture.

## Customizing the command

Override the spawn command per project in `.vbgraph/config.json`:

```jsonc
{
  // String form — whitespace-tokenized.
  "scipRefreshCommand": "scip-java index ./",

  // OR array form for paths with spaces.
  "scipRefreshCommand": ["scip-go", "index", "C:/Path With Spaces/"],

  // Output location — default './index.scip'.
  "scipRefreshOutputPath": "./scip-output/build.scip"
}
```

The CLI also accepts `--cmd` and `--scip-output` for one-off overrides without
editing config:

```sh
vbgraph scip-refresh --cmd "scip-typescript index" --scip-output ./out.scip
```

## Verifying the schedule worked

After install, check status after the next scheduled fire:

```sh
vbgraph status
# ...
# SCIP:
#   Last refresh:  2h ago — 1,234 file(s) in 5.6s
```

Or read the sidecar directly:

```sh
cat .vbgraph/scip-last-refresh.json
```

## Out of scope for these templates

- **Multi-indexer refresh** (running `scip-dotnet` + `scip-typescript` on the
  same project). `scip-refresh` runs one command; the broader sweep is what
  `vbgraph index --scip-auto` does at index time. P3 may add `--scip-auto`
  to `scip-refresh`.
- **Cross-platform installer** (`vbgraph schedule install`). The plan ships
  templates only; the helper is deferred.
- **Email / Slack notification on failure** — outside the scheduler scope;
  pipe exit codes to your own alerting.
