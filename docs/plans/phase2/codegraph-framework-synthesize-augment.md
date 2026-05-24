# CodeGraph Framework Resolver `synthesize` / `augment` Refactor — Implementation Plan

> Detailed P1 PR plan, written after P0 landed. Companion to [codegraph-scip-ingestion.md](codegraph-scip-ingestion.md) — assumes all P0 invariants: `edges.provenance` includes `'framework:<name>'`, `upsertGraphEdge` is the only edge-write path, `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION = {di_binding, config, convention}` is in place, `validateEdgeLineColumn` enforces the three-tier line/column invariant, edge dedup unique index `idx_edges_dedup` is live.

## Context

### What P0 left for P1

Two layers of framework hook are wired today, both pre-graph:

| Hook | Where | Defect |
|---|---|---|
| `extract(filePath, content)` | [tree-sitter.ts:2551](src/extraction/tree-sitter.ts#L2551) inside `extractFromSource`, called once per file | Sees only the file's raw text (`stripCommentsForRegex`). Regex-matches annotations / decorators / route DSLs. Cannot see the symbol table — for ASP.NET `[HttpGet]`-style annotations that's fine, but for Spring `@Autowired Foo foo` the type resolution falls into the name-matcher heuristic |
| `resolve(ref, context)` | [resolution/index.ts:528](src/resolution/index.ts#L528) `resolveOne` Strategy 1, called once per unresolved ref | The `ResolutionContext` only exposes `getNodesByName / ByQualifiedName / ByKind / ByFile / ByLowerName`. **No edge lookups.** A resolver cannot ask "who are all the `implements` children of `Foo`" — exactly the question Spring DI dispatch needs to answer |

P0.5b already introduced `provenance='scope-resolved'` (`confidence=0.75`) so bare-name references resolve through class then file scope for csharp/vbnet/java/python/typescript. P1 is the third static-resolution layer ("Phase 3"): look at the **whole graph**, write **derived edges and tags**.

### Why `synthesize` and `augment` are two separate stages

If a resolver writes a node and an edge in one call, the edge target may not yet exist (because another resolver hasn't run its `synthesize` yet). Splitting the work into "everyone produces nodes first → rebuild view → everyone produces edges" eliminates ordering dependencies across resolvers. The cost is one extra view-rebuild per index.

### Why `node_tags` and not a column

Tags are many-to-one against nodes (a Spring class is both `spring:service` and a `route-handler`), they grow with each new framework, and they are queried by tag (`getNodesByTag('react:hook')`). A dedicated table is the only sane representation. The cost is one new index file and one new query path.

## Ship gates

1. Every existing framework resolver's behavior (detect set + the `(source, target, kind)` triples covered by current tests) remains **equivalent**. `__tests__/frameworks.test.ts` passes with no snapshot diff — line/column may differ.
2. When SCIP and a framework resolver both produce an edge at the same `(source, target, kind, subkind, line, col)` fingerprint, the DB holds **one row** whose `provenances[]` contains both, and whose primary `provenance='scip'` per the P0.4 priority table.
3. A node synthesized by resolver A is visible to resolver B's `augment()` — i.e. `Phase3Orchestrator` rebuilds the `GraphView` snapshot between stages A and B.
4. A `synthesize` / `augment` throw in one resolver quarantines that resolver's output only. The other resolvers complete; the index exits 0; the thrown error surfaces as one `ExtractionError` of severity `warning`.
5. **Spring DI dispatch**: covers both field injection (`@Autowired Foo foo`) and constructor injection (`@Autowired UserService(Foo foo)`, including Spring 4.3+ implicit single-constructor injection). In a fixture with `interface Foo`, `class Bar implements Foo`, and a `UserService` using either form, the resulting graph contains a `references` edge from the `UserService` field/parameter node to the `Bar` class node, with `subkind='di_binding'`, `provenance='framework:spring-core'`, line and column NULL (allowed via `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION`).
6. **Spring / generic Temporal dispatch**: `WorkflowStub.start()` and `ActivityStub.execute()` invocations resolve to the concrete workflow / activity implementation method. Edge: `kind='calls'`, `subkind='temporal_dispatch'`, `provenance='framework:spring-temporal'` (or `framework:temporal` for the generic variant), `line`/`col` filled from the source `.start()` site.
7. **After every resolver in P1.5 has migrated**, the per-file framework extract hook at [tree-sitter.ts:2550–2573](src/extraction/tree-sitter.ts#L2550) is removed, `extractFromSource` no longer takes `frameworkNames`, and the worker-thread `parse` message no longer carries `frameworkNames`. The removal happens in the **final** cleanup PR, NOT in PR-2 — see PR breakdown. During the migration window the legacy hook stays active for resolvers that have not yet defined `synthesize` / `augment`, otherwise route/component extraction for un-migrated resolvers regresses.
8. `node_tags` supports `getNodesByTag(tag)` queries. MCP `codegraph_search` accepts an optional `tag` filter. Schema version is 6.
9. `codegraph status` reports detected frameworks and the edge count **contributed** by each `framework:*` provenance — counting `provenances[]` membership, NOT primary `provenance`. Otherwise SCIP-primary edges that merged with a framework contribution (ship gate 2) would be invisible in the framework count. Implementation: query via `getEdgesByContributingProvenance(p)` ([src/db/queries.ts:1181](src/db/queries.ts#L1181)).

---

## P1.1 — `node_tags` table + schema v6

### Schema

```sql
CREATE TABLE node_tags (
  node_id   TEXT NOT NULL,
  tag       TEXT NOT NULL,
  added_by  TEXT NOT NULL,    -- 'framework:spring-core', etc — first writer wins
  PRIMARY KEY (node_id, tag),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX idx_node_tags_tag      ON node_tags(tag);
CREATE INDEX idx_node_tags_added_by ON node_tags(added_by);
```

### Migration

- `CURRENT_SCHEMA_VERSION = 6`, bumped from 5 (P0).
- Migration `5→6`: `CREATE TABLE node_tags …` + the two indexes. No data migration — P0 produces zero tags.
- Append the same DDL to `schema.sql` so fresh installs match migrated ones.

### Tag-naming convention (documented in `node_tags`-touching code)

- All lowercase, kebab-case.
- `<framework>:<role>` form, e.g. `spring:controller`, `spring:service`, `aspnet:controller`, `react:hook`, `react:component`, `django:view`, `temporal:workflow`, `temporal:activity`.
- Cross-framework roles unprefixed: `route-handler`, `entry-point`.

### Conflict policy

`(node_id, tag)` duplicates use `INSERT OR IGNORE` silently. Duplicate writes are normal — joint detection (Spring Boot + Spring Temporal recognizing the same class) is the common case. `added_by` records the **first** writer; this mirrors the "first-occurrence wins" rule used by `pickPrimaryProvenance` for equal-rank provenances (P0.4). If the second writer's identity is ever needed for diagnostics, surface it via a `provenances`-style array column in a future schema bump; we have no concrete consumer today.

### Touch points

- `src/db/schema.sql` — append table + indexes.
- `src/db/migrations.ts` — add migration 5→6; bump `CURRENT_SCHEMA_VERSION`.
- `src/db/queries.ts` — add `insertNodeTag(nodeId: string, tag: string, addedBy: string): void` and `getNodesByTag(tag: string): readonly Node[]`.
- `__tests__/migrations.test.ts` — round-trip: insert tag, query, assert.

**Effort: 0.5 day**

---

## P1.2 — `GraphView` read-only snapshot interface

New file: `src/resolution/graph-view.ts`, ~200 lines.

### Interface

```ts
export interface GraphView {
  // ── Node lookups ────────────────────────────────────────────────
  getNode(id: string): Node | null;
  hasNode(id: string): boolean;
  getNodesByKind(kind: NodeKind): readonly Node[];
  getNodesByQualifiedName(qn: string): readonly Node[];        // exact match
  getNodesByName(name: string): readonly Node[];
  getNodesByLowerName(lower: string): readonly Node[];
  getNodesByFile(filePath: string): readonly Node[];
  getNodesByTag(tag: string): readonly Node[];                 // P1.1
  getAllNodes(): IterableIterator<Node>;                       // generator, memory-safe

  // ── Edge lookups ────────────────────────────────────────────────
  getOutgoingEdges(nodeId: string, kinds?: readonly EdgeKind[]): readonly Edge[];
  getIncomingEdges(nodeId: string, kinds?: readonly EdgeKind[]): readonly Edge[];

  // ── File-system context (already in ResolutionContext, reused) ──
  getAllFiles(): readonly string[];
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | null;
  readFileStripped(filePath: string, language: Language): string | null;   // uses stripCommentsForRegex
  getProjectRoot(): string;
}
```

### Implementation

- `class QueryGraphView implements GraphView` — thin wrapper over `QueryBuilder` with **per-instance** LRU caches keyed by name / lowerName / qualifiedName. Caches live on the view instance, NOT on the underlying `QueryBuilder`, so constructing a fresh view (the STAGE C rebuild) gives clean cache state. The view does NOT mutate QueryBuilder's own caches; it reads through them. Any STAGE 0 / STAGE B writes that need to be visible to a subsequent view construction depend on `QueryBuilder`-level cache invalidation via `invalidatePhase3Caches()` — see the purge / persistence flow.
- All reads go through existing prepared statements: `getNodesByName`, `getOutgoingEdges` (with kind filter — `idx_edges_kind` already exists), etc. **No new SQL indexes** are required at this stage.
- Returned arrays are typed `readonly`. In `__DEV__` (env var `CODEGRAPH_DEV=1`), `Object.freeze` is applied at the top level to catch accidental mutation. Production paths skip the freeze for the obvious perf reason.
- `getAllNodes` is a generator: `function* getAllNodes() { yield* db.prepare('SELECT … FROM nodes').iterate(); }`. Resolvers that need "everything" must paginate by kind/tag instead — see the per-resolver migration template.

### Snapshot timing

Created in **two passes** by `Phase3Orchestrator` (P1.4):

- `view1` — created before any `synthesize()` runs. Reflects the post-P0.5b graph (SCIP + tree-sitter + scope-resolved + heuristic edges, no framework nodes/edges).
- `view2` — created after all `synthesize()` results are persisted (BOTH framework nodes AND inherent tags from `SynthesizeResult.tags`), before any `augment()` runs. Reflects view1 plus every newly inserted framework-synthesized node AND every inherent tag. This is the load-bearing visibility invariant for cross-resolver dependencies: e.g. `spring-core.augment()`'s `isInjectionConstructor` can call `view2.getNodesByTag('spring:service')` and see tags that `spring-core.synthesize()` (or any other resolver's synthesize) just emitted.

Each view is a **value snapshot**: it caches what it has read; subsequent DB mutations are not reflected. Resolvers must not assume cross-call mutation visibility within a single stage.

### Relationship to existing `ResolutionContext`

`ResolutionContext` (`resolution/types.ts:65`) is kept. It still services `framework.resolve()` (legacy hook) and the import-resolver. `GraphView` is a strict superset — same `QueryBuilder` underneath, no data duplication. After all resolvers migrate (P1.5 complete), `ResolutionContext` can be retired in a P3 cleanup PR, but that is not in P1's scope.

**Effort: 1 day**

---

## P1.3 — Extended `FrameworkResolver` interface

`src/resolution/types.ts` — additive change, the old hooks stay as `@deprecated` for the migration window.

```ts
export interface FrameworkResolver {
  name: string;                                  // unique, equals the provenance suffix
  languages?: Language[];                        // unchanged
  detect(context: ResolutionContext): boolean;   // unchanged — runs once at startup against ResolutionContext

  // ── Legacy API. Retained during migration; removed in P3. ──────
  /** @deprecated Use synthesize() + augment() instead. Slated for P3 removal. */
  resolve?(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /** @deprecated Use synthesize() instead. Slated for P3 removal. */
  extract?(filePath: string, content: string): FrameworkExtractionResult;

  // ── New API ────────────────────────────────────────────────────
  /**
   * Project-level node and inherent-tag synthesis. Sees the complete static
   * graph (SCIP + tree-sitter + scope-resolved). Produces:
   *   - framework-specific nodes (allowed kinds: 'route', 'component' only —
   *     see "Node-kind discipline"; never 'hook' / 'bean' / 'workflow' /
   *     similar role-tags that already have a source-code counterpart)
   *   - INHERENT tags on existing nodes (annotations, naming conventions —
   *     e.g. 'spring:service' on a `@Service`-annotated class). These are
   *     persisted in STAGE B and visible to every resolver's augment().
   * Does NOT produce edges — edges go in augment() so all resolvers'
   * synthesize() outputs are visible to every augment() pass.
   */
  synthesize?(graph: GraphView): SynthesizeResult;

  /**
   * Project-level edge + derived-tag synthesis. Runs after all synthesize()
   * and a view rebuild (so it sees every synthesize's nodes AND inherent tags).
   * Sees its own and every other resolver's synthesized nodes.
   *
   * Tags emitted here are DERIVED from edge construction (e.g. 'route-handler'
   * on a method that just became the target of a route edge). They are
   * persisted in STAGE E and are NOT visible to other augments in the same run
   * — only post-Phase-3 queries see them. If a resolver needs another resolver
   * to see its tags during augment, the source resolver must emit them in
   * synthesize, not augment.
   */
  augment?(graph: GraphView): AugmentResult;
}

export interface SynthesizeResult {
  nodes: Node[];                                  // each must carry provenance = `framework:${resolver.name}`
  tags?: Array<{ nodeId: string; tags: string[] }>;   // INHERENT tags — see synthesize() doc
  errors?: ExtractionError[];                     // diagnostics surfaced through the normal channel
}

export interface AugmentResult {
  edges: Edge[];                                  // each must carry provenance = `framework:${resolver.name}`
                                                  // each MUST NOT carry `metadata` — see "Edge metadata ownership"
  tags?: Array<{ nodeId: string; tags: string[] }>;   // DERIVED tags — see augment() doc
  errors?: ExtractionError[];
}
```

### Contracts and invariants

| Field | Constraint |
|---|---|
| `synthesize` `Node.provenance` | Must equal `framework:<this.name>`. `Phase3Orchestrator` asserts before insert; violating nodes are dropped and a `warning`-severity `ExtractionError` is logged |
| `synthesize` `Node.id` | Namespaced `framework:<name>:<deterministic-suffix>`. **Deterministic** — same input on rerun must produce the same id (otherwise reindexing churns the graph) |
| `augment` `Edge.provenance` | Same as above |
| `augment` `Edge.subkind` | Convention edges use `references` + a subkind in the P0 allowlist (`di_binding` / `config` / `convention`) and may carry NULL line/col. Real call sites (Temporal) use `calls` + `subkind='temporal_dispatch'` and **must** carry line/col |
| `augment` `Edge.metadata` | **Must be undefined.** Metadata is owned by static extractors (SCIP / tree-sitter). Framework augmenters contribute provenance only. See "Edge metadata ownership" below |
| `augment` `Edge.confidence` | Informational. `upsertGraphEdge` takes `max(existing, new)`; STAGE 0 purge recomputes from surviving provenances |
| `synthesize` `SynthesizeResult.tags` | INHERENT — annotations or naming conventions that hold regardless of edges. Persisted in STAGE B; visible to all augments |
| `augment` `AugmentResult.tags` | DERIVED — tags that follow from an edge this resolver just emitted. Persisted in STAGE E; NOT visible to sibling augments in the same run |
| `tags[].tags[]` | kebab-case, per P1.1 |
| Failure isolation | A thrown `synthesize` / `augment` discards all output from that resolver for the current round and records one `ExtractionError`. Sibling resolvers are unaffected; index exits 0 |
| Rejected writes | Node kind ∉ `NodeKind` union, edge kind ∉ `EdgeKind` union, or three-tier line/column violation → rejected and logged. `validateEdgeLineColumn` is the enforcer |

### Edge metadata ownership and confidence reconciliation

The merged-edge model from P0 has three contributing pieces of state that flow through `upsertGraphEdge`:

1. **`provenances[]`** — append-only audit trail. Cleanly owned per-contributor.
2. **`confidence`** — `max(existing, new)` on upsert. Multi-contributor — must be reconcilable on retraction.
3. **`metadata`** — shallow-merged on upsert (`{ ...oldMeta, ...newMeta }`, [src/db/queries.ts:1042](src/db/queries.ts#L1042)). **Not** reconcilable on retraction without per-contributor namespacing.

For framework augmenters that share an edge fingerprint with a SCIP or tree-sitter contribution (ship gate 2), STAGE 0's "strip framework from `provenances[]`" must not leave stale `confidence` or `metadata` behind. Solutions per state:

- **`metadata`**: framework augmenters **MUST NOT** set `edge.metadata`. Metadata is owned by the static extractor that first produced the edge. Augment-time metadata writes have no place to go (they'd merge into the shared blob and be impossible to retract cleanly). Phase3Orchestrator's edge pre-flight check rejects framework edges with non-empty `metadata` and logs a `warning`-severity `ExtractionError`.
- **`confidence`**: STAGE 0 SQL 0.1 recomputes confidence from the *surviving* provenances after stripping framework entries: `MAX(defaultConfidence(p) for p in survivingProvenances)`. With framework `defaultConfidence` capped at 0.85 ([src/types.ts:310](src/types.ts#L310)), the realistic case is a tree-sitter primary (0.7) merged with framework contribution (0.85) → row reads 0.85. After framework strip → row recomputes to 0.7. Otherwise (SCIP primary 1.0) the framework never bumped the value, so the recompute is a no-op.

The "no metadata" rule is checked in P1.4's edge pre-flight. The "recompute confidence" rule lives in STAGE 0 SQL.

### New subkind: `'temporal_dispatch'`

Lives on `calls` edges only. **Not added** to `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION` — that allowlist governs `references` subkinds with no positional source (config-declared DI bindings, etc.). `calls` always requires line/col by the three-tier invariant, and `.start()` invocations are real source-code call sites with full position info. No allowlist change is needed.

**Effort: 0.5 day**

---

## P1.4 — Phase 3 orchestration: synthesize → rebuild view → augment → persist

New file: `src/resolution/phase3.ts`, ~180 lines.

### Where it plugs in

Phase 3 is **unconditional** — it runs after extraction completes, regardless of whether the resolution stage ran. The current `indexAll` gates resolution behind `unresolvedCount > 0` ([src/index.ts:696](src/index.ts#L696)), which is correct for resolution but **must not** wrap Phase 3: tag-only and synthesize-only resolvers (e.g. a future `react` that only writes `react:hook` tags) need to run even on projects with zero unresolved refs.

**`indexAll` path** — edit [src/index.ts:695–710](src/index.ts#L695):

```ts
// 1) Resolve references — gated on unresolvedCount, as today
if (result.success && unresolvedCount > 0) {
  await this.resolveReferencesBatched(...);
}

// 2) Phase 3 — UNCONDITIONAL when extraction succeeded
if (result.success) {
  const phase3 = new Phase3Orchestrator(this.projectRoot, this.queries);
  const phase3Result = await phase3.run(options.onProgress);
  result.errors.push(...phase3Result.errors);
  result.nodesCreated += phase3Result.nodesAdded;
  result.edgesCreated += phase3Result.edgesAdded;
}
```

Phase 3 internally runs STAGE 0 (purge) regardless of the invocation path — `indexAll`, `sync`, or a non-`--force` re-index of a populated DB all benefit.

`IndexResult` already has `errors: ExtractionError[]`, `nodesCreated`, `edgesCreated` ([extraction/index.ts:66–73](src/extraction/index.ts#L66)) — the merge is straightforward.

**`sync` path** — edit [src/index.ts:752–797](src/index.ts#L752). `SyncResult` does **not** have `errors` / `nodesCreated` / `edgesCreated` ([extraction/index.ts:79–87](src/extraction/index.ts#L79)). Two options:

1. **Extend `SyncResult`** (chosen — explicit accounting):
   ```ts
   export interface SyncResult {
     filesChecked: number; filesAdded: number; filesModified: number; filesRemoved: number;
     nodesUpdated: number; durationMs: number;
     changedFilePaths?: string[];
     phase3?: { nodesAdded: number; edgesAdded: number; tagsAdded: number; errors: ExtractionError[] };  // new
   }
   ```
   Sync's Phase 3 is **full recompute** with the same STAGE 0 purge that runs from `indexAll` (purge is unconditional — see "Sync recompute" below); incremental sync of derived facts is explicitly out of P1 scope. Phase 3 result attaches to `result.phase3`.

2. **Log-only fallback** (rejected — drops visibility): would just call `logWarn` on each Phase 3 error and discard the count.

The `phase3?:` sub-object is optional so existing `SyncResult` consumers keep compiling. Callers that need the count check `result.phase3?.nodesAdded ?? 0`.

### Detection timing — Phase 3 detects fresh, does NOT inherit from `ReferenceResolver`

`ReferenceResolver.initialize()` runs in the `CodeGraph` constructor ([src/index.ts:191](src/index.ts#L191)), **before** any file is indexed. At that point `getAllFiles()` returns empty (DB has no `files` rows yet), so `detectFrameworks` only sees resolvers whose `detect()` consults `package.json` / `pom.xml` / similar via `readFile` (filesystem-backed). Detection that scans `context.getAllFiles()` for source-file patterns (e.g. express looking for `routes/`, java's `springResolver` looking for `@SpringBootApplication`-annotated files) silently returns false.

This is a **pre-existing bug** for the legacy `framework.resolve()` strategy, masked because `ExtractionOrchestrator.detectedFrameworkNames` re-detects with the scanned file list at [extraction/index.ts:526](src/extraction/index.ts#L526) for the per-file `extract()` hook. P1 must not inherit it.

**Decision**: `Phase3Orchestrator` runs its own detection in its constructor using a `ResolutionContext` built from the **now-populated** post-extraction DB (`getAllFiles()` returns the indexed files, `getNodesByName` etc. return real nodes). The legacy `ReferenceResolver.frameworks` field is irrelevant to Phase 3:

```ts
class Phase3Orchestrator {
  private resolvers: FrameworkResolver[];

  constructor(projectRoot: string, private queries: QueryBuilder) {
    const ctx = this.buildPostExtractionContext(projectRoot, queries);   // DB-backed
    this.resolvers = detectFrameworks(ctx);                              // re-detect, fresh
  }
  // …
}
```

**No `mode` parameter** — STAGE 0 purge is unconditional (see R3-F2 fix). A non-`--force` re-run of `codegraph index` against an already-populated DB also benefits: stale framework facts from the previous run are cleaned up before fresh synthesis. On a truly empty DB the purge SQL matches zero rows.

`buildPostExtractionContext` mirrors `ReferenceResolver.createContext` (filesystem `readFile` + DB-backed `getAllFiles` / `getNodesByName` / …). A future refactor can share the builder; P1 duplicates ~30 lines.

**Side benefit**: this gives `ReferenceResolver.frameworks` a separate concern (Strategy 1 in `resolveOne`, soon to be retired) from Phase 3's framework list. The two no longer share staleness.

### `Phase3Orchestrator.run()` flow

**Concurrency note**: SQLite (better-sqlite3) is sync; transactions cannot span an `await`. Resolver `synthesize` / `augment` are themselves sync (they only do GraphView reads, which are sync prepared-statement calls). The orchestrator therefore runs **everything** — STAGE 0, view1 construction, STAGE A, STAGE B, view2 construction, STAGE D, STAGE E — sequentially inside one transaction. The `Promise.all` shape suggested by an earlier draft is dropped: it offered no real parallelism (CPU-bound JS serializes anyway) and would have forced the orchestrator to read view1 outside the transaction, **before** the purge — meaning synthesize would see the prior generation's framework state on any re-index. Single transaction is the only correct shape.

```
queries.transaction(() => {

  // STAGE 0 — Framework purge (UNCONDITIONAL, FIRST WRITES).
  //   Must run BEFORE view1 is constructed. If view1 were built before purge,
  //   synthesize() would see the prior Phase 3 generation's framework nodes,
  //   tags, and merged-edge contributions, breaking the "clean static-layer
  //   input" contract. Each helper also invalidates QueryBuilder-level caches
  //   so later view reads observe the deleted rows (see "Cache invalidation"
  //   in modified-files).
  queries.stripFrameworkContributionsFromMergedEdges()   // SQL 0.1 (also recomputes confidence)
  queries.deleteAllFrameworkTags()                       // SQL 0.2
  queries.deleteFrameworkPrimaryEdges()                  // SQL 0.3
  queries.deleteFrameworkNodes()                         // SQL 0.4
  queries.invalidatePhase3Caches()                       // explicit cache flush — see R4-F4

  // view1 — built AFTER purge, INSIDE the transaction. Sees a clean static
  // layer (SCIP + tree-sitter + scope-resolved + heuristic) with zero
  // framework-derived rows.
  const view1 = new QueryGraphView(queries)

  // STAGE A — synthesize (sequential, sync, per-resolver isolation)
  const resultsA: Array<{name: string, result: SynthesizeResult}> = []
  for (const r of resolvers.filter(r => r.synthesize)):
    try {
      const result = r.synthesize!(view1)
      resultsA.push({ name: r.name, result })
    } catch (e) {
      errors.push(toError(e, r.name, 'synthesize'))     // sibling resolvers unaffected
      resultsA.push({ name: r.name, result: { nodes: [], tags: [] } })
    }

  // STAGE B — persist synthesized nodes, then inherent tags (with pre-flight)
  const stagedNodes = new Map<string, Node>()
  for ({name, result}) in resultsA:
    for node in result.nodes:
      if (!assertSynthesizedNode(node, name)) {
        errors.push({severity:'warning', message:`framework:${name} node rejected: ${reason}`})
        continue                                          // rejects unknown kinds (Node-kind discipline)
      }
      if (stagedNodes.has(node.id) && stagedNodes.get(node.id)!.provenance !== node.provenance):
        errors.push({severity:'warning', message:`framework:${name} node id collision on ${node.id} — first-occurrence wins`})
        continue
      stagedNodes.set(node.id, node)
  // Single-row writes only (R5-F1): batch helpers like insertNodes() open
  // their own internal transaction, which would nest inside this one and
  // fail on WASM SQLite. Single-row insertNode does not open a transaction.
  for (const node of stagedNodes.values()):
    queries.insertNode(node)
  queries.invalidatePhase3Caches()                       // freshness for tag pre-flight reads below

  // Inherent tag pre-flight (R4-F2): node must exist (in view1) OR be one we
  // just persisted (in stagedNodes). Tag string must be kebab-case-shaped.
  // Bad inserts are dropped with a warning — never escape to rollback.
  const synthNodeIds = new Set(stagedNodes.keys())
  for ({name, result}) in resultsA:
    for ({nodeId, tags}) in result.tags ?? []:
      if (!view1.hasNode(nodeId) && !synthNodeIds.has(nodeId)):
        errors.push({severity:'warning', message:`framework:${name} tag targets unknown nodeId ${nodeId} — dropped`})
        continue
      for tag in tags:
        if (!isValidTagFormat(tag)):
          errors.push({severity:'warning', message:`framework:${name} tag "${tag}" is not kebab-case — dropped`})
          continue
        try { queries.insertNodeTag(nodeId, tag, `framework:${name}`) }
        catch (e) { errors.push({severity:'warning', message:`framework:${name} tag insert failed: ${e}`}) }

  // STAGE C — rebuild view INSIDE the transaction. QueryGraphView reads
  // see in-transaction writes (better-sqlite3 honors transactional reads on
  // the same connection).
  const view2 = new QueryGraphView(queries)

  // STAGE D — augment (sequential, sync, per-resolver isolation)
  const resultsD: Array<{name: string, result: AugmentResult}> = []
  for (const r of resolvers.filter(r => r.augment)):
    try {
      const result = r.augment!(view2)
      resultsD.push({ name: r.name, result })
    } catch (e) {
      errors.push(toError(e, r.name, 'augment'))
      resultsD.push({ name: r.name, result: { edges: [], tags: [] } })
    }

  // STAGE E — persist edges + derived tags (both pre-flighted)
  for ({name, result}) in resultsD:
    for edge in result.edges:
      // Edge pre-flight:
      //   1. No metadata on framework edges (ownership rule)
      //   2. Three-tier line/col invariant
      if (edge.metadata !== undefined && Object.keys(edge.metadata).length > 0):
        errors.push({severity:'warning', message:`framework:${name} edge has metadata — rejected`})
        continue
      try {
        validateEdgeLineColumn(edge)
        queries.upsertGraphEdge(edge)
      } catch (e) {
        errors.push({severity:'warning', message:`framework:${name} edge rejected: ${e}`})
      }
    // Derived tag pre-flight — same shape as inherent, but view2 already
    // includes synthesized nodes, so a single hasNode check suffices.
    for ({nodeId, tags}) in result.tags ?? []:
      if (!view2.hasNode(nodeId)):
        errors.push({severity:'warning', message:`framework:${name} tag targets unknown nodeId ${nodeId} — dropped`})
        continue
      for tag in tags:
        if (!isValidTagFormat(tag)):
          errors.push({severity:'warning', message:`framework:${name} tag "${tag}" is not kebab-case — dropped`})
          continue
        try { queries.insertNodeTag(nodeId, tag, `framework:${name}`) }
        catch (e) { errors.push({severity:'warning', message:`framework:${name} tag insert failed: ${e}`}) }

})  // ── end of transaction. Any throw escaping a per-resolver/per-write try/catch rolls back everything. ──

return { nodesAdded: stagedNodes.size, edgesAdded, tagsAdded, errors }
```

**`isValidTagFormat`**: matches the P1.1 naming convention — lowercase, kebab-case, optional `<framework>:<role>` form:

```ts
const TAG_RE = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/;
function isValidTagFormat(tag: string): boolean {
  return tag.length > 0 && tag.length <= 64 && TAG_RE.test(tag);
}
```

**Rollback property**: STAGE 0 purge, view construction, all reads, and all writes happen inside one transaction. An orchestrator-level failure at any point rolls back the purge along with whatever else was written — the graph stays at its pre-Phase-3 state, framework facts intact. Per-resolver `synthesize` / `augment` throws are still caught at the per-resolver level (sibling isolation). Per-write pre-flight failures (bad node kind, bad tag, edge with metadata, FK violation on a malformed tag) are caught at the write call site and DON'T trigger rollback — they're logged and skipped.

**STAGE 0 SQL 0.1 — confidence recomputation embedded (inline CASE, no UDF)**

The earlier draft proposed a `default_confidence` SQLite scalar UDF. Dropped — UDFs require adapter-specific registration code that works for both `better-sqlite3` (native) AND `node-sqlite3-wasm` (WASM fallback), plus tests for each. Not worth the surface area for a single SQL site. **Inline the CASE ladder** instead — it mirrors `defaultConfidence` in [src/types.ts:300](src/types.ts#L300) and lives in one place (the purge query):

```sql
-- Strip framework entries from provenances[] AND recompute confidence from survivors.
-- The CASE ladder mirrors defaultConfidence (src/types.ts:300); any drift between the
-- two is caught by a regression test that loads each defaultConfidence input value,
-- runs the inline CASE on it, and asserts equality.
UPDATE edges
   SET provenances = (
         SELECT json_group_array(value) FROM json_each(provenances)
          WHERE value NOT LIKE 'framework:%'
       ),
       confidence = (
         SELECT MAX(
           CASE
             WHEN value IN ('scip', 'scip:external')                                     THEN 1.00
             WHEN value = 'scope-resolved'                                                THEN 0.75
             WHEN value IN ('tree-sitter', 'tree-sitter (scip-empty-fallback)')           THEN 0.70
             WHEN value LIKE 'framework:%'                                                THEN 0.85
             WHEN value = 'heuristic'                                                     THEN 0.60
             ELSE 0.50
           END
         )
         FROM json_each(provenances)
         WHERE value NOT LIKE 'framework:%'   -- (also filtered by the outer WHERE above; defensive duplicate)
       )
 WHERE provenance NOT LIKE 'framework:%'
   AND EXISTS (
         SELECT 1 FROM json_each(provenances)
          WHERE value LIKE 'framework:%'
       );
```

Drift defense: a unit test in `__tests__/p1-stage0-confidence.test.ts` enumerates every `GraphProvenance` literal, calls `defaultConfidence(p)`, runs the same value through the SQL CASE via a one-row probe (`SELECT CASE … FROM (SELECT ? AS value)`), and asserts equality. Any addition to `GraphProvenance` that updates `defaultConfidence` but not the SQL CASE fails this test.

### Why synthesize doesn't write edges

If resolver A writes an edge `A.node → B.node` during synthesize but B.node isn't created until resolver B's synthesize runs, the edge target doesn't exist yet and `upsertGraphEdge` either rejects it or produces a dangling row. Splitting "nodes first, edges second" with a view rebuild between them is the smallest change that eliminates cross-resolver ordering dependencies.

### Concurrency

**Sequential, sync, inside one transaction.** No `Promise.all`. Earlier drafts proposed parallel resolver execution via `Promise.all`, but that's incompatible with R3-F3 / R4-F1: better-sqlite3 transactions are sync and cannot span an `await`; the resolvers must run inside the same transaction as the STAGE 0 purge, so they cannot be parallelized over async boundaries. Resolver work is CPU-bound and the JS event loop would serialize anyway — the `Promise.all` shape was cosmetic. Failure isolation is preserved via per-resolver `try/catch` inside the sequential loop, exactly as the orchestrator pseudocode shows.

### Transaction API surface and nesting

The orchestrator pseudocode calls `queries.transaction(() => { … })`. The current `QueryBuilder` ([src/db/queries.ts:164](src/db/queries.ts#L164)) does **not** expose a `transaction` method — only `CodeGraphDB` does ([src/db/index.ts:146](src/db/index.ts#L146)). And several existing batch helpers (`insertNodes` at [queries.ts:286](src/db/queries.ts#L286), and others) **open their own transactions internally** via `this.db.transaction(...)()`. Calling those from inside a Phase 3 transaction risks nesting issues — better-sqlite3 handles nesting via SAVEPOINTs automatically, but `node-sqlite3-wasm` uses raw `BEGIN` / `COMMIT` ([sqlite-adapter.ts:205](src/db/sqlite-adapter.ts#L205)) and nesting fails.

P1.4 / PR-2 closes both gaps:

1. **Add `QueryBuilder.transaction<T>(fn: () => T): T`** — thin delegate to the underlying adapter. Mirrors the shape `CodeGraphDB` already uses. Adapter-level support for nested transactions is **not** required: the new helper is the ONLY transaction boundary Phase 3 opens, and Phase 3 only calls non-tx-opening QueryBuilder methods inside it.

2. **Phase 3 uses single-row write helpers, NOT batch helpers, inside its transaction.** Specifically:
   - The orchestrator pseudocode uses `for (const n of stagedNodes.values()) queries.insertNode(n)` — single-row, no inner transaction. **Do NOT** use `insertNodes(…)` ([queries.ts:286](src/db/queries.ts#L286)) here, which opens its own transaction internally.
   - `upsertGraphEdge(edge)` ([queries.ts:1006](src/db/queries.ts#L1006)) is already single-row and tx-free — keep as-is.
   - `insertNodeTag` (new helper added by P1.1) is single-row and tx-free by construction.
   - STAGE 0 helpers (`stripFrameworkContributionsFromMergedEdges` / `deleteAllFrameworkTags` / `deleteFrameworkPrimaryEdges` / `deleteFrameworkNodes` / `invalidatePhase3Caches`) execute raw SQL via `this.db.exec(...)` or a prepared `.run()` — no inner transactions.

3. **Audit gate**: a unit test in `__tests__/p1-phase3-no-nested-tx.test.ts` instruments the adapter to record every `BEGIN` / `COMMIT` issued during `Phase3Orchestrator.run()`, and asserts exactly one matched `BEGIN` … `COMMIT` pair. Any inner helper that accidentally opens its own transaction shows up as a second pair and fails the test.

**Why not just pass `CodeGraphDB` to `Phase3Orchestrator`**: would couple Phase 3 to the higher-level facade and force constructor signature drift in test fixtures that already mock `QueryBuilder` for resolver tests. Adding `transaction` to `QueryBuilder` is the smaller change.

**Orchestrator constructor (revised)**:

```ts
class Phase3Orchestrator {
  private resolvers: FrameworkResolver[];

  constructor(projectRoot: string, private queries: QueryBuilder) {
    const ctx = this.buildPostExtractionContext(projectRoot, queries);
    this.resolvers = detectFrameworks(ctx);
  }

  async run(onProgress?: ProgressCb): Promise<Phase3Result> {
    return this.queries.transaction(() => this.runSync(onProgress));   // ← single tx boundary
  }
  // …
}
```

`runSync` contains everything from the orchestrator pseudocode (STAGE 0 → STAGE E). It's sync because the transaction is sync; `run` returns `Promise<Phase3Result>` only to match the existing `indexAll` / `sync` callsites' shape — internally there's no awaitable work.

### Legacy hooks during the migration window

**The legacy per-file `extract` hook stays active in PR-2.** Removing it before all resolvers migrate would drop route/component extraction for every un-migrated resolver. The hook call site at [tree-sitter.ts:2557](src/extraction/tree-sitter.ts#L2557) already short-circuits via `if (!fw.extract) continue` — so as each migration PR removes its resolver's `extract` field, that resolver naturally falls out of the legacy block. When the **last** resolver migrates, the block becomes a no-op.

The final cleanup PR (PR-16) then deletes:

- [src/extraction/tree-sitter.ts:2550–2573](src/extraction/tree-sitter.ts#L2550) (the framework extract block).
- The `frameworkNames` parameter from `extractFromSource` ([tree-sitter.ts:2519](src/extraction/tree-sitter.ts#L2519)).
- The 4 callers in `src/extraction/index.ts:676, 680, 711, 1125`.
- `ExtractionOrchestrator.detectedFrameworkNames` field and `ensureDetectedFrameworks` method ([extraction/index.ts:417, 473](src/extraction/index.ts#L417)).
- `frameworkNames` field from the worker-thread parse message in `src/extraction/parse-worker.ts`.

Worker-protocol skew is not a concern — main and worker ship from the same build artifact.

**Verification gate for PR-16**: a unit test asserts no resolver in the registry defines `extract`. If anyone in P1.5 forgot to remove the field, PR-16 CI catches it.

The legacy `resolve` hook stays callable in `ReferenceResolver.resolveOne` Strategy 1 with a `if (!framework.resolve) continue` guard. Each migration PR removes the `resolve` field from its resolver; eventually all guards short-circuit and Strategy 1 becomes dead code (cleanup in P3).

**Effort: 1.5 days**

---

## P1.5 — Resolver migration (one PR per resolver)

### Strategy

Each PR migrates exactly **one** resolver:

1. Keep `detect()` unchanged.
2. Convert `extract()` (if present) to `synthesize()`.
3. Convert `resolve()` (if present) to `augment()`-emitted edges. For per-ref logic that P0.5b's scope resolver already covers (most file-local refs in csharp/vbnet/java/python/typescript), simply drop it — check `__tests__/frameworks.test.ts` for the actual covered cases before removing.
4. Run `__tests__/frameworks.test.ts` — the resolver's existing section must pass with no snapshot diff.
5. Add a dedup regression: same edge fingerprint from this resolver and from a fake SCIP edge — DB has one row with both provenances.

### Order (lightest to heaviest)

1. `aspnet` — annotation→route, smallest surface.
2. `express` — `app.get('/path', h)` → route.
3. `react` — function-returning-JSX → component; `useX` → hook.
4. `vue` — SFC `<template>` / `<script>` / `<style>` decomposition (already in `vue-extractor.ts`).
5. `svelte` — file = component.
6. `django` — `urls.py` URL declarations.
7. `flask` — `@app.route('/path')`.
8. `fastapi` — `@app.get`/`@router.get`.
9. `rails` — `routes.rb` DSL.
10. `laravel` — routes + Facade resolution (Facade resolution becomes more precise — augment can now see `INHERITS` edges).
11. `go` — gin/echo route DSL; stdlib filtering stays where it already is in `isBuiltInOrExternal`.
12. `rust` — axum router.
13. `swift` (uikit + swiftui + vapor) — three resolvers in one file, ~430 lines, scheduled last for the file-size reason.
14. `spring` — split into `spring-core` + `spring-temporal`. See dedicated section below.
15. `temporal` — new, generic, cross-language.

### Per-resolver template (using `aspnet` as the worked example)

Current `aspnet.extract()` runs a regex over file contents to find `[HttpGet("/path")]` attributes, emits a `route` node, and emits an `UnresolvedRef` from route to the next-declared method name. That ref then flows through the normal resolution pipeline.

After migration:

```ts
export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',
  languages: ['csharp'],
  detect(ctx) { /* unchanged */ },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.cs')) continue;
      const content = graph.readFileStripped(file, 'csharp');
      if (!content) continue;
      for (const { method, route, line } of scanAttributeRoutes(content)) {
        nodes.push({
          id: `framework:aspnet:route:${method}:${route}:${file}:${line}`,
          kind: 'route',
          name: `${method} ${route}`,
          qualifiedName: `${file}::route:${route}`,
          filePath: file, language: 'csharp',
          startLine: line, endLine: line, startColumn: 0, endColumn: 0,
          provenance: 'framework:aspnet',
          updatedAt: Date.now(),
        });
      }
    }
    return { nodes };
  },

  augment(graph: GraphView): AugmentResult {
    const edges: Edge[] = [];
    const tags: Array<{ nodeId: string; tags: string[] }> = [];

    for (const route of graph.getNodesByKind('route')) {
      if (route.provenance !== 'framework:aspnet') continue;
      const handlerName = findNextMethodName(graph, route);
      if (!handlerName) continue;
      const candidates = graph.getNodesByName(handlerName)
        .filter(n => n.kind === 'method' && CONTROLLER_DIRS.some(d => n.filePath.includes(d)));
      if (candidates.length === 1) {
        edges.push({
          source: route.id, target: candidates[0]!.id,
          kind: 'references', subkind: 'convention',
          line: undefined, column: undefined,   // allowlist permits NULL position
          provenance: 'framework:aspnet', confidence: 0.85,
        });
        tags.push({ nodeId: candidates[0]!.id, tags: ['aspnet:controller', 'route-handler'] });
      }
    }

    return { edges, tags };
  },
};
```

The original `resolve()` logic (suffix-based name matching for `*Controller`, `*Service`, etc.) is largely subsumed by P0.5b's scope resolver for csharp. The migration PR runs `frameworks.test.ts` first, sees which assertions still need explicit handling, and ports only that residual logic into `augment()`. If everything passes without porting, the resolver's `resolve()` is just deleted.

### Per-resolver migration notes

| Resolver | `synthesize` produces | `augment` produces | Notes |
|---|---|---|---|
| `aspnet` | `route` from `[HttpGet]` / `app.MapGet` | route→handler `references/convention`, controller/route-handler tags | Largely subsumed by P0.5b; verify against `frameworks.test.ts` |
| `express` | `route` from `app.get('/x', h)` | route→handler `references/convention`, middleware tag | Existing `extractTailIdent` ported as-is |
| `react` | `component` (function-returning-JSX) | component→hook `references/convention`, `react:hook` tag on existing `function` nodes whose name matches `^use[A-Z]`, `react:component` tag on synthesized `component` nodes | Hooks are NOT a new node kind — they're tags on the existing `function` node (see "Node-kind discipline" below). Watch default-export ↔ named-export drift |
| `svelte` | `component` per `.svelte` file | parent→child component `references/convention` | File is the component; id hashed from path |
| `vue` | `component` per SFC | template→methods `calls` with line/col | Three-section SFC; `vue-extractor.ts` already decomposes |
| `django` | `route` from `urls.py` `path()` / `url()` | route→view `references/convention`, `django:view` tag | DSL parsing stays regex |
| `flask` | `route` from `@app.route('/x')` | route→handler `references/convention` | Mirror of aspnet template |
| `fastapi` | `route` from `@app.get` / `@router.get` | same as flask | |
| `rails` | `route` from `routes.rb` | route→controller#action `references/convention` | Ruby DSL; regex stays |
| `laravel` | `route` from `routes/web.php`, facade-call edges | route→`Controller@method` `references/convention`, Facade resolution → `calls` | Facade resolution upgrades — augment can read `INHERITS` edges |
| `go` | `route` from gin/echo (optional, if framework detected) | confirm `isBuiltInOrExternal` already filters stdlib | go.ts is small; light migration |
| `rust` | `route` from `axum::Router` (optional) | axum handler chain `calls` (line/col available) | Reuse `cargo-workspace.ts` for member resolution |
| `swift` × 3 | uikit `component`, swiftui `view`, vapor `route` | per-framework augment | swift.ts is the largest file; schedule last |
| `spring-core` (split) | `route` from `@RequestMapping`-family AND `spring:service`/`spring:component`/`spring:repository`/`spring:configuration`/`spring:controller` **inherent tags** on existing `class` nodes (annotations are properties of the class, not edge-derived) | **DI dispatch** edges (field + constructor injection; see below) | Beans are NOT a new node kind — they're tags on the existing `class` node. Bean tags MUST come from synthesize (R3-F1): `isInjectionConstructor` reads `view2.getNodesByTag('spring:service')` etc., and view2 only sees STAGE B-persisted tags. Split from monolithic `springResolver` |
| `spring-temporal` (new) | nothing | `WorkflowStub.start()` / `ActivityStub.execute()` → workflow/activity impl `calls/temporal_dispatch` | See below |
| `temporal` (new, generic) | nothing | Same dispatch logic for Go / TypeScript / Python clients | See below |

### Node-kind discipline: when to synthesize a node vs add a tag

`NODE_KINDS` ([src/types.ts:18](src/types.ts#L18)) is a closed enumeration backed by schema constraints, FTS5 weights, exhaustive switches, and MCP query surface. **Phase 3 does not extend it.** The only framework-specific kinds permitted are the ones already present (`route`, `component`) — both predate P1 and exist because a route and a component lack a 1:1 source-code counterpart (a route is "URL ↔ handler", co-located with but distinct from the handler function).

Concepts that **are** their source-code counterpart (Spring beans ARE classes; React hooks ARE functions) must be modeled as **tags on existing nodes**, never as new node kinds. Synthesizing a `bean` node would create a phantom class without a body, duplicate the qualified-name index, and break MCP `codegraph_callers` (which kind does the caller want?). Tags are additive metadata that survives all of those questions.

**Rule for resolver authors**:

| Question | Synthesize a new node | Tag an existing node |
|---|---|---|
| "Does this concept have a source-code body / file location independent of any other extracted symbol?" | YES — synthesize | — |
| "Is this concept a *role* played by an already-extracted symbol?" | — | YES — tag |
| Example | ASP.NET route (`[HttpGet("/x")]` is metadata above the handler — the handler is the method, the route is the URL mapping, they have distinct identities and the route can exist without the handler being present in a registry-style declaration) | Spring bean, React hook, Django view, Vapor route handler |

Phase3Orchestrator's `assertSynthesizedNode` enforces `node.kind ∈ NODE_KINDS`. If a future PR wants to add a new kind (`bean`, `hook`, …), it's an explicit P1.x or P3 design decision with schema, search, and MCP touch points enumerated — not a backdoor through framework synthesis.

### Sync recompute: clean derived facts before re-synthesizing

Phase 3 produces derived facts (framework nodes, inherent/derived tags, framework-provenance edges, and contributions to merged edges' `provenances[]` / `confidence` / `metadata`). Across reruns those derived facts can go **stale** in three ways:

1. A resolver previously emitted a node/edge but no longer does (source code changed).
2. A resolver previously detected but no longer detects (config file removed).
3. A merged edge previously had `provenances[]` containing `'framework:X'` as a non-primary contributor; the framework no longer agrees with that edge.

`upsertGraphEdge` and `insertNode` are **append-only with respect to provenance** — they merge but never strip. Without a deletion path, stale derived facts accumulate across reruns.

**Decision: full Phase 3 recompute with a STAGE 0 purge that runs UNCONDITIONALLY** — on `sync`, on `indexAll` against a populated DB, and on `indexAll --force` (where the purge SQL is a no-op because `clear()` already truncated). Incremental sync of derived facts is deferred to P2/P3. The recompute is bounded by `O(framework_node_count + framework_edge_count)` — typically tiny compared to total graph size.

#### STAGE 0 — Framework purge (UNCONDITIONAL)

Runs as the first set of writes inside `Phase3Orchestrator.run()`'s single transaction (see orchestrator pseudocode above for the transaction boundary). Earlier drafts gated STAGE 0 on a `mode: 'sync'` parameter; that was wrong because the CLI's `codegraph index` (no `--force`) does NOT call `clear()` ([src/bin/codegraph.ts:596](src/bin/codegraph.ts#L596)), so stale framework facts from a prior `indexAll` would have survived a normal re-index. The unconditional shape removes that bug.

```sql
-- 0.1 — Strip framework contributions from merged edges (SCIP / tree-sitter primary)
-- AND recompute confidence from the surviving provenances. Earlier draft only rewrote
-- provenances[]; without the confidence recompute, a tree-sitter row (0.7) inflated to
-- 0.85 by a framework contribution would stay at 0.85 after the framework retracted.
-- `metadata` is NOT touched here because framework augmenters are forbidden from writing
-- metadata (see "Edge metadata ownership" — Phase 3's edge pre-flight enforces this).
UPDATE edges
   SET provenances = (
         SELECT json_group_array(value)
           FROM json_each(provenances)
          WHERE value NOT LIKE 'framework:%'
       ),
       confidence = (
         SELECT MAX(
           CASE
             WHEN value IN ('scip', 'scip:external')                                     THEN 1.00
             WHEN value = 'scope-resolved'                                                THEN 0.75
             WHEN value IN ('tree-sitter', 'tree-sitter (scip-empty-fallback)')           THEN 0.70
             WHEN value LIKE 'framework:%'                                                THEN 0.85
             WHEN value = 'heuristic'                                                     THEN 0.60
             ELSE 0.50
           END
         )
         FROM json_each(provenances)
         WHERE value NOT LIKE 'framework:%'
       )
 WHERE provenance NOT LIKE 'framework:%'
   AND EXISTS (
         SELECT 1 FROM json_each(provenances)
          WHERE value LIKE 'framework:%'
       );

-- 0.2 — Drop tags written by any framework.
DELETE FROM node_tags WHERE added_by LIKE 'framework:%';

-- 0.3 — Delete edges whose PRIMARY provenance is framework-owned.
DELETE FROM edges WHERE provenance LIKE 'framework:%';

-- 0.4 — Delete nodes whose provenance is framework-owned. Cascade ON DELETE
-- on node_tags (already covered by 0.2) and on the `contains` edges to children
-- (handled by 0.3 since framework nodes only contain other framework nodes).
DELETE FROM nodes WHERE provenance LIKE 'framework:%';
```

The inline CASE ladder mirrors `defaultConfidence` in [src/types.ts:300](src/types.ts#L300). The two locations are kept in sync by regression test #24, which probes every `GraphProvenance` literal through both the TS function and the SQL CASE and asserts equality. Earlier drafts of this plan referenced a `default_confidence` SQLite UDF — dropped in R4-F5 because UDF registration semantics differ between `better-sqlite3` (native) and `node-sqlite3-wasm` (WASM fallback) and the surface area isn't worth one SQL site.

After STAGE 0 the graph contains exactly the static layers (SCIP + tree-sitter + scope-resolved + heuristic) — equivalent to "post-resolution, pre-Phase-3" state. STAGE A then runs normally and re-derives everything.

**Why unconditional**: the only `indexAll` path that guarantees an empty DB is `--force` (which calls `cg.clear()`). A plain `codegraph index` against a previously-indexed project re-extracts and merges; framework facts from the previous run would otherwise linger. STAGE 0 on a truly empty DB is a no-op (zero rows match the framework prefix), so unconditional purge costs nothing on the fresh-install path.

**Why `LIKE 'framework:%'` and not "framework names the orchestrator just detected"**: a resolver that no longer detects must still have its prior derivatives cleaned up. The purge runs against the prefix, independent of the current detect set, so frameworks that have "left" are handled correctly.

**Cost**: 0.1 is the only potentially expensive statement (full table scan when no edge has a framework contributor) — mitigated by the existing `idx_edges_provenance` partial index narrowing the `provenance NOT LIKE 'framework:%'` filter. Real-world graphs have framework contributors on a small fraction of edges (DI bindings, routes); 0.1 touches only those rows.

**Cache coherence**: each helper, plus an explicit `invalidatePhase3Caches()` call after each STAGE writes block, flushes the in-memory caches that QueryBuilder keeps on top of the DB. Without this, `getNodeById` for a just-deleted framework node could return a cached value, view2 would observe ghost rows, and resolvers reading via view2 would compute incorrect output. See the queries.ts modified-files entry for the list of caches cleared.

#### Edge case: framework still detects, edges identical

After STAGE 0 deletes the merged framework contribution and STAGE E re-upserts it, the merged edge's `provenances[]` and primary `provenance` end up byte-identical to before. The freshness invariant (P0.4) is the same as for tree-sitter shadow updates — no special handling needed.

#### Why not incremental

The incremental path the v1 plan hinted at — "only re-run resolvers whose detect set intersects the changed files" — is unimplementable in P1:

- `detect()` returns boolean; resolvers don't declare which files they read.
- Even if they did, a resolver's `augment` looks at the **whole graph**, not just files it "owns" — a Spring DI binding from `UserService` to `Bar` invalidates when `Bar.java` changes, even though `spring-core` doesn't "own" `Bar.java`.
- No deletion path exists for derived facts that should no longer exist (the core gap).

P2/P3 may add an incremental story (resolver-declared file dependencies + per-resolver provenance-scoped delete), but P1 ships the full recompute and revisits when there's a measured pain point.

### Spring split + DI dispatch

`spring-core` (extracted from `java.ts`):

```ts
synthesize(graph): SynthesizeResult {
  const nodes: Node[] = [];
  const tags: Array<{ nodeId: string; tags: string[] }> = [];

  // 1. Bean inherent tags — emitted in synthesize so augment() can read them via getNodesByTag.
  //    These are pure annotations on existing class nodes (no edge derivation), so they're
  //    INHERENT tags per the synthesize/augment contract.
  for (const cls of graph.getNodesByKind('class')) {
    const annotations = readClassAnnotations(graph, cls);
    if (annotations.has('Service'))      tags.push({ nodeId: cls.id, tags: ['spring:service'] });
    if (annotations.has('Component'))    tags.push({ nodeId: cls.id, tags: ['spring:component'] });
    if (annotations.has('Repository'))   tags.push({ nodeId: cls.id, tags: ['spring:repository'] });
    if (annotations.has('Configuration'))tags.push({ nodeId: cls.id, tags: ['spring:configuration'] });
    if (annotations.has('RestController') || annotations.has('Controller'))
                                         tags.push({ nodeId: cls.id, tags: ['spring:controller'] });
  }

  // 2. @RequestMapping-family routes — synthesized route nodes (these legitimately need
  //    their own node kind; see Node-kind discipline).
  for (const file of graph.getAllFiles().filter(f => f.endsWith('.java'))) {
    const content = graph.readFileStripped(file, 'java');
    if (!content) continue;
    for (const { method, path, line } of scanRequestMappings(content)) {
      nodes.push({
        id: `framework:spring-core:route:${method}:${path}:${file}:${line}`,
        kind: 'route',
        // … other Node fields, provenance: 'framework:spring-core'
      });
    }
  }

  return { nodes, tags };
}

augment(graph): AugmentResult {
  const edges: Edge[] = [];

  // STAGE B has already persisted the bean tags emitted by synthesize above;
  // graph (= view2) returns them via getNodesByTag. isInjectionConstructor() relies on this.

  // 2a. DI dispatch — field injection
  //   For each @Autowired / @Inject field, find the field's interface type, then
  //   write a references/di_binding edge to every implementing class.
  for (const field of graph.getNodesByKind('field')) {
    if (!hasAutowiredAnnotation(graph, field)) continue;
    emitDiBindings(graph, edges, field, resolveFieldInterfaceType(graph, field));
  }

  // 2b. DI dispatch — constructor injection (Spring 4.3+ implicit single-constructor too)
  //   For each constructor that's either explicitly @Autowired OR the lone constructor
  //   of an @Service/@Component/@Repository/@Configuration class, walk its parameters
  //   and bind each parameter's type to its implementing classes.
  for (const ctor of graph.getNodesByKind('constructor')) {
    if (!isInjectionConstructor(graph, ctor)) continue;
    for (const param of graph.getOutgoingEdges(ctor.id, ['contains'])
                            .map(e => graph.getNode(e.target))
                            .filter((n): n is Node => n !== null && n.kind === 'parameter')) {
      emitDiBindings(graph, edges, param, resolveParameterInterfaceType(graph, param));
    }
  }

  return { edges };   // no tags in augment — bean tags were inherent and went via synthesize
}

function emitDiBindings(graph: GraphView, edges: Edge[], source: Node, interfaceId: string | null) {
  if (!interfaceId) return;
  for (const impl of graph.getIncomingEdges(interfaceId, ['implements'])) {
    edges.push({
      source: source.id, target: impl.source,
      kind: 'references', subkind: 'di_binding',
      line: undefined, column: undefined,
      provenance: 'framework:spring-core', confidence: 0.85,
    });
  }
}

function isInjectionConstructor(graph: GraphView, ctor: Node): boolean {
  // Explicit @Autowired wins. Otherwise: Spring 4.3+ treats the lone constructor
  // of a Spring-managed class as implicitly @Autowired.
  if (hasAutowiredAnnotation(graph, ctor)) return true;
  const enclosing = enclosingClass(graph, ctor);
  if (!enclosing) return false;
  const enclosingIsSpringBean = ['spring:service', 'spring:component',
                                 'spring:repository', 'spring:configuration']
    .some(tag => graph.getNodesByTag(tag).some(n => n.id === enclosing.id));
  if (!enclosingIsSpringBean) return false;
  const allCtors = graph.getNodesByFile(enclosing.filePath)
    .filter(n => n.kind === 'constructor' && enclosingClass(graph, n)?.id === enclosing.id);
  return allCtors.length === 1;
}
```

**`resolveFieldInterfaceType` / `resolveParameterInterfaceType` fallback**. The clean path is `<node> → type_of edge → interface node`. P0.5b's scope resolver may or may not produce reliable `type_of` for Java fields and constructor parameters — verify against the Spring fixture during implementation. If `type_of` is missing, fall back to source-line regex against the declaration site:

```ts
function resolveFieldInterfaceType(graph: GraphView, field: Node): string | null {
  return resolveDeclaredInterface(graph, field, /@(?:Autowired|Inject)\s+(?:private\s+|public\s+|protected\s+)?(\w+)\s+/);
}

function resolveParameterInterfaceType(graph: GraphView, param: Node): string | null {
  // Parameter declaration: `(..., Foo foo, ...)`. Find token immediately before the param name.
  return resolveDeclaredInterface(graph, param, new RegExp(`(\\w+)\\s+${escapeRegex(param.name)}(?:\\s*[,)])`));
}

function resolveDeclaredInterface(graph: GraphView, node: Node, re: RegExp): string | null {
  const typeOf = graph.getOutgoingEdges(node.id, ['type_of']);
  if (typeOf.length === 1) return typeOf[0]!.target;

  const src = graph.readFileStripped(node.filePath, 'java');
  if (!src) return null;
  const lineText = src.split('\n')[node.startLine - 1];
  if (!lineText) return null;
  const m = lineText.match(re);
  if (!m) return null;
  const candidates = graph.getNodesByName(m[1]!).filter(n => n.kind === 'interface');
  return candidates.length === 1 ? candidates[0]!.id : null;
}
```

Tests cover the `type_of` path and the regex-fallback path for both field and constructor injection.

### Spring Temporal dispatch

```ts
augment(graph) {
  const edges: Edge[] = [];

  // Temporal's pattern: client.newWorkflowStub(MyWorkflow.class).workflowMethod(args)
  // The tree-sitter extractor sees `workflowMethod` as a calls edge from caller to
  // the WorkflowStub method (because resolution can't see the generic parameter).
  // We re-route that call to the concrete @WorkflowImpl method.

  for (const callEdge of streamCallEdgesTargetingStubs(graph)) {
    // streamCallEdgesTargetingStubs: filter all `calls` edges whose target is a
    // method on WorkflowStub / ActivityStub (identified by class name).
    const callerFile = graph.getNode(callEdge.source)?.filePath;
    if (!callerFile) continue;
    const stripped = graph.readFileStripped(callerFile, 'java');
    if (!stripped) continue;

    // Walk back from the call site to find the matching `newWorkflowStub(X.class)` token chain.
    const workflowInterfaceName = findWorkflowInterfaceAtCallSite(
      stripped, callEdge.line!, callEdge.column!
    );
    if (!workflowInterfaceName) continue;

    const ifaceCandidates = graph.getNodesByName(workflowInterfaceName)
                                 .filter(n => n.kind === 'interface');
    if (ifaceCandidates.length !== 1) continue;

    // Find the concrete implementor and re-route the call.
    const impls = graph.getIncomingEdges(ifaceCandidates[0]!.id, ['implements']);
    if (impls.length === 0) continue;

    const calledMethod = graph.getNode(callEdge.target)?.name;
    if (!calledMethod) continue;

    for (const impl of impls) {
      const implMethods = graph.getNodesByFile(graph.getNode(impl.source)!.filePath)
                               .filter(n => n.kind === 'method' && n.name === calledMethod);
      if (implMethods.length !== 1) continue;
      edges.push({
        source: callEdge.source, target: implMethods[0]!.id,
        kind: 'calls', subkind: 'temporal_dispatch',
        line: callEdge.line!, column: callEdge.column!,   // required by `calls` invariant
        provenance: 'framework:spring-temporal', confidence: 0.85,
      });
    }
  }

  return { edges };
}
```

The match is **strict** (`newWorkflowStub(X.class).method()` token chain visible at the call site, exactly one interface candidate, exactly one implementing class) — false-positive rate stays low at the cost of recall in malformed cases. We accept that trade-off because Temporal call edges are high-stakes (cross-service control flow) and a wrong edge would be confusing.

### Generic `temporal` (cross-language)

Same shape as `spring-temporal`, parameterized over language-specific patterns:

- **Go**: `client.ExecuteWorkflow(ctx, opts, MyWorkflow)` — workflow is a function reference, not a stub.
- **TypeScript**: `await client.workflow.start(MyWorkflow, { args })`.
- **Python**: `await client.start_workflow(MyWorkflow.run, args)`.
- **Java (without Spring)**: same as Spring Temporal pattern.

Implementation factors the pattern detection per language; the graph-level dispatch (interface → implementation → method) is shared.

### Removing `resolve` per-ref hook on each migration

Each migration PR removes the resolver's `resolve` field. The orchestrator's strategy-1 guard (`if (!framework.resolve) continue`, added in P1.4) makes this safe — once all resolvers drop the field, the loop is a no-op. Strategy 1 itself is removed in a P3 cleanup PR.

**Effort: 8 days total**

| Resolver | Estimate |
|---|---|
| aspnet, express, flask, fastapi, rails (route templates) | 0.5 d each = 2.5 d |
| react, vue, svelte (component-shape) | 0.5 d each = 1.5 d |
| django, laravel, go, rust (per-language idiosyncrasies) | 0.5 d each = 2.0 d |
| swift × 3 (file size) | 1.0 d |
| spring-core split + DI dispatch | 1.0 d |
| spring-temporal | 0.5 d |
| generic temporal | 0.5 d |
| **Subtotal** | **9.0 d** |

(Calibrate down to 8 d if scope resolver covers more of the per-resolver `resolve()` logic than expected.)

---

## P1.6 — Tests

### Regression (no behavior change)

- `__tests__/frameworks.test.ts` — each section passes after the corresponding resolver migrates. Done incrementally per-PR.
- `__tests__/resolution.test.ts` — P0.5b scope-resolver tests, unchanged behavior.

### Phase 3 wiring regression (matters in the absence of resolution work)

A test in `__tests__/p1-phase3-wiring.test.ts` covers F5: index a project with **zero unresolved references** (e.g. a single `.ts` file whose only symbol is a `console.log` filtered by `isBuiltInOrExternal`), with a fake resolver that emits one tag in `augment()`. Assert the tag is present — proves Phase 3 ran despite the resolution stage being skipped.

A second test covers F2: fresh `CodeGraph` instance, no `indexAll` yet, manually invoke `Phase3Orchestrator` after a tiny direct-DB ingest. Assert detection sees the in-DB framework markers (e.g. a `package.json` with `express` dep, written to fs before construction) — proves Phase 3 re-detects rather than inheriting the empty `ReferenceResolver.frameworks` set.

### New: `__tests__/p1-framework-synthesize.test.ts`

1. **Synthesize → augment visibility**. Fake resolver A synthesizes node `N`; fake resolver B's `augment` asserts `graph.getNode(N.id)` is non-null.
2. **Resolver exception isolation**. Fake A's `synthesize` throws; fake B is normal. B's output is fully persisted; A's error is one `warning`-severity `ExtractionError`; index exits 0.
3. **Dedup merges across SCIP and framework** (ship gate 2). Pre-write a SCIP edge at `(X, Y, calls, NULL, 10, 5)` with `provenance='scip'`. Fake framework resolver's `augment` writes an edge with the identical fingerprint and `provenance='framework:foo'`. Run Phase 3; assert the DB holds one row, `provenance='scip'` (priority), `provenances=['scip', 'framework:foo']`.
4. **`node_tags` first-writer-wins**. Fake A and fake B both tag node `N` with `route-handler`. DB row `(N, 'route-handler')` is unique; `added_by` reflects the resolver that ran first in Stage E.
5. **NULL-position framework edge accepted**. Augment emits `references` + `subkind='convention'` + line/col `undefined` → `validateEdgeLineColumn` accepts via the allowlist; row persists.
6. **Forbidden-kind position rejection**. Augment emits `contains` with line/col set → `validateEdgeLineColumn` throws → edge dropped, error logged, sibling edges in same `augment` result still persisted.
7. **Spring DI dispatch — field injection**. Fixture `__tests__/fixtures/spring-di-field/` containing `Foo.java` (interface), `Bar.java` (implements), `UserService.java` (`@Autowired Foo foo`). Assert exactly one `references/di_binding` edge from `UserService.foo` to `Bar`, `provenance='framework:spring-core'`.
7a. **Spring DI dispatch — constructor injection (explicit `@Autowired`)**. Fixture `__tests__/fixtures/spring-di-ctor-explicit/` with `class UserService { private final Foo foo; @Autowired public UserService(Foo foo) { this.foo = foo; } }`. Assert one `references/di_binding` edge from the `foo` **parameter** node to `Bar`.
7b. **Spring DI dispatch — constructor injection (Spring 4.3+ implicit single constructor)**. Fixture `__tests__/fixtures/spring-di-ctor-implicit/` with `@Service class UserService { private final Foo foo; public UserService(Foo foo) { this.foo = foo; } }` — no `@Autowired` on the lone constructor, class is `@Service`-tagged. Assert one `references/di_binding` edge.
7c. **Spring DI dispatch — multi-constructor without `@Autowired` is NOT injected**. Fixture with two constructors, neither annotated. Assert **zero** `di_binding` edges from either constructor's parameters — implicit injection only fires for the *single* constructor case.
8. **Spring DI dispatch — fallback path**. Re-run fixture 7 with `type_of` edges artificially suppressed. Assert the regex fallback still produces the edge.
9. **Spring Temporal dispatch**. Fixture `__tests__/fixtures/temporal-java/` with `MyWorkflow` interface, `MyWorkflowImpl` implementor, and a caller using `newWorkflowStub(MyWorkflow.class).run()`. Assert one `calls/temporal_dispatch` edge from the caller to `MyWorkflowImpl.run`, line/col matching the `.run()` call site.
10. **Generic Temporal dispatch — Go**. Equivalent fixture in Go using `client.ExecuteWorkflow(ctx, opts, MyWorkflow)`.
11. **STAGE 0 purge — stale framework node cleared on sync**. IndexAll a fixture with `aspnet`-detected; assert one `route` node exists. Modify the source so the `[HttpGet]` annotation is removed; `sync`. Assert the route node and its convention edges are gone (not lingering from prior Phase 3 run).
12. **STAGE 0 purge — stale framework contribution stripped from merged edge**. Pre-seed an edge `(X, Y, calls, NULL, 10, 5)` with `provenances=['scip','framework:spring-core']`, primary `'scip'`. Run sync where `spring-core` no longer agrees with this edge (fixture deletes the Spring annotation). Assert: edge row survives (SCIP still owns it), `provenances=['scip']`, primary still `'scip'`.
13. **STAGE 0 purge — resolver that stopped detecting**. IndexAll a fixture detecting `laravel`; assert laravel-tagged nodes exist. Delete `composer.json`; `sync`. Assert laravel tags and laravel-derived edges are purged even though no `laravel` resolver is now in the detect set.
14. **STAGE 0 confidence recompute**. Pre-seed an edge `(X, Y, calls, NULL, 10, 5)` with `provenances=['tree-sitter','framework:spring-core']`, `confidence=0.85`. Run sync where `spring-core` no longer agrees. Assert: row survives, `provenances=['tree-sitter']`, `confidence=0.7` (recomputed from `defaultConfidence('tree-sitter')`).
15. **Framework metadata pre-flight rejection**. Fake augment emits an edge with `metadata: { foo: 'bar' }`. Assert the edge is dropped with a `warning` ExtractionError and DOES NOT persist (existing rows at the same fingerprint are unaffected).
16. **Unconditional STAGE 0 on `codegraph index` without `--force`**. IndexAll once → assert framework facts exist. IndexAll again WITHOUT `--force` (no `clear()`) → assert framework facts are first purged then re-derived, equal in shape to the first run (no duplication, no stale-leftover).
17. **Transaction atomicity around STAGE 0**. Inject an orchestrator-level throw (e.g. monkey-patch `queries.insertNode` to raise on the 2nd call) after STAGE 0 SQL but during STAGE B persistence. Assert the DB state matches the pre-Phase-3 snapshot — framework facts still present, NOT purged. (Without the R3-F3 / R4-F1 single-transaction fix, this test would fail: facts purged with nothing to replace them.)
18. **Cross-resolver inherent tag visibility**. Fake resolver A emits inherent tag `team-internal:bean` on existing class `C` in its `synthesize`. Fake resolver B's `augment` reads `graph.getNodesByTag('team-internal:bean')` and asserts `C` is in the result. (Proves inherent tags from synthesize are persisted before any augment runs.)
19. **Derived tag NOT visible to sibling augments**. Fake resolver A emits derived tag `route-handler` in its `augment`. Fake resolver B's `augment` (running after A in iteration order) queries `getNodesByTag('route-handler')` and asserts an empty result during the same Phase 3 run. Post-Phase-3, the tag IS present.
20. **Synthesize sees CLEAN view1 — no stale framework rows from prior generation**. IndexAll a project where `spring-core` synthesizes routes; assert routes exist. Re-IndexAll **WITHOUT** `--force`. Inside a hook around STAGE A, capture `view1.getNodesByKind('route')` for spring-core's synthesize invocation; assert the captured set is empty (purge ran before view1 was built). Without the R4-F1 fix, the captured set would contain the prior generation's routes.
21. **Tag preflight — bad nodeId in synthesize**. Fake resolver A's synthesize returns one valid node + a tag `{nodeId: 'nonexistent', tags: ['foo']}`. Assert: A's node persists, the bad tag is dropped with a `warning` ExtractionError, sibling resolvers complete normally, no transaction rollback.
22. **Tag preflight — malformed tag string**. Fake augment returns `{nodeId: validId, tags: ['Foo Bar', 'snake_case', '']}`. Assert all three are dropped with warnings (uppercase + space, underscore, empty); a sibling well-formed tag persists.
23. **Cache invalidation after purge — read-after-delete consistency**. Pre-seed a framework node via the test harness. Call `queries.deleteFrameworkNodes()` + `queries.invalidatePhase3Caches()`. Call `queries.getNodeById(framework_node_id)` and assert `null` (NOT the cached pre-delete value). Repeat without `invalidatePhase3Caches` — assert this returns the stale cached node (proves the invalidation is load-bearing, not theoretical).
24. **STAGE 0 confidence CASE matches `defaultConfidence`**. For every literal in the `GraphProvenance` union, invoke `defaultConfidence(p)` and a `SELECT CASE … FROM (SELECT ? AS value)` probe with the same literal. Assert the SQL result equals the TS result. Guards against the CASE ladder drifting from `src/types.ts:300`.
25. **Phase 3 runs exactly one transaction — no nesting**. `__tests__/p1-phase3-no-nested-tx.test.ts` wraps the DB adapter with an interceptor that records `BEGIN` / `COMMIT` / `SAVEPOINT` / `RELEASE` events. Run a complete Phase 3 (purge + synthesize + augment with realistic resolver outputs). Assert exactly one `BEGIN` and one matching `COMMIT`, zero `SAVEPOINT`s. Guards against an accidental batch-helper reuse opening an inner transaction.

### Performance baseline (optional, opt-in)

`__tests__/p1-phase3-perf.test.ts` guarded by `process.env.PERF === '1'`. Synthetic project with 10k+ nodes; Phase 3 wall time < 5s. If exceeded, the next step is to add narrower indexes on `node_tags(tag, kind_join)` and revisit `getAllNodes` callers.

**Effort: 1 day**

---

## P1 effort summary

| Subsection | Effort |
|---|---|
| P1.1 — `node_tags` + schema v6 | 0.5 d |
| P1.2 — `GraphView` interface + `QueryGraphView` | 1.0 d |
| P1.3 — `FrameworkResolver` interface extension | 0.5 d |
| P1.4 — `Phase3Orchestrator` (incl. STAGE 0 purge) + indexAll/sync wiring. **Does NOT remove the legacy `extract` hook** — that happens in the final cleanup PR (P1.5's PR-16) after every resolver migrates | 1.5 d |
| P1.5 — 16 resolver migrations + Spring split + Temporal × 2 | 8.0 d |
| P1.6 — Tests | 1.0 d |
| **Total** | **~12.5 d** |

---

## Risk register

| Risk | Trigger | Mitigation |
|---|---|---|
| Resolver A's `synthesize` references a node B's `synthesize` would create, but B isn't registered | Migration miss | `graph.getNode(missing)` returns null; resolvers must accept null and skip the edge; P1.6 test #1 covers happy path |
| `GraphView` mutated via a side-channel by a buggy resolver | Implementation bug | `readonly` types in TS, `Object.freeze` under `CODEGRAPH_DEV=1`; docs warning at the type definition |
| `detect()` false positive on fresh / empty repo | `package.json` exists but no source files yet | Already handled by `detectFrameworks`'s `try/catch`; no change |
| `node_tags.added_by` loses second-writer information | Multiple frameworks tag the same node | Single-value first-writer semantics is documented; `provenances`-style multi-write column deferred until a consumer needs it |
| Old worker protocol skew after removing `frameworkNames` field | User running mixed-version dist | Worker and main ship from the same build artifact — non-issue |
| Phase 3 OOM on huge repos (GraphView caches 1M+ nodes) | Monorepo scale | `getAllNodes` is a generator; resolvers must use kind/tag-filtered queries; PR review enforces |
| Spring DI dispatch falls back to regex unexpectedly often | `type_of` edge missing for Java fields after P0.5b | Both paths tested (P1.6 tests #7 and #8); ledger which path was taken via an `ExtractionError` of severity `info` if needed |
| Temporal pattern detection emits false positives | Pattern too loose | Strict match — full token chain `newWorkflowStub(X.class).method()` must be visible at call site, exactly one interface candidate, exactly one implementor; recall traded for precision |
| Phase 3 runtime regression > 50% on existing projects | Resolver implementation does whole-graph scans without indexes | P1.6 optional perf test catches; resolver-specific indexes added as needed |
| `synthesize()` produces non-deterministic ids (e.g., uses `Date.now()` in id) | Implementation bug | Code review + `assertSynthesizedNode` warns if id doesn't start with `framework:<name>:` and id includes any timestamp-like substring |
| Resolver author tries to introduce a new node kind through `synthesize` (e.g. `bean`, `hook`) | New framework or refactor temptation | `assertSynthesizedNode` checks `node.kind ∈ NODE_KINDS`; doc rule "concept that IS its source-code counterpart → tag, not kind"; PR-2 unit test asserts NODE_KINDS unchanged from P0 |
| STAGE 0 purge runs but Phase 3 throws before re-deriving → framework facts gone | Orchestrator-level error (DB lock, OOM, programming bug) anywhere between purge and final commit | Final invariant (R4-F1): STAGE 0 + view1 construction + STAGE A + STAGE B + view2 construction + STAGE D + STAGE E are ALL inside one transaction opened via `queries.transaction(...)`. Per-resolver `synthesize` / `augment` throws are caught at the per-resolver level (sibling isolation, no rollback). Only orchestrator-level escapes — failed pre-flight + a programming error in pre-flight itself, or DB-adapter exceptions — bubble out of the transaction and roll EVERYTHING back, leaving the pre-Phase-3 graph intact. Regression test #17 covers a deliberate inner throw |
| STAGE 0 purge SQL 0.1 (`json_each` rewrite) is slow on large graphs | Many edges have framework contributions | Real workloads have framework contributors on a small fraction of edges; mitigated by the existing `idx_edges_provenance` partial index. If perf bites, switch to a two-pass approach (collect ids first, then update) |
| `codegraph status` counts framework edges with `provenance LIKE 'framework:%'` instead of contributing provenances | Implementer follows the natural shape | F3 fix is explicit in the modified-files list AND ship gate 9; status implementation PR (P1.5 final) has a regression test ingesting a SCIP+framework merged edge and asserting the framework count > 0 |
| Spring DI fallback to a tag query before STAGE B persists tags (cross-stage visibility bug) | Resolver author treats tags emitted in augment as visible to other augments | Synthesize/augment tag contracts are split (R3-F1): inherent tags emitted in synthesize, derived tags in augment. Doc comment on each field spells out visibility. Regression test #18 covers cross-resolver inherent-tag visibility; #19 asserts derived tags are NOT visible to sibling augments |
| Existing batch helpers (e.g. `insertNodes`) open their own transaction; calling them inside Phase 3 nests, which fails on WASM SQLite | Helper reuse during implementation | R5-F1 fix: Phase 3 uses ONLY single-row write helpers (`insertNode`, `upsertGraphEdge`, `insertNodeTag`) and raw-SQL purge helpers (which don't open transactions). New `QueryBuilder.transaction` wrapper is the only transaction opened. Audit gate: `__tests__/p1-phase3-no-nested-tx.test.ts` records `BEGIN`/`COMMIT` calls and asserts exactly one matched pair per Phase 3 run |
| Framework augmenter writes `edge.metadata`, polluting the shared merged metadata blob | Resolver author convenience | R3-F4 fix: contract forbids `Edge.metadata` on augment results. Phase3Orchestrator edge pre-flight rejects + logs `warning` ExtractionError. Regression test #15 covers |
| STAGE 0 leaves inflated `confidence` from a removed framework contributor | Tree-sitter (0.7) + framework (0.85) merge → strip → row stays at 0.85 | R3-F4 fix: STAGE 0 SQL 0.1 recomputes `confidence = MAX(defaultConfidence(p))` over surviving provenances in the same UPDATE. Regression test #14 covers |
| `codegraph index` (no `--force`) on a populated DB leaves stale Phase 3 facts | CLI re-run scenario | R3-F2 fix: STAGE 0 is unconditional; runs on every Phase 3 invocation regardless of mode. Regression test #16 covers |
| view1 built before purge → synthesize reads prior Phase 3 generation's framework nodes/tags/edges as if they were static-layer inputs | Order-of-operations bug | R4-F1 fix: STAGE 0 + view1 + STAGE A + STAGE B + … all happen inside one transaction with purge as the FIRST writes. view1 constructed AFTER purge sees a clean static layer. Regression test #20 captures view1 contents inside synthesize and asserts they exclude framework rows |
| Tag insert with bad nodeId / malformed tag string crashes the whole Phase 3 run | Resolver bug | R4-F2 fix: tag pre-flight per insert — `view.hasNode(nodeId)` (or `synthNodeIds.has(...)` for synth-stage), `isValidTagFormat(tag)`, and a try/catch around `insertNodeTag`. Bad inserts logged + dropped, never escape. Regression tests #21 and #22 cover |
| QueryBuilder caches survive STAGE 0 purge, view2 observes ghost framework rows | Cache-coherence bug | R4-F4 fix: `invalidatePhase3Caches()` is called by each STAGE writes block (after purge, after STAGE B insert/tag, before view2 construction). View instances themselves keep per-view LRUs that are fresh on construction. Regression test #23 cross-checks read-after-delete |
| `default_confidence` SQLite UDF behaves differently across native (better-sqlite3) and WASM (node-sqlite3-wasm) backends, breaking STAGE 0 0.1 on one of them | Backend drift | R4-F5 fix: UDF dropped. STAGE 0 0.1 uses inline CASE ladder. Drift between SQL ladder and `defaultConfidence` in src/types.ts caught by regression test #24 (probes every `GraphProvenance` literal through both code paths and asserts equality) |

---

## Modified files

### Schema
- Edit: [src/db/schema.sql](src/db/schema.sql) — `node_tags` + indexes
- Edit: [src/db/migrations.ts](src/db/migrations.ts) — migration 5→6, `CURRENT_SCHEMA_VERSION = 6`
- Edit: [src/db/queries.ts](src/db/queries.ts) — `insertNodeTag`, `getNodesByTag`, optional `getNodesByKindStream` generator

### Core
- New: `src/resolution/graph-view.ts` — `GraphView` interface + `QueryGraphView` implementation
- New: `src/resolution/phase3.ts` — `Phase3Orchestrator`
- Edit: [src/resolution/types.ts](src/resolution/types.ts) — `SynthesizeResult`, `AugmentResult`, optional `synthesize`/`augment` on `FrameworkResolver`
- Edit: [src/resolution/index.ts](src/resolution/index.ts) — `getDetectedResolvers()`, `if (!framework.resolve) continue` guard in Strategy 1
- Edit: [src/index.ts](src/index.ts) — Phase 3 invocation after `resolveAndPersist` (both `indexAll` and `sync` paths)
- Edit (**PR-16 only, after all P1.5 migrations**): [src/extraction/tree-sitter.ts](src/extraction/tree-sitter.ts) — remove framework extract block (lines 2550–2573) + `frameworkNames` parameter
- Edit (**PR-16 only**): [src/extraction/index.ts](src/extraction/index.ts) — remove `detectedFrameworkNames` field, `ensureDetectedFrameworks` method, 4 caller sites (676, 680, 711, 1125)
- Edit (**PR-16 only**): [src/extraction/parse-worker.ts](src/extraction/parse-worker.ts) — remove `frameworkNames` from parse message
- Edit (**P1.4 / PR-2**): [src/db/queries.ts](src/db/queries.ts) — add `transaction<T>(fn: () => T): T` public method (thin delegate to `this.db.transaction(fn)()`); add STAGE 0 purge helpers (`stripFrameworkContributionsFromMergedEdges`, `deleteAllFrameworkTags`, `deleteFrameworkPrimaryEdges`, `deleteFrameworkNodes`) AND a single `invalidatePhase3Caches()` method called explicitly by Phase 3 after each batch of writes. The purge helpers do raw SQL; without explicit cache invalidation, any post-purge `getNodeById` / `getNodesByName` / `getNodesByQualifiedName` against a freshly-deleted framework row would return a stale cached node (`QueryBuilder` carries an in-memory `nodeById` LRU and several name caches — current implementation reset them on writes via `insertNode` / `upsertGraphEdge` paths, but raw `DELETE` SQL bypasses those code paths). `invalidatePhase3Caches()` clears every cache map that could hold framework-derived rows: `nodeById`, `nodesByName`, `nodesByLowerName`, `nodesByQualifiedName`, `nodesByKind`, `nodesByFile`, plus the framework-tag and outgoing/incoming edge caches if they exist. **Verification gate**: a regression test deletes a framework node via the helper, then immediately calls `queries.getNodeById` and asserts `null`

### Resolvers (one PR each)
- Edit: [src/resolution/frameworks/csharp.ts](src/resolution/frameworks/csharp.ts)
- Edit: [src/resolution/frameworks/express.ts](src/resolution/frameworks/express.ts)
- Edit: [src/resolution/frameworks/react.ts](src/resolution/frameworks/react.ts)
- Edit: [src/resolution/frameworks/svelte.ts](src/resolution/frameworks/svelte.ts)
- Edit: [src/resolution/frameworks/vue.ts](src/resolution/frameworks/vue.ts)
- Edit: [src/resolution/frameworks/python.ts](src/resolution/frameworks/python.ts)
- Edit: [src/resolution/frameworks/ruby.ts](src/resolution/frameworks/ruby.ts)
- Edit: [src/resolution/frameworks/laravel.ts](src/resolution/frameworks/laravel.ts)
- Edit: [src/resolution/frameworks/go.ts](src/resolution/frameworks/go.ts)
- Edit: [src/resolution/frameworks/rust.ts](src/resolution/frameworks/rust.ts)
- Edit: [src/resolution/frameworks/swift.ts](src/resolution/frameworks/swift.ts)
- New: `src/resolution/frameworks/spring-core.ts` (split from `java.ts`)
- New: `src/resolution/frameworks/spring-temporal.ts`
- New: `src/resolution/frameworks/temporal.ts` (cross-language)
- Edit: [src/resolution/frameworks/java.ts](src/resolution/frameworks/java.ts) — emptied or removed (replaced by `spring-core.ts`)
- Edit: [src/resolution/frameworks/index.ts](src/resolution/frameworks/index.ts) — registry updated (spring → spring-core + spring-temporal; add temporal)

### MCP and CLI surface
- Edit: [src/mcp/tools.ts](src/mcp/tools.ts) — `codegraph_search` accepts optional `tag` parameter (ship gate 8)
- Edit: [src/mcp/server-instructions.ts](src/mcp/server-instructions.ts) — document the new `tag` parameter
- Edit: [src/installer/instructions-template.ts](src/installer/instructions-template.ts) — keep agent-facing docs in sync (per CLAUDE.md house rule)
- Edit: `.cursor/rules/codegraph.mdc` — same
- Edit: [src/bin/codegraph.ts](src/bin/codegraph.ts) — `status` subcommand reports per-framework edge counts (ship gate 9). Uses `getEdgesByContributingProvenance` against each detected `framework:<name>`, NOT `WHERE provenance LIKE 'framework:%'` (which would miss SCIP-primary merged edges)

### Tests / fixtures
- New: `__tests__/p1-framework-synthesize.test.ts` (tests #1–#13, #15, #20–#23 — the main synthesize/augment behavior + dedup + tag visibility + STAGE 0 purge + view1 cleanliness + tag pre-flight)
- New: `__tests__/p1-phase3-wiring.test.ts` (R1 review — covers F2 fresh-detection and F5 unconditional-Phase3)
- New: `__tests__/p1-phase3-sync-recompute.test.ts` (R2 review — STAGE 0 purge clears stale framework facts on resync; tests #11–#13)
- New: `__tests__/p1-stage0-confidence.test.ts` (R4-F5 — test #24, drift defense between inline CASE ladder and `defaultConfidence` in src/types.ts:300)
- New: `__tests__/p1-phase3-no-nested-tx.test.ts` (R5-F1 — test #25, adapter interceptor records `BEGIN`/`COMMIT`/`SAVEPOINT` and asserts exactly one matched pair per Phase 3 run)
- New: `__tests__/p1-cache-invalidation.test.ts` (R4-F4 — test #23, read-after-delete consistency for QueryBuilder caches after STAGE 0 purge)
- New: `__tests__/fixtures/spring-di-field/` (Foo.java + Bar.java + UserService.java with `@Autowired Foo foo` field)
- New: `__tests__/fixtures/spring-di-ctor-explicit/` (same shape with `@Autowired` constructor)
- New: `__tests__/fixtures/spring-di-ctor-implicit/` (`@Service` class with single un-annotated constructor)
- New: `__tests__/fixtures/spring-di-ctor-multi/` (two un-annotated constructors — negative test, no di_binding edges expected)
- New: `__tests__/fixtures/temporal-java/`
- New: `__tests__/fixtures/temporal-go/`
- Edit: [__tests__/frameworks.test.ts](__tests__/frameworks.test.ts) — each section adjusted per migration PR (line/col may shift)
- Edit: [__tests__/migrations.test.ts](__tests__/migrations.test.ts) — `node_tags` round-trip

### Docs
- Edit: [CHANGELOG.md](CHANGELOG.md) — P1 entry (draft already in `codegraph-scip-ingestion.md`'s CHANGELOG section)

---

## PR breakdown

| PR | Scope |
|---|---|
| **PR-1** | P1.1 schema v6 + P1.2 `GraphView` + P1.3 interface extension (additive only; legacy hooks untouched) |
| **PR-2** | P1.4 `Phase3Orchestrator` + wiring into `indexAll` / `sync`. **Legacy `extract` per-file hook stays active** — removing it before resolvers migrate would drop route/component extraction for un-migrated resolvers. Each migration PR removes its own resolver's `extract` field; the call site naturally short-circuits via `if (!fw.extract) continue`. The legacy hook block is deleted in the **final** cleanup PR after every resolver has migrated |
| **PR-3** | Migrate `aspnet` |
| **PR-4** | Migrate `express` |
| **PR-5** | Migrate `react` |
| **PR-6** | Migrate `vue` |
| **PR-7** | Migrate `svelte` |
| **PR-8** | Migrate `django` + `flask` + `fastapi` (one PR — they share Python machinery) |
| **PR-9** | Migrate `rails` |
| **PR-10** | Migrate `laravel` (Facade resolution upgrade is the main payoff) |
| **PR-11** | Migrate `go` |
| **PR-12** | Migrate `rust` |
| **PR-13** | Migrate `swift` (uikit + swiftui + vapor in one PR — they share the file) |
| **PR-14** | Spring split — produce `spring-core.ts` + `spring-temporal.ts`, retire `java.ts/springResolver` |
| **PR-15** | Generic `temporal.ts` for Go / TypeScript / Python |
| **PR-16** | Cleanup: **remove the legacy framework-extract block in `tree-sitter.ts:2550–2573`, the `frameworkNames` parameter chain through `extractFromSource` and `parse-worker.ts`, `ExtractionOrchestrator.detectedFrameworkNames` field + `ensureDetectedFrameworks`**. CI invariant: assert no registered resolver still defines `extract`. Also: MCP `codegraph_search` `tag` parameter, `codegraph status` per-framework edge counts, CHANGELOG, final regression sweep |

Each PR ships independently. Tests in `frameworks.test.ts` for the migrated resolver pass after that PR; previously-migrated resolvers are unaffected by subsequent ones.

---

## Out of scope (deferred)

- **Removing the legacy `resolve` / `extract` fields from `FrameworkResolver`** — kept as `@deprecated`. Removed in a P3 cleanup once all resolvers are migrated; doing it in P1 turns every resolver migration into a churn vector across unrelated PRs.
- **Cross-service framework resolution** (Kafka producer/consumer, gRPC client/server pairs) — explicitly deferred to a multi-repo Contract Bridge epic (already noted in `codegraph-scip-ingestion.md` out-of-scope list).
- **Live `GraphView`** (would let `augment` see edges written by earlier augments in the same Phase 3 run) — adds order-dependence we deliberately removed; if a real need arises, structure it as additional Phase 3 passes (Phase 3a, 3b) rather than relaxing the snapshot.
- **User-pluggable framework resolvers** (`CodeGraphConfig.customFrameworks`) — the `FrameworkResolver` interface is now public-shaped enough to support it, but the registration mechanism (config file format, sandboxing, error attribution) is its own design.
- **Tag-based query routing in `codegraph_callers` / `codegraph_callees`** — current MCP tools filter by node kind; adding tag filter requires a separate query path. P1 only adds tag filter to `codegraph_search`.

---

## CHANGELOG entry (P1 release)

```markdown
### Added
- **Spring DI dispatch resolution**: `@Autowired` / `@Inject` field injection AND constructor injection (explicit `@Autowired` constructor + Spring 4.3+ implicit single-constructor injection) resolve through the declared type to concrete implementations via `implements` edges. Emits `references` edges with `subkind='di_binding'`.
- **Spring Temporal workflow / activity resolution**: `WorkflowStub.start()` and `ActivityStub.execute()` resolve to concrete workflow / activity implementations. Emits `calls` edges with `subkind='temporal_dispatch'`.
- **Generic Temporal resolver** (language-agnostic) covering Go / TypeScript / Java / Python clients.
- **`node_tags` table**: framework resolvers can tag nodes (`spring:service`, `react:hook`, `route-handler`, …). MCP `codegraph_search` accepts an optional `tag` parameter to filter results.

### Changed
- Framework resolvers refactored to a `synthesize` / `augment` API that runs against the complete graph after static extraction. Resolvers now see SCIP-precise type information when augmenting framework edges (routes, DI bindings, component references).
- Spring resolver split: former monolithic `spring` is now `spring-core` (DI / `@Component` / `@Service` / routes) plus `spring-temporal` (workflow dispatch).
- `codegraph status` reports detected frameworks and per-framework edge counts.

### Notes
- Existing framework resolver behavior remains equivalent on the regression suite — `frameworks.test.ts` covers every supported resolver.
- The per-file framework extract hook (`extractFromSource` `frameworkNames` parameter) is removed; resolvers now run as a project-level Phase 3 pass after reference resolution completes.
```

---

## Review Round 1 — Patch Pass

Six findings (3 High, 2 Medium, 1 Low) against the v1 of this plan. All applied inline; this appendix records the trace.

| # | Severity | Issue | Fix |
|---|---|---|---|
| F1 | High | PR-2 removed the per-file extract hook before resolvers migrated → routes/components would disappear for every un-migrated resolver. Contradicted "each PR ships independently" | Ship gate 7 reworded to gate hook removal on "after every resolver has migrated". PR-2 keeps the hook live; PR-16 is the cleanup. Each migration PR strips its own resolver's `extract` field; the legacy block short-circuits via existing `if (!fw.extract) continue` |
| F2 | High | Phase 3 was specified to reuse `ReferenceResolver.frameworks`, but `ReferenceResolver.initialize()` runs in the `CodeGraph` constructor before any file is indexed — `getAllFiles()` is empty, scan-based `detect()` returns false | New "Detection timing" subsection in P1.4. `Phase3Orchestrator` runs its own `detectFrameworks` against a context built from the post-extraction DB. A new wiring-regression test guards this |
| F3 | High | Stage E pseudocode called `upsertGraphEdge` directly, but `upsertGraphEdge` only `coerceEdgePosition`s — it doesn't run the strict three-tier validator. Test #6 expected validator rejection that wouldn't happen | Stage E pseudocode now calls `validateEdgeLineColumn(edge)` explicitly before `upsertGraphEdge`. The doc comment in the pseudocode notes that this is a separate caller responsibility per `src/types.ts:367` |
| F4 | Medium | The single wiring snippet pushed into `result.errors` / `result.nodesCreated` / `result.edgesCreated`, but `SyncResult` has none of those fields | Split into two snippets. `indexAll` merges into `IndexResult`. `sync` gets a new optional `phase3?` sub-object on `SyncResult` (additive — existing consumers keep compiling) |
| F5 | Medium | Plan said Phase 3 runs "after reference resolution", which implementer would naturally nest inside the `if (unresolvedCount > 0)` gate at `index.ts:696` — tag-only and synth-only resolvers would never run on projects with no unresolved refs | Explicit "Phase 3 is unconditional" callout. Snippet shows Phase 3 outside the resolution gate, only gated on `result.success`. Added wiring-regression test |
| F6 | Low | CHANGELOG promised constructor injection, but ship gate 5, augment pseudocode, fixture, and test #7 only covered field injection | Spring DI augment expanded to handle both: field injection (`@Autowired` field), explicit constructor injection (`@Autowired` constructor), and Spring 4.3+ implicit single-constructor injection. New `resolveParameterInterfaceType` + `isInjectionConstructor` helpers. Tests 7a/7b/7c cover the three constructor paths; CHANGELOG updated |

**Pattern note** (carried over from P0's "fixes introduce ripple" lesson): F3 and F5 are bugs introduced by the abstraction the plan itself was promoting. F3 conflated `coerceEdgePosition` (silent normalization) with `validateEdgeLineColumn` (loud rejection); F5 conflated "after resolution conceptually" with "inside the resolution code path". The mitigation in both cases is being explicit about contract boundaries rather than relying on adjacency.

---

## Review Round 2 — Patch Pass

Five findings (2 High, 1 Medium, 2 Low) against the v2 of this plan. All applied inline; this appendix records the trace.

| # | Severity | Issue | Fix |
|---|---|---|---|
| R2-F1 | High | Resolver migration notes listed `hook` and `bean` as synthesized node kinds, but `NODE_KINDS` only contains `route` / `component` for framework concepts. Phase 3 was specified to reject invalid kinds — implementation would have crashed | New "Node-kind discipline" subsection. Hard rule: tags for "concept that IS its source-code counterpart" (Spring beans = classes, React hooks = functions), nodes only for concepts with independent identity (route, component). Migration table updated: `react` synthesizes `component` only, hooks become tags; `spring-core` synthesizes `route` only, beans become tags. Added a risk register entry and a PR-2 unit test asserting `NODE_KINDS` unchanged |
| R2-F2 | High | Sync was specified as "incremental Phase 3 — re-run resolvers whose detect set intersects the changed files", but `detect()` returns boolean, resolvers don't declare file dependencies, and there was no deletion path for stale derived nodes / tags / edges / merged-edge provenance contributions. Stale framework facts would accumulate across syncs | Decision reversed: **full Phase 3 recompute on sync** with a new STAGE 0 framework purge that runs before STAGE A. STAGE 0 has four scoped DELETE/UPDATE statements covering merged-edge contribution stripping, tag deletion, framework-primary edge deletion, framework-node deletion. `Phase3Orchestrator` ctor now takes `mode: 'indexAll' \| 'sync'`; indexAll skips STAGE 0. Three new regression tests (#11–#13) cover stale node, stale merged-edge contribution, and stopped-detecting cases. Incremental sync of derived facts deferred explicitly to P2/P3 |
| R2-F3 | Medium | `codegraph status` "edge count contributed by each framework" would naturally be implemented as `WHERE provenance LIKE 'framework:%'`, but that misses SCIP-primary merged edges where the framework is a non-primary contributor in `provenances[]` (the exact case ship gate 2 promises will exist) | Ship gate 9 made explicit: must count via `provenances[]` membership. Status implementation path bound to existing `getEdgesByContributingProvenance` ([queries.ts:1181](src/db/queries.ts#L1181)). Risk register entry + a regression test in the status implementation PR |
| R2-F4 | Low | Effort summary and modified-files list still placed extract-hook removal under P1.4, contradicting the round-1 fix that moved it to PR-16. Invited the implementer to make the same mistake | P1.4 effort row reworded to explicitly say "Does NOT remove the legacy `extract` hook". Modified-files entries for `tree-sitter.ts` / `extraction/index.ts` / `parse-worker.ts` annotated `**PR-16 only**`. Added a new `queries.ts` entry for STAGE 0 SQL helpers (which DO belong to P1.4 / PR-2) |
| R2-F5 | Low | Test fixture inventory still listed one `spring-di/` directory after the round-1 fix split test #7 into 7 / 7a / 7b / 7c with four distinct fixtures | Fixture inventory updated: `spring-di-field/`, `spring-di-ctor-explicit/`, `spring-di-ctor-implicit/`, `spring-di-ctor-multi/`. Two additional wiring tests (`p1-phase3-wiring.test.ts`, `p1-phase3-sync-recompute.test.ts`) also added since they came up implicitly in the round-1 fixes but weren't in the modified-files list |

**Design hole closed by R2-F2**: Phase 3 produces derived facts; the round-1 plan had no path to retract derived facts. STAGE 0 purge is the explicit, bounded mechanism — at the cost of full Phase 3 recompute on sync (acceptable given resolver workloads are small relative to total graph). Incremental retraction is a real P2/P3 design topic, not a P1 gap to paper over.

**Pattern note**: R2-F4 and R2-F5 are both "cleanup didn't reach the index". The plan changes one section but the references to that section in summary/inventory tables linger. Mitigation for future rounds: when a fix changes WHERE something happens, audit every section that lists WHERE things happen — effort tables, modified-files lists, PR breakdowns, fixture inventories.

---

## Review Round 3 — Patch Pass

Five findings (3 High, 1 Medium, 1 Low) against the v3 of this plan. All applied inline; this appendix records the trace.

| # | Severity | Issue | Fix |
|---|---|---|---|
| R3-F1 | High | Spring implicit constructor injection's `isInjectionConstructor` called `graph.getNodesByTag('spring:service')` inside `augment`, but the v3 plan emitted bean tags from the SAME augment — view2 (passed in) was built before any augment ran, so the tag query returned empty. Constructor injection silently became no-op | **Split tag emission across stages**. `SynthesizeResult` now carries `tags?:` for INHERENT tags (annotations, naming conventions — visible to all augments via STAGE B persistence + STAGE C view rebuild). `AugmentResult.tags` is reserved for DERIVED tags (e.g. `route-handler`, derived from edge construction — visible only post-Phase-3). Spring bean tags moved to `spring-core.synthesize()`; constructor-injection check now reads from view2 correctly. New tests #18 / #19 cover the visibility contract |
| R3-F2 | High | STAGE 0 purge was gated on `mode='sync'`, but `codegraph index` without `--force` doesn't call `clear()` ([src/bin/codegraph.ts:596](src/bin/codegraph.ts#L596)). A plain re-index of a populated DB would have left stale Phase 3 facts intact | **STAGE 0 is now unconditional**. `Phase3Orchestrator` constructor no longer takes a `mode` parameter. Purge SQL on a truly empty DB matches zero rows (no cost). Regression test #16 covers `codegraph index` without `--force` |
| R3-F3 | High | Pseudocode committed STAGE 0 in its own transaction before STAGE A/D, but the risk table claimed STAGES 0–E rolled back together. An orchestrator-level throw between commits could leave framework facts purged without re-derivation | **Single transaction wraps STAGE 0 + STAGE B + STAGE C + STAGE D + STAGE E**. STAGE A runs OUTSIDE the transaction (pure compute, view1 read once). better-sqlite3's sync nature precluded the `Promise.all` concurrency hint — resolvers now run sequentially inside the transaction, which was always a cosmetic concurrency claim anyway (CPU-bound JS serializes). View2 is built INSIDE the transaction and sees STAGE B's in-transaction writes. Regression test #17 covers the rollback property |
| R3-F4 | Medium | STAGE 0 stripped framework entries from `provenances[]` but left `confidence` (max-merged) and `metadata` (shallow-merged) carrying framework-contributed values. A merged tree-sitter+framework edge (0.85) would stay at 0.85 after the framework retracted | **Two-pronged fix**: (a) Framework augmenters MUST NOT write `Edge.metadata` — metadata is owned by the static extractor that first produced the edge. Phase3Orchestrator's edge pre-flight rejects framework edges with non-empty metadata (test #15). (b) STAGE 0 SQL 0.1 was extended to recompute `confidence = MAX(defaultConfidence(p))` over surviving provenances in the same UPDATE statement (test #14). Added "Edge metadata ownership" subsection documenting both rules |
| R3-F5 | Low | The `synthesize` interface comment still listed "hook / workflow" as example synthesized kinds, contradicting the Node-kind discipline section added in round 2 | Comment rewritten to list allowed kinds (`route`, `component` only) and explicitly cross-reference Node-kind discipline. Removed `hook` / `workflow` references |

**The "tags are not first-class" theme**: R3-F1 surfaced the underlying gap — Phase 3 produces several kinds of derived state (nodes, tags, edges, provenance contributions), and each needs a stage placement. The fix made the contract explicit: **inherent state** (nodes, annotation/naming-convention tags) lands in synthesize and is persisted before any augment runs. **Derived state** (edges, edge-driven tags) lands in augment and is persisted at the end. This is the same shape P0's two-pass SCIP ingester uses for "definitions visible to references" — a known good pattern.

**Atomicity theme**: R3-F2 + R3-F3 + R3-F4 are all forms of "the purge and the re-derivation must be all-or-nothing AND must cover every contributing state". Single transaction (R3-F3) handles atomicity; unconditional purge (R3-F2) handles "did we even purge"; confidence recompute + metadata ownership (R3-F4) handle "did the purge cover everything the upsert contributed to". The three findings clustered for a reason — they're facets of the same invariant.

---

## Review Round 4 — Patch Pass

Five findings (2 High, 2 Medium, 1 Low) against the v4 of this plan. All applied inline; this appendix records the trace.

| # | Severity | Issue | Fix |
|---|---|---|---|
| R4-F1 | High | `view1` was constructed BEFORE STAGE 0 purge. On any populated DB, `synthesize()` saw the prior Phase 3 generation's framework nodes / tags / merged-edge contributions as if they were static-layer input. Defeated the "clean static-layer input" contract and could cause resolvers to skip re-synthesizing rows they thought already existed | **STAGE 0 + view1 construction + STAGE A all moved inside one transaction**, with purge as the FIRST writes. view1 is built AFTER purge, so synthesize observes only the static layer. New test #20 captures view1 contents from inside synthesize and asserts framework rows are absent |
| R4-F2 | High | Tag inserts (both inherent in STAGE B and derived in STAGE E) were called raw against `insertNodeTag`. A resolver returning a bad `nodeId` (FK violation) or malformed tag would escape per-resolver isolation and roll back the whole Phase 3 transaction | **Tag pre-flight at every write site**: `view.hasNode(nodeId)` (or `synthNodeIds.has(...)` for STAGE B inserts targeting just-persisted nodes), `isValidTagFormat(tag)` (kebab-case + optional `<prefix>:<role>` form via regex `/^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/`), and a try/catch around the actual insert. Bad inserts logged + dropped. Tests #21 (bad nodeId) and #22 (malformed string) cover |
| R4-F3 | Medium | Internal inconsistency: prose said "all resolver invocations sequentially inside a single transaction" but pseudocode had STAGE A executing OUTSIDE the transaction. The R3 appendix likewise said STAGE A ran outside. Two conflicting models | Resolved by R4-F1: STAGE A is INSIDE the transaction (no other choice, since view1 must be built post-purge and inside the transaction). All resolver invocations are now uniformly inside. Prose, pseudocode, and R3 appendix reconciled |
| R4-F4 | Medium | STAGE 0 purge helpers are raw SQL DELETE/UPDATE; they bypass QueryBuilder's `nodeById` and name LRU caches. Post-purge `getNodeById` would return cached deleted nodes; view2 would observe ghost framework rows | **New `invalidatePhase3Caches()` method on QueryBuilder**, called explicitly after STAGE 0 and after STAGE B writes. Clears `nodeById`, `nodesByName`, `nodesByLowerName`, `nodesByQualifiedName`, `nodesByKind`, `nodesByFile`, plus framework-tag and edge caches. QueryGraphView's caches are per-instance (per STAGE C rebuild) so they're naturally fresh. Test #23 covers read-after-delete with explicit assertion |
| R4-F5 | Low | STAGE 0 SQL 0.1 referenced a `default_confidence` SQLite UDF that doesn't currently exist, with a hand-wave that it was "already needed elsewhere". UDF support varies between native and WASM SQLite adapters — committing to it would add a separate DB-adapter task | **Inline CASE ladder** mirroring `defaultConfidence` from `src/types.ts:300`. Lives in one place (the purge query). Drift defense: test #24 enumerates every `GraphProvenance` literal and asserts the SQL CASE result equals the TS function result |

**Ordering theme** (R4-F1 + R4-F3): the central P1 ordering invariant is now explicit — purge precedes every Phase 3 read. The earlier "STAGE 0 inside transaction" fix (R3-F3) was incomplete because it placed STAGE A outside the transaction (synth runs first, then transactional writes). R4 closes that gap: purge → view1 → synth → persist → view2 → augment → persist all happen inside one transaction, in that order.

**Hygiene theme** (R4-F2 + R4-F4): write paths must defend against bad caller input (R4-F2) and stale cache reads (R4-F4). Both are forms of "the transaction's atomicity assumes only deliberate writes, but the path can be poisoned by FK violations or stale state". Pre-flight + cache invalidation are the standard fixes; the plan now enumerates both.

**Adapter-portability theme** (R4-F5): native vs WASM SQLite is a genuine portability surface. The plan prefers inline SQL over UDF registration whenever the difference is one CASE statement vs ~20 lines of adapter-specific code + tests.

---

## Review Round 5 — Patch Pass

Four findings (2 High, 2 Medium) against the v5 of this plan. All applied inline; this appendix records the trace.

| # | Severity | Issue | Fix |
|---|---|---|---|
| R5-F1 | High | Orchestrator pseudocode called `queries.transaction(() => …)` but `QueryBuilder` has no public `transaction` method — only `CodeGraphDB` does. Worse, existing batch helpers like `insertNodes` open their own internal transactions, and the WASM adapter uses raw `BEGIN`/`COMMIT` (no SAVEPOINT support), so nesting silently fails. Implementation blocker — the whole single-transaction design had no executable path | New "Transaction API surface and nesting" subsection. Three explicit moves: (a) add `QueryBuilder.transaction<T>(fn): T` as a thin delegate; (b) Phase 3 uses ONLY single-row write helpers (`insertNode`, `upsertGraphEdge`, `insertNodeTag`) plus the new raw-SQL purge helpers — no batch helpers that open inner transactions; (c) audit test #25 records `BEGIN`/`COMMIT`/`SAVEPOINT` calls and asserts exactly one matched pair. Modified-files entry for `queries.ts` updated to list the new `transaction` method |
| R5-F2 | High | The canonical "Sync recompute" SQL block at line 664 (pre-patch) still called `MAX(default_confidence(value))` and the prose after it still said to register a SQLite UDF — directly contradicting R4-F5's decision to inline the CASE ladder | SQL block rewritten with the inline CASE ladder identical to the version in the orchestrator pseudocode. Trailing prose rewritten to point at test #24 as the drift defense. Removed the "fold the CASE inline" hedge — it's now the only path |
| R5-F3 | Medium | "Concurrency" subsection still said "`Promise.all` is safe" and "concurrency is free" — contradicted R3-F3 / R4-F1 / R4-F3 which dropped Promise.all entirely. Risked steering implementers back to the ordering bug that motivated R4-F1 | Section rewritten: "Sequential, sync, inside one transaction. No `Promise.all`." Explicitly justifies why parallelism is incompatible with sync transactions and why the earlier shape was cosmetic anyway |
| R5-F4 | Medium | Risk register held two stale rows describing transaction scope — one said "STAGE 0 + A–E in nested transactions" (wrong — single tx), another said "STAGE 0 + B + E in a SINGLE transaction" (incomplete — missing view1/A/C/view2/D). Both contradicted the final invariant | Collapsed into one accurate row: STAGE 0 + view1 + STAGE A + STAGE B + view2 + STAGE D + STAGE E in one transaction; per-resolver throws caught; only orchestrator-level escapes roll back. Added a new row for the R5-F1 nesting risk |

**Stale-text theme**: R5-F2 / R5-F3 / R5-F4 are all "old plan text outlived its design decision". The R3 / R4 fixes added new sections describing the new design, but didn't sweep the document for *all* sites that described the old design. This is the pattern R2 already called out under "cleanup didn't reach the index" — and it recurred here. Mitigation going forward: when a fix changes a design property (transaction shape, SQL form, concurrency model), grep for every keyword from the *old* design (`default_confidence`, `Promise.all`, `nested transactions`) and ensure every mention is reconciled. The R5 review caught these three; the R6+ pre-flight is `grep -rEn 'default_confidence|Promise\.all|nested transaction|STAGE 0 \+ B'` on the plan before declaring it ready.

**Executable-path theme** (R5-F1): the plan had grown rich abstract design without anchoring to the actual API surface. The `queries.transaction(...)` line read naturally but didn't exist as code. Mitigation: when a future round introduces a new orchestration method, audit the underlying class signatures with `Read` or `Grep` before committing the design — the same discipline P0 used when cross-referencing schema/migration version bumps.

---

## Review Round 6 — Patch Pass

Four findings (2 High, 1 Medium, 1 Low) against the v6 of this plan. All applied inline; this appendix records the trace.

| # | Severity | Issue | Fix |
|---|---|---|---|
| R6-F1 | High | Resolver migration table said `spring-core` synthesizes only `route`, with bean tags in the augment column. R3-F1 had moved inherent tags (annotations are properties of the class, not edge-derived) to `synthesize`, and the later Spring pseudocode does it correctly — but this migration table is exactly where a resolver implementer looks first. A literal reading would have reintroduced the constructor-DI visibility bug (`isInjectionConstructor` reads bean tags via `view2.getNodesByTag(...)`; tags emitted in the same augment aren't persisted yet) | `spring-core` row rewritten: "synthesizes `route` AND inherent bean tags (`spring:service` etc.) on existing class nodes". Notes column spells out why bean tags MUST come from synthesize and references R3-F1 |
| R6-F2 | High | Orchestrator pseudocode still called `queries.insertNodesBatch([...])` inside the transaction. The R5-F1 fix said Phase 3 must NOT use batch helpers (they open inner transactions, which fail on WASM SQLite), and the transaction-section text said this call should be rewritten to a single-row loop — but the rewrite never reached the pseudocode | Pseudocode replaced with `for (const node of stagedNodes.values()) queries.insertNode(node)`. Inline comment cross-references R5-F1 and explains why batch helpers can't be used. Test #17's "inject throw via `insertNodesBatch`" mention was also updated to `queries.insertNode` to match |
| R6-F3 | Medium | "Snapshot timing" section said `view2` reflects view1 plus newly inserted framework-synthesized **node[s]** only — silent about inherent tags. The interface docs (R3-F1) say augment sees both nodes AND inherent tags via view2; the load-bearing invariant for `isInjectionConstructor` and similar cross-resolver dependencies is that inherent tags are persisted in STAGE B and visible in view2 | view2 description rewritten to explicitly call out: nodes AND inherent tags from `SynthesizeResult.tags`. Cited the `view2.getNodesByTag('spring:service')` use case to make it concrete |
| R6-F4 | Low | Test-files inventory listed only the three test files defined in the v1 plan; the four new test files added across rounds (`p1-stage0-confidence`, `p1-phase3-no-nested-tx`, `p1-cache-invalidation`, and the wiring + sync-recompute variants from earlier rounds) were missing. PR-2 implementer following the inventory verbatim would not create these | Inventory expanded with all 6 test files; each annotated with the review round / test number that introduced it, so an implementer can trace WHY each file exists |

**Stale-text theme (round 3 in a row)**: every single R6 finding is the same pattern — design decision from an earlier round didn't propagate to every high-copy location. R6-F1 (migration table), R6-F3 (snapshot timing prose), R6-F4 (test inventory) are all sites a PR implementer reads literally without cross-checking against the orchestrator pseudocode. R6-F2 is the orchestrator pseudocode itself diverging from the transaction-section narrative.

The R5 appendix proposed a grep pre-flight as the mitigation. R6 ratifies it: before declaring this plan ready, the pre-flight is:

```
grep -nE 'default_confidence|Promise\.all|nested transaction|insertNodesBatch|inserted framework-synthesized node[^s]|bean.*from.*augment|STAGE 0 \+ B \+ E\b' \
  docs/plans/phase2/codegraph-framework-synthesize-augment.md
```

Every match must be either (a) absent or (b) inside a `## Review Round N — Patch Pass` appendix (historical, not prescriptive). The current state satisfies this.

**Structural take**: the inverse correlation between number of patch passes and severity (R6 has zero implementation-blocker findings) suggests the plan is converging — but the persistence of stale-text findings is its own signal. A R7 round would likely still find one or two stale phrasings without finding any new design holes. The cost of finding those vs the cost of fixing them inline during PR-2 implementation has flipped: it's cheaper to start implementing and let PR-2's audit gate (test #25 and the no-nested-tx test) catch any drift than to keep grepping for stale words.

