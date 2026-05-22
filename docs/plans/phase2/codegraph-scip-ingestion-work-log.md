# CodeGraph SCIP Ingestion — Work Log

> Chronicle of the conversation that took an existing 11-iteration SCIP ingestion plan, applied a comparative review against two friendly projects (GitNexus, code-review-graph), did a product-layering correction (Tier 0/1/2), ran three more close-reading review rounds, and produced a version-trace-free execution spec at [codegraph-scip-ingestion.md](codegraph-scip-ingestion.md).
>
> This log is forward-looking: it documents *how* the spec reached its current state so that future readers can understand the reasoning behind specific decisions and reuse the review pattern. It does not aim to repeat content that is already in the spec itself.

## Artifacts produced (final inventory)

| File | Location | Role |
|---|---|---|
| `codegraph-scip-ingestion.md` | `c:\Users\zuohg\repo\codeBaseAnalystPlan\` | **The execution source of truth.** Forward spec, no version trace. |
| `graceful-wibbling-shannon.md` | `C:\Users\zuohg\.claude\plans\` | Comparative analysis vs GitNexus / code-review-graph + ranked borrow backlog + v12 patch proposals. Reference for future P3+ work. |
| `codegraph-scip-ingestion-final-plan.md` | `C:\Users\zuohg\.claude\plans\` | The historical v11 → v12 → v12.1 plan with version annotations and the inline patch log appendix. Kept for archaeology; not for execution. |
| `codegraph-scip-ingestion-discussion-log.md` | `C:\Users\zuohg\.claude\plans\` | Pre-existing v1→v11 iteration log (predates this conversation). |
| `codegraph-scip-ingestion-v13.md` | `C:\Users\zuohg\.claude\plans\` | Empty skeleton for the next iteration when one is needed. |

The **clean spec** (`codegraph-scip-ingestion.md`) is what implementers should follow. The other files are reference / history.

---

## Phase 1 — Initial comparative analysis

**Trigger**: User asked to read the two existing plan files (final-plan, discussion-log) and compare them with the two friendly repos (GitNexus, code-review-graph) to find what's worth borrowing.

**User preferences captured via AskUserQuestion**:
- Deliverable form: analysis report + incremental PR proposals
- Coverage: both repos in parallel, full comparison
- Taste: aggressive — list everything worth borrowing

**Method**:

- Read final-plan.md and discussion-log.md in full to internalize the v11 plan and its 11-round iteration history.
- Launched two parallel `Explore` agents:
  - Agent A: GitNexus deep dive — purpose, extraction stack, storage, query layer, framework resolvers, sync, novel patterns, tests.
  - Agent B: code-review-graph deep dive — same shape but framed around the review-centric tooling angle.
- Spot-verified key claims (file existence, tool counts, line numbers) before trusting agent reports.

**Outcome**: Created [graceful-wibbling-shannon.md](../../.claude/plans/graceful-wibbling-shannon.md) with:

1. Three-way architecture comparison table (~25 dimensions)
2. What v11 plan already covered (avoid re-borrowing)
3. Borrow candidates ranked A / B / C / D (37+ items, ~50 days total if all done)
4. Incremental PR proposals
5. Open questions for the user

This was the "horizontal scan" — what does the ecosystem do that we should learn from.

---

## Phase 2 — Strategic discussions (3 hinge points)

After the analysis landed, three strategic questions emerged. Each had a sharp answer that reshaped the plan.

### Hinge 2.1 — "Would GitNexus or code-review-graph be a better base than CodeGraph?"

**Analysis**: scored across 6 dimensions — language consistency (TS vs Python), DB paradigm (SQLite vs LadybugDB Cypher), schema SCIP-awareness, multi-extractor infrastructure maturity, free-capability inheritance, mission alignment.

**Three scenarios cost-modeled**:
- Switch to GitNexus: gains ~25 days of capability (communities/processes/multi-repo/embeddings) but costs ~14 days of LadybugDB retrofit + losing 11-iteration plan investment.
- Switch to code-review-graph: gains ~11.5 days of capability but costs ~12 days of Python rewrite + node-id model migration + mission mismatch (review-first vs precision-first).
- Stay on CodeGraph: 0 swap cost, capabilities deferred to P3+.

**Decision**: Stay on CodeGraph. Three load-bearing reasons:
1. `edges.provenance` column already exists with `'scip'` in its value union (v7 discussion-log finding) — the schema was *designed* for SCIP. Friend repos require schema retrofit.
2. SCIP's value prop is depth (compiler precision), not breadth. Switching trades depth (11 iterations of careful integration design) for breadth (others' features).
3. LadybugDB / Python are *architecture* mismatches, not feature mismatches. Cannot be patched by adding code.

**Borrow strategy**: borrow capabilities, not the base.

### Hinge 2.2 — "Should scope-resolution come pre-P0, before SCIP?"

**User intuition**: v11's Phase 2 (`import-resolver + name-matcher`, conf=0.6) is weak. Should we replace it with GitNexus-style scope resolution *first*, then layer SCIP on top?

**Counter-argument**: scope-resolution improves tree-sitter paths, but SCIP edges *skip Phase 2 entirely* (they're already pre-resolved by the compiler). So scope-resolution adds zero value to SCIP-covered languages. Its real value is in fallback scenarios: non-SCIP languages, empty-document fallback, staleness shadow, build-broken cases — all secondary. Pre-P0 timing would push the primary user-visible win (compiler-grade .NET via scip-dotnet) back by ~10-15 days.

**Decision**: Resolution-Parity becomes **P0.5b** (a P0 subsection after SCIP ingester, before P1 framework refactor), not pre-P0. The borrow target shifts from "the scope resolution algorithm itself" (GitNexus has only 2 languages anyway) to "the parity test methodology" (same edge from either path must come out the same way).

### Hinge 2.3 — "Users won't install heavy SCIP toolchains (e.g., .NET SDK)"

**User intuition**: v11 plan implicitly assumes users have `scip-dotnet`, `scip-java`, etc. installed. Real polyglot repos have partial toolchain coverage. Users running `codegraph index` for the first time expect zero-toolchain operation.

**Trace of the dependency stack for a single language** (.NET):
```
codegraph index --scip → needs .scip file
                      → needs scip-dotnet binary
                      → needs dotnet tool install -g scip-dotnet
                      → needs .NET SDK ~500MB
                      → needs dotnet restore (NuGet network)
                      → needs dotnet build success (project must compile)
```

**Comparison**: GitNexus and code-review-graph ship as `npx` / `uv` packages — one command, zero toolchain.

**Decision**: introduce explicit **Tier 0 / Tier 1 / Tier 2 product layering**:
- Tier 0: tree-sitter only, zero toolchain (default).
- Tier 1: SCIP opt-in via `--scip-auto` (detects installed indexers).
- Tier 2: CI-built `.scip` artifacts (separate epic).

This was the most impactful strategic correction. It reversed v11's "don't build VB.NET tree-sitter extractor" decision: without it, users without .NET SDK would get *no graph* for `.vb` files. The reversal cost ~5 days but made the product positioning honest.

It also led to four new P0 subsections: P0.0 (toolchain detection), P0.4c (build-failure tolerance), P0.6b (VB.NET tree-sitter extractor), and supporting infrastructure.

---

## Phase 3 — v11 → v12 patches applied to final-plan.md

**Trigger**: User said "update the original SCIP final plan" with the Tier 0/1/2 corrections.

**Method**: applied 18 inline edits to the original final-plan.md, tracked via TodoWrite. Key changes:

| Patch | Section | Effect |
|---|---|---|
| Title + abstract | top of file | Add v12 product layering paragraph |
| Context "Original task and pivot" | bullet 1 | Rewrite to frame tree-sitter as Tier 0 fallback, not "not built" |
| Architecture decisions | items 5/6/7 | Add: VB tree-sitter as backstop, toolchain auto-detect, build-failure tolerance |
| Pipeline pseudocode | Phase 0/1/2 | Add Phase 0 detection; note vbnet shadow-capable; insert scope-resolved path |
| GraphProvenance type | type def | Add `'scope-resolved'` + `ConfidenceTier` derived type |
| PR breakdown table | top of file | P0 ~13d → ~21d; P1 ~11d → ~12.5d; add deltas table |
| Ship gates | top of P0 | Split into Tier 0 / Tier 1 / robustness blocks |
| **P0.0** (new) | after ship gates | Toolchain detection, `--scip-auto`, CLI surface, spawn orchestration |
| **P0.4c** (new) | after P0.4b | Build-failure tolerance — 8 failure modes × degradation paths |
| **P0.4d** (new) | after P0.4c | Derived `ConfidenceTier` enum |
| **P0.5b** (new) | after P0.5 | Resolution-Parity scope index + parity harness |
| **P0.6b** (new) | after P0.6 | VB.NET tree-sitter extractor (WASM grammar + language extractor) |
| P0.8 type/config | grammars.ts changes | Add WASM_GRAMMAR_FILES entry; remove vbnet from Exclude |
| P0.10 tests | tests file | Add Tier 0 / P0.0 / P0.4c / P0.5b test files |
| P0 effort total | bottom of P0 | New effort table summing to ~21d |
| P1 resolver list | P1.5 | Spring split into spring-core + spring-temporal + (briefly) spring-kafka |
| Modified files | bottom | Annotate v12 additions |
| CHANGELOG | bottom | Split P0 release into Tier 0 / Tier 1 entries |
| Out of scope | bottom | Add Kafka rationale, Docker bundling rationale |
| Risk register | bottom | Add 5 new v12 risks |

**Mid-stream correction**: user asked "why do we need a Kafka resolver?" The honest answer was that I'd included it because code-review-graph has it, not because it makes sense for a single-repo SCIP plan. Walked it back: Kafka is intrinsically cross-service (producer in one repo, consumer in another), and topic-string matching is the same name-matcher anti-pattern v11 carefully avoided in Phase 2. Removed Kafka from P1.5; added explicit "Why no spring-kafka" rationale; deferred to a future multi-repo epic.

---

## Phase 4 — v12 → v12.1 review pass

**Trigger**: User said "review the plan once more, make sure no blow-up points" (再 review 一遍 plan, 确定没有炸点).

**Method**: applied v11-style close-reading discipline retroactively to the ~600 lines of v12 deltas (which had not gone through the original 11-round iteration).

- Launched a single `Explore` agent with a detailed brief listing v11-style finding examples (column collisions, fake streaming, missed schema bumps, etc.).
- In parallel, did my own targeted re-read of the v12 deltas to catch what the agent might miss.
- Verified the most consequential claims via `Grep` against actual file content (priority list line numbers, CURRENT_SCHEMA_VERSION, etc.).

**16 findings produced**:

| Severity | Count | What they were |
|---|---|---|
| HIGH | 4 | Priority list inconsistency across sections / `pickPrimaryProvenance` implementation never shown / P0.7 CLI section stale (still v11) / VB WASM grammar has no commit pinning |
| MEDIUM | 10 | `which` vs `where` portability / multi-indexer concurrency unspecified / parity fingerprint discards line/col / `provenances[]` semantic ambiguity / no scope-resolved backfill note / migration MIN→MAX rowid / scip-failures.json schema versioning / CI matrix thresholds arbitrary / 5-language selection unjustified / `--scip-auto` + `--scip` collision unaddressed |
| LOW | 2 | Hardcoded SCIP_INDEXERS list / ledger schema version field |

**Action**: applied F1–F14 inline to v12 (F16 collapsed into F11; F15 deferred). Promoted file to v12.1. Added a "v12.1 Patch Pass" appendix documenting the finding-by-finding resolution. Spec quality bar reached v11's "8.8/10".

**Methodology callout**: the review pattern was the discussion-log's v3-v11 pattern compressed: an Explore agent finds findings against the prose, the user verifies by reading actual files, fixes get applied inline rather than triggering another full plan-loop iteration. Diminishing severity is the signal to stop.

---

## Phase 5 — v13 carrier file created

**Trigger**: User asked to create `codegraph-scip-ingestion-v13.md` as the carrier for the next iteration round.

**Method**: wrote an empty skeleton at `~/.claude/plans/codegraph-scip-ingestion-v13.md` with:
- Status banner (phase = stub)
- Inputs to read (final-plan, discussion-log, graceful-wibbling-shannon)
- Q1-Q7 open questions inherited from v12 (path A/B/C choice, P1 detail plan, P4 multi-repo, P3 promotion, Docker bundling, ingest_order priority, P0 implementation feedback)
- Empty templates ready for Context / Scope / Detailed design / Modified files / Ship gates / Risk register / Out of scope / CHANGELOG
- Editorial notes (plan-loop discipline, when to end an iteration)
- List of v12 decisions that should not be relitigated without strong trigger

Purpose: when the user wants to plan v13 of something, this file is the carrier and the harness can target it directly (avoiding the awkward dance of plan mode auto-picking a different file).

---

## Phase 6 — Clean spec produced (no version trace)

**Trigger**: User asked for a version-trace-free spec to live alongside the source code at `c:\Users\zuohg\repo\codeBaseAnalystPlan\`.

**Rationale**: the v12.1 plan is invaluable as a record of how each decision was reached, but it's a poor *implementation* artifact. Engineers reading it have to constantly translate "v12 added X" / "v11 said Y but v12 reverses" into "the design is Z". A clean forward spec serves implementers better.

**Method**: rewrote the entire ~1900-line plan as a single forward-looking document. Surgical removals:
- All v11 / v12 / v12.1 version markers (title, abstract, section headers, CHANGELOG)
- "v11 originally said X, v12 reverses" historical narrative
- `(v12 addition)` / `(v12 deliberate exclusion)` / `(v12 deferred)` inline annotations
- "v11 → v12 P0 deltas at a glance" comparison table
- The entire v12.1 Patch Pass appendix
- "F1/F7/F10/F12/F14" internal finding number references
- Source attribution ("borrowed from code-review-graph", "borrowed from GitNexus RFC #909")
- Effort estimate parentheticals (`(was ~13d in v11)`)
- `~~strikethrough~~` entries in Out of scope

What was kept and rephrased: every technical decision, schema definition, code block, ship gate, modified-files entry, risk register entry, CHANGELOG section. The Tier 0 / Tier 1 product layering, the 7 architecture decisions, all P0 subsections, P1 directional outline, P2 detailed design — all preserved.

Result: [codegraph-scip-ingestion.md](codegraph-scip-ingestion.md), ~1180 lines, single forward spec.

---

## Phase 7 — Round 1 close review on the clean spec

**Trigger**: User flagged 6 findings against the clean spec (4 HIGH + 2 MEDIUM).

**Findings and resolutions**:

| # | Severity | Issue | Resolution |
|---|---|---|---|
| F1 | HIGH | External SCIP nodes keyed by `hashSymbol(sym.symbol)` but also "owned" via `scipIndexPath`. Two `.scip` indexes both referencing `System.Console.WriteLine` would collide on `INSERT OR FAIL` or cause shared-node deletion. | Redesigned external nodes as **globally unique** (id = symbol hash, no per-index salt) with many-to-many ownership tracked in a new `scip_external_refs (scip_index_path, external_node_id)` table. Cleanup deletes refs first, then GCs unreferenced nodes. Edge GC SQL uses `INSERT OR IGNORE` so concurrent ingesters can both contribute. |
| F2 | HIGH | VB extractor maps `constructor_statement` → `constructor` and `event_statement` → `event`, but `NODE_KINDS` in [types.ts:18](../codeGraph/codegraph/src/types.ts#L18) does not contain those two values. Literal implementation fails TypeScript. | Added explicit P0.8 directive to extend `NODE_KINDS` with `'constructor'` and `'event'`. Noted that `npm run build` will surface any exhaustive-switch sites. |
| F3 | HIGH | Plan commits `src/extraction/wasm/vbnet.wasm` but the existing loader at [grammars.ts:129](../codeGraph/codegraph/src/extraction/grammars.ts#L129) hard-codes `lang === 'pascal' \|\| lang === 'scala'` for self-hosted WASM. Without updating that check, `loadGrammarsForLanguages(['vbnet'])` falls through to `require.resolve('tree-sitter-wasms/out/vbnet.wasm')` and silently fails. | Added explicit "Self-hosted WASM loader update" subsection requiring a `SELF_HOSTED_WASM_LANGUAGES` Set refactor that includes `'vbnet'`. Wired into the integrity test. |
| F4 | HIGH | P2 stale-mark SQL writes `UPDATE edges SET stale=1 WHERE file_path=?`, but `edges` table in [schema.sql:44](../codeGraph/codegraph/src/db/schema.sql#L44) has no `file_path` column (edges are between nodes). | Replaced with node-join SQL: edge is stale when *either* endpoint is in the changed file. Added "Schema reality and the stale-edge policy" subsection explaining the symmetric endpoint convention. Added asymmetric-clearing regression test. |
| M1 | MED | `spring-temporal` was specified as emitting `calls` edges with `subkind='temporal_dispatch'` AND registering that subkind in `REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION`. But the allowlist only governs `references` subkinds — `calls` already requires line/col by the three-tier invariant. The validator would reject. | Clarified that `WorkflowStub.start()` is a real source-code invocation with available line/col, so `calls` is correct AND line/col is required. Removed the spurious allowlist registration. |
| M2 | MED | Ship gate 12 said "every corrupted/OOM `.scip` case degrades to tree-sitter", but P0.4c said explicit `--scip <path>` corruption is fatal. The two contradicted each other. | Split ship gate 12 into 12 (auto-mode degrades, exit 0) and 12a (explicit `--scip <bad-path>` exits non-zero with DB unchanged). Added matching test in `p04c-failure-tolerance.test.ts`. |

All 6 applied in a single pass.

---

## Phase 8 — Round 2 close review on the clean spec

**Trigger**: User flagged 2 more findings — both subtle execution-time bugs introduced by the Round 1 fixes themselves.

**Findings and resolutions**:

| # | Severity | Issue | Resolution |
|---|---|---|---|
| F-1 | HIGH | The external-node GC SQL written in Round 1 contained a short-circuit bug. `(source IN externals OR target IN externals) AND (source NOT IN refs OR target NOT IN refs)` matches `Foo (internal) → System.String (still-referenced external)` and deletes the edge — because `source NOT IN refs` is trivially true for an internal node. | Rewrote SQL to per-endpoint orphan test: delete edges whose *specific* endpoint is an external node with zero remaining refs. Used subqueries directly on `WHERE provenance = 'scip:external' AND id NOT IN (SELECT external_node_id FROM scip_external_refs)`. Added a regression test fixture documenting the `Foo (internal) → System.String (still-ref'd external)` survival case. |
| F-2 | HIGH | P2 sync marks SCIP rows `stale=1, staleness_visible=0`, then runs tree-sitter shadow which calls `upsertGraphEdge`. The upsert finds the stale row at the same fingerprint, merges provenances, but **never clears the stale flag**. The fresh shadow data inherits `stale=1` and remains hidden by the default query filter. | Added unconditional `SET stale=0, staleness_visible=0` to the UPDATE branch of `upsertGraphEdge`. Documented as the "freshness invariant": `upsertGraphEdge` is the only path for fresh contributions; by definition any caller is delivering currently-true data. Added P2.6 regression test that pre-seeds a stale row and asserts post-upsert visibility. |

**Schema lifecycle question raised by F-2**: writing `SET stale=0` requires the `stale` column to exist when `upsertGraphEdge` runs. But the original plan added the column in P2.1, not P0. Resolved by moving column creation to P0 schema (`DEFAULT 0`, unused at P0) while keeping the partial indexes + sync wiring in P2. This avoids version-conditional SQL in `upsertGraphEdge`.

---

## Phase 9 — Round 3 wording / checklist consistency

**Trigger**: User flagged 2 last findings — both self-inflicted inconsistencies from the previous rounds' fixes.

| # | Severity | Issue | Resolution |
|---|---|---|---|
| MEDIUM | Modified-files checklist | P2 entry still said "Edit schema.sql + migrations.ts — `stale`, `staleness_visible`, CURRENT_SCHEMA_VERSION = 7", but Round 2's F-2 fix moved those columns to P0. Implementer following the P0 checklist verbatim would have `upsertGraphEdge` referencing columns that don't exist until P2. | Updated P0 modified-files entry to enumerate the reserved stale columns + `scip_external_refs` table. Updated P2 entry to say "partial indexes only — columns added in P0, don't re-add them here". |
| LOW | Schema comment | `nodes.scip_index_path` comment still read "incl. external nodes", but Round 2's F1 fix moved external nodes to `scip_external_refs` (no per-node `scip_index_path` field for externals). | Updated comment: "internal-symbol nodes only; NULL for external (their ownership is in scip_external_refs)". |

Both fixed in a single small pass. User verdict: "No blocking findings. Ready as the future execution source of truth."

---

## Meta-observations from the review arc

### Pattern: each review round found real, smaller issues

| Round | Findings | Severity arc |
|---|---|---|
| v12.1 patch pass (Phase 4) | 16 (4 HIGH + 10 MED + 2 LOW) | Architecture-adjacent and spec-completeness — same flavor as v11's v8-v11 rounds |
| Round 1 on clean spec (Phase 7) | 6 (4 HIGH + 2 MED) | Implementation-detail bugs — column collisions, missing NodeKinds, missing loader wiring |
| Round 2 on clean spec (Phase 8) | 2 (2 HIGH) | Subtle interaction bugs introduced *by* Round 1 fixes |
| Round 3 on clean spec (Phase 9) | 2 (1 MED + 1 LOW) | Self-inflicted checklist/comment inconsistencies from Round 2 |

This matches the v11 discussion log's diminishing-severity pattern. Each round found real issues but smaller than the last. Ending criterion: when findings flip from "implementation will fail" to "wording is slightly stale", another round is no longer the cheapest catcher — implementation + PR review is.

### Pattern: fixes introduce ripple bugs

Round 1's F1 (external node redesign) introduced Round 2's F-1 (GC SQL short-circuit).
Round 2's F-2 (move `stale` columns) introduced Round 3's MED (checklist inconsistency).

This is the cost of inline editing under iteration pressure: each fix touches multiple sections and the ripple is easy to miss. The mitigation is exactly what happened — another close-reading round catches the ripple. The lesson is *not* to slow down each fix; it's to expect at least one more round after any substantial set of inline edits.

### Pattern: borrow capabilities, not bases

The biggest strategic decision (Hinge 2.1) was not to switch base projects despite the friendly repos' larger feature surface. The reasoning was that base-level architecture mismatches (LadybugDB Cypher vs SQLite; Python vs TypeScript) cannot be patched by adding code — they require rewriting load-bearing infrastructure. By contrast, individual capabilities (confidence tiers, diff-aware risk scoring, Leiden communities, scope-resolution parity tests) port cleanly into CodeGraph's architecture.

The implementation discipline that emerged: when borrowing, borrow the *methodology* (e.g., GitNexus's "same edge from any path must come out the same" parity test) not the *algorithm* (GitNexus's specific scope resolution implementation, which only covered 2 languages anyway).

### Pattern: the toolchain-friction blind spot

Hinge 2.3 (Tier 0/1/2 product layering) was a strategic correction that no amount of close-reading review of the v11 plan itself would have produced. It came from a *user question about real-world deployment* (`SCIP needs .NET SDK ~500MB — that's a lot`) — a question outside the plan's frame of reference. v11 was technically rigorous but implicitly assumed users would always have the toolchain. The comparative review against zero-toolchain friend repos (GitNexus, code-review-graph) made the assumption visible.

The lesson is to deliberately stress plans against *deployment friction* questions, not just technical-correctness questions. A plan can be implementation-ready and still ship a product that nobody can actually use.

---

## Final state checklist

- [x] Forward execution spec ready at `codegraph-scip-ingestion.md` (no version trace, all 24 review findings applied across rounds)
- [x] Comparative analysis archived at `graceful-wibbling-shannon.md` (P3+ backlog reference)
- [x] Historical v11→v12.1 plan archived at `codegraph-scip-ingestion-final-plan.md` (with embedded patch log)
- [x] Future-iteration carrier at `codegraph-scip-ingestion-v13.md` (empty skeleton)
- [x] This work log at `codegraph-scip-ingestion-work-log.md`
- [x] **P0 implemented and validated** — sub-phases P0.0–P0.10, per-sub-phase logs under `worklog/` (see Phase 10)

Implementation can begin from `codegraph-scip-ingestion.md`. The other files are for reference if implementers need to trace the *why* behind specific design decisions.

---

## Phase 10 — P0 implementation

The forward spec was executed. Every P0 sub-phase has a detailed work log under
`worklog/P0.*.md`; this section records the arc, not the per-file detail.

**P0.0–P0.9** landed first (worklogs dated 2026-05-20): toolchain detection +
`--scip-auto`, the streaming SCIP decoder, protobuf tooling, the six-stage
persister, crash recovery, build-failure tolerance, ingester orchestration, the
VB.NET tree-sitter extractor + committed WASM grammar, dual-backend dispatch,
the CLI `--scip*` flags, and the schema migration. `P0-review-round-1.md`
records a 6-finding close review of that work, all resolved.

### 2026-05-21 — P0 completion arc

The remaining P0 work was finished once the .NET SDK was installed:

| Item | What landed |
|---|---|
| **P0.10** — VB.NET validation fixture | `__tests__/fixtures/vbnet-sample/` — a `.vbproj` + three `.vb` files exercising every required VB construct, plus a committed `index.scip` from a real `scip-dotnet` run so the SCIP path is tested without a .NET SDK. End-to-end ingestion tests + a fixture parity test added. |
| **P0.4 persister fix** (surfaced by P0.10) | Ingesting *real* `scip-dotnet` output exposed that containment + call-site enclosure relied on body-spanning definition ranges, which `scip-dotnet` 0.2.14 does not emit (name-token-only ranges) — the graph came out flat (file-contains-everything, every call sourced from the file node). Fixed: containment derived from the SCIP **symbol descriptor path**; call-site enclosure gained a nearest-preceding-scope fallback; method `isImplementation` relationships emit `overrides` instead of a malformed `extends`. |
| **P0.5b** — scope-resolution pipeline integration | The scope-resolved pass is wired into `codegraph index` as a strategy inside `ReferenceResolver.resolveOne` — it resolves a bare name against the use site's class then file scope, gated to the SCIP-priority languages, tagged `provenance='scope-resolved'`. |
| **P0.5b / P0.7** — `codegraph parity` | `runParity` runner + the `codegraph parity --fixture` CLI subcommand. The harness moved from `__tests__/parity/` to `src/parity.ts` so the CLI (in `src/`) can drive it. |
| **P0.6b** — Structure / Enum | `extractStruct` now uses the `resolveBody` fallback (mirroring `extractEnum`), so VB `Structure` / `Enum` extract on Tier 0. `Inherits` / `Implements` stay Tier-1 (SCIP) only — the community grammar misparses them irrecoverably. |
| **P0.7** — CLI Tier-0 hint | Verified end-to-end: `codegraph index` on a non-SCIP project prints the "install scip-* for compiler-grade" note (ship gate 3). The wiring was completed earlier in `P0-review-round-1`; the deferred note was stale. |

Two honest limitations were recorded rather than papered over:

- `scip-dotnet` 0.2.14 emits `SymbolInformation.kind = 0` for every symbol, so VB `Module` / `Interface` both surface as `class` and `Property` as `variable`. A newer indexer fixes this with no CodeGraph change.
- The 500 MB ingester memory benchmark stays deferred: the WASM SQLite fallback holds the whole DB in linear memory, so a fixed RSS budget measures the backend, not the ingester. The streaming *decoder* guarantee is proven separately by `p01-streaming-decoder.test.ts`.

**Pattern repeated from the review arc**: P0.10's job was validation, and it did
it — running the real indexer surfaced the P0.4 persister defect that synthetic
fixtures had masked. The fix was authorized and applied in the same arc. This is
the "each round finds real, smaller issues" pattern (above) carried into
implementation: a synthetic fixture proves the code runs; only a real artifact
proves it is correct.

**P0 status: complete** — all sub-phases (P0.0–P0.10) plus their follow-ups are
delivered. Remaining work is P1 (framework synthesize/augment refactor) and P2
(stale-aware sync).

---

## Open items deferred to future iterations

These are tracked in `codegraph-scip-ingestion-v13.md` (Q1–Q7) and / or `graceful-wibbling-shannon.md` (P3+ backlog), not in the execution spec:

- P1 detailed PR plan (interface-level spec for GraphView API, synthesize/augment data contracts, node_tags semantics)
- P4 multi-repo Contract Bridge epic (independent, ~10d)
- `codegraph_detect_changes` MCP tool (post-P0, when PR review use case priority)
- Architecture-drift snapshots
- Token budget / `detail_level` parameter for MCP tools
- Execution flow detection + criticality scoring (Flows)
- Leiden community detection
- Vector search + RRF hybrid search
- `shape_check` API consistency detection
- Custom / community SCIP indexer extension point (`customScipIndexers` config)
- `--scip-docker` toolchain bundling escape hatch
- Same-repo multi-`.scip` priority (`ingest_order`)
- Cross-platform `codegraph schedule install` helper
- Lexical / block scope resolution (P0.5b only covers file + class scope)
- Scope resolution for languages outside the initial 5 (Rust, Go, Ruby, Kotlin, Scala)
- L0 (repo map) / L1 (domain ontology) layers
