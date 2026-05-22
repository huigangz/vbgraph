# CodeGraph SCIP Ingestion — Implementation Plan

> General-purpose SCIP file ingestion for CodeGraph. Lifts indexing precision to compiler-grade for every language with a Sourcegraph SCIP indexer (.NET C#/VB.NET, Java, Kotlin, Scala, Rust, TypeScript, Python, Go, Ruby). Tree-sitter remains the always-available baseline; SCIP layers on top when the toolchain is installed.

## Product layering

| Tier | What it is | When it applies |
|---|---|---|
| **Tier 0 — Tree-sitter** | Default. Zero toolchain. One command (`codegraph index ./`), ~3s indexing, ~80% precision. Covers all supported languages including VB.NET via bundled WASM grammar. | Always available |
| **Tier 1 — SCIP opt-in** | `codegraph index --scip-auto` detects installed SCIP indexers and only enables SCIP for languages where the user has the toolchain. Compiler-grade precision. Requires project to build. | Opt-in per-language |
| **Tier 2 — SCIP CI mode** | Pre-built `.scip` artifacts produced in CI, consumed via `codegraph index --scip <path>`. Local has zero toolchain; CI does the heavy lifting. | Out of scope for v1; see "Out of scope" |

## Context

### Why SCIP

CodeGraph's existing tree-sitter pipeline produces a syntactic graph. For statically-typed, compiler-driven languages, a syntactic parser cannot resolve:

- Compiler-synthesized members (e.g., VB's `My.*` namespace)
- Project-/solution-level configuration (e.g., `.vbproj` XML `Imports`, `.csproj` references)
- Auto-event-binding (`WithEvents` + `Handles`)
- Late binding (`Option Strict Off`)
- Conditional compilation (`#If` / `#define`)
- Cross-project / cross-module symbol references
- Overload resolution

Sourcegraph's SCIP indexers (Roslyn-backed `scip-dotnet`, `scip-java`, `scip-typescript`, etc.) emit a `.scip` file that captures all of these as a stable on-disk format. Ingesting `.scip` files into CodeGraph promotes the affected languages to compiler-grade precision in a single investment.

### Why Tier 0 is first-class

SCIP indexers require heavy toolchains (`.NET SDK` ~500MB, JDK 11+, Rust toolchain, etc.) plus a buildable project (`dotnet restore`, `dotnet build`, equivalents). Users running `codegraph index` for the first time expect a one-command zero-dependency experience comparable to other code-graph tools. Tier 0 (tree-sitter) is that baseline.

VB.NET is covered by a bundled tree-sitter WASM grammar so that users without `.NET SDK` still get a usable graph for `.vb` files. Tier 0 precision is ~70% of SCIP; the compiler-magic features remain SCIP-only territory.

### CodeGraph vs SCIP

SCIP is a data format / extraction layer. CodeGraph is the storage + query + AI-context-shaping layer (SQLite, `codegraph_context`, `codegraph_explore`, MCP server, CLI). The two are complementary, not substitutes.

### Coverage analysis (L2/L3)

| Layer | Tree-sitter only | After SCIP + framework augment |
|---|---|---|
| L2 Symbol Index | Heuristic | **Compiler-grade** for SCIP-covered languages |
| L3 Static call graph + type hierarchy | Heuristic | **Compiler-grade** for SCIP-covered languages |
| L3 Framework / convention / configuration edges (routes, DI bindings, components) | Partial (existing framework resolvers) | **Preserved and strengthened** — SCIP cannot see these |
| L3 Dynamic / reflection edges (`Activator.CreateInstance`, late binding) | None | None (no static analyzer can recover these) |
| L0 Repo map / L1 Domain ontology | Weak / none | Unchanged (separate work) |

SCIP fills L2 and the static portion of L3. Framework resolvers continue to own the convention layer. Dynamic relationships remain out of reach for any static tool. L0/L1 are out of scope.

### Key architecture decisions

1. **SCIP integration strategy**: file-format ingestion. CodeGraph reads `.scip` files; it does not embed any SCIP indexer's source code. Users generate `.scip` files however they want — `--scip-auto` (spawn detected indexers), `--scip <path>` (CI / cron pre-built), or any external process.

2. **Framework resolver API**: full refactor to `synthesize` / `augment` (deprecate per-file `extract` / `resolve`). Resolvers see the full graph after static extraction and contribute new nodes + edges + tags.

3. **DI binding-style "convention" edges**: reuse the existing `references` edge kind plus a new `subkind` column (e.g., `subkind='di_binding'`). Avoids touching the `EdgeKind` union and all graph-query code paths.

4. **Sync model**: tree-sitter shadow on file change + nightly cron refresh + language-aware staleness. Files whose language has a shadow-capable extractor get fresh tree-sitter on change and stale SCIP is hidden; files without (e.g., `.vb` in P0.6b's narrow Tier 0 case — see P2) keep stale SCIP visible with a staleness annotation.

5. **VB.NET Tier 0 backstop**: built as a minimal tree-sitter extractor (~70% of SCIP precision). Covers Module / Class / Namespace nodes, Sub / Function / Property signatures, Inherits / Implements within a file, file-local calls, per-file Imports. Skips compiler-magic features (those remain SCIP-only).

6. **Toolchain auto-detection**: `codegraph index --scip-auto` probes `PATH` for installed SCIP indexers and only enables SCIP for languages where the indexer is present. Mixed-toolchain repos (Java-installed-but-not-.NET) get partial SCIP coverage gracefully rather than binary success/fail.

7. **Build-failure tolerance as a hard invariant**: any SCIP failure mode — missing indexer, `dotnet restore` failure, `dotnet build` failure, mid-run OOM, partially-corrupt `.scip` — degrades cleanly to tree-sitter for the affected files. CodeGraph never becomes unusable because SCIP failed.

## Architecture: extraction pipeline

```
Phase 0: Toolchain detection
  scan PATH for installed SCIP indexers (scip-dotnet, scip-java, scip-typescript, etc.)
  build effective_scip_coverage = { language: indexer_installed } map

Phase 1: Static extraction (per file)
  if SCIP covers this file AND effective_scip_coverage[file.lang]:
    use SCIP-derived nodes/edges                  (provenance='scip',         conf=1.0)
  elif a shadow-capable extractor exists (WASM grammar OR custom svelte/vue/liquid):
    tree-sitter extract                            (provenance='tree-sitter',  conf=0.7)
  else:
    skip

Phase 2: Static resolution (only against tree-sitter's unresolved references)
  scope-index lookup (csharp/vbnet/java/python/ts) (provenance='scope-resolved', conf=0.75)
  import-resolver + name-matcher (fallback)         (provenance='heuristic',    conf=0.6)
  // SCIP edges skip this phase — already pre-resolved by the indexer

Phase 3: Framework augmentation (whole-graph)
  for each detected framework: synthesize() → new nodes
  rebuild GraphView snapshot
  for each detected framework: augment() → new edges + tags
                                                     (provenance='framework:N', conf=0.85)

Phase 4: Persist with dedup
  Nodes: dedup by id; priority scip > tree-sitter > framework
  Edges: UNIQUE INDEX (source, target, kind, COALESCE(subkind,''),
                       COALESCE(line,-1), COALESCE(col,-1))
         Application-level upsert merges provenances[] and metadata JSON.
         Single-value provenance column = primary (highest-priority) extractor.
```

### Naming alignment with existing schema

- `edges.provenance` already exists (`schema.sql:52`). This plan **extends the union** rather than introducing a new `extractor` column.
- `edges.metadata` already exists (`schema.sql:49`). Reused.
- `nodes.docstring` already exists, integrated with FTS5 BM25 weights. External SCIP symbol documentation maps onto this field.
- DB column is `col`, TS field is `column` — existing `insertEdge` / `rowToEdge` already handle this binding-boundary mapping. New code must do the same.

### Type system

```ts
type GraphProvenance =
  | 'tree-sitter'
  | 'tree-sitter (scip-empty-fallback)'
  | 'scope-resolved'
  | 'scip'
  | 'scip:external'
  | 'heuristic'
  | `framework:${string}`;
```

Used by both `Node.provenance` and `Edge.provenance`. Optional on both (default `'tree-sitter'`) so existing object-literal constructions don't break.

Derived `ConfidenceTier` (computed by P0.4d, not stored):

```ts
type ConfidenceTier =
  | 'compiler'        // provenance ∈ {scip, scip:external}
  | 'syntactic'       // provenance ∈ {tree-sitter, tree-sitter (scip-empty-fallback)}
  | 'scope-resolved'  // provenance = 'scope-resolved'
  | 'inferred'        // provenance ∈ {heuristic, framework:*}
  | 'ambiguous';      // unresolved placeholder
```

### Edge line/column invariant (three-tier)

| Kind + subkind | line / column requirement |
|---|---|
| `calls` (any subkind) | **REQUIRED** |
| `references` with no subkind or `subkind='direct_ref'` | **REQUIRED** |
| `references` with framework subkind (`'di_binding'`, `'config'`, `'convention'`, whitelisted) | **NULL allowed** |
| `instantiates` (promoted from `calls`) and `implements` (promoted from `extends`) | **OPTIONAL** — promotion preserves source location |
| `contains`, `extends`, `type_of`, `returns`, `overrides`, `decorates`, `imports`, `exports` | **FORBIDDEN** — pure symbol-to-symbol relations |

A `validateEdgeLineColumn(edge)` helper enforces this. Allowlist `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION = new Set(['di_binding', 'config', 'convention'])` is checked when classifying.

## PR breakdown

| PR | Scope | Effort | User-visible benefit |
|---|---|---|---|
| **P0** | Toolchain detection + `--scip-auto`, VB.NET Tier 0 extractor, streaming SCIP ingester, DB provenance, multi-index scope, unified edge upsert, scope-resolution parity infra, build-failure tolerance, VB.NET validation | ~21 days | `codegraph index ./` works on any codebase with zero toolchain. For users with `scip-dotnet` installed, `--scip-auto` promotes to compiler-grade. Any SCIP failure degrades cleanly. |
| **P1** | FrameworkResolver synthesize/augment refactor, GraphView, node_tags, migrate 14+2 resolvers | ~12 days | Framework edges (routes, DI bindings, component references) resolve against compiler-precise type info under the SCIP backend |
| **P2** | scip-aware sync with stale flag + language-aware shadow + `codegraph scip-refresh` + cron templates | ~5 days | Editing a file no longer requires manual re-indexing; nightly cron auto-refreshes; `codegraph status` reports staleness transparently |

Total: ~38 days. P0 is fully detailed below. P1 is directional — its detailed PR plan should be written after P0 lands. P2 is detailed.

---

# P0 — SCIP Ingester + DB Provenance + Multi-Index Management

## Ship gates

1. `codegraph index ./vbnet-sample/` works **with no .NET SDK installed**, producing L2 symbol nodes (Module, Class, Namespace, Interface, Structure, Enum, Sub, Function, Property), `contains` containment edges, file-local `Imports`, and **file-local call** edges.

   **Revised (P0.6b finding):** `Inherits` / `Implements` relationship edges are **not** a Tier-0 requirement. The available community VB.NET tree-sitter grammar (`CodeAnt-AI/tree-sitter-vb-dotnet`, pinned commit `cfca210`) misparses `Inherits` / `Implements` statements, so VB inheritance edges are **SCIP-only (Tier 1)**. The core `extractInheritance` is already wired for an `inherits_clause` node, so a future grammar fix enables them with no code change. `Structure` / `Enum` extraction was a follow-up — **resolved 2026-05-21**: `extractStruct` now uses the `resolveBody` fallback (VB members are direct children, not a `body` field), so `Structure` / `Enum` produce nodes. See `worklog/P0.6b.md`.
2. `codegraph index ./` on a mixed-language repo without any SCIP indexers installed completes successfully, producing tree-sitter graphs for every supported language including `.vb`.
3. CLI output after a Tier 0 index informs the user which languages would benefit from a SCIP indexer and how to install it.
4. `scip-dotnet index ./ && codegraph index --scip ./index.scip` yields a complete .NET project graph with cross-file edges and multiple call sites correctly distinguished.
5. Multiple `--scip` flags compose cleanly with strict scoping. Overlapping coverage (same source file in two different `.scip` files) is rejected with a clear error and **leaves the DB completely unchanged**.
6. Large `.scip` files (500 MB+, 1M definitions, 100k external symbols) ingest with RSS delta below 200 MB.
7. Every SCIP-covered file gets a `files` table row with the correct language (so P2's shadow policy can decide per-language behavior).
8. Files that newly become SCIP-covered have their previous tree-sitter nodes/edges cleaned up.
9. Edge dedup preserves call-site semantics: the same `caller → callee` at different source lines remains distinct rows.
10. External SCIP symbols (referenced but defined outside the index, e.g., `System.Console.WriteLine`) become well-formed `Node` rows with a clearly defined synthetic shape.
11. An incomplete ingestion left over from a prior crash never leaks into query results.
12. **Auto-mode failure tolerance**: under `codegraph index --scip-auto`, every detectable failure mode — missing `scip-dotnet` from PATH, `dotnet restore` failure, `dotnet build` failure, mid-run OOM, indexer-produced `.scip` truncation or corruption — degrades to tree-sitter for the affected files with a clear log message. The overall ingest exits 0 and produces a usable graph.
12a. **Explicit `--scip <path>` fail-fast on caller-supplied bad input**: when the user passes `--scip <path>` referring to a corrupted or unreadable `.scip` file, ingest exits non-zero with a clear error message AND **leaves the DB completely unchanged** (STAGE A pre-scan rejects before any mutation). This is the deliberate distinction from gate 12 — auto-spawned `.scip` artifacts are CodeGraph's responsibility to recover from; user-supplied `.scip` paths are caller-asserted-valid inputs, and silent fallback would hide the user's mistake.
13. `codegraph index --scip-auto` on a polyglot repo where only some indexers are installed produces a SCIP graph for the covered languages and a tree-sitter graph for the rest, without errors.
14. **Resolution parity**: on the VB.NET validation fixture, running tree-sitter alone produces a graph whose `(source qualified name → target qualified name, kind)` triples are a strict subset of (or equivalent to) the SCIP-produced graph for non-compiler-magic features. Parity test report flags any divergence.

## P0.0 — Toolchain detection + `--scip-auto`

### Detection

`src/extraction/scip/detect-indexers.ts`:

```ts
interface ScipIndexerSpec {
  name: string;                            // 'scip-dotnet'
  cmd: string;                             // binary name to look up on PATH
  languages: Language[];                   // ['csharp', 'vbnet']
  installHint: string;                     // 'dotnet tool install -g scip-dotnet'
  versionFlag?: string;                    // e.g. '--version' if supported
}

const SCIP_INDEXERS: ScipIndexerSpec[] = [
  { name: 'scip-dotnet',     cmd: 'scip-dotnet',     languages: ['csharp', 'vbnet'],
    installHint: 'dotnet tool install -g scip-dotnet' },
  { name: 'scip-java',       cmd: 'scip-java',       languages: ['java', 'kotlin', 'scala'],
    installHint: 'brew install sourcegraph/sourcegraph/scip-java' },
  { name: 'scip-typescript', cmd: 'scip-typescript', languages: ['typescript', 'javascript'],
    installHint: 'npm install -g @sourcegraph/scip-typescript' },
  { name: 'scip-python',     cmd: 'scip-python',     languages: ['python'],
    installHint: 'npm install -g @sourcegraph/scip-python' },
  { name: 'scip-go',         cmd: 'scip-go',         languages: ['go'],
    installHint: 'go install github.com/sourcegraph/scip-go/cmd/scip-go@latest' },
  { name: 'scip-rust',       cmd: 'scip-rust',       languages: ['rust'],
    installHint: 'cargo install scip-rust' },
  { name: 'scip-ruby',       cmd: 'scip-ruby',       languages: ['ruby'],
    installHint: 'gem install scip-ruby' },
];

export interface DetectedIndexer extends ScipIndexerSpec {
  resolvedPath: string;
  version?: string;
}

export async function detectInstalledScipIndexers(): Promise<DetectedIndexer[]>;
```

Implementation:

- Use the **npm `which` package** (cross-platform; handles Windows `where.exe` vs Unix `which`). Add as a runtime dependency. Avoid raw `child_process.exec('which X')` because Windows portability is brittle.
- For each candidate: `which(spec.cmd).catch(() => null)`. Found → proceed; not found → exclude from `DetectedIndexer[]`.
- **Version probe semantics**: if found, spawn `${spec.cmd} --version` with a 2-second timeout.
  - Success + parseable output → record `version: <parsed>`.
  - Success + unparseable output → record `version: 'unknown'` (do NOT exclude).
  - Failure (unknown flag / timeout) → record `version: 'unknown'` (do NOT exclude).
  - **Invariant**: a detected indexer is NEVER excluded based on version probe alone. Version is informational, used for warnings (e.g., "scip-dotnet v<old> predates SCIP 0.3 metadata — some fields may be missing").
- **Cache**: result is cached in-memory per Node.js process (single `codegraph` invocation = single process). Not persisted across runs because toolchain state can change between invocations.
- Detection is sequential (~milliseconds per candidate); no concurrency.

### CLI surface

| Command | Behavior |
|---|---|
| `codegraph index ./` | Tier 0 only (tree-sitter for every supported language). Prints a hint listing detected-but-uninstalled indexers and their `installHint`s. |
| `codegraph index --scip-auto` | Detect installed indexers; spawn each for its language subset that exists in the repo; ingest the resulting `.scip` files; tree-sitter the rest. |
| `codegraph index --scip-auto --languages java,python` | Restrict auto mode to a specific language subset. |
| `codegraph index --scip <path>` | Explicit pre-built `.scip` ingestion (CI / cron). Flag is repeatable for multiple indexes. |
| `codegraph index --scip-auto --scip ./extra.scip` | Combine. **Precedence**: user-supplied `--scip <path>` takes priority. Before auto-spawn, each provided `.scip` is pre-scanned (P0.4 STAGE A); if it covers files an auto-detectable indexer would also produce, the auto-spawn for that indexer is **skipped**. Prevents `MultiIndexConflictError`. If precedence cannot be resolved (e.g., pre-built `.scip` covers only a subset of an indexer's languages), error with `"Cannot combine pre-built --scip path with --scip-auto for partially-overlapping coverage."`. |
| `codegraph index --no-scip` | Force Tier 0 even if SCIP indexers are present (debugging or speed). |

### Spawn orchestration

**Concurrency model**: indexers run **sequentially** (one at a time). Deterministic order: scip-typescript, scip-python, scip-go, scip-ruby, scip-rust, scip-java, scip-dotnet (lightest-first; .NET typically slowest). Parallel spawn is deferred to P3.

**Process lock**: at start of `--scip-auto`, acquire `.codegraph/.scip-auto.lock` (advisory lock file containing PID + timestamp). If lock exists and PID is still alive, error: `"Another codegraph --scip-auto is running (PID X). Wait or remove .codegraph/.scip-auto.lock manually."`. Lock is released on normal exit AND on SIGINT/SIGTERM via cleanup handler.

For each detected indexer × languages-present-in-repo:

1. Spawn the indexer with a CodeGraph-managed `--output` path under `.codegraph/scip-cache/<indexer-name>.scip`.
2. Capture stdout/stderr to `.codegraph/logs/<indexer-name>-<timestamp>.log`.
3. On success, ingest the produced `.scip` via the P0.5 ingester orchestration.
4. On failure, **continue with the next indexer**. Record the failure in P0.4c's failure ledger.
5. After all indexers, run tree-sitter on the *remaining* files (those not SCIP-covered per `scip_documents`).

**Per-indexer failure isolation invariant**: when indexer N fails, the SCIP ingest results from indexers 1..N-1 are **preserved intact**. The failed indexer's `scip_documents` rows are simply absent; its files fall back to tree-sitter at step 5. There is no global rollback across indexers.

**Partial-build case**: if scip-dotnet succeeds for 80% of `.cs` files and fails for 20% (build errors on specific files), the successful 80% appear in `scip_documents` with `provenance='scip'`; the failed 20% have no `scip_documents` row, so step 5's tree-sitter pass picks them up. The P0.4c failure ledger records this as `mode='build-failed'` with `filesAffected=<N>`.

### Verification

- Unit test: mock `which` to return success for `scip-dotnet` only; run `--scip-auto` on a mixed C#/Java repo; assert C# files have `provenance='scip'`, Java files have `provenance='tree-sitter'`.
- Unit test: mock `which` to return no SCIP indexers; run `--scip-auto`; assert the run completes successfully with all files `provenance='tree-sitter'`.
- Integration test: actually run `scip-dotnet` if available in CI matrix; assert the output graph matches `--scip <pre-built-path>` behavior.

**Effort: 1.5 days**

## P0.1 — True streaming decoder (implementation risk red line)

Three streaming APIs, all decode wire-format manually:

```ts
export async function readScipMetadata(scipPath: string): Promise<Metadata>;
export async function* iterateScipDocuments(scipPath: string): AsyncIterable<Document>;
export async function* iterateScipExternalSymbols(scipPath: string): AsyncIterable<SymbolInformation>;
```

### Mandatory implementation constraints

Without these, the memory budget is unmet:

- **Do not** use `protobufjs.Type.decode(fs.readFileSync(scipPath))` — that loads the entire `Index` message into memory.
- **Do not** call `protobuf.load(scipPath)` thinking it's data — that loads `.proto` schemas, not `.scip` files.
- **Do** write a wire-level reader:
  1. `fs.createReadStream(scipPath)` for chunked buffers.
  2. Maintain a small accumulating buffer.
  3. Decode the `Index` top-level fields by tag; for repeated fields 2 (`documents`) and 3 (`external_symbols`), read each length-delimited submessage, call `Document.decode(bytes)` / `SymbolInformation.decode(bytes)`, yield, and release.
  4. Make no assumption about field ordering — handle fields as encountered.
  5. The JS process holds only the single currently-decoding message plus the chunked buffer (a few MB at most).

### Verification

- Unit test: synthesize a 500 MB `.scip` fixture; measure `process.memoryUsage().rss` delta during `iterateScipDocuments` (expect < 50 MB).
- Unit test: after iteration completes and GC runs, RSS returns to baseline (no leaks).

**Effort: 2 days**

## P0.2 — Protobuf tooling (runtime only)

Decision: **no code generation**. Use `protobufjs` runtime reflection only. The wire-level decoder in P0.1 already does its own top-level parsing; `protobufjs` is only used as a fallback for individual `Document` / `SymbolInformation` decoding. Avoids the `protobufjs-cli` devDep and dual `.js` / `.d.ts` artifact management.

Implementation:
- Add `"protobufjs": "^7.x"` to `dependencies`.
- Copy [`sourcegraph/scip/scip.proto`](https://github.com/sourcegraph/scip/blob/main/scip.proto) into `src/extraction/scip/scip.proto` with a header comment pinning the upstream commit hash.
- Runtime: `const root = await protobuf.load(path.join(__dirname, 'scip.proto'))`. Cache `root.lookupType('scip.Document')` and friends.
- Update `package.json` build step to copy `scip.proto` into `dist/`.

**Effort: 0.5 day**

## P0.3 — SCIP symbol parser

`src/extraction/scip/symbol-parser.ts`:

- Parse the SCIP symbol string format: `scheme . package_manager package_name version . descriptors`.
- Descriptor suffix determines default `NodeKind`: `#` = class/type, `.` = method/field, `:` = namespace, `(` = parameter.
- `SymbolInformation.kind` (SCIP 0.3+) overrides the default when present. The value `Module` maps to CodeGraph's `module` node kind (important for VB.NET).
- Hash the SCIP symbol string to produce CodeGraph's `node.id`; preserve the original string in `nodes.scip_symbol`.

**Effort: 0.5 day**

## P0.4 — Persister: six-stage pipeline with pre-scan validation

### Schema additions (executed by P0.9)

```sql
-- Nodes: provenance + scip ownership
ALTER TABLE nodes ADD COLUMN provenance      TEXT DEFAULT 'tree-sitter';
ALTER TABLE nodes ADD COLUMN scip_symbol     TEXT;
ALTER TABLE nodes ADD COLUMN scip_index_path TEXT;    -- which .scip owns this internal-symbol node; NULL for external nodes (their multi-index ownership is tracked in scip_external_refs)
CREATE INDEX idx_nodes_provenance     ON nodes(provenance);
CREATE INDEX idx_nodes_scip_symbol    ON nodes(scip_symbol)     WHERE scip_symbol     IS NOT NULL;
CREATE INDEX idx_nodes_scip_index     ON nodes(scip_index_path) WHERE scip_index_path IS NOT NULL;

-- Edges: extend, do not duplicate metadata/provenance (both already exist)
ALTER TABLE edges ADD COLUMN provenances TEXT;        -- JSON array of GraphProvenance values
ALTER TABLE edges ADD COLUMN confidence  REAL DEFAULT 0.7;
ALTER TABLE edges ADD COLUMN subkind     TEXT;

-- Stale flags reserved at P0 ship time (default 0 = fresh). P0 never sets them to 1,
-- but upsertGraphEdge's UPDATE branch unconditionally writes 0 to maintain the freshness
-- invariant once P2 starts setting them to 1 via the sync path. Indexes and query-filter
-- wiring land in P2.1.
ALTER TABLE nodes ADD COLUMN stale             INTEGER DEFAULT 0;
ALTER TABLE nodes ADD COLUMN staleness_visible INTEGER DEFAULT 0;
ALTER TABLE edges ADD COLUMN stale             INTEGER DEFAULT 0;
ALTER TABLE edges ADD COLUMN staleness_visible INTEGER DEFAULT 0;

-- Edge dedup unique index includes line/col to preserve call-site identity.
-- Migration dedups historical duplicates by keeping MAX(rowid) — the NEWEST row,
-- which is most likely to carry up-to-date provenance/metadata (e.g., a SCIP edge
-- inserted after an earlier tree-sitter edge for the same fingerprint).
DELETE FROM edges WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM edges
  GROUP BY source, target, kind,
           COALESCE(subkind, ''),
           COALESCE(line, -1),
           COALESCE(col, -1)
);
CREATE UNIQUE INDEX idx_edges_dedup ON edges(
  source, target, kind,
  COALESCE(subkind, ''),
  COALESCE(line, -1),
  COALESCE(col, -1)
);

-- SCIP metadata tables
CREATE TABLE scip_documents (
  source_file_path TEXT NOT NULL,
  scip_index_path  TEXT NOT NULL,
  source_hash      TEXT NOT NULL,
  ingested_at      INTEGER NOT NULL,
  PRIMARY KEY (source_file_path, scip_index_path)
);
CREATE INDEX idx_scip_documents_index ON scip_documents(scip_index_path);

CREATE TABLE scip_ingestions (
  scip_index_path  TEXT PRIMARY KEY,
  started_at       INTEGER NOT NULL,
  completed_at     INTEGER,                          -- NULL means crashed mid-ingest
  intended_files   TEXT                              -- JSON array, for crash recovery
);
```

### Six-stage execution flow

```
STAGE A — Validation (no persistent DB writes; TEMP table protected by try/finally)
  CREATE TEMP TABLE IF NOT EXISTS scip_docs_seen (source_file_path TEXT PRIMARY KEY);
  try {
    for await (doc of iterateScipDocuments(scipPath)):
      // (a) Multi-index conflict — file already covered by a different .scip?
      conflict = db.prepare(
        `SELECT scip_index_path FROM scip_documents
         WHERE source_file_path = ? AND scip_index_path != ? LIMIT 1`
      ).get(doc.relativePath, scipPath);
      if (conflict) throw new MultiIndexConflictError(...);

      // (b) Same-.scip duplicate Document.relativePath
      try { db.prepare('INSERT INTO scip_docs_seen VALUES (?)').run(doc.relativePath); }
      catch (e) {
        if (isPkViolation(e)) throw new SameIndexDuplicateDocumentError(...);
        throw e;
      }
  } finally {
    db.exec('DROP TABLE IF EXISTS scip_docs_seen');
  }
  // If either check throws, no persistent state has changed — caller observes
  // the DB exactly as it was before the call.

STAGE B — Destructive setup (single synchronous transaction)
  open tx:
    B.1 Crash recovery: if any prior incomplete ingestion exists for this scipPath, clean it up.
    B.2 Scoped delete of old SCIP/fallback data owned by this scipPath:
          -- Owned (non-external) SCIP nodes/edges for this index
          DELETE FROM edges
          WHERE source IN (SELECT id FROM nodes WHERE scip_index_path = ?)
             OR target IN (SELECT id FROM nodes WHERE scip_index_path = ?);
          DELETE FROM nodes WHERE scip_index_path = ?;

          -- External nodes: drop this index's refs, GC nodes that have no remaining refs
          -- (full SQL + per-endpoint orphan-test rationale in "External node shape" section)
          DELETE FROM scip_external_refs WHERE scip_index_path = ?;
          DELETE FROM edges
          WHERE source IN (
                  SELECT id FROM nodes
                  WHERE provenance = 'scip:external'
                    AND id NOT IN (SELECT external_node_id FROM scip_external_refs)
                )
             OR target IN (
                  SELECT id FROM nodes
                  WHERE provenance = 'scip:external'
                    AND id NOT IN (SELECT external_node_id FROM scip_external_refs)
                );
          DELETE FROM nodes
          WHERE provenance = 'scip:external'
            AND id NOT IN (SELECT external_node_id FROM scip_external_refs);

          -- Compatibility pass for 'tree-sitter (scip-empty-fallback)' nodes,
          -- which are file-path-associated rather than scip_index_path-owned:
          DELETE FROM edges WHERE source IN (
            SELECT id FROM nodes WHERE file_path IN (
              SELECT source_file_path FROM scip_documents WHERE scip_index_path = ?
            ) AND provenance = 'tree-sitter (scip-empty-fallback)'
          ) OR target IN (...);
          DELETE FROM nodes WHERE file_path IN (
            SELECT source_file_path FROM scip_documents WHERE scip_index_path = ?
          ) AND provenance = 'tree-sitter (scip-empty-fallback)';
          DELETE FROM scip_documents WHERE scip_index_path = ?;
    B.3 (Per-document supersede of old tree-sitter rows is done in STAGE E.)
    B.4 INSERT OR UPDATE scip_ingestions:
          INSERT INTO scip_ingestions (scip_index_path, started_at, completed_at, intended_files)
          VALUES (?, NOW(), NULL, json(?))
          ON CONFLICT(scip_index_path) DO UPDATE SET
            started_at = excluded.started_at,
            completed_at = NULL,
            intended_files = excluded.intended_files;
    B.5 CREATE TEMP TABLE scip_symbol_map (scip_symbol PRIMARY KEY, node_id);
    B.6 CREATE TEMP TABLE scip_external_symbols (scip_symbol PRIMARY KEY, info_blob);
  commit;

STAGE C — Stream external symbols into temp table (per-batch synchronous tx)
  batch = []
  for await (sym of iterateScipExternalSymbols(scipPath)):
    batch.push(sym)
    if batch.length >= 1000:
      tx { INSERT INTO scip_external_symbols VALUES (sym.symbol, jsonify(sym)) ... }
      batch = []
  flush remainder

STAGE D — Pass 1: build symbol_map (per-batch synchronous tx)
  docBatch = []
  for await (doc of iterateScipDocuments(scipPath)):
    docBatch.push(doc)
    if docBatch.length >= 50:
      tx {
        for doc in docBatch:
          for Definition occurrence in doc:
            INSERT OR IGNORE INTO scip_symbol_map VALUES (symbol, hash(symbol))
            // INSERT OR IGNORE silently handles any same-.scip duplicate definitions
            // (would indicate a SCIP indexer bug; log a warning)
      }
      docBatch = []
  flush remainder

STAGE E — Pass 2: produce nodes/edges (per-batch synchronous tx)
  docBatch = []
  for await (doc of iterateScipDocuments(scipPath)):    // second stream pass
    docBatch.push(doc)
    if docBatch.length >= 50:
      tx {
        for doc in docBatch:
          // Supersede prior tree-sitter rows for this file (idempotent per-doc)
          DELETE FROM edges WHERE source IN (
            SELECT id FROM nodes WHERE file_path=? AND provenance='tree-sitter'
          ) OR target IN (...);
          DELETE FROM nodes WHERE file_path=? AND provenance='tree-sitter';

          if doc.occurrences.length == 0 AND file_size > opts.emptyFallbackThresholdBytes:
            // Empty-document fallback: tree-sitter the file, tag with provenance='tree-sitter (scip-empty-fallback)'
            ...
          else:
            insertScipNode(...)       // INSERT OR FAIL (multi-index conflicts already filtered in STAGE A)
            upsertGraphEdge(...)      // application-level upsert; see below
            // Cross-file edge target: SELECT node_id FROM scip_symbol_map WHERE scip_symbol=?
            // Symbol not in map but in scip_external_symbols:
            //   upsertExternalNode(node, scipPath)  — INSERT OR IGNORE on nodes,
            //                                         INSERT OR IGNORE on scip_external_refs
            // Symbol in neither → falls into unresolved_refs

          INSERT OR REPLACE INTO files (path, language, ...)
            VALUES (?, detectLanguage(path), ...);    // ensures e.g. .vb → 'vbnet'
          INSERT INTO scip_documents VALUES (path, scipIndexPath, hash, NOW());
      }
      docBatch = []
  flush remainder

STAGE F — Completion
  tx {
    UPDATE scip_ingestions SET completed_at = NOW() WHERE scip_index_path = ?;
    DROP TABLE scip_symbol_map;
    DROP TABLE scip_external_symbols;
  }
  // The TEMP-table drops must be inside a finally that runs even if STAGE C/D/E throw.
```

### Unified `upsertGraphEdge` — replaces `insertEdge` everywhere

The existing [`insertEdge` (queries.ts:958)](src/db/queries.ts#L958) uses `INSERT OR IGNORE`. After the new UNIQUE INDEX, that semantics would silently discard new edges that conflict with existing ones — meaning framework or tree-sitter paths would never merge with SCIP edges. Introduce a single `upsertGraphEdge(edge: Edge): void` used by *all* edge-writing paths.

```ts
upsertGraphEdge(edge: Edge): void {
  validateEdgeLineColumn(edge);   // enforce three-tier invariant

  const prov = edge.provenance ?? 'tree-sitter';
  const conf = edge.confidence ?? defaultConfidence(prov);

  // SELECT must include the single-value provenance column for seed logic
  const existing = this.db.prepare(
    `SELECT provenance, provenances, confidence, metadata FROM edges
     WHERE source=? AND target=? AND kind=?
       AND COALESCE(subkind,'')=COALESCE(?,'')
       AND COALESCE(line,-1)=COALESCE(?,-1)
       AND COALESCE(col,-1)=COALESCE(?,-1)`
  ).get(edge.source, edge.target, edge.kind, edge.subkind,
        edge.line, edge.column);   // TS field is .column, SQL column is col

  if (existing) {
    // Seed: prefer provenances JSON; fall back to single-value provenance
    // (migration has not back-filled provenances for historical rows).
    const seed: string[] = existing.provenances
      ? safeJsonParse<string[]>(existing.provenances, [])
      : (existing.provenance ? [existing.provenance] : []);
    const provenances = new Set(seed);
    provenances.add(prov);

    // Primary provenance = highest-priority extractor in the set
    const primary = pickPrimaryProvenance([...provenances]);

    // Merge metadata: only write NULL if both sides are empty (do not clobber old metadata)
    const oldMeta = existing.metadata ? safeJsonParse<object>(existing.metadata, {}) : {};
    const newMeta = edge.metadata ?? {};
    const mergedMeta = { ...oldMeta, ...newMeta };
    const metaJson = Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null;

    this.db.prepare(
      `UPDATE edges
       SET provenance=?, provenances=?, confidence=max(COALESCE(confidence,0),?), metadata=?,
           stale=0, staleness_visible=0
       WHERE source=? AND target=? AND kind=?
         AND COALESCE(subkind,'')=COALESCE(?,'')
         AND COALESCE(line,-1)=COALESCE(?,-1)
         AND COALESCE(col,-1)=COALESCE(?,-1)`
    ).run(primary, JSON.stringify([...provenances]), conf, metaJson,
          edge.source, edge.target, edge.kind, edge.subkind,
          edge.line, edge.column);
  } else {
    this.db.prepare(
      `INSERT INTO edges
       (source, target, kind, subkind, line, col, provenance, provenances, confidence, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(edge.source, edge.target, edge.kind, edge.subkind,
          edge.line, edge.column,
          prov, JSON.stringify([prov]),
          conf, edge.metadata ? JSON.stringify(edge.metadata) : null);
  }
}
```

**Freshness invariant** (interacts with P2 stale flags): `upsertGraphEdge` is the only path through which fresh edge contributions enter the DB — every extractor (SCIP, tree-sitter, scope-resolver, framework augmenter) eventually calls it. By definition, any caller is delivering currently-true data. The UPDATE branch therefore **unconditionally resets `stale=0, staleness_visible=0`** on the merged row. Without this, P2's "mark stale → run shadow → upsert merges new provenance" loop would deadlock: a fresh tree-sitter shadow edge whose fingerprint collides with a previously-marked-stale SCIP edge would inherit `stale=1` and remain hidden by the default query filter (`WHERE stale=0 OR staleness_visible=1`).

**Schema lifecycle note**: the `stale` and `staleness_visible` columns are declared in **P0** schema (both `nodes` and `edges`, both default 0) even though no P0 code ever sets them to 1. This allows `upsertGraphEdge` to clear them from day one without conditional SQL. P2 then adds the partial indexes, the query-filter wiring, and the sync code that actually flips them to 1. The column existence is a P0 commitment so the upsert is uniform across phases.

### Primary provenance priority

Single source of truth — used by `pickPrimaryProvenance` and referenced by P0.4d / P0.5b / CHANGELOG:

`scip > scip:external > scope-resolved > tree-sitter > framework:* > heuristic > tree-sitter (scip-empty-fallback)`

`framework:*` denotes all `framework:<name>` provenances as equal-priority peers (not ordered by `<name>`). Implementation:

```ts
const PROVENANCE_RANK: Record<string, number> = {
  'scip':                              100,
  'scip:external':                      90,
  'scope-resolved':                     80,
  'tree-sitter':                        70,
  // 'framework:*'                      60   — handled by prefix check below
  'heuristic':                          50,
  'tree-sitter (scip-empty-fallback)':  40,
};

function provenanceRank(p: GraphProvenance): number {
  if (p.startsWith('framework:')) return 60;   // all framework:* are equal-priority peers
  return PROVENANCE_RANK[p] ?? 0;
}

export function pickPrimaryProvenance(provs: GraphProvenance[]): GraphProvenance {
  if (provs.length === 0) throw new Error('pickPrimaryProvenance: empty input');
  // Stable: among same-priority items, preserve first-occurrence order
  return provs.reduce((best, p) =>
    provenanceRank(p) > provenanceRank(best) ? p : best
  );
}
```

**Unit test invariant**: `pickPrimaryProvenance(['framework:aspnet', 'framework:spring'])` returns `'framework:aspnet'` (first occurrence wins for same-priority peers — deterministic, not lexicographic).

### Semantics of `provenances[]` vs single-value `provenance`

The two columns have different roles:

| Column | Semantic | Use case |
|---|---|---|
| `provenance` (single value) | The **primary** / display extractor — highest-ranked one in `provenances[]` per `pickPrimaryProvenance`. Updates on every upsert. | Default query filter; "show me the best source for this edge" |
| `provenances[]` (JSON array) | The **audit trail** — every extractor that has independently observed this exact edge fingerprint `(source, target, kind, subkind, line, col)`. Append-only on upsert; never shrinks. | Cross-extractor verification, parity reports, debugging "why does this edge exist" |

When scope-resolved upserts an edge SCIP already added, `scope-resolved` IS added to `provenances[]` (unconditional append) — preserves audit information. The single-value `provenance` remains `scip`. Downstream queries that need "which edges came from any tree-sitter path" should use `provenances[] LIKE '%tree-sitter%'`, not the single-value column.

Existing `getOutgoingEdges(provenance?: string)` (filtering by single-value primary) gets the semantics "edges whose **primary** extractor is X". A new `getEdgesByContributingProvenance(p)` can query the `provenances[]` array (`WHERE provenances LIKE '%"'||?||'"%'`).

### `rowToEdge` must map the new columns

```ts
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    subkind: row.subkind ?? undefined,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance as Edge['provenance'],
    provenances: row.provenances ? safeJsonParse(row.provenances, undefined) : undefined,
    confidence: row.confidence ?? undefined,
  };
}
```

`EdgeRow` extends accordingly.

### External node shape (shared across `.scip` indexes via reference count)

A single external symbol (e.g., `System.Console.WriteLine`) may be referenced by multiple `.scip` indexes simultaneously. External nodes are therefore **globally unique by symbol hash** and **not owned by any single index**. Ownership is tracked many-to-many in a separate `scip_external_refs` table; cleanup decrements references and garbage-collects nodes whose ref count drops to zero.

Additional schema (alongside P0.4 schema):

```sql
CREATE TABLE scip_external_refs (
  scip_index_path    TEXT NOT NULL,
  external_node_id   TEXT NOT NULL,
  PRIMARY KEY (scip_index_path, external_node_id),
  FOREIGN KEY (external_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_scip_external_refs_index ON scip_external_refs(scip_index_path);
CREATE INDEX idx_scip_external_refs_node  ON scip_external_refs(external_node_id);
```

External node construction:

```ts
function externalSymbolToNode(sym: SymbolInformation): Node {
  const parsed = parseSymbol(sym.symbol);
  return {
    id: hashSymbol(sym.symbol),               // GLOBAL — no per-index salt
    kind: scipKindToNodeKind(sym.kind),
    name: parsed.descriptors.at(-1).name,
    qualifiedName: parsed.qualifiedName,
    filePath: `<external:${parsed.scheme}/${parsed.package.name}>`,
    language: 'external',
    startLine: 0, endLine: 0, startColumn: 0, endColumn: 0,
    docstring: sym.documentation?.join('\n'),   // existing field, integrated with FTS5
    provenance: 'scip:external',
    scipSymbol: sym.symbol,
    // No scipIndexPath — ownership is in scip_external_refs
    updatedAt: Date.now(),
  };
}

function upsertExternalNode(node: Node, scipIndexPath: string): void {
  db.prepare(`INSERT OR IGNORE INTO nodes (...) VALUES (...)`).run(...node);
  db.prepare(`INSERT OR IGNORE INTO scip_external_refs (scip_index_path, external_node_id)
              VALUES (?, ?)`).run(scipIndexPath, node.id);
}
```

`INSERT OR IGNORE` on `nodes` is safe because the row identity (symbol hash → node id) is stable; subsequent indexes referencing the same external symbol simply add a row to `scip_external_refs`.

STAGE B.2 cleanup for external nodes (overrides scoped delete for the external-node case):

```sql
-- 1. Delete this index's external refs
DELETE FROM scip_external_refs WHERE scip_index_path = ?;

-- 2. Garbage-collect edges that connect to a NOW-ORPHANED external node
--    (an external node with zero remaining refs across all indexes).
--    The endpoint check is per-side: an edge dies only if its specific endpoint
--    is itself an orphaned external node. Edges from a still-referenced
--    external to an internal node, or between two still-referenced externals,
--    survive.
DELETE FROM edges
WHERE source IN (
        SELECT id FROM nodes
        WHERE provenance = 'scip:external'
          AND id NOT IN (SELECT external_node_id FROM scip_external_refs)
      )
   OR target IN (
        SELECT id FROM nodes
        WHERE provenance = 'scip:external'
          AND id NOT IN (SELECT external_node_id FROM scip_external_refs)
      );

-- 3. Delete the orphaned external nodes themselves
DELETE FROM nodes
WHERE provenance = 'scip:external'
  AND id NOT IN (SELECT external_node_id FROM scip_external_refs);
```

**Why the per-endpoint orphan test matters**: a naive `WHERE (source IN externals OR target IN externals) AND (source NOT IN refs OR target NOT IN refs)` would short-circuit incorrectly. For an edge `Foo (internal) → System.String (external, still referenced by another index)`:
- `target IN externals` → true (overall outer clause satisfied)
- `source NOT IN refs` → **true** (Foo is internal, so its id is trivially not in `scip_external_refs`)
- The AND clause matches and the edge is deleted — wrong, because `System.String` is still referenced.

The corrected SQL above asks the right question per endpoint: "is THIS endpoint an external node whose ref count just dropped to zero?" Internal endpoints never match the `provenance = 'scip:external'` filter, so they don't trigger deletion regardless of whether they appear in `scip_external_refs`.

(The ON DELETE CASCADE on `scip_external_refs.external_node_id` is for the rare reverse path — manual node deletion — and is not relied on here.)

**Verification (extends P0.10)**:

- Ingest A.scip and B.scip where both reference `System.Console.WriteLine` → assert exactly one node row exists with that symbol hash, and `scip_external_refs` has two rows for it.
- Delete A.scip's ingestion (re-ingest A) → assert the node still exists (B still references it), and `scip_external_refs` count for that node is 1.
- Delete B.scip's ingestion → assert the node is GC'd.
- **Per-endpoint orphan regression**: ingest A.scip (defines `Foo` → calls `System.String.Trim`) and B.scip (also references `System.String.Trim`). Re-ingest only A.scip. Assert:
  - `System.String.Trim` external node still exists (still referenced by B).
  - The `Foo → System.String.Trim` edge from A is replaced by the new ingest (per STAGE B.2 owned-node cleanup), but the EXTERNAL node and any B.scip-owned edge to it MUST survive.
  - No edge whose endpoint is a still-referenced external node is collateral-damaged.

Synthetic file paths beginning with `<external:` are **not written to the `files` table** — they would pollute file statistics and confuse the sync flow. FTS5 picks up `docstring` automatically.

**Effort: 4 days**

## P0.4b — Open-time incomplete-ingestion cleanup

A prior crash mid-ingest leaves an `scip_ingestions` row with `completed_at IS NULL` and a partially-mutated graph. Clean up at `open()` (and `openSync()`) time:

```ts
private cleanupIncompleteIngestions(): void {
  const incomplete = this.db.prepare(
    `SELECT scip_index_path FROM scip_ingestions WHERE completed_at IS NULL`
  ).all();
  if (incomplete.length === 0) return;

  logWarn(
    `Found ${incomplete.length} incomplete SCIP ingestion(s) from a prior crash. ` +
    `Cleaning up partial data; you must re-run scip-refresh or codegraph index --scip ` +
    `to restore SCIP coverage for these indexes.`
  );
  for (const row of incomplete) {
    this.cleanupIncompleteScipIngestion(row.scip_index_path);
  }
}

async open()    { /* migrations + */ this.cleanupIncompleteIngestions(); }
static openSync(){ /* migrations + */ instance.cleanupIncompleteIngestions(); }
```

The cleanup is **destructive of the prior index's data, not restorative**. Old SCIP data is gone after a crash; user must re-run the indexer. Acceptable when paired with the nightly refresh cron.

**Effort: 0.5 day**

## P0.4c — Build-failure tolerance

Comprehensive failure ledger so that **no SCIP failure mode can leave CodeGraph unusable**.

### Failure modes and degradation paths

| Failure type | Detection | Degradation | Logged as |
|---|---|---|---|
| `scip-dotnet` binary not found | `spawn` ENOENT | Skip this language's SCIP; tree-sitter the files | `warn: scip-dotnet not installed; falling back to tree-sitter for csharp/vbnet. Install: dotnet tool install -g scip-dotnet` |
| Indexer process startup failure (cannot find `.csproj` / `.sln`) | exit code != 0 within 5s + no `.scip` file produced | Skip this language's SCIP; tree-sitter the files | `warn: scip-dotnet failed to start in {dir}. Falling back to tree-sitter.` |
| `dotnet restore` failure | scip-dotnet stderr contains `restore failed` | Skip this language's SCIP; tree-sitter the files | `warn: dotnet restore failed. Falling back to tree-sitter. Run 'dotnet restore' manually to enable SCIP.` |
| `dotnet build` failure (broken project source) | scip-dotnet exits 0 but `.scip` `metadata.tool_info` contains error markers | **Partial ingestion**: successfully-indexed documents go through SCIP; failed files get tree-sitter | `warn: dotnet build had errors. Ingesting {N}/{M} SCIP documents; remaining files via tree-sitter.` |
| Indexer OOM / mid-run crash | `.scip` file exists but P0.1 streaming decoder hits unexpected EOF before final field | Reject the `.scip`; rely on P0.4b crash recovery on next open; tree-sitter the files | `error: .scip file truncated. Rejecting ingest; run scip-refresh.` |
| Single Document empty occurrences | `Document.occurrences.length === 0` AND `file_size > emptyFallbackThresholdBytes` | tree-sitter fallback for this single file (`provenance='tree-sitter (scip-empty-fallback)'`) | `info: empty SCIP coverage for {file}; using tree-sitter fallback.` |
| `.scip` file corruption (CRC / format) | Protobuf decode throws during STAGE A pre-scan | Reject ingest at STAGE A; **DB completely unchanged** | `error: {scipPath} is corrupted; ingest aborted.` |
| Indexer found but version mismatch | Detected version < required minimum (defined per indexer) | Warn but proceed; flag results with `provenance` annotation that the user should upgrade | `warn: scip-dotnet v{actual} predates SCIP 0.3 features; some metadata may be missing.` |

### Failure ledger

`.codegraph/scip-failures.json` records the last run's failure modes per indexer, surfaced by `codegraph status`:

```json
{
  "version": 1,
  "runAt": "2026-05-18T12:34:56Z",
  "failures": [
    {
      "indexer": "scip-dotnet",
      "language": "csharp",
      "mode": "build-failed",
      "filesAffected": 47,
      "fallback": "tree-sitter",
      "hint": "Run 'dotnet build' to see errors."
    }
  ]
}
```

**Schema versioning**: top-level `version: 1` field. Reader rejects unknown versions with `"scip-failures.json schema version <N> unknown — codegraph upgrade required"`.

**File semantics**:
- **Overwritten** (not appended) per run. Long-term history is in `.codegraph/logs/*.log`.
- **Atomic write**: write to `.codegraph/scip-failures.json.tmp` first, then `fs.renameSync(tmp, final)`. Atomic on POSIX and Windows (NTFS). Prevents partial-write corruption.
- `.codegraph/` directory is created by `CodeGraph.open()`; ledger write assumes it exists.
- **Concurrent-write protection**: covered by the `.codegraph/.scip-auto.lock` from P0.0 — only one `--scip-auto` runs at a time, so ledger writes are naturally serialized.

### Invariant

> **No SCIP failure mode causes a fatal CodeGraph exit.** The only fatal cases are (a) the user explicitly passes `--scip <path>` with a corrupted file (caller-induced), or (b) an unrecoverable internal bug. Auto-mode (`--scip-auto`) and absent-toolchain modes always degrade gracefully.

### Verification

- Unit test: mock `spawn` to throw ENOENT for `scip-dotnet`; assert `--scip-auto` completes successfully with tree-sitter results.
- Unit test: inject a corrupted `.scip` via a synthesized truncated fixture; assert STAGE A pre-scan rejects it and DB state matches pre-call snapshot.
- Unit test: synthesize a `.scip` with `metadata.tool_info` containing error markers; assert partial ingestion + tree-sitter fallback for failed files.
- Integration test: point `scip-dotnet` at a deliberately-broken `.csproj`; assert ingest completes and `scip-failures.json` records the build-failed mode.

**Effort: 1 day**

## P0.4d — Derived `ConfidenceTier`

`confidence: REAL` stays as the continuous value; `ConfidenceTier` is a derived enum that downstream consumers (MCP tools, status command, future risk-scoring features) can switch on cleanly. **No schema change** — purely a function.

`src/types.ts` (alongside `GraphProvenance`):

```ts
export type ConfidenceTier =
  | 'compiler'
  | 'syntactic'
  | 'scope-resolved'
  | 'inferred'
  | 'ambiguous';

export function deriveConfidenceTier(prov: GraphProvenance | undefined): ConfidenceTier {
  if (prov === undefined) return 'ambiguous';
  if (prov === 'scip' || prov === 'scip:external') return 'compiler';
  if (prov === 'tree-sitter' || prov === 'tree-sitter (scip-empty-fallback)') return 'syntactic';
  if (prov === 'scope-resolved') return 'scope-resolved';
  if (prov === 'heuristic') return 'inferred';
  if (prov.startsWith('framework:')) return 'inferred';
  return 'ambiguous';
}
```

Usage sites (incremental):

- `getEdge` / `getOutgoingEdges` response: include `confidenceTier` field at MCP serialization boundary.
- `codegraph status`: report counts per tier (e.g., "compiler: 12,345 edges; syntactic: 3,456; …").
- `codegraph_context` MCP tool: when `detail_level !== 'verbose'`, omit `confidence` numeric and include `confidenceTier` enum only.

**Effort: 0.5 day**

## P0.5 — Ingester orchestration

`src/extraction/scip/index.ts`:

```ts
export async function ingestScipFile(scipPath, projectRoot, opts, ctx): Promise<IngestStats> {
  const metadata = await readScipMetadata(scipPath);
  return await persistScipIndex(scipPath, metadata, ctx);
}
```

`persistScipIndex` opens `iterateScipDocuments` twice (once in Pass 1, once in Pass 2) and `iterateScipExternalSymbols` once. Each open is an independent stream; nothing is buffered globally.

**Effort: 1 day**

## P0.5b — Resolution-Parity: scope index + parity tests

The default Phase 2 (`import-resolver + name-matcher`) is a heuristic that produces ambiguous targets. P0.5b adds a minimal scope index for the SCIP-priority languages and a parity test harness that guards "same edge from either path = same semantics".

### Scope index — minimal version

`src/resolution/scope-index.ts`:

```ts
export interface ScopeIndex {
  /** All symbols visible at file scope (top-level declarations). */
  fileScope(filePath: string): SymbolRef[];

  /** All symbols visible at class scope (methods, fields of a class). */
  classScope(classQualifiedName: string): SymbolRef[];

  /** Look up a name from a use site, walking out file → class → import. */
  resolve(name: string, useSite: { filePath: string; enclosingClass?: string }): SymbolRef | null;
}
```

### Language selection (C#, VB.NET, Java, Python, TypeScript)

Criteria, in order:

1. **SCIP indexer is available upstream** — so the parity test is actually runnable. Eliminates languages without SCIP support.
2. **Codebase has framework resolvers benefiting from scope-resolved nodes** — these 5 cover ~all of the 14 framework resolvers (aspnet, django, flask, fastapi, spring, express, react, vue, etc.).
3. **5-day budget allocation** — each language is ~1d for the scope walker + parity fixture pairing.

**Languages deferred** (~1 day each, paired with parity test extension): Rust, Go, Ruby, Kotlin, Scala. Add when the corresponding framework resolver migration in P1 surfaces precision needs.

Coverage:

- **File-level scope**: top-level functions, classes, type aliases, namespaces, modules. Built by walking tree-sitter top-level declarations once per file.
- **Class-level scope**: methods, properties, fields. Built by walking class body declarations.
- **Import resolution**: leveraging the existing `import-resolver` to map alias → real symbol.

Explicitly out of scope:

- Lexical / block scope (function-local variables, closures, nested scopes)
- Generic / type parameter scopes
- Conditional compilation branches
- Cross-`.vbproj` / cross-module visibility resolution (SCIP handles these)

### `provenance='scope-resolved'` semantics

Edges emitted by the scope resolver get `provenance='scope-resolved'` and default `confidence=0.75` (between heuristic 0.6 and tree-sitter direct 0.7; below SCIP 1.0). `pickPrimaryProvenance` priority is documented in P0.4.

### Parity test infrastructure

`__tests__/parity/parity-harness.ts`:

```ts
export interface ParityReport {
  scipOnly:      EdgeFingerprint[];   // edges in SCIP but not tree-sitter
  treeSitterOnly: EdgeFingerprint[];  // edges in tree-sitter but not SCIP
  shared:        EdgeFingerprint[];   // edges in both
  conflicting:   Array<{ scip: Edge; treeSitter: Edge; mismatch: string[] }>;
}

export async function runParity(
  fixturePath: string,
  opts?: { tolerance?: { confidenceDelta: number } }
): Promise<ParityReport>;

export function assertEdgesEquivalent(
  scipEdges: Edge[],
  tsEdges: Edge[],
  opts?: { tolerance?: ParityTolerance; allowedDivergence?: AllowedDivergence }
): void;
```

`EdgeFingerprint = (sourceQualifiedName, targetQualifiedName, kind)` ignoring line/col (since heuristic may not produce them precisely). To avoid hiding missed call sites, the report carries a `callSiteCount` column **per fingerprint**:

```ts
interface ParityRow {
  fingerprint: EdgeFingerprint;
  scipCallSites: number;       // count of SCIP rows for this fingerprint (distinct line/col)
  treeSitterCallSites: number; // count of tree-sitter rows for this fingerprint
  missedSites: number;         // = max(0, scipCallSites - treeSitterCallSites)
}
```

`assertEdgesEquivalent` fails the test when `missedSites > 0` for any fingerprint (unless the fingerprint is in `allowedDivergence`). This recovers the call-site-coverage signal that fingerprint-only comparison would have lost.

### Allowed divergence

Compiler-magic features are expected to diverge:

```ts
const VBNET_ALLOWED_DIVERGENCE: AllowedDivergence = {
  scipOnlyKinds: [
    'calls (My.* synthesized member)',
    'references (project-level Imports)',
    'calls (WithEvents+Handles auto-binding)',
    'calls (late binding, Option Strict Off)',
  ],
  treeSitterOnlyKinds: [],  // tree-sitter should never have edges SCIP lacks
};
```

`assertEdgesEquivalent` accepts these as expected divergences; everything else outside the allowed set fails the test.

### CLI surface

`codegraph parity --fixture ./__tests__/fixtures/vbnet-sample/` — runs the parity harness and prints a report. Useful for debugging when a new language is added or a SCIP indexer upgrades.

### Integration with P1

P1 framework `synthesize` / `augment` resolvers accept scope-resolved nodes as input alongside SCIP and tree-sitter nodes. The new `GraphView` (P1.2) returns scope-resolved nodes transparently; resolvers do not need to know which backend produced them.

### Verification

- Unit test: a VB.NET file with `Sub Foo()` calling `Bar()` (same file) gets a scope-resolved `calls` edge.
- Unit test: a VB.NET file with `Sub Foo()` calling `Baz()` (defined in another file in the same module via project-level Imports) does NOT get a scope-resolved edge but DOES get the SCIP edge — parity report flags this as `scipOnly` and `assertEdgesEquivalent` accepts it via the allowed-divergence list.
- Parity test: VB.NET fixture, full report; zero unexpected divergences.

**Effort: 5 days**

## P0.6 — Orchestrator dual-backend dispatch

[`extraction/index.ts indexAll`](src/extraction/index.ts#L484) becomes:

```
1. Detect installed SCIP indexers if --scip-auto.
2. Resolve effective .scip sources:
     - Auto-spawn for detected indexers (P0.0)
     - Plus any --scip <path> values from config.scipSources
3. For each scipPath: await ingestScipFile(scipPath, ...).
     - On MultiIndexConflictError: abort
     - On any other failure: log to P0.4c failure ledger; continue.
4. globalScipCoveredFiles = SELECT source_file_path FROM scip_documents
5. Tree-sitter path runs for all files NOT in globalScipCoveredFiles.
     - Includes .vb files via the vbnet WASM grammar (P0.6b).
6. Run scope-resolved pass (P0.5b) on tree-sitter-extracted files for the
   supported languages (csharp, vbnet, java, python, typescript).
7. SCIP-derived edges are tagged provenance='scip' and bypass the heuristic resolution stage.
```

**Effort: 1 day**

## P0.6b — VB.NET tree-sitter extractor (Tier 0 backstop)

For users without `.NET SDK` or `scip-dotnet` installed. Precision is ~70% of SCIP (missing compiler-magic features) but covers the Tier 0 baseline so that **no user opening a VB.NET project gets an empty graph**.

### WASM grammar

- Source grammar: [CodeAnt-AI/tree-sitter-vb-dotnet](https://github.com/CodeAnt-AI/tree-sitter-vb-dotnet). Targets VB 16.9 / .NET 5+.
- **Pinned upstream commit**: `CodeAnt-AI/tree-sitter-vb-dotnet@<SHA>` — record the actual SHA when implementing. Treat this commit pin like a code dependency: bumping it requires PR review.
- **Build reproduction script**: `scripts/build-vbnet-wasm.sh` — clones at the pinned SHA, runs `tree-sitter generate && tree-sitter build --wasm` (WASI SDK toolchain), computes SHA-256 of the resulting `.wasm`, writes both the binary and the hash file.
- Output committed: `src/extraction/wasm/vbnet.wasm` AND `src/extraction/wasm/vbnet.wasm.sha256`. The hash file's first line is the SHA-256; second line is the upstream commit SHA.
- **CI integrity check** — `__tests__/wasm-integrity.test.ts`:
  ```ts
  test('vbnet.wasm matches committed SHA-256', () => {
    const wasm = fs.readFileSync('src/extraction/wasm/vbnet.wasm');
    const actual = crypto.createHash('sha256').update(wasm).digest('hex');
    const expected = fs.readFileSync('src/extraction/wasm/vbnet.wasm.sha256', 'utf8').split('\n')[0].trim();
    expect(actual).toBe(expected);
  });
  ```
  Extend this same test pattern to Pascal / Scala self-hosted grammars.
- **Fail-loud invariant**: if `vbnet.wasm` is missing at runtime (e.g., not bundled into `dist/`), `loadGrammarsForLanguages` throws a clear error (`"VB.NET WASM grammar missing — was the build step skipped? Run scripts/build-vbnet-wasm.sh"`) rather than silently falling back to "language unsupported".

### Language extractor

`src/extraction/languages/vbnet.ts` — maps tree-sitter VB AST nodes to CodeGraph `NodeKind`:

| VB AST | NodeKind | Notes |
|---|---|---|
| `module_statement` | `module` | VB Module (compiler-synthesizes Shared) |
| `class_statement` | `class` | |
| `namespace_statement` | `namespace` | |
| `interface_statement` | `interface` | |
| `enum_statement` | `enum` | |
| `structure_statement` | `struct` | |
| `sub_statement` / `function_statement` | `method` or `function` (depending on enclosing scope) | |
| `property_statement` | `property` | Get/Set accessors as children |
| `constructor_statement` (`Sub New`) | `constructor` | |
| `event_statement` | `event` | |

Visibility mapping: `Public` → `public`, `Friend` → `internal`, `Protected` → `protected`, `Private` → `private`. `Shared` → `static=true`.

### Relationship extraction

Inside a single file (and inside a single class within that file):

- `Inherits TypeName` → `extends` edge to a `<unresolved>` placeholder if `TypeName` is not in scope; resolved by P0.5b scope-resolver or P1 framework augmentation.
- `Implements TypeName` → `implements` edge, same resolution flow.
- `Imports X` → `imports` edge (per-file scope only; project-level `Imports` declared in `.vbproj` XML are NOT parsed — SCIP territory).
- `Imports Alias = X.Y` → `imports` edge with `subkind='alias'` and `metadata.alias=Alias`.
- Method calls within a method body → `calls` edges (file-local resolution only).

### Cross-file resolution

NOT done by P0.6b itself. P0.5b scope-resolver handles cross-file references for VB.NET; if the target is not in the scope index, it falls back to heuristic name-matcher (`provenance='heuristic'`).

### Things explicitly NOT covered

- `My.*` namespace (compiler-synthesized — invisible to any tree-sitter)
- Project-level `Imports` from `.vbproj` XML (not in source files)
- `WithEvents` + `Handles` auto-event-binding (requires Roslyn semantic model)
- Late binding under `Option Strict Off`
- Conditional compilation `#If` branches (tree-sitter sees both branches as text)
- Cross-`.vbproj` symbol references
- Overload resolution ambiguity (name-only matching)

These are all SCIP territory. The CLI MUST tell users this when they index a VB project without `scip-dotnet`:

```
$ codegraph index ./my-vb-project/
✓ Tier 0 indexed 142 .vb files (~70% of SCIP precision)
⚠ The following VB.NET features are not covered without scip-dotnet:
    • My.* namespace references
    • Project-level Imports from .vbproj
    • WithEvents + Handles auto-binding
    • Cross-project references
  Install scip-dotnet for compiler-grade VB indexing:
    dotnet tool install -g scip-dotnet
  Then run: codegraph index --scip-auto
```

### Schema / config touch points

- `EXTENSION_MAP['.vb'] = 'vbnet'` (also in P0.8)
- `WASM_GRAMMAR_FILES['vbnet'] = 'vbnet.wasm'`
- `GrammarLanguage` definition: `Exclude<Language, 'svelte' | 'vue' | 'liquid' | 'unknown' | 'external'>`. `WASM_GRAMMAR_FILES: Record<GrammarLanguage, string>` type-checks cleanly.
- **Self-hosted WASM loader update** — [`extraction/grammars.ts:129`](src/extraction/grammars.ts#L129) currently special-cases Pascal / Scala for `path.join(__dirname, 'wasm', wasmFile)` vs `require.resolve('tree-sitter-wasms/out/${wasmFile}')`. v12's `vbnet.wasm` is also self-hosted (no `tree-sitter-wasms` package entry). The hardcoded `lang === 'pascal' || lang === 'scala'` check must be refactored:
  ```ts
  const SELF_HOSTED_WASM_LANGUAGES = new Set<GrammarLanguage>(['pascal', 'scala', 'vbnet']);
  // ...
  const wasmPath = SELF_HOSTED_WASM_LANGUAGES.has(lang)
    ? path.join(__dirname, 'wasm', wasmFile)
    : require.resolve(`tree-sitter-wasms/out/${wasmFile}`);
  ```
  Without this refactor, `loadGrammarsForLanguages(['vbnet'])` will try `require.resolve('tree-sitter-wasms/out/vbnet.wasm')`, fail (no upstream entry), and silently mark `vbnet` as unavailable — Tier 0 VB indexing returns zero nodes.
- **Verification**: `__tests__/wasm-integrity.test.ts` (added in this section's CI integrity check) also asserts `loadGrammarsForLanguages(['vbnet'])` succeeds and `languageCache.has('vbnet')` is true.

### Verification

- Unit test: VB Module with `Sub Main()` calling local `Sub Foo()` → `calls` edge present, `provenance='tree-sitter'`.
- Unit test: VB Class `Inherits Base` → `extends` edge to `Base` (if Base is in another file, edge target is the scope-resolved `Base` symbol or `<unresolved>`).
- Unit test: VB `Imports System.IO` → `imports` edge.
- Unit test: VB `My.Application.StartupPath` → only file-local references resolved; `My.Application` does NOT get an external node (SCIP territory).
- **Parity test** (P0.5b): tree-sitter VB graph compared to SCIP VB graph; expected divergences confined to the allowed-divergence list.
- **Tier 0 smoke test**: run `codegraph index ./vbnet-sample/` **without** `.NET SDK` installed (CI matrix); assert the graph matches a recorded baseline within tolerance.
  - **CI matrix setup**: GitHub Actions job `tier0-no-sdk` runs in `ubuntu-latest` without the `setup-dotnet` action step (separate from the main matrix). On Windows / macOS, the equivalent omission applies.
  - **Baseline derivation**: when the VB fixture is first committed, run BOTH `codegraph index --scip-auto` (Tier 1) AND `codegraph index --no-scip` (Tier 0) on the fixture; record the resulting node/edge counts to `__tests__/fixtures/vbnet-sample/baseline.json`. The smoke test asserts Tier 0 counts match the recorded Tier 0 baseline within ±5%. The relative Tier 0 vs Tier 1 ratio is a reported metric in the test output, not a gating threshold.
  - Baseline file format:
    ```json
    {
      "fixtureCommit": "<sha>",
      "tier0": { "nodes": 142, "edges": 318 },
      "tier1": { "nodes": 178, "edges": 521 },
      "recordedTier0Coverage": { "nodesPct": 79.8, "edgesPct": 61.0 }
    }
    ```
  - Updating the baseline requires explicit re-recording (`scripts/record-baseline.sh`) — prevents silent regression masquerading as a baseline shift.

**Effort: 5 days**

## P0.7 — CLI

[`src/bin/codegraph.ts`](src/bin/codegraph.ts) — wire up the full CLI surface defined in **P0.0** ("CLI surface" table). This section is the CLI integration work (argument parsing, flag handling, help text); the *behavior* of each flag is specified in P0.0.

Summary:

- `codegraph index ./` — Tier 0 only.
- `codegraph index --scip-auto` — detect installed SCIP indexers, spawn each, ingest results.
- `codegraph index --scip-auto --languages <lang,…>` — restrict auto-mode to specific languages.
- `codegraph index --scip <path>` — explicit pre-built `.scip` ingestion. Repeatable.
- `codegraph index --scip-auto --scip <path>` — combine; precedence rules in P0.0.
- `codegraph index --no-scip` — force Tier 0 even if SCIP indexers are present.
- `codegraph index` (no flags + config has `scipSources`) — auto-discovery via `config.scipSources` (default glob `./index.scip`).
- `codegraph parity --fixture <path>` — run P0.5b parity harness on a fixture, print divergence report.

**Effort: 0.5 day** (CLI integration; per-flag implementation is absorbed into P0.0 / P0.5b effort budgets).

## P0.8 — Types, config, EXTENSION_MAP, GrammarLanguage, Node touch points

### Type and config changes

- `NODE_KINDS` ([types.ts:18](src/types.ts#L18)) adds `'constructor'` and `'event'`. Required by P0.6b's VB extractor mapping (`constructor_statement` → `constructor`, `event_statement` → `event`). Both kinds are also useful for C#/Java framework augmentation. **Touch points after adding**: any exhaustive switch over `NodeKind` must add cases for the two new kinds (`npm run build` surfaces them); FTS5 weighting (if it special-cases kinds) should treat them like `method` / `field` respectively.
- `LANGUAGES` ([types.ts:66](src/types.ts#L66)) adds `'vbnet'` and `'external'`.
- `DEFAULT_CONFIG.include` ([types.ts:498](src/types.ts#L498)) adds `'**/*.vb'`.
- `EXTENSION_MAP` ([grammars.ts:43](src/extraction/grammars.ts#L43)) adds `'.vb': 'vbnet'`.
- `WASM_GRAMMAR_FILES` ([grammars.ts](src/extraction/grammars.ts)) adds `'vbnet': 'vbnet.wasm'`.
- **`GrammarLanguage` type** ([grammars.ts:13](src/extraction/grammars.ts#L13)): `Exclude<Language, 'svelte' | 'vue' | 'liquid' | 'unknown' | 'external'>`. `WASM_GRAMMAR_FILES: Record<GrammarLanguage, string>` type-checks cleanly with the new entry.
- `validateConfig` ([config.ts:76](src/config.ts#L76)) — `validLanguages` derives from `LANGUAGES` instead of a hand-maintained duplicate list.
- `CodeGraphConfig` gains:
  - `scipSources?: { files?: string[]; glob?: string }`
  - `emptyFallbackThresholdBytes?: number` (default 200)
  - `scipAuto?: boolean` (default `false`; CLI `--scip-auto` flag overrides)
  - `disabledScipIndexers?: string[]` (opt-out specific indexers in auto mode)
- `Node` adds `provenance?: GraphProvenance` (optional — required would break the many existing `const node: Node = {...}` constructions), `scipSymbol?: string`, `scipIndexPath?: string`.
- `Edge` extends `provenance` to `GraphProvenance` and adds `provenances?: GraphProvenance[]`, `confidence?: number`, `subkind?: string`. **Does not** add `metadata` (already exists) or rename `column` (keep TS `column` / SQL `col` mapping at the binding boundary).

### Node `QueryBuilder` touch points

Adding `provenance` / `scipSymbol` / `scipIndexPath` to `Node` requires synchronized changes at:

| Site | Change |
|---|---|
| `NodeRow` type ([queries.ts:38](src/db/queries.ts#L38)) | Add three columns |
| `rowToNode` (~`queries.ts:80`) | Map row.provenance / scip_symbol / scip_index_path |
| `insertNode` ([queries.ts:196](src/db/queries.ts#L196)) | Add columns to INSERT SQL and bind object |
| `insertNodes` (~[queries.ts:258](src/db/queries.ts#L258)) | Same as `insertNode` |
| `updateNode` (~`queries.ts:280`) | Decide whether `update` should touch provenance (usually no, but declare the semantics) |
| Any direct `INSERT INTO nodes` SQL | Synchronize |

A round-trip test in P0.10 verifies: insert a node with all three fields → query it back → all fields present.

### Provenance union extension ripple

| Site | Concern |
|---|---|
| [`rowToEdge:123`](src/db/queries.ts#L123) `provenance: row.provenance as Edge['provenance']` | Cast holds — the wider union is more permissive |
| [`insertEdge:973`](src/db/queries.ts#L973) `provenance: edge.provenance ?? null` | Binds a string — no change |
| [`getOutgoingEdges:1001`](src/db/queries.ts#L1001) `provenance?: string` filter | Still accepts string — no enum tightening |
| Existing tests | Any exhaustive switch over the original three-value union must be relaxed; `npm run build` will surface them |

P0.10 acceptance: `npm run build` passes; provenance ripple causes no `tsc` errors.

**Effort: 0.5 day**

## P0.9 — DB schema migration

The migration file in [`db/migrations.ts`](src/db/migrations.ts) needs:

1. A new migration entry.
2. `CURRENT_SCHEMA_VERSION` ([migrations.ts:10](src/db/migrations.ts#L10)) bumped from 4 → 5. Without bumping, existing databases will skip the new migration. (P1 will bump to 6 when it adds `node_tags`; P2 to 7 when it adds `stale`.)

The migration SQL appears in P0.4. It includes the `nodes.scip_index_path` column and its partial index.

### `scope-resolved` backfill policy

Migration does **NOT** backfill `provenance='scope-resolved'` on historical `tree-sitter` edges. Rationale:

- Scope-resolution runs as part of Phase 2 during extraction. Replaying it post-hoc against historical rows would require re-running tree-sitter on every existing file — effectively a full re-index.
- The benefit of upgrading historical `tree-sitter` rows to `scope-resolved` is marginal: most `tree-sitter` edges are file-local and already correct. Scope-resolution primarily helps `heuristic` edges (unresolved cross-file refs), which the migration does not touch either.
- Eventual consistency is achieved by the P2 nightly cron refresh: any file modified after the upgrade gets re-indexed with full Phase 2 (including scope-resolution). After at most 24 hours + one full git commit cycle, all reasonably-active files are upgraded.

**User-facing message**: include a one-line note in the migration completion log: `"Existing edges retain their original provenances; run 'codegraph index' to upgrade incrementally."`

**Effort: 0.5 day**

## P0.10 — VB.NET validation fixture + full test coverage

Fixture: `__tests__/fixtures/vbnet-sample/` — a `.vbproj` and a handful of `.vb` files covering `Namespace`, `Module`, `Class`, `Sub`, `Function`, `Property`, `Imports`, `Inherits`, `Implements`, `Friend`, `Shared`, `Sub New`. Run `scip-dotnet index ./` once and commit the resulting `.scip` (so tests do not require .NET SDK installation).

`__tests__/scip-ingester.test.ts` asserts (Tier 1 / SCIP path):

- VB Module maps to `kind='module'`; `Friend` → `visibility='internal'`; `Shared` → `static=true`.
- `Inherits` produces `extends` edges; `Implements` produces `implements` edges.
- **Cross-file `calls` edges with multiple call sites at distinct lines are preserved** (regression for the unique-key-with-line/col invariant).
- Empty-Document fallback path: a file producing zero SCIP occurrences but with size > threshold is tree-sitter-extracted with `provenance='tree-sitter (scip-empty-fallback)'`.
- **Memory benchmark**: a synthetic 500 MB `.scip` containing ~1M definitions and ~100k external symbols ingests with RSS delta < 200 MB.
- **Multi-`.scip` isolation**: ingest A.scip then B.scip — A's data remains intact.
- **Multi-`.scip` conflict**: A and B both cover `Foo.vb` → ingesting B throws `MultiIndexConflictError`, and the DB state matches what it was after A's ingest completed.
- **`tree-sitter` rows for files that newly become SCIP-covered are cleaned up**.
- **Edge dedup preserves call sites and merges across extractors**: same `(caller, callee, kind, subkind, line, col)` from SCIP and from framework results in one row with `provenances=['scip', 'framework:aspnet']`.
- **File language acceptance**: `SELECT language FROM files WHERE path LIKE '%.vb'` returns `'vbnet'`.
- **External node shape**: `<external:...>` file path; `language='external'`; `docstring` populated; FTS5 search hits external symbols.
- **Crash recovery**: simulate Pass 2 throw → second `open()` runs `cleanupIncompleteIngestions` → DB is consistent (no rows for this index).
- **Same-`.scip` duplicate Document.relativePath** throws `SameIndexDuplicateDocumentError`.
- **Edge invariant (three tiers)**: `calls` and direct `references` require line/col; framework `references` subkinds in the allowlist may have NULL; promoted `instantiates`/`implements` allow optional line/col; pure relation kinds (`contains`, `extends`, `type_of`, `returns`, `overrides`, `decorates`, `imports`, `exports`) must have NULL.
- **Provenance union extension does not break `tsc`**.

`__tests__/tier0-vbnet.test.ts` asserts (Tier 0 / tree-sitter path, **no `.NET SDK` required**):

- A VB.NET fixture file with `Module Foo / Sub Main / Sub Helper` builds a graph with `kind='module'` for Foo, `kind='function'` (or `method` if inside a class) for Sub Main and Sub Helper, all `provenance='tree-sitter'`.
- File-local `Sub Main()` calling `Helper()` produces a `calls` edge with `provenance='tree-sitter'` and `confidence=0.7`.
- `Inherits BaseClass` (where `BaseClass` is in another file) produces an `extends` edge; if scope-resolver is enabled, target is resolved; otherwise target is `<unresolved>` with `provenance='heuristic'`.
- `My.Application.StartupPath` references are NOT resolved to external nodes.
- **CLI tier-hint output**: after indexing a VB project without `scip-dotnet`, stdout contains the install hint for scip-dotnet.
- **No regression**: indexing the same VB fixture WITH SCIP enabled produces the same edges that Tier 0 produces, PLUS the compiler-magic edges (parity test P0.5b).

`__tests__/p00-toolchain-detection.test.ts` asserts:

- Mock `which`/`where` to return `scip-dotnet`-only → `--scip-auto` on mixed C#/Java/.vb repo spawns scip-dotnet, ingests, then runs tree-sitter on Java/Python files. Final graph has `provenance='scip'` for C#/VB nodes, `provenance='tree-sitter'` for Java.
- Mock to return zero indexers → `--scip-auto` completes with all-tree-sitter graph; failure ledger is empty.
- `--no-scip` flag forces tree-sitter even when indexers are detected.

`__tests__/p04c-failure-tolerance.test.ts` asserts:

- ENOENT on spawn → graceful degradation under `--scip-auto`; `scip-failures.json` records `mode='not-installed'`. Process exits 0.
- Under `--scip-auto`: synthesized truncated `.scip` in `.codegraph/scip-cache/` → STAGE A rejects; failed-indexer files fall back to tree-sitter; process exits 0.
- Under `--scip-auto`: `metadata.tool_info` with error markers → partial ingestion (successfully-decoded files get SCIP, error files get tree-sitter); process exits 0.
- **Explicit `--scip <bad-path>`**: pass a deliberately corrupted file to `codegraph index --scip ./bad.scip` → process exits **non-zero**, error message names the file, and DB state matches snapshot taken before the call. This is the fail-fast contract for caller-supplied input (ship gate 12a).

`__tests__/p05b-parity.test.ts` asserts:

- Run parity harness on VB.NET fixture; report shows `shared` covers ≥ 80% of total edges; `scipOnly` covers only the expected compiler-magic categories.
- Run parity on a hand-crafted C# fixture with namespace/class scope dependencies; report shows zero divergences.

**Effort: 3 days**

### P0 effort summary

| Subsection | Effort |
|---|---|
| P0.0 Toolchain detection | 1.5d |
| P0.1 Streaming decoder | 2d |
| P0.2 Protobuf tooling | 0.5d |
| P0.3 SCIP symbol parser | 0.5d |
| P0.4 Persister | 4d |
| P0.4b Crash recovery | 0.5d |
| P0.4c Build-failure tolerance | 1d |
| P0.4d Derived ConfidenceTier | 0.5d |
| P0.5 Ingester orchestration | 1d |
| P0.5b Resolution-Parity | 5d |
| P0.6 Orchestrator dual-backend dispatch | 1d |
| P0.6b VB.NET tree-sitter extractor | 5d |
| P0.7 CLI | 0.5d |
| P0.8 Types / config / WASM grammar registration | 0.5d |
| P0.9 DB schema migration | 0.5d |
| P0.10 Tests + fixtures | 3d |
| **Total** | **~21d** |

P0.7 CLI and P0.8 types overlap with P0.0 work; the realistic total accounting for shared infrastructure is in the ~21d range.

---

# P1 — Framework Resolver synthesize/augment Refactor (directional)

> P1 is intentionally less detailed than P0. The GraphView API surface, the `synthesize` / `augment` data contracts, the `node_tags` write semantics, and the framework-subkind registration mechanism all need interface-level specification before implementation. Write a dedicated PR plan (`codegraph-framework-synthesize-augment.md`) after P0 lands.

### Direction (overall structure)

- **P1.1** — `node_tags` table (0.5 day):
  ```sql
  CREATE TABLE node_tags (
    node_id  TEXT NOT NULL,
    tag      TEXT NOT NULL,
    added_by TEXT,
    PRIMARY KEY (node_id, tag),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
  );
  CREATE INDEX idx_node_tags_tag ON node_tags(tag);
  ```

- **P1.2** — `GraphView` interface (1 day): a read-only facade exposing 13 methods (`getNode`, `hasNode`, `getNodesByKind` / `ByQualifiedName` / `ByName` / `ByLowerName` / `ByFile` / `ByTag`, `getOutgoingEdges`, `getIncomingEdges`, `getAllFiles`, `fileExists`, `readFile`, `readFileStripped`). Phase 3 internally snapshots the view; mutations are returned, not made through the view.

- **P1.3** — New `FrameworkResolver` interface (0.5 day):
  ```ts
  interface FrameworkResolver {
    name: string;
    languages?: Language[];
    detect(ctx: ResolutionContext): boolean;
    synthesize?(graph: GraphView): Node[];
    augment?(graph: GraphView): { edges: Edge[]; tags?: Array<{ nodeId: string; tags: string[] }> };
  }
  ```

- **P1.4** — Pipeline Phase 3 (1.5 days): run all `synthesize()` first, rebuild the view, then run all `augment()`. Remove the per-file framework extract hook at [`tree-sitter.ts:2487`](src/extraction/tree-sitter.ts#L2487).

- **P1.5** — Migrate existing resolvers + add framework-specific resolvers (~8 days):
  - **Migrate 14 existing** (~7 days, ~4 hours each): `csharp/aspnet`, `laravel`, `express`, `react`, `svelte`, `vue`, `django`, `flask`, `fastapi`, `rails`, `go`, `rust`, `swift` (uikit + swiftui + vapor), and `spring-core` (split from former monolithic `spring`).
  - **Add `spring-temporal`** (~0.5 day) — `WorkflowStub.start()` and `ActivityStub.execute()` resolve to concrete workflow / activity implementations. Emits `calls` edges with `subkind='temporal_dispatch'`. The call site is an explicit invocation in source code, so `line` / `col` ARE available and the edge follows the standard `calls` rule (REQUIRED position) — the subkind does NOT need to be added to `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION` (that allowlist applies only to `references` edges that lack a positional source, like DI bindings declared in config). Type-driven matching (workflow stub generic parameter → workflow class), low false-positive rate in monorepo deployments.
  - **Add generic `temporal`** (~0.5 day) — language-agnostic Temporal stub→workflow resolution for Go / TypeScript / Java / Python clients.

  > **Why no `spring-kafka` resolver**: Kafka producer/consumer edges are typically *cross-service* (producer in one repo, consumer in another). This plan is single-repo; multi-repo support is a separate epic. Within a single repo, Kafka resolution is also string-based (topic name matching), which is the same anti-pattern Phase 2 carefully avoids. The right home for Kafka analysis is the multi-repo epic, where topic strings can be treated as cross-service contracts with proper provider/consumer matching.

- **P1.6** — Regression tests (0.5 day): the existing `frameworks.test.ts` suite plus a new dedup test verifying that SCIP and framework edges for the same `(caller, callee, kind, subkind, line, col)` merge into one row with both contributing provenances recorded.

### Constraints framework-augmented edges must respect

- `provenance` is `'framework:<name>'` (already part of `GraphProvenance`).
- All edge writes go through `upsertGraphEdge` — no bypass of dedup.
- Edge line/column invariant: a route-to-handler edge typically uses `references` + `subkind='convention'` (NULL allowed); a containment edge uses `contains` (FORBIDDEN line/col).

### Items the P1 PR plan must specify in detail

- Full signatures, return types, and index guarantees for every `GraphView` method.
- The snapshot timing of the view passed to `synthesize` / `augment`.
- Required vs optional fields on every `Node` and `Edge` returned by `synthesize` / `augment`.
- Concurrency semantics of `node_tags` when multiple frameworks tag the same node.
- The framework-subkind registration mechanism (how `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION` is extended).

**P1 estimate: ~12 days. Calibrate when writing the detailed PR plan.**

---

# P2 — Stale-Aware Sync + Language-Aware Shadow + Nightly Refresh

## Ship gates

- A file modification does not require manually re-running the SCIP indexer.
- Files whose language has a shadow-capable extractor (tree-sitter WASM grammar or custom svelte/vue/liquid) get a fresh tree-sitter shadow on change; stale SCIP edges for that file are hidden in default queries.
- Files whose language has no shadow-capable extractor keep stale SCIP data visible with a staleness annotation, rather than disappearing entirely.
- `codegraph scip-refresh` re-runs the upstream indexer and re-ingests in one command.

## P2.1 — Stale partial indexes + query inventory

The `stale` and `staleness_visible` columns themselves are added in P0 schema (see P0.4) so that `upsertGraphEdge` can clear them uniformly from day one. P2 adds only the partial indexes and the query-filter wiring:

```sql
CREATE INDEX idx_nodes_stale ON nodes(stale) WHERE stale = 1;
CREATE INDEX idx_edges_stale ON edges(stale) WHERE stale = 1;
```

Semantics: `stale=1` plus `staleness_visible=0` means "hidden in queries — fresh shadow exists for this file"; `stale=1` plus `staleness_visible=1` means "still shown with a staleness annotation — no fresh data is available". Default query filter: `WHERE stale = 0 OR staleness_visible = 1`.

### Query inventory — every public query must apply this filter

| Module | Methods |
|---|---|
| [`db/queries.ts`](src/db/queries.ts) node SQL | `getNodeById`, `getNodesByName`, `getNodesByLowerName`, `getNodesByKind`, `getNodesByFile`, `searchNodes` (FTS5 join), `getAllNodes` |
| [`db/queries.ts`](src/db/queries.ts) edge SQL | `getOutgoingEdges`, `getIncomingEdges`, `getEdgesByKind`, `getAllEdges` |
| [`graph/traversal.ts`](src/graph/traversal.ts) | `bfs`, `dfs`, `findPaths`, `getImpactRadius` |
| [`graph/queries.ts`](src/graph/queries.ts) | `getCallers`, `getCallees`, `getCallGraph` |
| [`context/index.ts`](src/context/index.ts) | `buildContext`, `explore` |
| [`mcp/tools.ts`](src/mcp/tools.ts) | `codegraph_search`, `codegraph_callers`, `codegraph_callees`, `codegraph_impact`, `codegraph_context`, `codegraph_explore`, `codegraph_node` |

Push the filter into the low-level prepared statements in `QueryBuilder`. Add suffixed `*IncludingStale` methods for the `status` command. A regression test in [`__tests__/queries.test.ts`](__tests__/queries.test.ts) inserts mock stale data and asserts that every listed public method does not return it.

**Effort: 1 day**

## P2.2 — Language-aware shadow policy

```ts
function isShadowCapable(lang: Language): boolean {
  return isLanguageSupported(lang)
      && lang !== 'unknown'
      && lang !== 'external';
}
```

(Note: with P0.6b's vbnet WASM grammar in place, `vbnet` IS shadow-capable.)

Modify [`extraction/index.ts:1203 sync`](src/extraction/index.ts#L1203) — note this is the real sync path; `src/sync/index.ts` is only a watcher export.

### Schema reality and the stale-edge policy

The `edges` table has no `file_path` column (edges are between nodes, identified by `source`/`target` node ids). To mark "edges associated with a file" stale, we must join through `nodes`. The policy: **an edge is stale when *either* endpoint is in the changed file** — both the inbound and outbound directions of a cross-file relationship are invalidated when one file moves. This matches how SCIP-derived call/reference edges become semantically invalid when the source side is rewritten.

```sql
-- For nodes in the changed file
UPDATE nodes
   SET stale = 1, staleness_visible = ?   -- 0 if shadow-capable, 1 if not
 WHERE file_path = ?
   AND provenance LIKE 'scip%';

-- For edges with either endpoint in the changed file
UPDATE edges
   SET stale = 1, staleness_visible = ?
 WHERE provenance LIKE 'scip%'
   AND (source IN (SELECT id FROM nodes WHERE file_path = ?)
     OR target IN (SELECT id FROM nodes WHERE file_path = ?));
```

Cross-file edges therefore get re-marked when either side moves. After tree-sitter shadow extraction re-emits the source-side edges with fresh data, the stale rows naturally lose `staleness_visible=0` priority via the default query filter. The target-side stale flag is cleared when the *other* file is itself re-extracted or refreshed.

### Pseudocode

```
for each modified file:
  if file in scip_documents AND hash != stored_hash:
    lang = SELECT language FROM files WHERE path = file
    if isShadowCapable(lang):
      mark_stale(file, staleness_visible = 0)   // SQL above
      treesitter_extract(file)
    else:
      mark_stale(file, staleness_visible = 1)   // SQL above
      # no tree-sitter fallback
  elif file not in scip_documents:
    treesitter_extract(file)
```

Branch-switch defense: if `changedScipFiles > maxStaleFiles` (default 50), mark in bulk without per-file shadow work; warn the user to refresh.

**Edge case — symmetric endpoint test**: when file X changes, an edge `A.foo (in X) → B.bar (in Y)` is marked stale. When file Y *also* changes, the same edge gets re-marked (idempotent — `stale=1` stays `stale=1`). When file X is later refreshed, the source-side stale flag is cleared by the re-emitted edge replacing the row; the target-side flag clears when Y is refreshed. A regression test in P2.6 covers this asymmetric clearing.

**How shadow extraction clears stale**: the sync sequence is `mark_stale(file)` → `treesitter_extract(file)`. Tree-sitter extraction emits edges that go through `upsertGraphEdge`. When the upsert finds an existing row at the same `(source, target, kind, subkind, line, col)` fingerprint (i.e., a SCIP edge that was just marked stale=1), the UPDATE branch sets `stale=0, staleness_visible=0` as part of its standard freshness invariant (see P0.4). This makes the merged row visible again under the default query filter. The merged `provenances[]` now contains both `'scip'` (historical, still in the audit trail) and `'tree-sitter'` (fresh contribution); the primary `provenance` stays `'scip'` because of the priority order, but the row is no longer hidden. When a SCIP edge has no tree-sitter counterpart (e.g., compiler-magic feature in VB), the upsert never fires for that fingerprint and the row remains `stale=1, staleness_visible=0` — correctly hidden until the next `scip-refresh` ingests fresh SCIP data and the STAGE B.2 scoped delete + re-insert restores it.

**Effort: 2 days**

## P2.3 — `codegraph scip-refresh`

```
1. Spawn config.scipRefreshCommand (default 'scip-dotnet index ./').
2. On success, equivalent to `codegraph index --scip ./index.scip`:
     - STAGE B scoped delete (with crash-recovery branch)
     - Re-ingest
     - Clear stale + staleness_visible for files covered by this scip_index_path
3. Log to .codegraph/logs/scip-refresh-YYYY-MM-DD.log
4. Update metadata in .codegraph/scip-last-refresh.json
```

Exit codes: 0 success, 1 indexer failed, 2 ingest failed.

**Effort: 0.5 day**

## P2.4 — `codegraph status` enhancements

Report: number of SCIP-covered files, last refresh time, stale file list grouped into "shadow active" vs "needs refresh", empty-fallback file count, next scheduled refresh time, per-language tier (e.g., "C#: Tier 1 SCIP (scip-dotnet 0.4.2); VB.NET: Tier 0 tree-sitter"), explicit manual-refresh hint.

**Effort: 0.5 day**

## P2.5 — Cron templates + documentation

`docs/scheduling/`:
- `launchd.plist.template` (macOS)
- `systemd.service.template` + `systemd.timer.template` (Linux)
- `task-scheduler.xml.template` (Windows)

The first release ships templates only; a cross-platform `codegraph schedule install` helper is deferred.

**Effort: 0.5 day**

## P2.6 — Tests

- Shadow-capable language path: modify a `.cs` file → queries return fresh tree-sitter data; stale SCIP does not surface.
- Non-shadow-capable path: modify a file in a no-WASM-grammar language → stale SCIP rows remain visible with staleness annotation.
- Refresh replaces shadow + clears stale flags.
- Branch switch > 50 files → bulk-stale path triggered.
- Empty-fallback mock.
- Query inventory regression: for each public method in the inventory above, mock stale rows and verify they do not leak out.
- **Freshness invariant regression**: pre-insert a SCIP edge at `(A, B, calls, NULL, 10, 5)` with `stale=1, staleness_visible=0`. Then call `upsertGraphEdge` with a tree-sitter edge at the identical fingerprint. Assert:
  - The row's `provenances[]` contains both `'scip'` and `'tree-sitter'`.
  - The row's `provenance` (primary) is still `'scip'` (priority).
  - The row's `stale=0` and `staleness_visible=0` (cleared by the upsert).
  - Default query filter now returns the row.
- **Stale persistence when no shadow contributor exists**: pre-insert a SCIP edge with `stale=1, staleness_visible=0`. Run sync without any extractor emitting a matching fingerprint. Assert the row's `stale=1` stays unchanged and the default query filter still hides it.

**Effort: 1 day**

**P2 total: ~5 days.**

---

## Modified files

### P0

- New: `src/extraction/scip/detect-indexers.ts` — installed SCIP indexer detection
- New: `src/extraction/scip/failure-ledger.ts` — failure ledger write to `.codegraph/scip-failures.json`
- New: `src/extraction/scip/{scip.proto, streaming-decoder.ts, symbol-parser.ts, persister.ts, index.ts}`
- New: `src/resolution/scope-index.ts` — file + class scope index for csharp/vbnet/java/python/typescript
- New: `src/extraction/wasm/vbnet.wasm` + `vbnet.wasm.sha256` — committed binary + integrity hash
- New: `src/extraction/languages/vbnet.ts` — `LanguageExtractor` config
- New: `scripts/build-vbnet-wasm.sh` — WASM grammar build script
- New: `__tests__/parity/parity-harness.ts` — parity report + `assertEdgesEquivalent`
- Edit: [`src/types.ts`](src/types.ts) — `LANGUAGES` += vbnet/external; `GraphProvenance` union; `ConfidenceTier` type + `deriveConfidenceTier()`; `Node.provenance/scipSymbol/scipIndexPath`; `Edge` extensions (`provenances`, `confidence`, `subkind`); `CodeGraphConfig.scipSources`, `scipAuto`, `disabledScipIndexers`, `emptyFallbackThresholdBytes`; `DEFAULT_CONFIG.include` += `**/*.vb`
- Edit: [`extraction/index.ts`](src/extraction/index.ts) — `indexAll` and `sync` dual-backend dispatch + auto-detection branch + scope-resolver call after tree-sitter
- Edit: [`src/index.ts`](src/index.ts) — `open()` and `openSync()` add `cleanupIncompleteIngestions`
- Edit: [`src/bin/codegraph.ts`](src/bin/codegraph.ts) — `--scip`, `--scip-auto`, `--no-scip`, `--languages` subset filter, `codegraph parity` subcommand
- Edit: [`extraction/grammars.ts`](src/extraction/grammars.ts) — `EXTENSION_MAP['.vb'] = 'vbnet'`; `WASM_GRAMMAR_FILES['vbnet'] = 'vbnet.wasm'`; `GrammarLanguage` `Exclude<>`
- Edit: [`config.ts`](src/config.ts) — `validLanguages` derives from `LANGUAGES`
- Edit: [`db/schema.sql`](src/db/schema.sql) + [`db/migrations.ts`](src/db/migrations.ts) — provenance columns (`nodes.provenance/scip_symbol/scip_index_path`, `edges.provenances/confidence/subkind`); reserved stale flags (`nodes.stale/staleness_visible`, `edges.stale/staleness_visible` — default 0; values flipped to 1 only in P2, but columns exist from P0 so `upsertGraphEdge` clears them uniformly); new tables `scip_documents`, `scip_ingestions`, `scip_external_refs`; edge unique index `idx_edges_dedup`; `CURRENT_SCHEMA_VERSION = 5`
- Edit: [`db/queries.ts`](src/db/queries.ts) — `NodeRow`, `rowToNode`, `insertNode`, `insertNodes`, `updateNode`, new `insertScipNode`, new `upsertGraphEdge` + `pickPrimaryProvenance`, new `cleanupIncompleteScipIngestion`; update `rowToEdge` to include `provenances` / `confidence` / `subkind`
- Edit: [`package.json`](package.json) — add `protobufjs`, `which`; copy `.proto` to `dist/`; ensure `src/extraction/wasm/vbnet.wasm` and `.sha256` are included in the published artifact
- New: `__tests__/fixtures/vbnet-sample/` (`.vbproj` + `.vb` files + committed `.scip` + `baseline.json`)
- New: `__tests__/scip-ingester.test.ts`, `__tests__/tier0-vbnet.test.ts`, `__tests__/p00-toolchain-detection.test.ts`, `__tests__/p04c-failure-tolerance.test.ts`, `__tests__/p05b-parity.test.ts`, `__tests__/wasm-integrity.test.ts`

### P1

- New: `src/resolution/graph-view.ts`
- New: `src/resolution/frameworks/spring-temporal.ts`, `src/resolution/frameworks/temporal.ts` (generic, language-agnostic)
- (No `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION` change for `'temporal_dispatch'` — the subkind lives on `calls` edges which carry line/col from the actual stub invocation site; the allowlist only governs `references` subkinds with no positional source.)
- Edit: [`resolution/types.ts`](src/resolution/types.ts), [`resolution/index.ts`](src/resolution/index.ts), [`extraction/tree-sitter.ts:2487`](src/extraction/tree-sitter.ts#L2487)
- Edit: every file under [`resolution/frameworks/`](src/resolution/frameworks/) — 14 existing resolvers + `spring-core.ts` (split from former monolithic `spring`) + 2 new files = 16 framework modules
- Edit: [`db/schema.sql`](src/db/schema.sql), [`db/migrations.ts`](src/db/migrations.ts) — `node_tags`, `CURRENT_SCHEMA_VERSION = 6`
- Edit: [`__tests__/frameworks.test.ts`](__tests__/frameworks.test.ts) — add Spring DI / Temporal test cases

### P2

- Edit: [`db/schema.sql`](src/db/schema.sql), [`db/migrations.ts`](src/db/migrations.ts) — partial indexes `idx_nodes_stale` / `idx_edges_stale` only (the `stale` and `staleness_visible` columns themselves are added in P0 so `upsertGraphEdge` can clear them uniformly from day one — do NOT re-add them here); `CURRENT_SCHEMA_VERSION = 7`
- Edit: [`db/queries.ts`](src/db/queries.ts) — default filter `WHERE stale = 0 OR staleness_visible = 1` pushed into prepared statements
- Edit: [`extraction/index.ts:1203`](src/extraction/index.ts#L1203) — language-aware shadow; sync path sets `stale=1` on affected SCIP rows via node-join SQL (P2.2)
- Edit: [`src/bin/codegraph.ts`](src/bin/codegraph.ts) — `scip-refresh` subcommand; `status` enhancements
- New: `docs/scheduling/*.template`
- Edit: [`README.md`](README.md), [`CLAUDE.md`](CLAUDE.md), [`CHANGELOG.md`](CHANGELOG.md)
- New/edit: [`__tests__/queries.test.ts`](__tests__/queries.test.ts) — stale-leak regression + freshness invariant regression (per P2.6)

## Existing infrastructure reused

- Migration framework in [`db/migrations.ts`](src/db/migrations.ts)
- Case-insensitive name index ([`db/queries.ts:466`](src/db/queries.ts#L466)): `SELECT ... WHERE lower(name) = ?`
- Git-fast-path sync detection in [`extraction/index.ts:1203+`](src/extraction/index.ts#L1203)
- MCP server in [`src/mcp/`](src/mcp/) — unchanged; new data flows through existing queries
- `isLanguageSupported` in [`grammars.ts:206`](src/extraction/grammars.ts#L206)
- The pre-existing `edges.provenance` column and index — extended, not reinvented
- The pre-existing `edges.metadata` column — reused, not re-added
- The pre-existing `nodes.docstring` + FTS5 BM25 integration — external node documentation flows into it directly

## Implementation risk register

Risks below are accepted as caught-by-PR-review-and-tests rather than further plan iteration.

| Risk | Trigger | Detection | Mitigation |
|---|---|---|---|
| `upsertGraphEdge` migration gap — a write site directly uses `INSERT INTO edges` | Forgotten replacement during refactor | `grep "INSERT INTO edges"` + `grep "insertEdge("` audits in CI | Tests that double-insert the same edge and assert merge; CI alert on unique-constraint violation |
| Node provenance touch point missed — a query path forgets to read the three new fields | Refactor oversight | Round-trip insert→update→select test in P0.10 | Automated "DB column exists but select does not return it" check |
| Protobuf field-order assumption breaks if scip-dotnet changes wire encoding | Upstream change | Tests that mock field reorderings of the synthesized `.scip` | Wire-level reader explicitly handles any field order |
| Corrupt `.scip` file (network truncation, disk error) | External | `iterateScipDocuments` throws → fail-fast ingest | `scip_ingestions.completed_at` left NULL → next open auto-cleans |
| GraphView queries slow under unexpected access patterns from new framework resolvers | P1 implementation | P1 perf baseline test | Add LRU cache or specialised indexes as needed |
| `validateEdgeLineColumn` missed by a new promotion path | Future kind-promotion feature | Validator throws → implementer adds to allowlist | All current promotion paths covered by P0.10 tests |
| `nodes.scip_index_path` index selectivity low when one .scip dominates | Single-index project | `EXPLAIN QUERY PLAN` audit | Partial index with `WHERE scip_index_path IS NOT NULL` already in schema |
| VB.NET tree-sitter extractor (P0.6b) precision below user expectation | User compares Tier 0 graph against actual VB semantics and finds gaps (My.\*, project-level Imports, etc.) | User-reported missing edges | CLI output explicitly states "Tier 0, ~70% precision" + install hint for scip-dotnet upgrade; documentation lists exactly which VB features Tier 0 does not cover |
| Scope index (P0.5b) extended beyond 5 languages by future contributors | Contributor adds Ruby/Go scope walker for parity completeness | PR review | Document the deliberate 5-language scope in `scope-index.ts` header; reject additions as separate-PR work unless paired with parity test coverage |
| `--scip-auto` spawns slow indexers serially in large repos | scip-java on a 1M LOC monorepo takes minutes | Wall-clock benchmark | Parallel spawn deferred; document the sequential model; revisit when measurements warrant |
| P0.4c failure ledger grows unbounded | Repeated failures from cron-driven scip-refresh | `.codegraph/scip-failures.json` file size | File is overwritten per run; long-term history is in `.codegraph/logs/`. No truncation needed |
| Tier 0 / Tier 1 UX confusion: user thinks SCIP is running when it isn't | User installs `scip-dotnet` after a Tier 0 index but forgets to re-run with `--scip-auto` | `codegraph status` surfaces tier per-language | `codegraph status` reports per-language tier (e.g., "C#: Tier 1 SCIP (scip-dotnet 0.4.2); VB.NET: Tier 0 tree-sitter") |

## Out of scope

- L0 (repo map) / L1 (domain ontology) — separate effort.
- **Kafka producer/consumer resolution** — Kafka edges are typically cross-service (producer and consumer in different repos), so single-repo resolution produces mostly dangling edges. Also relies on topic-string matching, which is the name-matcher anti-pattern Phase 2 carefully avoids. Belongs in a multi-repo Contract Bridge epic where cross-service contracts can be tracked properly with provider/consumer matching and schema awareness.
- **`--scip-docker` toolchain bundling escape hatch** — a Docker container pre-bundled with all SCIP indexers (~2GB image) would let users with only Docker installed get Tier 1 SCIP precision without installing each language toolchain. Considered but deferred: (a) Docker dependency is heavy, (b) container size is non-trivial, (c) the auto-detection + tree-sitter fallback path handles "missing toolchain" UX adequately. Revisit if user feedback indicates persistent toolchain friction.
- WebForms `.aspx` markup parsing — neither SCIP nor tree-sitter covers it.
- Cross-platform `codegraph schedule install` helper — this plan ships templates only.
- Shared SCIP indexes (CI generation + team distribution) — separate plan: artifact upload/download, version negotiation, branch awareness.
- Same source file covered by multiple `.scip` indexes — rejected with `MultiIndexConflictError`; an `ingest_order` priority mechanism is a possible future enhancement.
- Qualified-name bridging across extractors — cross-file references that target a fallback file remain unresolved.
- Switching non-positional edges to support source location — if a real need emerges, introduce a new subkind rather than relaxing the three-tier invariant.
- Lexical / block scope resolution (function-local variables, closures, nested scopes) — P0.5b intentionally only covers file + class scope. Lexical scope adds substantial per-language complexity (Python LEGB, JS hoisting, Go package scope, etc.) for limited additional value on top of SCIP.
- Scope resolution for languages outside {csharp, vbnet, java, python, typescript} — P0.5b intentionally limits the language scope; other supported languages continue to use the heuristic name-matcher with `provenance='heuristic'`.
- Custom / community SCIP indexers — the `SCIP_INDEXERS` constant is hardcoded. Users with new indexers (`scip-elixir`, team-internal SCIP producers) currently need to fork. A future `CodeGraphConfig.customScipIndexers` extension point is straightforward to add.
- Multi-repo / cross-service contract analysis — independent epic.

## CHANGELOG entries (one per PR ship)

**P0 release:**

> ### Added (Tier 0 — zero toolchain required)
> - **VB.NET tree-sitter support out-of-the-box**: bundled WASM grammar parses `.vb` files with no .NET SDK required. Covers `Module`, `Class`, `Namespace`, `Sub`, `Function`, `Property` (with Get/Set), `Inherits`, `Implements`, `Friend` (mapped to `internal`), `Shared` (mapped to static), `Sub New` constructors, and per-file `Imports`. Achieves ~70% of SCIP precision; compiler-magic features (`My.*`, `WithEvents`+`Handles`, project-level Imports, cross-`.vbproj` references) remain SCIP territory.
> - **Resolution-parity infrastructure**: file + class scope index for C#, VB.NET, Java, Python, and TypeScript replaces the prior name-matcher heuristic, lifting cross-file reference accuracy for tree-sitter-only paths.
>
> ### Added (Tier 1 — opt-in compiler-grade)
> - **SCIP file ingestion** via `codegraph index --scip <path>` (CI-friendly explicit path) or `codegraph index --scip-auto` (auto-detect installed indexers and spawn them). Compiler-grade indexing for .NET (C#/VB.NET), Java, Kotlin, Scala, Rust, TypeScript, Python, Go, and Ruby. Multiple `--scip` flags can be combined; each `.scip`'s coverage is tracked independently. Overlapping coverage of the same file by two `.scip` files is rejected with a clear error.
> - **VB.NET compiler-grade via scip-dotnet** (when installed): adds the compiler-magic features above on top of the Tier 0 graph.
> - **Streaming protobuf decoder** and on-disk symbol map keep ingest memory bounded for large (500 MB+) `.scip` files with millions of symbols.
> - **Crash recovery**: incomplete ingestion is detected and cleaned up on next open.
> - **Build-failure tolerance**: any SCIP failure mode (missing indexer, build failure, OOM, corrupt `.scip`) degrades cleanly to tree-sitter for the affected files. CodeGraph never becomes unusable because SCIP failed.
>
> ### Changed
> - DB schema adds `provenance` extension (now includes `'scope-resolved'` and `'scip:external'`), `scip_symbol`, edge `subkind` and `confidence` columns to track provenance and resolution quality. `validLanguages` in config validation now derives from the canonical `LANGUAGES` list.
> - `pickPrimaryProvenance` priority: `scip > scip:external > scope-resolved > tree-sitter > framework:* > heuristic > tree-sitter (scip-empty-fallback)`.
>
> ### Notes
> - CLI prints toolchain hints after Tier 0 indexing, suggesting which `scip-*` indexers to install for compiler-grade upgrade.
> - New `codegraph parity --fixture <path>` subcommand for comparing tree-sitter vs SCIP graphs side-by-side.

**P1 release:**

> ### Added
> - **Spring DI dispatch resolution**: `@Autowired` / `@Inject` fields and constructor injection resolve through the field type to concrete implementations via `INHERITS` edges. Emits `references` edges with `subkind='di_binding'`.
> - **Spring Temporal workflow / activity resolution**: `WorkflowStub.start()` and `ActivityStub.execute()` resolve to concrete workflow / activity implementations. Emits `calls` edges with `subkind='temporal_dispatch'`.
> - **Generic Temporal resolver** (language-agnostic) covering Go / TypeScript / Java / Python clients.
>
> ### Changed
> - Framework resolvers refactored to a `synthesize` / `augment` API that runs against the complete graph after static extraction. Resolvers now see SCIP-precise type information when augmenting framework edges (routes, DI bindings, component references). A new `node_tags` table backs the `GraphView.getNodesByTag` query.
> - Spring resolver split: former monolithic `spring` is now `spring-core` (DI / `@Component` / `@Service`) plus `spring-temporal`.

**P2 release:**

> ### Added
> - `codegraph scip-refresh` for one-step re-index. Pair with cron / launchd / systemd timer for nightly auto-refresh — templates in `docs/scheduling/`.
> - Stale-aware queries with language-aware shadowing: when a SCIP-covered file is modified, codegraph falls back to tree-sitter for that file if a grammar exists. For files without a tree-sitter grammar, stale SCIP data remains visible with a staleness annotation rather than disappearing entirely.
> - `codegraph status` reports SCIP coverage, stale files (grouped by shadow vs needs-refresh), fallback files, per-language tier, and next-scheduled-refresh time transparently.
