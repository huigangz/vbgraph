# P0 Review — Round 2 (post-implementation) — Work Log

**Status:** Done — all 5 findings resolved.
**Date:** 2026-05-21

A close review of the **implemented** P0 SCIP path (round 1 reviewed the spec;
this round reviews the code) surfaced 5 findings — 1 High, 2 Medium, 1
Low/Medium, 1 Low. All fixed in one pass.

## F1 (High) — `codegraph index --force` could leave SCIP-covered files unindexed

**Finding:** the CLI's `--force` path calls `cg.clear()`, but
`QueryBuilder.clear()` only deleted `unresolved_refs` / `edges` / `nodes` /
`files` — it left `scip_documents` and `scip_ingestions`. `runScipPrePass` then
reads `scip_documents` to build the SCIP-covered set the tree-sitter pass
skips. After a forced Tier-0 reindex following a prior SCIP run, the stale
`scip_documents` rows made the tree-sitter pass skip those files even though
their nodes had just been deleted — silently un-indexing them.

**Fix:** `clear()` now also wipes `scip_external_refs`, `scip_documents`, and
`scip_ingestions` inside the same transaction — coverage bookkeeping that
describes data which no longer exists. (`src/db/queries.ts`.)

**Regression test:** `p06-dual-backend.test.ts` — "a forced reindex re-indexes
a file a prior SCIP run covered": index with `--scip`, `clear()`, plain
`indexAll()`, assert the file is re-indexed via tree-sitter.

## F2 (Medium) — empty-document fallback was not wired through public indexing

**Finding:** `persistScipIndex` supports `extractFallback` (P0.4c — tree-sitter
a file whose SCIP document has zero occurrences, e.g. an isolated build error),
but `runScipPrePass` called `ingestScipFile` without it. `maybeEmptyFallback`
no-ops without a fallback, so a real `codegraph index --scip` with an empty
over-threshold document still marked the file SCIP-covered and the tree-sitter
pass skipped it — the file ended up with no graph at all.

**Fix:** `runScipPrePass` now collects the languages of every covered document
during the pre-scan, loads their grammars (`initGrammars` +
`loadGrammarsForLanguages`) before ingest, and passes an `extractFallback` that
reads the file and runs `extractFromSource`, plus the configured
`emptyFallbackThresholdBytes`. The persister's `maybeEmptyFallback` was also
corrected to hand the fallback a genuine **absolute** path (it previously
passed the relative path twice). (`src/index.ts`, `src/extraction/scip/persister.ts`.)

**Regression test:** `p06-dual-backend.test.ts` — "tree-sitters an empty SCIP
document through codegraph index --scip": asserts the file gets nodes with
`provenance='tree-sitter (scip-empty-fallback)'`.

## F3 (Medium) — auto-spawn could ingest a stale cached `.scip`

**Finding:** `runScipAutoSpawn` writes each indexer to a **deterministic** cache
path (`.codegraph/scip-cache/<indexer>.scip`) and never cleared it before
spawning. `spawnIndexer` treats exit-0 + `existsSync(outputPath)` as success —
so an indexer that exits 0 without writing output would leave the previous
run's `.scip` in place and CodeGraph would ingest the stale artifact.

**Fix:** `runScipAutoSpawn` deletes any pre-existing `outputPath`
(`fs.rmSync(..., { force: true })`) immediately before spawning. An indexer
that writes nothing now correctly fails the `existsSync` check.
(`src/extraction/scip/auto-spawn.ts`.)

**Regression test:** `p06-dual-backend.test.ts` — "ignores a stale cached
.scip when the indexer writes no output": pre-places a stale `.scip` at the
cache path, runs a fake indexer that exits 0 without writing, asserts the run
records a failure rather than ingesting the stale file.

## F4 (Low/Medium) — partial explicit+auto overlap was silently skipped

**Finding:** when an `--scip-auto` artifact overlapped an explicit `--scip`
path, `runScipPrePass` stopped scanning on the first overlapping document and
skipped the **entire** auto artifact. If the auto artifact also covered files
the explicit path did *not*, those non-overlapping files were silently
downgraded to tree-sitter. The spec says partial overlap should error.

**Fix:** the auto pre-scan now counts overlapping vs non-overlapping documents
across the whole artifact. Both present → throw (fatal, with a message naming
the counts and telling the user to disjoin the coverage). Only overlap → skip
(explicit-over-auto precedence, as before). No overlap → ingest.
(`src/index.ts`.)

**Test:** no dedicated regression test — exercising it end-to-end needs an
auto-spawn injection seam (`runScipPrePass` calls `runScipAutoSpawn` without a
`detected` override, and the only auto-path source is a real spawn). The fix is
a small counting guard, `tsc`-checked; noted here rather than scaffolded.

## F5 (Low) — generated `.codegraph/.gitignore` did not cover `scip-cache/`

**Finding:** auto-spawn writes `.scip` artifacts to `.codegraph/scip-cache/`,
but the generated ignore file only listed `cache/` — users could accidentally
commit large local `.scip` files.

**Fix:** the generated `.gitignore` template now lists `scip-cache/`.
(`src/directory.ts`.) Note: the file is written once at init, so pre-existing
`.codegraph/.gitignore` files are not retroactively updated — only new
projects. `*.log` already covers the `logs/` artifacts.

## Round 2.1 — follow-up (a second pass caught two incomplete round-2 fixes)

The "fixes introduce ripple" pattern again: F2 and F5 were each fixed only
halfway.

### F2.1 (Medium) — the fallback still dropped `unresolvedReferences`

**Finding:** F2 wired `extractFallback` through, but it returned only
`{ nodes, edges }`. Tree-sitter call / import / type references flow through
`unresolvedReferences` → the resolver pass; the fallback dropped them, so an
empty-document file got symbols + containment but lost its file-local calls —
not equivalent to a normal tree-sitter file. The F2 regression test only
checked nodes, hiding the gap.

**Fix:**
- `EmptyDocumentFallback` now returns `unresolvedReferences` too;
  `maybeEmptyFallback` persists them via `qb.insertUnresolvedRef` (single-row,
  to avoid a nested transaction inside STAGE E); `runScipPrePass`'s
  `extractFallback` passes `extracted.unresolvedReferences` through.
- **Also surfaced**: `indexAll` gated the resolver pass on
  `result.filesIndexed > 0`. The empty-document fallback inserts unresolved
  refs during `runScipPrePass`, so when *every* file is SCIP-covered the
  tree-sitter pass indexes zero files and the resolver was skipped — the
  fallback's refs never resolved. The gate is now `unresolvedCount > 0`
  (a cheap `COUNT(*)`), which runs exactly when there is work.

**Regression test:** the F2 test in `p06-dual-backend.test.ts` was
strengthened — the fallback file now contains a file-local call (`Alpha`
calls `Beta`) and the test asserts the resolved `calls` edge exists, not just
the nodes.

### F2.2 (Medium) — fallback refs were persisted without language context

**Finding:** F2.1 inserted the fallback refs raw. Extraction omits `filePath` /
`language` on most refs — `ExtractionOrchestrator.storeExtractionResult`
back-fills them before persistence (`ref.language ?? language`), but the
fallback path bypassed that. `QueryBuilder.insertUnresolvedRef` stores a
missing language as `'unknown'`, and the resolver back-fills the language only
when it is *falsy* — `'unknown'` is truthy, so it survived and silently
disabled language-sensitive resolution (scope resolution, built-in filters).
The strengthened F2.1 test missed it because the name-matcher still resolved
the call by name regardless of language.

**Fix:** `maybeEmptyFallback` now enriches each ref before insert, mirroring
`storeExtractionResult` — `filePath: ref.filePath ?? doc.relativePath`,
`language: ref.language ?? languageForPath(doc.relativePath)`.
(`src/extraction/scip/persister.ts`.)

**Regression test:** `scip-ingester.test.ts` — "enriches fallback unresolved
refs with the document path and language": a fallback ref with no `filePath` /
`language` is asserted to persist in `unresolved_refs` as `src/Empty.cs` /
`csharp`, not `''` / `'unknown'`.

### F5.1 (Low) — the `.gitignore` auto-repair template still omitted `scip-cache/`

**Finding:** F5 updated the template in `createDirectory`, but
`validateDirectory`'s auto-repair path had its *own* inline one-line template
that still omitted `scip-cache/`. A project whose `.codegraph/.gitignore` went
missing and got repaired would still leave `.scip` artifacts unignored.

**Fix:** both paths now write a single module-level `CODEGRAPH_GITIGNORE`
constant — the duplication that allowed the drift is gone. (`src/directory.ts`.)

## Verification

- `npx tsc --noEmit` — clean; `npm run build` — clean.
- SCIP + parity + sync suites green (`scip-ingester`, `p04b`, `p04c`, `p05`,
  `p06`, `p00`, `p08`, `p09`, `p05b`, `sync`); `p06` carries 3 new regression
  tests (now 10), `scip-ingester` 1 more. `extraction.test.ts` 185 passed.
- `foundation.test.ts` 30/31 and the two `resolution.test.ts` "kind bias" cases
  are pre-existing, unrelated failures (WASM-backend `VACUUM`; a `matchReference`
  WIP — see `P0.4.md`).
