# P0 Completion Arc — Session Work Log (partial track)

**Status:** P0 complete. Partial track of the 2026-05-21 session that finished
the remaining P0 work; P1 / P2 not started.
**Date:** 2026-05-21

A consolidated tracker for one session's worth of work. Each item has a
detailed per-sub-phase log — this file is the index + the cross-cutting story.

## What this session did

| # | Item | Detail log | Outcome |
|---|---|---|---|
| 1 | P0.10 — VB.NET validation fixture + `.scip` | `P0.10.md` | Done |
| 2 | P0.4 persister containment fix (surfaced by #1) | `P0.4.md` (follow-up section) | Done |
| 3 | P0.5b — scope-resolution pipeline integration | `P0.5b.md` | Done |
| 4 | `codegraph parity` CLI + `runParity` runner | `P0.5b.md`, `P0.7.md` | Done |
| 5 | P0.6b — VB `Structure` / `Enum` extraction | `P0.6b.md` | Done |
| 6 | P0.7 — CLI Tier-0 hint (verification only) | `P0.7.md` | Already wired; verified |
| 7 | P0 review round 2 — 5 post-implementation findings | `P0-review-round-2.md` | All fixed |

## Narrative

### 1 + 2 — P0.10 fixture, and the persister defect it surfaced

`__tests__/fixtures/vbnet-sample/` was created — a `net8.0` `.vbproj` plus
`Shapes.vb` / `Geometry.vb` / `Catalog.vb` covering Namespace, Module, Class,
Interface, Sub, Function, Property, Imports, Inherits, Implements, Friend,
Shared, Sub New. `scip-dotnet index` was run once against it and the resulting
`index.scip` committed, so the SCIP path is tested without a .NET SDK.

Ingesting that *real* `.scip` exposed a P0.4 defect the synthetic fixtures had
masked: the persister derived containment and call-site enclosure from
positional range nesting, but `scip-dotnet` 0.2.14 emits name-token-only
definition ranges — so the graph came out flat (the file node contained every
symbol; every call edge was sourced from the file node). The user authorised
the fix in the same arc:

- Containment is now derived from the SCIP **symbol descriptor path**
  (`A#foo().` is contained by `A#`), range-independent.
- Call-site enclosure gained a nearest-preceding-scope fallback.
- Method `isImplementation` relationships emit `overrides`, not a malformed
  `extends` between two `method` nodes.

`__tests__/scip-ingester.test.ts` gained 9 real-`.scip` ingestion tests.

### 3 — P0.5b scope-resolution pipeline integration

The scope-resolved pass is wired into `codegraph index` as a strategy inside
`ReferenceResolver.resolveOne` (no separate pass — `indexAll` already calls
`resolveReferencesBatched`). It resolves a bare name against the use site's
class scope then file scope, gated to the SCIP-priority languages, with a
file-scope kind guard so a bare call cannot bind to another class's member.
Edges carry `provenance='scope-resolved'`, `confidence=0.75`.

### 4 — `codegraph parity`

`runParity(fixturePath)` ingests a fixture's `.scip`, tree-sitter-extracts the
same files, and returns a parity report. `codegraph parity --fixture <path>`
prints it. The harness moved `__tests__/parity/parity-harness.ts` →
`src/parity.ts` because the CLI (in `src/`) cannot import from `__tests__/`.

### 5 — P0.6b Structure / Enum

`extractStruct` now uses the `resolveBody` fallback (mirroring `extractEnum`),
so VB `structure_block` — whose members are direct children, not a `body`
field — produces a node. `Structure` / `Enum` extract on Tier 0; the
`tier0-vbnet.test.ts` skip became a passing test. `Inherits` / `Implements`
stay Tier-1 (SCIP) only — the community grammar misparses them irrecoverably.

### 6 — CLI Tier-0 hint

Verified, not built: `printScipUpgradeHints` already calls
`formatUninstalledIndexerHints` after a non-SCIP `codegraph index`. Confirmed
end-to-end on the built binary — ship gate 3 satisfied. The `P0.7.md` "deferred"
note was stale (the wiring landed in `P0-review-round-1`).

## Honest limitations recorded (not papered over)

- `scip-dotnet` 0.2.14 emits `SymbolInformation.kind = 0` for every symbol, so
  VB `Module` / `Interface` surface as `class` and `Property` as `variable`. A
  newer indexer fixes this with no CodeGraph change.
- The 500 MB ingester memory benchmark stays deferred — the WASM SQLite
  fallback holds the whole DB in linear memory, so a fixed RSS budget would
  measure the backend, not the ingester. The streaming decoder guarantee is
  proven separately by `p01-streaming-decoder.test.ts`.

## Verification

- `npx tsc --noEmit` — clean; `npm run build` — clean.
- Phase-2 suites: `scip-ingester` 22, `p05b-parity` 18, `tier0-vbnet` 5 (+1
  skipped), plus the rest of `p0*` / `wasm-integrity` — all green.
- `codegraph parity` and the Tier-0 hint verified on the built binary.
- Pre-existing unrelated failures, untouched by this work: `foundation.test.ts`
  "optimize operation" (WASM-backend `VACUUM`) and two `resolution.test.ts`
  name-matcher "kind bias" cases.

## Not done (next)

- P1 — FrameworkResolver synthesize/augment refactor, GraphView, node_tags.
- P2 — stale-aware sync + language-aware shadow + nightly refresh.
- Optional: a higher-quality VB.NET grammar that parses `Inherits`/`Implements`;
  promote the 500 MB ingester benchmark once the native SQLite backend is live.
