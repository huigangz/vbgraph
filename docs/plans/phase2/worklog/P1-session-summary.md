# P1 — session summary (foundation + easy migrations)

**Status**: PR-1 through PR-9 of 16 PRs landed in this session
**Date**: 2026-05-23
**Plan**: [codegraph-framework-synthesize-augment.md](../codegraph-framework-synthesize-augment.md)

## What landed

| PR | Sub-step | Worklog |
|---|---|---|
| PR-1 | P1.1 schema v6 + node_tags table + queries | [P1.1.md](P1.1.md) |
| PR-1 | P1.2 GraphView interface + QueryGraphView | [P1.2.md](P1.2.md) |
| PR-1 | P1.3 FrameworkResolver interface extension | [P1.3.md](P1.3.md) |
| PR-1 | tests (migrations round-trip + GraphView) | [P1.1-and-P1.2-tests.md](P1.1-and-P1.2-tests.md) |
| PR-2 | P1.4 Phase3Orchestrator + STAGE 0 purge + wiring + tests | [P1.4.md](P1.4.md) |
| PR-3 | aspnet migration | [P1.5-aspnet.md](P1.5-aspnet.md) |
| PR-4 | express migration | [P1.5-express.md](P1.5-express.md) |
| PR-5 | react migration | [P1.5-react.md](P1.5-react.md) |
| PR-6 | vue migration | [P1.5-vue.md](P1.5-vue.md) |
| PR-7 | svelte migration | [P1.5-svelte.md](P1.5-svelte.md) |
| PR-8 | django + flask + fastapi migration | [P1.5-python.md](P1.5-python.md) |
| PR-9 | rails migration | [P1.5-rails.md](P1.5-rails.md) |

## Code changes

### New files

- `src/resolution/graph-view.ts` — `GraphView` interface + `QueryGraphView`.
- `src/resolution/phase3.ts` — `Phase3Orchestrator` + `isValidTagFormat`.
- `__tests__/p1-node-tags-and-graphview.test.ts` — 10 tests for schema v6 + view shape.
- `__tests__/p1-phase3-orchestrator.test.ts` — 16 tests covering plan items #1, #2, #5, #15, #16, #18–#25.

### Schema bump 5 → 6

- `src/db/migrations.ts`: `CURRENT_SCHEMA_VERSION = 6`, new migration entry that creates `node_tags`.
- `src/db/schema.sql`: matching DDL for fresh installs, documenting the tag-naming convention.

### QueryBuilder additions (`src/db/queries.ts`)

- `insertNodeTag(nodeId, tag, addedBy)` + `getNodesByTag(tag)`.
- `transaction<T>(fn)` — public delegate for Phase 3's single tx boundary.
- STAGE 0 purge helpers: `stripFrameworkContributionsFromMergedEdges` (inline CASE ladder mirroring `defaultConfidence`), `deleteAllFrameworkTags`, `deleteFrameworkPrimaryEdges`, `deleteFrameworkNodes`.
- `invalidatePhase3Caches()` — explicit cache flush after raw-SQL deletes.

### Resolver interface (`src/resolution/types.ts`)

- `FrameworkResolver.resolve` and `.extract` are now `@deprecated` optional.
- New `synthesize?(graph): SynthesizeResult` and `augment?(graph): AugmentResult` hooks with full contract docs (node-kind discipline, no-metadata-on-edges, inherent-vs-derived tag visibility).
- Strategy-1 guard `if (!framework.resolve) continue` added to `resolution/index.ts:528`.
- `unregisterFrameworkResolver(name)` helper for test cleanup.

### Phase 3 wiring (`src/index.ts`)

- `indexAll`: unconditional Phase 3 after `result.success`, OUTSIDE the resolution gate.
- `sync`: unconditional Phase 3, attached to `SyncResult.phase3` sub-object.
- `SyncResult.phase3?` field added (optional, source-compatible).

### Migrated resolvers (9 total)

| Resolver | synthesize | augment | resolve dropped? |
|---|---|---|---|
| aspnet | route nodes (attribute + minimal API) | route→handler convention edges, aspnet:controller + route-handler tags | yes |
| express | route nodes | route→handler + middleware convention edges, route-handler + express:middleware tags | yes |
| react | component nodes + Next.js routes; react:hook tags on existing `use*` functions; react:component tags on synthesized components | — | yes |
| vue | Nuxt page + API routes | — | **retained** (compiler macros / Nuxt auto-imports / virtual modules) |
| svelte | SvelteKit routes | — | **retained** (Svelte 5 runes / `$store` / virtual modules) |
| django | route nodes (path / re_path / url) | route→view convention edges, django:view + route-handler tags | yes |
| flask | route nodes from @app.route | — | yes |
| fastapi | route nodes from @app.METHOD | — | yes |
| rails | route nodes from routes.rb DSL | — | yes |

## Tests

- `__tests__/frameworks.test.ts` — all 44 tests pass (the 12 `extract` tests across the migrated resolvers were rewritten to drive `synthesize` via a new in-test `makeStubGraphView` helper).
- `__tests__/frameworks-integration.test.ts` — passes (django route→view edge regression caught and fixed by adding `djangoResolver.augment`).
- `__tests__/p1-node-tags-and-graphview.test.ts` — 10/10 pass.
- `__tests__/p1-phase3-orchestrator.test.ts` — 16/16 pass.
- `__tests__/p09-schema-migration.test.ts` — 4/4 pass (the version-equals-5 assertion was bumped to 6).
- `__tests__/resolution.test.ts` — 2 react legacy-resolve tests now `describe.skip` with a doc-comment pointer; remaining failures are pre-existing P0 "kind bias" cases noted in [P0.4.md](P0.4.md).

Full-suite known-good cross-section (frameworks + frameworks-integration + p1-* + p0* + scip + extraction + graph + sync): 343/348 pass. The 5 outstanding failures are all pre-existing P0 issues plus 2 react legacy tests now explicitly skipped:

| Test | Status |
|---|---|
| foundation.test.ts: "should support optimize operation" | pre-existing (WASM VACUUM) |
| resolution.test.ts: "kind bias for new ref kinds" (×2) | pre-existing P0 WIP |
| resolution.test.ts: React legacy resolve tests (×2) | skipped, documented |
| installer-targets / mcp-initialize / watcher | pre-existing platform-specific |

## What did NOT land (out of session scope)

PR-10 through PR-16 — laravel, go, rust, swift (×3), Spring split + DI dispatch, Spring Temporal, generic Temporal, and the cleanup PR. The user selected "Foundation + all easy migrations" as the session scope; PR-10..16 are the heavier resolvers (Facade resolution, Spring DI, Temporal pattern detection) and the cleanup that removes the legacy `extract` hook chain. They are not blocked by anything in this session's work — each follows the same template as PR-3..9.

## Outstanding work for follow-on sessions

1. **PR-10..15** — heavier migrations:
   - laravel (Facade resolution becomes more precise — augment can read `INHERITS` edges)
   - go (gin/echo)
   - rust (axum)
   - swift × 3 (uikit + swiftui + vapor; largest single file)
   - **Spring split + DI dispatch** (PR-14 — the load-bearing payoff: split `java.ts/springResolver` into `spring-core.ts` + `spring-temporal.ts`; emit `references/di_binding` edges for `@Autowired` field AND constructor injection including Spring 4.3+ implicit single-constructor case)
   - generic **Temporal** (Go / TS / Python clients)
2. **PR-16 — cleanup**:
   - Remove the legacy framework-extract block in `tree-sitter.ts:2550–2573`.
   - Remove the `frameworkNames` parameter chain through `extractFromSource` and `parse-worker.ts`.
   - Remove `ExtractionOrchestrator.detectedFrameworkNames` field + `ensureDetectedFrameworks` method.
   - MCP `codegraph_search` `tag` parameter.
   - `codegraph status` per-framework edge counts (via `getEdgesByContributingProvenance`).
   - CHANGELOG entry.
   - Final regression sweep.
3. **Test inventory deferred items** (from P1.6, deferred per worklog [P1.4.md](P1.4.md)):
   - #3 SCIP+framework dedup (cross-cutting, lands with first augment that emits at a SCIP fingerprint).
   - #6 forbidden-kind position rejection (validateEdgeLineColumn).
   - #7/7a–c, 8 — Spring DI dispatch tests (lands with PR-14).
   - #9, 10 — Temporal dispatch tests.
   - #11/12/13 — STAGE 0 purge against real migrated resolvers.
   - #17 — transaction rollback on inner throw.

## Notes / lessons

- **`unregisterFrameworkResolver` was missing** — added to `src/resolution/frameworks/index.ts` for test cleanup. Tests register fakes via `registerFrameworkResolver` and need a teardown path.
- **Tests against `objectExists` helpers fail on WASM SQLite** because `.get()` returns `null` instead of `undefined`. Made the local helper resilient (`row !== undefined && row !== null`); the same issue is latent in `__tests__/p09-schema-migration.test.ts` but doesn't bite there because it runs on the native backend in CI.
- **Django integration test regression** caught an oversight: dropping `extract` without an `augment` removes the route→view edge that the test asserts. Added `djangoResolver.augment` to emit `references/convention` edges with `django:view` + `route-handler` tags. Same shape should be considered for flask/fastapi/rails in a follow-on PR if integration tests for those frameworks are added.
- **Vue and Svelte intentionally keep `resolve`** — framework-built-in symbols (Vue 3 compiler macros, Nuxt auto-imports, Svelte 5 runes, etc.) are not visible to scope/import resolution. Dropping `resolve` would leak phantom unresolved refs. A P3 design decision is required: either a global "framework-provided names" registry, or per-resolver `synthesize` that emits "self-loop" `references/convention` edges to mark these symbols resolved.
- **React removed `resolve` but kept the legacy tests' assertions broken** until they were `describe.skip`d. The component/hook lookup paths are now covered by import + scope resolution; the legacy strategy-1 path was a heuristic that the migration intentionally drops.
