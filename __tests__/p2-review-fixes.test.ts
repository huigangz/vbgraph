/**
 * Review-round regression tests for the 5 findings raised against the
 * P2.6 ship (date: 2026-05-25).
 *
 *   Fix #1  — refreshScip wires extractFallback so empty-doc fallback
 *             rows are RE-created after refresh.
 *   Fix #2  — refreshScip invalidates nodeCache after ingestion.
 *   Fix #3  — refreshScip rebuilds resolution + Phase 3.
 *   Fix #4  — *IncludingDanglingEndpoints siblings + status counter.
 *   Fix #5  — Task Scheduler template is loadable as UTF-8 (validated
 *             via file-content check; live import requires Windows).
 *
 * Driving the full `cg.refreshScip()` flow uses a no-op spawn command
 * (`node -e "process.exit(0)"`) plus a pre-staged `.scip` fixture at
 * the expected `scipOutputPath`. This exercises the real refresh
 * codepath end-to-end WITHOUT requiring a real SCIP indexer in CI.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';
import type { Node, Edge } from '../src/types';
import CodeGraph from '../src/index';
import { writeSyntheticScip } from './helpers/scip-fixtures';
import { detectInstalledScipIndexers } from '../src/extraction/scip';

let tmpDir: string;
let projectRoot: string;

// Detection is cached module-wide; warm once so individual tests don't
// pay the 5s probe cost.
beforeAll(async () => {
  await detectInstalledScipIndexers();
}, 30000);

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p2review-'));
  projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<Node> & { id: string; filePath: string }): Node {
  return {
    id: overrides.id,
    kind: 'function',
    name: 'n_' + overrides.id,
    qualifiedName: 'q_' + overrides.id,
    filePath: overrides.filePath,
    language: 'csharp',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeEdge(source: string, target: string): Edge {
  return { source, target, kind: 'calls', line: 1, column: 0, provenance: 'scip' };
}

// ---------------------------------------------------------------------------
// Fix #4 — *IncludingDanglingEndpoints sibling methods
// ---------------------------------------------------------------------------

describe('Review fix #4 — *IncludingDanglingEndpoints siblings', () => {
  let conn: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    fs.mkdirSync(path.join(projectRoot, '.codegraph'), { recursive: true });
    conn = DatabaseConnection.initialize(getDatabasePath(projectRoot));
    qb = new QueryBuilder(conn.getDb());
  });
  afterEach(() => {
    try { conn.close(); } catch { /* ignore */ }
  });

  it('getOutgoingEdgesIncludingDanglingEndpoints surfaces edges that default API filters', () => {
    qb.insertNode(makeNode({ id: 'src', filePath: 'Src.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt', filePath: 'Tgt.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge('src', 'tgt'));

    // Hide target — default getOutgoingEdges filters the edge out (Decision 7).
    qb.markScipFileStale('Tgt.cs', 0);
    expect(qb.getOutgoingEdges('src').length).toBe(0);

    // Sibling surfaces it.
    expect(qb.getOutgoingEdgesIncludingDanglingEndpoints('src').length).toBe(1);
  });

  it('getIncomingEdgesIncludingDanglingEndpoints surfaces edges hidden ONLY by endpoint visibility', () => {
    // Setup: edge with target's file marked hidden-stale. Source-only
    // edge stale (Decision 2) does NOT mark this edge's row stale — the
    // edge is hidden ONLY by the endpoint visibility filter (Decision 7).
    qb.insertNode(makeNode({ id: 'src', filePath: 'Src.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt', filePath: 'Tgt.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge('src', 'tgt'));

    qb.markScipFileStale('Tgt.cs', 0);  // target hidden, edge row stays fresh
    expect(qb.getIncomingEdges('tgt').length).toBe(0);
    expect(qb.getIncomingEdgesIncludingDanglingEndpoints('tgt').length).toBe(1);
  });

  it('findEdgesBetweenNodesIncludingDanglingEndpoints bypasses visibility filter', () => {
    qb.insertNode(makeNode({ id: 'a', filePath: 'A.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'b', filePath: 'B.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge('a', 'b'));

    qb.markScipFileStale('B.cs', 0);
    expect(qb.findEdgesBetweenNodes(['a', 'b']).length).toBe(0);
    expect(qb.findEdgesBetweenNodesIncludingDanglingEndpoints(['a', 'b']).length).toBe(1);
  });

  it('siblings still respect edge-row freshness (only endpoint visibility bypassed)', () => {
    qb.insertNode(makeNode({ id: 'a', filePath: 'A.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'b', filePath: 'B.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge('a', 'b'));

    // Mark A's file stale-hidden → edge gets stale=1 via source-only
    // marking AND its source becomes hidden. The sibling still respects
    // edge-row stale, so it must return 0.
    qb.markScipFileStale('A.cs', 0);
    expect(qb.getOutgoingEdgesIncludingDanglingEndpoints('a').length).toBe(0);
  });

  it('countDanglingEdgesAgainstHiddenStale counts edges hidden ONLY by endpoint filter', () => {
    qb.insertNode(makeNode({ id: 'src', filePath: 'Src.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt1', filePath: 'T1.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt2', filePath: 'T2.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge('src', 'tgt1'));
    qb.upsertGraphEdge(makeEdge('src', 'tgt2'));

    expect(qb.countDanglingEdgesAgainstHiddenStale()).toBe(0);

    // Hide one target — that edge becomes dangling.
    qb.markScipFileStale('T1.cs', 0);
    expect(qb.countDanglingEdgesAgainstHiddenStale()).toBe(1);

    // Hide both — both dangling.
    qb.markScipFileStale('T2.cs', 0);
    expect(qb.countDanglingEdgesAgainstHiddenStale()).toBe(2);
  });

  it('countDanglingEdgesAgainstHiddenStale excludes edges whose own row is stale', () => {
    qb.insertNode(makeNode({ id: 'a', filePath: 'A.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'b', filePath: 'B.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge('a', 'b'));

    // Marking source A hides both the edge row (source-only) AND the source endpoint.
    // The edge is hidden by ROW stale, not endpoint visibility — should NOT
    // count as "dangling-against-stale" (it's just stale).
    qb.markScipFileStale('A.cs', 0);
    expect(qb.countDanglingEdgesAgainstHiddenStale()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fix #1 — refreshScip wires extractFallback so empty-doc fallback rows
//          are RE-created after refresh.
// Fix #2 — Cache invalidated after ingest.
// Fix #3 — Phase 3 + resolution re-run.
//
// One integration test exercises all three by running cg.refreshScip()
// with a no-op spawn command and a pre-staged .scip fixture.
// ---------------------------------------------------------------------------

describe('Review fixes #1 + #2 + #3 — refreshScip end-to-end with no-op spawn', () => {
  it('recreates fallback rows for empty SCIP docs; invalidates cache; reruns phase3', async () => {
    // Init a project.
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    // Stage 1: pre-populate the DB with an OLD scip-empty-fallback row
    // for a file that will become empty in the refreshed .scip. The
    // STAGE B compatibility pass deletes it via the scip_documents join,
    // so we also need to seed a scip_documents row pointing at the
    // soon-to-be-refreshed index.scip path.
    const scipPathAbs = path.join(projectRoot, 'index.scip');
    {
      const conn = DatabaseConnection.open(getDatabasePath(projectRoot));
      const qb = new QueryBuilder(conn.getDb());
      qb.insertNode(makeNode({
        id: 'old-fb',
        filePath: 'src/Empty.cs',
        provenance: 'tree-sitter (scip-empty-fallback)',
      }));
      // Pre-seed scip_documents for the prior generation so STAGE B's
      // compatibility-pass cleanup actually finds `old-fb` (the cleanup
      // joins on scip_documents WHERE scip_index_path=?).
      conn.getDb().prepare(
        `INSERT OR REPLACE INTO scip_documents
           (source_file_path, scip_index_path, source_hash, ingested_at)
         VALUES (?, ?, '', 0)`,
      ).run('src/Empty.cs', scipPathAbs);
      conn.close();
    }

    // Stage 2: build a real .scip fixture with one empty doc for the
    // same file path. The empty-doc fallback should recreate fallback rows.
    const scipPath = scipPathAbs;
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    // File must exceed emptyFallbackThresholdBytes (default 200) to
    // trigger maybeEmptyFallback.
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPath, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    // Stage 3: open CodeGraph + warm the cache + run refresh with a
    // no-op spawn (just `node -e ""` which exits 0).
    const cg = await CodeGraph.open(projectRoot);
    try {
      // Pre-warm cache for the fallback node about to be wiped + replaced.
      const cached = cg.getNode('old-fb');
      expect(cached).not.toBeNull();

      const result = await cg.refreshScip({
        command: ['node', '-e', '""'],
        scipOutputPath: 'index.scip',
      });

      // Refresh must succeed.
      if (result.phase !== 'ok') {
        // eslint-disable-next-line no-console
        console.error('refresh failed:', result);
      }
      expect(result.phase).toBe('ok');

      // === Fix #1 ===
      // After refresh, the empty-doc fixture file MUST have a FRESH
      // fallback row from maybeEmptyFallback, not the seeded 'old-fb'.
      // The fresh row's id is derived from generateNodeId(filePath, kind,
      // name, line) so it won't equal 'old-fb'. Assert there's AT LEAST
      // one tree-sitter% row for the file that is NOT 'old-fb'.
      const inFile = cg.getNodesInFile('src/Empty.cs');
      const fresh = inFile.filter((n) => n.id !== 'old-fb');
      expect(fresh.length).toBeGreaterThan(0);

      // === Fix #2 ===
      // The cached `old-fb` was deleted by STAGE B's compatibility-pass
      // cleanup (joins through scip_documents). Re-querying MUST return
      // null — if cache wasn't invalidated post-ingest, this would
      // still serve the pre-refresh cached row.
      expect(cg.getNode('old-fb')).toBeNull();

      // === Fix #3 ===
      // Phase 3 ran (no exception) and the result.error is null.
      // Resolution ran too (the empty-doc fallback may have produced
      // unresolved refs that got resolved; we don't assert the exact
      // count, just that the call didn't throw and refresh completed
      // with derivedErrors empty.
      expect(result.error).toBeNull();
    } finally {
      cg.destroy();
    }
  }, 60000); // 60s timeout: this test spawns a real subprocess.
});

// ---------------------------------------------------------------------------
// Review ROUND 2 fix #1 — refreshScip surfaces Phase 3 errors via result.error
//
// Phase3Orchestrator.run() returns recoverable per-resolver errors in
// result.errors rather than throwing. The previous fix only caught
// thrown exceptions, so a Phase 3 failure could exit 'ok' with
// result.error === null. This test plants a synthetic framework
// resolver whose `synthesize()` throws — Phase 3 catches it and writes
// an error entry, refresh must propagate it to result.error.
// ---------------------------------------------------------------------------

describe('Round-2 fix #1 — Phase 3 recoverable errors surface in refresh result.error', () => {
  it('phase stays "ok" but result.error carries the Phase 3 diagnostic', async () => {
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    // Pre-stage a synthetic .scip + project DB just like the fix-#1
    // integration test does.
    const scipPathAbs = path.join(projectRoot, 'index.scip');
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPathAbs, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    // Plant a synthetic framework resolver that always throws in synthesize.
    // Phase3Orchestrator catches the throw and records it in result.errors
    // — exactly the path the round-2 fix #1 must now surface.
    const { registerFrameworkResolver, unregisterFrameworkResolver } = await import(
      '../src/resolution/frameworks'
    );
    const resolverName = 'synthetic-phase3-thrower';
    registerFrameworkResolver({
      name: resolverName,
      detect: () => true,
      synthesize: () => {
        throw new Error('synthetic phase3 failure (round-2 fix #1 test)');
      },
    });

    try {
      const cg = await CodeGraph.open(projectRoot);
      try {
        const result = await cg.refreshScip({
          command: ['node', '-e', '""'],
          scipOutputPath: 'index.scip',
        });

        // Phase stays 'ok' — SCIP data is fresh, only Phase 3 derived
        // state failed (and Phase3Orchestrator's per-resolver isolation
        // captures the throw rather than propagating it).
        expect(result.phase).toBe('ok');

        // result.error MUST be non-null and reference the synthetic
        // resolver's failure. Without the round-2 fix, this would be null.
        expect(result.error).not.toBeNull();
        expect(result.error).toMatch(/phase 3/i);
        expect(result.error).toContain(resolverName);
      } finally {
        cg.destroy();
      }
    } finally {
      unregisterFrameworkResolver(resolverName);
    }
  }, 60000);
});

// ---------------------------------------------------------------------------
// Review ROUND 3 — derived-data warnings reach scheduled-refresh observers
//
// The round-2 fix populated `result.error` but the CLI surfaced it via
// `warn()` which writes to stdout. Schedulers (Task Scheduler XML in
// particular) preserve only the exit code + stderr (when redirected),
// so the warning could still vanish on a `--quiet` scheduled refresh.
//
// Round 3 adds three persistent channels for the warning:
//   (a) stderr — covers launchd StandardErrorPath + systemd journald
//   (b) per-run log file append — covers Task Scheduler (any OS)
//   (c) sidecar `lastError` field — persistent across runs; surfaced
//       by `codegraph status` and `cat .codegraph/scip-last-refresh.json`
// ---------------------------------------------------------------------------

describe('Round-3 — derived-error persistence for scheduled refresh', () => {
  it('refreshScip writes derived errors to the sidecar lastError field and the log file', async () => {
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    const scipPathAbs = path.join(projectRoot, 'index.scip');
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPathAbs, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    const { registerFrameworkResolver, unregisterFrameworkResolver } = await import(
      '../src/resolution/frameworks'
    );
    const resolverName = 'synthetic-round3-thrower';
    registerFrameworkResolver({
      name: resolverName,
      detect: () => true,
      synthesize: () => {
        throw new Error('synthetic phase3 failure (round 3 test)');
      },
    });

    try {
      const cg = await CodeGraph.open(projectRoot);
      let result: import('../src/types').ScipRefreshResult;
      try {
        result = await cg.refreshScip({
          command: ['node', '-e', '""'],
          scipOutputPath: 'index.scip',
        });
      } finally {
        cg.destroy();
      }

      expect(result.phase).toBe('ok');
      expect(result.error).not.toBeNull();

      // === Channel (b): per-run log file append ===
      expect(result.logPath).not.toBeNull();
      const logContents = fs.readFileSync(result.logPath!, 'utf-8');
      expect(logContents).toContain('[codegraph derived-data warning');
      expect(logContents).toContain(resolverName);

      // === Channel (c): sidecar lastError ===
      const sidecarPath = path.join(projectRoot, '.codegraph', 'scip-last-refresh.json');
      expect(fs.existsSync(sidecarPath)).toBe(true);
      const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
      expect(sidecar.lastError).not.toBeNull();
      expect(sidecar.lastError).toContain(resolverName);
    } finally {
      unregisterFrameworkResolver(resolverName);
    }
  }, 60000);

  // Regression — indexer-output ordering vs derived-warning append.
  //
  // Previous code called logStream.end() then immediately did
  // fs.appendFileSync(logPath, '...') without waiting for the stream's
  // underlying fd to flush + close. With a quiet child the race was
  // invisible (zero pending bytes). With a noisy child, the appended
  // warning could land mid-pipe-write or even before tail bytes from the
  // child's stdout, scrambling the log.
  //
  // This test makes the child emit ~256KB of stdout (enough to exceed
  // default fs writeStream buffer + Windows pipe buffer thresholds) and
  // also triggers a derived-data warning. The log file must contain ALL
  // of the child's output BEFORE the derived-warning marker.
  it('refreshScip preserves indexer-output / derived-warning ordering with a noisy child', async () => {
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    const scipPathAbs = path.join(projectRoot, 'index.scip');
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPathAbs, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    const { registerFrameworkResolver, unregisterFrameworkResolver } = await import(
      '../src/resolution/frameworks'
    );
    const resolverName = 'synthetic-noisy-thrower';
    registerFrameworkResolver({
      name: resolverName,
      detect: () => true,
      synthesize: () => {
        throw new Error('synthetic phase3 failure (noisy)');
      },
    });

    // Marker for the head and tail of the child's output so we can locate
    // them in the log and prove they're both present and ordered.
    const HEAD_MARKER = '@@CHILD_OUTPUT_HEAD@@';
    const TAIL_MARKER = '@@CHILD_OUTPUT_TAIL@@';
    // ~256KB of pad bytes — well past any reasonable pipe / stream buffer.
    const childScript =
      `process.stdout.write('${HEAD_MARKER}\\n');` +
      `for (let i = 0; i < 4096; i++) { process.stdout.write('x'.repeat(63) + '\\n'); }` +
      `process.stdout.write('${TAIL_MARKER}\\n');`;

    try {
      const cg = await CodeGraph.open(projectRoot);
      let result: import('../src/types').ScipRefreshResult;
      try {
        result = await cg.refreshScip({
          command: ['node', '-e', childScript],
          scipOutputPath: 'index.scip',
        });
      } finally {
        cg.destroy();
      }

      expect(result.phase).toBe('ok');
      expect(result.error).not.toBeNull();
      expect(result.logPath).not.toBeNull();

      const log = fs.readFileSync(result.logPath!, 'utf-8');
      const headIdx = log.indexOf(HEAD_MARKER);
      const tailIdx = log.indexOf(TAIL_MARKER);
      const warningIdx = log.indexOf('[codegraph derived-data warning');

      // All three markers present.
      expect(headIdx).toBeGreaterThanOrEqual(0);
      expect(tailIdx).toBeGreaterThan(headIdx);
      expect(warningIdx).toBeGreaterThan(tailIdx);

      // No truncation — the full pad payload is between head and tail.
      expect(tailIdx - headIdx).toBeGreaterThan(200 * 1024);
    } finally {
      unregisterFrameworkResolver(resolverName);
    }
  }, 60000);

  it('sidecar lastError is null on a clean refresh', async () => {
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    const scipPathAbs = path.join(projectRoot, 'index.scip');
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPathAbs, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    const cg = await CodeGraph.open(projectRoot);
    let result: import('../src/types').ScipRefreshResult;
    try {
      result = await cg.refreshScip({
        command: ['node', '-e', '""'],
        scipOutputPath: 'index.scip',
      });
    } finally {
      cg.destroy();
    }

    expect(result.phase).toBe('ok');
    expect(result.error).toBeNull();

    const sidecar = JSON.parse(
      fs.readFileSync(path.join(projectRoot, '.codegraph', 'scip-last-refresh.json'), 'utf-8'),
    );
    expect(sidecar.lastError).toBeNull();
  }, 60000);

  it('CodeGraph.getLastScipRefresh exposes lastError (and tolerates legacy sidecars without it)', () => {
    const codegraphDir = path.join(projectRoot, '.codegraph');
    fs.mkdirSync(codegraphDir, { recursive: true });
    // Initialize so CodeGraph.openSync accepts the project.
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    // Write a sidecar WITH lastError.
    fs.writeFileSync(
      path.join(codegraphDir, 'scip-last-refresh.json'),
      JSON.stringify({
        refreshedAt: new Date().toISOString(),
        scipPath: '/x.scip',
        command: 'cmd',
        filesCovered: 0,
        durationMs: 1,
        lastError: 'some phase3 warning',
      }),
    );
    {
      const cg = CodeGraph.openSync(projectRoot);
      try {
        const lr = cg.getLastScipRefresh();
        expect(lr?.lastError).toBe('some phase3 warning');
      } finally {
        cg.close();
      }
    }

    // Legacy sidecar (no lastError field) — must surface as null.
    fs.writeFileSync(
      path.join(codegraphDir, 'scip-last-refresh.json'),
      JSON.stringify({
        refreshedAt: new Date().toISOString(),
        scipPath: '/x.scip',
        command: 'cmd',
        filesCovered: 0,
        durationMs: 1,
      }),
    );
    const cg2 = CodeGraph.openSync(projectRoot);
    try {
      const lr = cg2.getLastScipRefresh();
      expect(lr).not.toBeNull();
      expect(lr?.lastError).toBeNull();
    } finally {
      cg2.close();
    }
  });

  it('CLI source routes derived-error warning to stderr (not stdout)', () => {
    // Source-grep check: the bin/vbgraph.ts scip-refresh handler must
    // use process.stderr.write (NOT warn() which writes to stdout) so
    // schedulers that capture stderr preserve the warning.
    const cliSrc = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'bin', 'vbgraph.ts'),
      'utf-8',
    );
    // The handler must contain BOTH:
    //   (a) the warn-line constant referencing the documented message
    //   (b) process.stderr.write within the same handler block
    expect(cliSrc).toContain('scip-refresh completed with derived-data issues');
    expect(cliSrc).toContain('process.stderr.write');
    // And the warning message MUST NOT be passed to warn() (which writes
    // to stdout — schedulers wouldn't capture it).
    expect(cliSrc).not.toMatch(/warn\([^)]*completed with derived-data issues/);
  });
});

// ---------------------------------------------------------------------------
// Fix #5 — Task Scheduler template encoding declaration matches actual bytes
// ---------------------------------------------------------------------------

describe('Review fix #5 — Task Scheduler template encoding', () => {
  it('declares UTF-8 (matches actual file bytes)', () => {
    const tpl = fs.readFileSync(
      path.join(__dirname, '..', 'docs', 'scheduling', 'task-scheduler.xml.template'),
      'utf-8',
    );
    // The XML declaration line (first line) must say UTF-8. The previous
    // version declared UTF-16 while the file was stored as UTF-8 —
    // schtasks rejected it before users got to the documented conversion
    // step. The comment header CAN (and should) still mention UTF-16 as
    // the optional conversion path for older Windows versions.
    expect(tpl.split('\n')[0]).toContain('encoding="UTF-8"');
    // Header should explain the optional UTF-16 conversion for older
    // schtasks versions that require UTF-16.
    expect(tpl).toContain('UTF-16');
    expect(tpl).toContain('powershell');
  });
});

// ---------------------------------------------------------------------------
// Round-5 fix — log-stream error handler must be attached synchronously
// so a failed log open / mid-stream write doesn't crash the parent.
//
// Previous code only attached an 'error' listener inside the post-spawn
// `await new Promise(... once('error', ...))` block. If the underlying
// fs.createWriteStream failed (EACCES, EROFS, ENOSPC, or a mid-stream
// write error) BEFORE the child closed, the stream emitted 'error' with
// no listener → Node treats it as an unhandled emitter error and exits
// the process. A `--quiet` scheduled refresh would crash silently from
// the scheduler's perspective.
//
// The fix attaches the listener immediately after createWriteStream and
// converts a captured error into a structured 'spawn-failed' result.
// ---------------------------------------------------------------------------

describe('Round-5 — log stream error handling', () => {
  it('refreshScip returns spawn-failed (not a crash) when the log stream errors immediately', async () => {
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    // Stage a synthetic .scip so we'd otherwise reach ingest.
    const scipPathAbs = path.join(projectRoot, 'index.scip');
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPathAbs, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    // Inject a stream that emits 'error' on the very next tick after
    // construction — same observable shape as a real open failure
    // (EACCES on a read-only logs dir, EROFS on a read-only filesystem,
    // EISDIR if the path is a directory). Without the round-5 fix
    // (synchronous on('error') listener attached right after the stream
    // is created), Node would crash the process with an unhandled
    // emitter error before refreshScip's later listener got the chance.
    const { Writable } = await import('stream');
    const cg = await CodeGraph.open(projectRoot);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cg as any).createRefreshLogStream = (_logPath: string) => {
      const s = new Writable({ write(_c, _e, cb) { cb(); } });
      process.nextTick(() => s.emit('error', new Error('synthetic EROFS at open')));
      return s as unknown as fs.WriteStream;
    };

    let result: import('../src/types').ScipRefreshResult;
    try {
      result = await cg.refreshScip({
        command: ['node', '-e', '""'],
        scipOutputPath: 'index.scip',
      });
    } finally {
      cg.destroy();
    }

    // The process did NOT crash — we got here. Result shape is
    // structured and points at the log error.
    expect(result.phase).toBe('spawn-failed');
    expect(result.error).toMatch(/log file unwritable|EROFS|EISDIR|EACCES|illegal operation/i);
    // We never reached ingest, so no SCIP path should be reported.
    expect(result.scipPath).toBeNull();
    expect(result.filesCovered).toBe(0);
  }, 60000);

  // Round-6 — flush-time error path. The round-5 fix caught immediate
  // open failure (createWriteStream's 'open' → 'error' microtask). A
  // separate hazard is a write that succeeds during piping but errors
  // during the final flush — ENOSPC right at fd close, EIO from the
  // device on the trailing buffer drain, or the destination being
  // removed mid-flush. The on('error') listener is still attached at
  // that point so the error gets captured into logStreamError, but
  // without an AFTER-wait re-check, refresh would happily proceed to
  // ingest and return phase: 'ok' with a silently truncated log.
  //
  // refreshScip routes log-stream creation through the private instance
  // method `createRefreshLogStream` precisely so this regression can
  // inject a synthetic flush-failing stream without monkey-patching the
  // OS or the global fs module (both of which fail cross-platform —
  // see the ESM-namespace freeze on `import * as fs`).
  it('refreshScip returns spawn-failed when the log stream errors during final flush', async () => {
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    const scipPathAbs = path.join(projectRoot, 'index.scip');
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPathAbs, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    const { Writable } = await import('stream');

    const cg = await CodeGraph.open(projectRoot);

    // Override the per-run log stream factory on this single instance.
    // The returned Writable accepts every piped write (so the spawn loop
    // runs to completion), then emits 'error' AFTER `.end()` is called,
    // which is exactly the flush-time failure shape (the underlying fd's
    // final drain failing with ENOSPC, EIO, etc.).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cg as any).createRefreshLogStream = (_logPath: string) => {
      const stream = new Writable({
        write(_chunk, _enc, cb) { cb(); },
        final(_cb) {
          // Don't call cb — the stream never finishes cleanly. Defer
          // the error to nextTick so refreshScip's flush-wait listener
          // has time to attach.
          process.nextTick(() => stream.emit('error', new Error('synthetic ENOSPC at flush')));
        },
      });
      return stream as unknown as fs.WriteStream;
    };

    let result: import('../src/types').ScipRefreshResult;
    try {
      result = await cg.refreshScip({
        command: ['node', '-e', '""'],
        scipOutputPath: 'index.scip',
      });
    } finally {
      cg.destroy();
    }

    // Refresh must NOT have proceeded to ingest after the flush error.
    // Without the round-6 fix (post-flush logStreamError re-check),
    // refreshScip would return phase 'ok' here with a silently
    // truncated log file — the failure mode the user reported.
    expect(result.phase).toBe('spawn-failed');
    expect(result.error).toMatch(/flush failed|synthetic ENOSPC/i);
    expect(result.scipPath).toBeNull();
    expect(result.filesCovered).toBe(0);
  }, 60000);

  // Round-7 — noisy-child hang. When logStream errors WHILE the child
  // is still actively writing, Node's pipe() machinery auto-unpipes the
  // source readable. The source then has no consumer; its kernel pipe
  // buffer fills (~64 KB on Linux, ~4 KB on Windows); the child blocks
  // on write; our `await child.close()` never resolves; refresh hangs
  // forever.
  //
  // The fix: logStream.on('error') captures `childRef` and immediately
  // kills the child + resumes its stdout/stderr (so any pipe-buffered
  // bytes drain to a no-op consumer) so the spawn Promise resolves
  // promptly with a non-zero exit.
  //
  // Test strategy: launch a child that writes continuously and DOES NOT
  // exit on its own. The injected log stream errors on its first write.
  // Without the fix, this test hangs until the suite timeout. With the
  // fix, refreshScip returns phase 'spawn-failed' within a few seconds.
  // The tight test-level timeout (10s) is the hang detector.
  it('refreshScip kills the noisy child and does not hang when the log stream errors mid-run', async () => {
    const cgInit = CodeGraph.initSync(projectRoot);
    cgInit.close();

    const scipPathAbs = path.join(projectRoot, 'index.scip');
    const fileRel = 'src/Empty.cs';
    const fileAbs = path.join(projectRoot, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    fs.writeFileSync(fileAbs, 'public class Empty { ' + 'a'.repeat(300) + ' }');
    await writeSyntheticScip(scipPathAbs, {
      metadata: { projectRoot: `file://${projectRoot}` },
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    const { Writable } = await import('stream');
    const cg = await CodeGraph.open(projectRoot);

    // Synthetic stream: errors on the very first write attempt while the
    // child is still producing output. This is the "mid-run" timing — the
    // logStream open succeeded, piping has begun, then the destination
    // dies before the child has finished.
    let firstWrite = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cg as any).createRefreshLogStream = (_logPath: string) => {
      const s = new Writable({
        write(_chunk, _enc, cb) {
          if (firstWrite) {
            firstWrite = false;
            process.nextTick(() => s.emit('error', new Error('synthetic mid-run EIO')));
          }
          cb();
        },
      });
      return s as unknown as fs.WriteStream;
    };

    // Child that emits ~1KB per tick forever — pipes will fill quickly.
    // Listens to SIGTERM/SIGINT and exits cleanly so kill() works
    // promptly on Windows (where signals are translated). Includes a
    // safety upper bound (~30s) so the test doesn't leak orphan
    // processes if something else goes wrong.
    const noisyScript = `
      const i = setInterval(() => {
        process.stdout.write('x'.repeat(1024) + '\\n');
      }, 1);
      process.on('SIGTERM', () => { clearInterval(i); process.exit(1); });
      process.on('SIGINT',  () => { clearInterval(i); process.exit(1); });
      setTimeout(() => { clearInterval(i); process.exit(2); }, 30000);
    `;

    const start = Date.now();
    let result: import('../src/types').ScipRefreshResult;
    try {
      result = await cg.refreshScip({
        command: ['node', '-e', noisyScript],
        scipOutputPath: 'index.scip',
      });
    } finally {
      cg.destroy();
    }
    const elapsedMs = Date.now() - start;

    // Refresh resolved — no hang. (Without the round-7 fix, the
    // child-close listener would never fire and we'd hit the it()
    // timeout before reaching this assertion.)
    expect(result.phase).toBe('spawn-failed');
    expect(result.error).toMatch(/log file unwritable|mid-run EIO/i);

    // Tight upper bound so a regression that re-introduces the hang
    // gets caught even if the it()-level timeout is generous. Kill
    // signal propagation + Node teardown completes in well under a
    // second locally; allow 5s headroom for slower CI environments.
    expect(elapsedMs).toBeLessThan(5000);
  }, 10000);
});
