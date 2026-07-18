/**
 * P2.6.2 — Semantic regression tests closing the gaps identified in
 * P2.6.0's audit.
 *
 * Covers the five missing test categories from design-doc § P2.6:
 *   #3  insertNode explicitly writes stale=0, staleness_visible=0
 *   #5  freshness invariant: pre-stale SCIP edge + tree-sitter upsert at
 *       same fingerprint → merged row stale=0, both provenances
 *   #6  stale persistence: pre-stale edge with NO matching upsert → stays
 *       stale=1
 *   #9  explicit getStats vs getStatsIncludingStale contrast
 *   #11 endpoint visibility coherence (Decision 7): hidden target node
 *       hides the edge in default queries
 *   #12 fuzzy search excludes hidden-stale candidate names (round 5
 *       finding 2)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';
import type { Node, Edge } from '../src/types';

let tmpDir: string;
let projectRoot: string;
let conn: DatabaseConnection;
let db: SqliteDatabase;
let qb: QueryBuilder;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p26sem-'));
  projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(path.join(projectRoot, '.vbgraph'), { recursive: true });
  conn = DatabaseConnection.initialize(getDatabasePath(projectRoot));
  db = conn.getDb();
  qb = new QueryBuilder(db);
});

afterEach(() => {
  try { conn.close(); } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<Node> & { id: string }): Node {
  return {
    id: overrides.id,
    kind: 'function',
    name: 'n_' + overrides.id,
    qualifiedName: 'q_' + overrides.id,
    filePath: overrides.filePath ?? `src/${overrides.id}.cs`,
    language: 'csharp',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<Edge> & { source: string; target: string }): Edge {
  return {
    kind: 'calls',
    line: 1,
    column: 0,
    ...overrides,
  };
}

function readRawNode(id: string): { stale: number; staleness_visible: number; provenance: string } | null {
  return (
    db
      .prepare(`SELECT stale, staleness_visible, provenance FROM nodes WHERE id = ?`)
      .get(id) as { stale: number; staleness_visible: number; provenance: string } | undefined
  ) ?? null;
}

function readRawEdge(
  source: string,
  target: string,
): { stale: number; staleness_visible: number; provenance: string; provenances: string | null } | null {
  return (
    db
      .prepare(
        `SELECT stale, staleness_visible, provenance, provenances FROM edges WHERE source = ? AND target = ? LIMIT 1`,
      )
      .get(source, target) as
      | { stale: number; staleness_visible: number; provenance: string; provenances: string | null }
      | undefined
  ) ?? null;
}

// ---------------------------------------------------------------------------
// #3 insertNode explicitly writes stale=0, staleness_visible=0 (P2.1.4)
// ---------------------------------------------------------------------------

describe('P2.6.2 — insertNode freshness invariant', () => {
  it('insertNode writes stale=0 and staleness_visible=0 explicitly', () => {
    qb.insertNode(makeNode({ id: 'fresh' }));
    expect(readRawNode('fresh')).toEqual({
      stale: 0,
      staleness_visible: 0,
      provenance: 'tree-sitter',
    });
  });

  it('INSERT OR REPLACE on a stale row clears the flags', () => {
    qb.insertNode(makeNode({ id: 'n', provenance: 'scip' }));
    qb.markScipFileStale('src/n.cs', 1); // visible-stale
    expect(readRawNode('n')?.stale).toBe(1);

    // Re-insert the same node — should clear stale.
    qb.insertNode(makeNode({ id: 'n', provenance: 'scip' }));
    expect(readRawNode('n')).toEqual({
      stale: 0,
      staleness_visible: 0,
      provenance: 'scip',
    });
  });
});

// ---------------------------------------------------------------------------
// #5 Freshness invariant on shared-fingerprint edges (P0.4 / design § "How
//    shadow extraction clears stale")
// ---------------------------------------------------------------------------

describe('P2.6.2 — edge freshness invariant on shared fingerprints', () => {
  it('pre-stale SCIP edge + tree-sitter upsert at same fingerprint → merged stale=0', () => {
    // Setup: source + target nodes, then a SCIP-provenance edge between them.
    qb.insertNode(makeNode({ id: 'A', filePath: 'A.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'B', filePath: 'B.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge({ source: 'A', target: 'B', line: 10, provenance: 'scip' }));

    // Mark stale via the source file (Decision 2 — source-only).
    qb.markScipFileStale('A.cs', 0);
    const beforeUpsert = readRawEdge('A', 'B');
    expect(beforeUpsert?.stale).toBe(1);
    expect(beforeUpsert?.staleness_visible).toBe(0);

    // Now upsert a tree-sitter edge at the SAME fingerprint
    // (source, target, kind, subkind, line, col). upsertGraphEdge MUST
    // reset stale=0 and merge provenances.
    qb.upsertGraphEdge(makeEdge({ source: 'A', target: 'B', line: 10, provenance: 'tree-sitter' }));

    const afterUpsert = readRawEdge('A', 'B');
    expect(afterUpsert?.stale).toBe(0);
    expect(afterUpsert?.staleness_visible).toBe(0);
    // Primary provenance stays 'scip' (higher rank); 'tree-sitter' is in
    // the audit trail provenances[].
    expect(afterUpsert?.provenance).toBe('scip');
    const provList = JSON.parse(afterUpsert?.provenances ?? '[]') as string[];
    expect(provList).toContain('scip');
    expect(provList).toContain('tree-sitter');
  });
});

// ---------------------------------------------------------------------------
// #6 Stale persistence — pre-stale edge, no matching upsert, stays stale
// ---------------------------------------------------------------------------

describe('P2.6.2 — stale persistence when no shadow contributor', () => {
  it('marked-stale edge stays stale=1 without an upsert', () => {
    qb.insertNode(makeNode({ id: 'A', filePath: 'A.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'B', filePath: 'B.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge({ source: 'A', target: 'B', line: 10, provenance: 'scip' }));

    qb.markScipFileStale('A.cs', 0);
    const before = readRawEdge('A', 'B');
    expect(before?.stale).toBe(1);

    // Perform an UNRELATED edge upsert — same source/target but different
    // line (different fingerprint). Should NOT touch the original row.
    qb.upsertGraphEdge(makeEdge({ source: 'A', target: 'B', line: 99, provenance: 'tree-sitter' }));

    // Original (line=10) still stale; the new (line=99) row exists fresh.
    const stillStale = db
      .prepare(`SELECT stale, line FROM edges WHERE source = ? AND target = ?`)
      .all('A', 'B') as Array<{ stale: number; line: number }>;
    const line10 = stillStale.find((r) => r.line === 10);
    const line99 = stillStale.find((r) => r.line === 99);
    expect(line10?.stale).toBe(1);
    expect(line99?.stale).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #9 getStats vs getStatsIncludingStale contrast (P2.1.7 / Decision 5)
// ---------------------------------------------------------------------------

describe('P2.6.2 — getStats vs getStatsIncludingStale', () => {
  it('hidden-stale rows excluded from getStats but included in getStatsIncludingStale', () => {
    qb.insertNode(makeNode({ id: 'fresh', filePath: 'F.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'hidden', filePath: 'H.cs', provenance: 'scip' }));
    qb.markScipFileStale('H.cs', 0);

    const filtered = qb.getStats();
    const raw = qb.getStatsIncludingStale();

    expect(raw.nodeCount).toBe(2);
    expect(filtered.nodeCount).toBe(1);
    expect(raw.nodeCount - filtered.nodeCount).toBe(1);
  });

  it('visible-stale rows counted in BOTH stats variants (they pass the default filter)', () => {
    qb.insertNode(makeNode({ id: 'v1', filePath: 'V.cs', provenance: 'scip' }));
    qb.markScipFileStale('V.cs', 1);

    expect(qb.getStats().nodeCount).toBe(1);
    expect(qb.getStatsIncludingStale().nodeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #11 Endpoint visibility coherence (Decision 7)
// ---------------------------------------------------------------------------

describe('P2.6.2 — Decision 7 endpoint visibility coherence', () => {
  it('getOutgoingEdges filters edges whose TARGET is hidden-stale', () => {
    qb.insertNode(makeNode({ id: 'src', filePath: 'Src.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt', filePath: 'Tgt.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge({ source: 'src', target: 'tgt', line: 5 }));

    // Before hiding: edge is visible.
    expect(qb.getOutgoingEdges('src').length).toBe(1);

    // Hide the TARGET file. Source-only edge stale (Decision 2) leaves
    // the edge row's own stale=0, but Decision 7 must still hide the edge
    // because its target is hidden.
    qb.markScipFileStale('Tgt.cs', 0);

    const visibleEdges = qb.getOutgoingEdges('src');
    expect(visibleEdges.length).toBe(0); // hidden by Decision 7's visibleNodeIdPredicate
  });

  it('getIncomingEdges filters edges whose SOURCE is hidden-stale', () => {
    qb.insertNode(makeNode({ id: 'src', filePath: 'Src.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt', filePath: 'Tgt.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge({ source: 'src', target: 'tgt', line: 5 }));

    expect(qb.getIncomingEdges('tgt').length).toBe(1);
    qb.markScipFileStale('Src.cs', 0);
    expect(qb.getIncomingEdges('tgt').length).toBe(0);
  });

  it('VISIBLE-stale endpoints do NOT hide the edge (default filter passes them)', () => {
    qb.insertNode(makeNode({ id: 'src', filePath: 'Src.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt', filePath: 'Tgt.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge({ source: 'src', target: 'tgt', line: 5 }));

    // Mark target VISIBLE-stale (1, not 0). Edge stays visible — only
    // hidden-stale endpoints trigger the visibility filter.
    qb.markScipFileStale('Tgt.cs', 1);
    expect(qb.getOutgoingEdges('src').length).toBe(1);
  });

  it('edge with hidden source AND hidden target is filtered', () => {
    qb.insertNode(makeNode({ id: 'src', filePath: 'Src.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'tgt', filePath: 'Tgt.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge({ source: 'src', target: 'tgt', line: 5 }));

    qb.markScipFileStale('Src.cs', 0);
    qb.markScipFileStale('Tgt.cs', 0);
    expect(qb.getOutgoingEdges('src').length).toBe(0);
    expect(qb.getIncomingEdges('tgt').length).toBe(0);
  });

  it('findEdgesBetweenNodes applies the same endpoint visibility filter', () => {
    qb.insertNode(makeNode({ id: 'a', filePath: 'A.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'b', filePath: 'B.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'c', filePath: 'C.cs', provenance: 'scip' }));
    qb.upsertGraphEdge(makeEdge({ source: 'a', target: 'b' }));
    qb.upsertGraphEdge(makeEdge({ source: 'a', target: 'c' }));

    expect(qb.findEdgesBetweenNodes(['a', 'b', 'c']).length).toBe(2);

    qb.markScipFileStale('B.cs', 0);
    expect(qb.findEdgesBetweenNodes(['a', 'b', 'c']).length).toBe(1); // only a→c survives
  });
});

// ---------------------------------------------------------------------------
// #12 Fuzzy search excludes hidden names (round 5 finding 2)
// ---------------------------------------------------------------------------

describe('P2.6.2 — fuzzy search excludes hidden-stale candidate names', () => {
  it('getAllNodeNames omits names from hidden-stale rows', () => {
    qb.insertNode(makeNode({ id: 'v', name: 'visibleName', filePath: 'V.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'h', name: 'hiddenName', filePath: 'H.cs', provenance: 'scip' }));

    expect(qb.getAllNodeNames().sort()).toEqual(['hiddenName', 'visibleName']);

    qb.markScipFileStale('H.cs', 0);
    expect(qb.getAllNodeNames()).toEqual(['visibleName']);
  });

  it('visible-stale names ARE returned (they pass the default filter)', () => {
    qb.insertNode(makeNode({ id: 'v', name: 'visName', filePath: 'V.cs', provenance: 'scip' }));
    qb.markScipFileStale('V.cs', 1); // visible-stale, NOT hidden
    expect(qb.getAllNodeNames()).toEqual(['visName']);
  });
});
