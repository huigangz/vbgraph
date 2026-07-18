# Changelog

All notable changes to vbgraph are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

vbgraph is a fork of [codegraph](https://github.com/colbymchenry/codegraph);
the upstream changelog up to the fork point is archived in
[CHANGELOG-upstream.md](CHANGELOG-upstream.md).

## [1.0.0-rc.0] - Unreleased

First vbgraph release candidate — the codegraph → vbgraph rebrand.

### Changed

- Package renamed to `vbgraph`; the CLI command is now `vbgraph`.
- Per-project data directory renamed from `.codegraph/` to `.vbgraph/`
  (derived data — delete the old directory and re-run `vbgraph index`).
- MCP server and all nine tools renamed (`codegraph_search` → `vbgraph_search`,
  etc.); agent instructions and installer templates updated to match.
- Environment variables renamed from `CODEGRAPH_*` to `VBGRAPH_*`.
- Codex MCP config table renamed to `[mcp_servers.vbgraph]`; installer section
  markers renamed to `VBGRAPH_SECTION_START/END`.
- Public API class renamed `CodeGraph` → `VBGraph`.

### Fixed

- Schema-version stale-guard test asserted version 4 while the schema was at 7;
  it only ran with native better-sqlite3 installed, which masked it.

### Migration from codegraph installs

Machines with an old codegraph install must uninstall with the **old** binary
first (`codegraph uninstall` or `npm uninstall -g @colbymchenry/codegraph`) —
the new installer does not recognize the old section markers or MCP entries.
Then install vbgraph and re-run `vbgraph init` in each project.

[1.0.0-rc.0]: https://github.com/huigangz/vbgraph/releases
