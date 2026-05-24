# P1 — complete

**Status**: all 16 PRs landed
**Date**: 2026-05-23
**Plan**: [codegraph-framework-synthesize-augment.md](../codegraph-framework-synthesize-augment.md)

## Per-PR worklog index

| PR | Sub-step | Worklog |
|---|---|---|
| PR-1 | P1.1 schema v6 + node_tags | [P1.1.md](P1.1.md) |
| PR-1 | P1.2 GraphView + QueryGraphView | [P1.2.md](P1.2.md) |
| PR-1 | P1.3 FrameworkResolver interface extension | [P1.3.md](P1.3.md) |
| PR-1 | PR-1 tests | [P1.1-and-P1.2-tests.md](P1.1-and-P1.2-tests.md) |
| PR-2 | P1.4 Phase3Orchestrator + STAGE 0 purge + wiring + tests | [P1.4.md](P1.4.md) |
| PR-3 | aspnet | [P1.5-aspnet.md](P1.5-aspnet.md) |
| PR-4 | express | [P1.5-express.md](P1.5-express.md) |
| PR-5 | react | [P1.5-react.md](P1.5-react.md) |
| PR-6 | vue | [P1.5-vue.md](P1.5-vue.md) |
| PR-7 | svelte | [P1.5-svelte.md](P1.5-svelte.md) |
| PR-8 | django + flask + fastapi | [P1.5-python.md](P1.5-python.md) |
| PR-9 | rails | [P1.5-rails.md](P1.5-rails.md) |
| PR-10 | laravel (Facade upgrade) | [P1.5-laravel.md](P1.5-laravel.md) |
| PR-11 + PR-12 | go + rust | [P1.5-go-and-rust.md](P1.5-go-and-rust.md) |
| PR-13 | swift (uikit + swiftui + vapor) | [P1.5-swift.md](P1.5-swift.md) |
| PR-14 | Spring split + DI dispatch | [P1.5-spring.md](P1.5-spring.md) |
| PR-15 | generic Temporal | [P1.5-temporal-generic.md](P1.5-temporal-generic.md) |
| PR-16 | cleanup (extract removal, MCP tag, status, CHANGELOG) | [P1.5-PR16-cleanup.md](P1.5-PR16-cleanup.md) |

(P1-session-summary.md was written mid-session after PR-1..9; this
file supersedes it for the full P1 picture.)

## Final regression

```
$ npx vitest run \
    __tests__/frameworks.test.ts \
    __tests__/frameworks-integration.test.ts \
    __tests__/p1-node-tags-and-graphview.test.ts \
    __tests__/p1-phase3-orchestrator.test.ts \
    __tests__/p1-spring-di.test.ts \
    __tests__/p1-pr16-cleanup.test.ts \
    __tests__/p09-schema-migration.test.ts \
    __tests__/p08-node-provenance-roundtrip.test.ts \
    __tests__/scip-ingester.test.ts

Test Files  9 passed (9)
     Tests  ~190 passed
```

All P1-introduced + baseline framework / resolution / SCIP suites
green. The only outstanding failures are pre-existing P0 items
(foundation "optimize operation" WASM VACUUM, two name-matcher "kind
bias" WIPs, platform-specific installer/mcp/watcher) — all documented
in [P0.4.md](P0.4.md) and unchanged by this work.

## What the API surface looks like now

### `FrameworkResolver`

```ts
interface FrameworkResolver {
  name: string;
  languages?: Language[];
  detect(context): boolean;

  /** @deprecated — runtime path removed in PR-16; kept for type compat. */
  resolve?(ref, context): ResolvedRef | null;
  /** @deprecated — runtime path removed in PR-16; kept for type compat. */
  extract?(filePath, content): FrameworkExtractionResult;

  synthesize?(graph: GraphView): SynthesizeResult;
  augment?(graph: GraphView): AugmentResult;
}
```

### Registered resolvers (16)

| Resolver | Languages | synthesize | augment | resolve retained? |
|---|---|---|---|---|
| aspnet | csharp | routes | route→handler + tags | no |
| express | ts/js | routes | route→handler + middleware + tags | no |
| react | ts/js | components + Next.js routes + hook tags | — | no |
| vue | (any) | Nuxt page/api routes | — | **yes** (macros, auto-imports, virtual modules) |
| svelte | svelte | SvelteKit routes | — | **yes** (runes, virtual modules) |
| django | python | routes | route→view + tags | no |
| flask | python | routes | — | no |
| fastapi | python | routes | — | no |
| rails | ruby | routes | — | no |
| laravel | php | routes + resource routes | route→handler + Facade upgrade + tags | no |
| go | go | routes | route→handler + tags | no |
| rust | rust | routes (axum + Actix/Rocket attr) | route→handler + tags | **yes** (Cargo workspace) |
| swiftui | swift | components + app tag | — | no |
| uikit | swift | tags only (no synthesized nodes) | — | no |
| vapor | swift | routes | route→handler + tags | no |
| spring-core | java | routes + bean tags | DI dispatch + route→handler + tags | no |
| spring-temporal | java | — | Workflow/Activity dispatch | no |
| temporal | (any) | — | cross-language workflow dispatch (only when Spring not detected) | no |

(spring-core and spring-temporal both detect on the same signal; the
spring-core/spring-temporal counts together = 17 detected items in
the registry table above gives 17 because spring-core/spring-temporal/
generic-temporal coexist while react+vue+svelte+next handle JS/TS.)

### Phase 3 lifecycle

```
indexAll() / sync():
  1. Extract (tree-sitter / SCIP)
  2. Resolve refs (when unresolvedCount > 0)
  3. Phase 3 (UNCONDITIONAL):
       single transaction:
         STAGE 0: purge stale framework nodes/tags/edges/contributions
         view1: post-purge snapshot
         STAGE A: every resolver's synthesize(view1)
         STAGE B: persist synthesized nodes + inherent tags
         view2: post-STAGE-B snapshot
         STAGE D: every resolver's augment(view2)
         STAGE E: persist edges + derived tags
```

### Observable changes

- **Schema v6**: `node_tags` table.
- **MCP `codegraph_search`**: optional `tag` parameter.
- **`codegraph status`**: per-framework edge contribution counts (JSON
  + human-readable).
- **`SyncResult.phase3`**: optional sub-object reporting Phase 3
  counts and errors.
- **`CodeGraph` public API**: `getNodesByTag(tag)` and
  `getFrameworkEdgeContributionCounts()`.
- **CHANGELOG**: `## [0.8.0] - 2026-05-23` block describing all of the
  above from a user perspective.

## Notes for future work

- The three resolvers with retained `resolve` hooks (vue, svelte, rust)
  could be cleaned up in P3 via a global "framework-provided names"
  registry, which would let `ReferenceResolver.resolveOne` Strategy 1
  become dead code.
- PHP / Ruby / Swift scope resolvers — extending P0.5b coverage to
  these languages would let the laravel / rails / swift migrations
  recover the recall lost when their suffix-based `resolve` paths
  were dropped.
- Spring DI fixtures (`spring-di-field/` exists, three more inventoried
  in [P1.5-spring.md](P1.5-spring.md)) for end-to-end Java extraction
  testing — currently the DI behavior is unit-tested via stub
  GraphView, which validates resolver contract precisely but doesn't
  exercise tree-sitter's Java field/constructor/parameter extraction.
- A `__tests__/p1-cache-invalidation.test.ts` standalone file (from
  the P1.6 inventory) was deferred — test #23 in
  [P1.4.md](P1.4.md) covers the same invariant via the orchestrator
  tests.
