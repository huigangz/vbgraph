# vbgraph

**Local-first code intelligence for AI coding agents — with first-class VB.NET and Delphi support.**

vbgraph parses your codebase with tree-sitter (plus optional compiler-grade [SCIP](https://github.com/sourcegraph/scip) indexes), stores every symbol, edge, and file in a local SQLite knowledge graph, and serves it to AI agents over MCP. Agents answer structural questions — *what calls this, what breaks if I change it, where is it defined* — in one tool call instead of dozens of grep/read round-trips.

> vbgraph is a fork of [codegraph](https://github.com/colbymchenry/codegraph) by Colby Mchenry (MIT), extended with VB.NET and Delphi extraction, SCIP ingestion for legacy .NET codebases, and ongoing divergent development.

- **100% local** — no API keys, no telemetry, no network calls. Your code never leaves your machine.
- **Deterministic** — extraction is derived from the AST, not LLM-summarized.
- **Legacy-friendly** — VB.NET (tier-0 tree-sitter + scip-dotnet), Delphi/Pascal (including DFM/FMX form files), alongside 18 modern languages.

## Install

```bash
npx vbgraph
```

The interactive installer configures the MCP server and instructions for your agents — Claude Code, Cursor, Codex CLI, and opencode are supported.

Then, in each project you want indexed:

```bash
cd your-project
vbgraph init -i
```

## What agents get

Nine MCP tools over the graph:

| Tool | Answers |
|---|---|
| `vbgraph_explore` | "How does X work?" — line-numbered source across many files in one call |
| `vbgraph_search` | "Where is X defined?" — full-text symbol search (FTS5), filterable by framework tag |
| `vbgraph_callers` / `vbgraph_callees` | "What calls Y?" / "What does Y call?" — with confidence tiers |
| `vbgraph_impact` | "What would break if I changed Z?" — impact radius |
| `vbgraph_node` | Signature / source / docstring of a symbol |
| `vbgraph_context` | Focused context bundle for a task or area |
| `vbgraph_files` | File listing under a path |
| `vbgraph_status` | Index health |

The graph stays fresh automatically: a native file watcher (FSEvents / inotify / ReadDirectoryChangesW) re-indexes changed files with debounce, zero config.

## Languages

TypeScript / TSX, JavaScript / JSX, Python, Go, Rust, Java, C, C++, C#, **VB.NET**, PHP, Ruby, Swift, Kotlin, Dart, Scala, Svelte, Vue, Liquid, **Pascal / Delphi** (`.pas`, `.dpr`, `.dpk`, `.lpr`, plus DFM/FMX form files).

Framework-aware route extraction covers Express, Django, Flask, FastAPI, Laravel, Rails, Spring, Gin, Axum, ASP.NET, Vapor, React Router, SvelteKit, and Vue/Nuxt.

### Compiler-grade precision via SCIP

Where a [SCIP indexer](https://sourcegraph.com/docs/code-search/code-navigation/precise_code_navigation) is installed (`scip-dotnet` for C#/VB.NET, `scip-java`, `scip-typescript`, `scip-python`, and more), vbgraph ingests its output and layers compiler-accurate symbols and references on top of the tree-sitter baseline:

```bash
vbgraph index --scip-auto      # detect installed indexers and run them
vbgraph index --scip out.scip  # or ingest an existing index (CI-friendly)
```

## CLI

```bash
vbgraph install     # configure agents (same as bare `npx vbgraph`)
vbgraph init        # initialize .vbgraph/ in a project
vbgraph index       # (re)index
vbgraph sync        # incremental sync
vbgraph status      # index health, backend (native/wasm), SCIP coverage
vbgraph query <q>   # search from the terminal
vbgraph affected <file>  # impact analysis
vbgraph serve --mcp # run the MCP server (agents do this for you)
```

Requires Node 18–24. SQLite runs on `better-sqlite3` (native) with a transparent `node-sqlite3-wasm` fallback.

## License

MIT — see [LICENSE](LICENSE). Original work Copyright (c) 2026 Colby Mchenry ([codegraph](https://github.com/colbymchenry/codegraph)); vbgraph modifications Copyright (c) 2026 Huigang Zuo.
