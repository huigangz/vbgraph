/**
 * P2.2 — Stale-aware sync write helpers + sync rewrite regression.
 *
 * Covers the five round-N findings made load-bearing in the design doc:
 *  1. Cache invalidation runs BEFORE the SQL mutation (round 4 finding 1).
 *  2. Source-only edge stale marking (Decision 2): only edges sourced from
 *     the changed file are marked, not target-side edges.
 *  3. `'tree-sitter (scip-empty-fallback)'` rows are included in the
 *     SCIP-owned predicate (round 4 finding 2).
 *  4. Branch-switch bulk path: > maxStaleFilesPerSync triggers
 *     `bulkMarkScipFilesStale` with visible=1 and skips per-file shadow.
 *  5. Shadow extraction preserves SCIP rows under hidden-stale (Decision 1).
 *
 * All tests use direct QueryBuilder helpers — they do NOT drive the full
 * sync orchestrator. The sync rewrite at extraction/index.ts:1278 is
 * indirectly covered by the existing extraction.test.ts sweep (which
 * continues to pass for non-SCIP-covered files because that path is
 * unchanged).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection } from '../src/db';
import {
  QueryBuilder,
  SCIP_FILE_PROVENANCES,
  freshPredicate,
} from '../src/db/queries';
import type { Node, Edge } from '../src/types';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p22-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openFreshDb(): { conn: DatabaseConnection; qb: QueryBuilder } {
  const conn = DatabaseConnection.initialize(path.join(tmpDir, `p22-${Math.random().toString(36).slice(2)}.db`));
  return { conn, qb: new QueryBuilder(conn.getDb()) };
}

function makeNode(overrides: Partial<Node> & { id: string; filePath: string }): Node {
  return {
    id: overrides.id,
    kind: 'function',
    name: 'fn_' + overrides.id,
    qualifiedName: 'q_' + overrides.id,
    filePath: overrides.filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeEdge(source: string, target: string, overrides: Partial<Edge> = {}): Edge {
  return {
    source,
    target,
    kind: 'calls',
    line: 1,
    column: 0,
    ...overrides,
  };
}

/** Mark `scip_documents` so isFileScipCovered returns true. */
function markFileScipCovered(qb: QueryBuilder, filePath: string, scipIndexPath = 'index.scip'): void {
  // Direct insert — there is no public helper for adding a scip_documents row
  // outside the persister pipeline.
  (qb as unknown as { db: { prepare: (s: string) => { run: (...args: unknown[]) => unknown } } }).db
    .prepare(
      `INSERT OR REPLACE INTO scip_documents (source_file_path, scip_index_path, source_hash, ingested_at)
       VALUES (?, ?, '', 0)`,
    )
    .run(filePath, scipIndexPath);
}

/** Raw read bypassing rowToNode (so we can see raw stale columns). */
function readRawNode(qb: QueryBuilder, id: string): { stale: number; staleness_visible: number } | null {
  const row = (qb as unknown as { db: { prepare: (s: string) => { get: (...args: unknown[]) => unknown } } }).db
    .prepare(`SELECT stale, staleness_visible FROM nodes WHERE id = ?`)
    .get(id) as { stale: number; staleness_visible: number } | undefined;
  return row ?? null;
}

function readRawEdge(qb: QueryBuilder, source: string, target: string): { stale: number; staleness_visible: number } | null {
  const row = (qb as unknown as { db: { prepare: (s: string) => { get: (...args: unknown[]) => unknown } } }).db
    .prepare(`SELECT stale, staleness_visible FROM edges WHERE source = ? AND target = ? LIMIT 1`)
    .get(source, target) as { stale: number; staleness_visible: number } | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Constants smoke
// ---------------------------------------------------------------------------

describe('P2.2 — SCIP_FILE_PROVENANCES export', () => {
  it('includes both scip and the empty-fallback variant', () => {
    expect(SCIP_FILE_PROVENANCES).toContain('scip');
    expect(SCIP_FILE_PROVENANCES).toContain('tree-sitter (scip-empty-fallback)');
    // No other entries — keeps the "SCIP-coverage-for-this-file" semantic narrow.
    expect(SCIP_FILE_PROVENANCES).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// isFileScipCovered
// ---------------------------------------------------------------------------

describe('P2.2 — isFileScipCovered', () => {
  it('returns false for files with no scip_documents row', () => {
    const { qb, conn } = openFreshDb();
    try {
      expect(qb.isFileScipCovered('some/file.ts')).toBe(false);
    } finally {
      conn.close();
    }
  });

  it('returns true after a scip_documents row exists for the file', () => {
    const { qb, conn } = openFreshDb();
    try {
      markFileScipCovered(qb, 'src/Foo.cs');
      expect(qb.isFileScipCovered('src/Foo.cs')).toBe(true);
      expect(qb.isFileScipCovered('src/Bar.cs')).toBe(false);
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// markScipFileStale — node-side
// ---------------------------------------------------------------------------

describe('P2.2 — markScipFileStale: node marking', () => {
  it('marks scip-provenance nodes stale with the given visibility', () => {
    const { qb, conn } = openFreshDb();
    try {
      const file = 'src/Foo.cs';
      qb.insertNode(makeNode({ id: 'n_scip', filePath: file, provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'n_ts', filePath: file, provenance: 'tree-sitter' }));

      const summary = qb.markScipFileStale(file, 0);
      expect(summary.nodesMarked).toBe(1); // only the scip one

      expect(readRawNode(qb, 'n_scip')).toEqual({ stale: 1, staleness_visible: 0 });
      expect(readRawNode(qb, 'n_ts')).toEqual({ stale: 0, staleness_visible: 0 });
    } finally {
      conn.close();
    }
  });

  it('also marks scip-empty-fallback nodes (round 4 finding 2)', () => {
    const { qb, conn } = openFreshDb();
    try {
      const file = 'src/Foo.cs';
      qb.insertNode(makeNode({ id: 'n_scip', filePath: file, provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'n_fallback', filePath: file, provenance: 'tree-sitter (scip-empty-fallback)' }));

      const summary = qb.markScipFileStale(file, 1);
      expect(summary.nodesMarked).toBe(2);

      expect(readRawNode(qb, 'n_scip')).toEqual({ stale: 1, staleness_visible: 1 });
      expect(readRawNode(qb, 'n_fallback')).toEqual({ stale: 1, staleness_visible: 1 });
    } finally {
      conn.close();
    }
  });

  it('does NOT mark nodes in other files', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'n_A', filePath: 'A.cs', provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'n_B', filePath: 'B.cs', provenance: 'scip' }));

      qb.markScipFileStale('A.cs', 0);

      expect(readRawNode(qb, 'n_A')).toEqual({ stale: 1, staleness_visible: 0 });
      expect(readRawNode(qb, 'n_B')).toEqual({ stale: 0, staleness_visible: 0 });
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// markScipFileStale — source-only edge marking (Decision 2)
// ---------------------------------------------------------------------------

describe('P2.2 — markScipFileStale: source-only edge marking', () => {
  it('marks edges sourced FROM the changed file as stale', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'A', filePath: 'A.cs', provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'B', filePath: 'B.cs', provenance: 'scip' }));
      qb.insertEdge(makeEdge('A', 'B', { provenance: 'scip' }));

      qb.markScipFileStale('A.cs', 0);

      // A→B should be marked: source A is in A.cs.
      expect(readRawEdge(qb, 'A', 'B')).toEqual({ stale: 1, staleness_visible: 0 });
    } finally {
      conn.close();
    }
  });

  it('does NOT mark edges TARGETING the changed file from elsewhere', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'A', filePath: 'A.cs', provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'B', filePath: 'B.cs', provenance: 'scip' }));
      qb.insertEdge(makeEdge('B', 'A', { provenance: 'scip' })); // edge INTO A.cs

      qb.markScipFileStale('A.cs', 0);

      // B→A should NOT be marked: source B is in B.cs (unchanged).
      // Target-side visibility is handled by Decision 7's query-layer
      // visibleNodeIdPredicate, not by this stale flag.
      expect(readRawEdge(qb, 'B', 'A')).toEqual({ stale: 0, staleness_visible: 0 });
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// markScipFileStale — cache invalidation BEFORE SQL (round 4 finding 1)
// ---------------------------------------------------------------------------

describe('P2.2 — markScipFileStale: cache invalidation', () => {
  it('hides a cached fresh node after marking it stale (cache flushed)', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'n', filePath: 'F.cs', provenance: 'scip' }));

      // Pre-warm the cache.
      const cached = qb.getNodeById('n');
      expect(cached).not.toBeNull();
      expect(cached?.stale).toBeUndefined();

      // Mark stale with visible=0 (hidden).
      qb.markScipFileStale('F.cs', 0);

      // freshPredicate filter in getNodeById should now return null.
      // If cache were not invalidated, we'd still get the cached fresh row.
      expect(qb.getNodeById('n')).toBeNull();
    } finally {
      conn.close();
    }
  });

  it('returns visible-stale rows with Node.stale = true after visible-stale marking', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'n', filePath: 'F.cs', provenance: 'scip' }));
      qb.getNodeById('n'); // warm cache
      qb.markScipFileStale('F.cs', 1);

      const reread = qb.getNodeById('n');
      expect(reread).not.toBeNull();
      expect(reread?.stale).toBe(true);
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// deleteFileTreeSitterRows
// ---------------------------------------------------------------------------

describe('P2.2 — deleteFileTreeSitterRows', () => {
  it('removes only tree-sitter% rows; leaves SCIP rows intact', () => {
    const { qb, conn } = openFreshDb();
    try {
      const file = 'F.cs';
      qb.insertNode(makeNode({ id: 'n_scip', filePath: file, provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'n_ts', filePath: file, provenance: 'tree-sitter' }));
      qb.insertNode(makeNode({ id: 'n_fb', filePath: file, provenance: 'tree-sitter (scip-empty-fallback)' }));

      const summary = qb.deleteFileTreeSitterRows(file);
      expect(summary.nodesDeleted).toBe(2); // tree-sitter + fallback

      // Raw access (cached state may differ).
      expect(readRawNode(qb, 'n_scip')).not.toBeNull();
      expect(readRawNode(qb, 'n_ts')).toBeNull();
      expect(readRawNode(qb, 'n_fb')).toBeNull();
    } finally {
      conn.close();
    }
  });

  it('invalidates the cache so deleted-row reads return null (not cached)', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'n', filePath: 'F.cs', provenance: 'tree-sitter' }));
      qb.getNodeById('n'); // warm

      qb.deleteFileTreeSitterRows('F.cs');

      expect(qb.getNodeById('n')).toBeNull();
    } finally {
      conn.close();
    }
  });

  it('removes incident edges symmetrically (source-OR-target)', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'A', filePath: 'F.cs', provenance: 'tree-sitter' }));
      qb.insertNode(makeNode({ id: 'B', filePath: 'OTHER.cs', provenance: 'scip' }));
      qb.insertEdge(makeEdge('A', 'B'));
      qb.insertEdge(makeEdge('B', 'A'));

      qb.deleteFileTreeSitterRows('F.cs');

      expect(readRawEdge(qb, 'A', 'B')).toBeNull();
      expect(readRawEdge(qb, 'B', 'A')).toBeNull();
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// bulkMarkScipFilesStale (branch-switch path)
// ---------------------------------------------------------------------------

describe('P2.2 — bulkMarkScipFilesStale', () => {
  it('marks every passed file stale with the given visibility', () => {
    const { qb, conn } = openFreshDb();
    try {
      for (let i = 0; i < 5; i++) {
        qb.insertNode(makeNode({ id: `n${i}`, filePath: `F${i}.cs`, provenance: 'scip' }));
      }

      const summary = qb.bulkMarkScipFilesStale(
        ['F0.cs', 'F1.cs', 'F2.cs', 'F3.cs', 'F4.cs'],
        1,
      );

      expect(summary.nodesMarked).toBe(5);
      expect(summary.filesAffected).toBe(5);

      for (let i = 0; i < 5; i++) {
        expect(readRawNode(qb, `n${i}`)).toEqual({ stale: 1, staleness_visible: 1 });
      }
    } finally {
      conn.close();
    }
  });

  it('includes fallback rows in the bulk mark (round 4 finding 2)', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'a', filePath: 'A.cs', provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'b', filePath: 'B.cs', provenance: 'tree-sitter (scip-empty-fallback)' }));

      qb.bulkMarkScipFilesStale(['A.cs', 'B.cs'], 1);

      expect(readRawNode(qb, 'a')).toEqual({ stale: 1, staleness_visible: 1 });
      expect(readRawNode(qb, 'b')).toEqual({ stale: 1, staleness_visible: 1 });
    } finally {
      conn.close();
    }
  });

  it('empty batch is a no-op', () => {
    const { qb, conn } = openFreshDb();
    try {
      const summary = qb.bulkMarkScipFilesStale([], 1);
      expect(summary).toEqual({ nodesMarked: 0, edgesMarked: 0, filesAffected: 0 });
    } finally {
      conn.close();
    }
  });

  it('invalidates cached entries for files in the batch', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'n', filePath: 'F.cs', provenance: 'scip' }));
      qb.getNodeById('n');

      qb.bulkMarkScipFilesStale(['F.cs'], 0);

      expect(qb.getNodeById('n')).toBeNull(); // hidden-stale
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// End-to-end shadow flow (the design's "modified file F" diagram)
// ---------------------------------------------------------------------------

describe('P2.2 — shadow flow preserves SCIP rows', () => {
  it('SCIP rows survive a markScipFileStale + deleteFileTreeSitterRows + tree-sitter re-insert cycle', () => {
    const { qb, conn } = openFreshDb();
    try {
      const file = 'F.cs';
      markFileScipCovered(qb, file);

      // SCIP-emitted node (e.g. from prior scip-dotnet ingest).
      const scipId = 'scip:F#bar()';
      qb.insertNode(makeNode({ id: scipId, filePath: file, provenance: 'scip' }));

      // Sync detects F changed. Mark stale, drop prior shadow, re-extract.
      qb.markScipFileStale(file, 0);
      qb.deleteFileTreeSitterRows(file);
      qb.insertNode(makeNode({ id: 'ts:fresh', filePath: file, provenance: 'tree-sitter' }));

      // SCIP row still exists in the DB but is hidden by the freshness filter.
      const scipRaw = readRawNode(qb, scipId);
      expect(scipRaw).not.toBeNull();
      expect(scipRaw).toEqual({ stale: 1, staleness_visible: 0 });

      // Public getNodeById returns null for the hidden SCIP node.
      expect(qb.getNodeById(scipId)).toBeNull();
      // And returns the fresh tree-sitter row.
      const fresh = qb.getNodeById('ts:fresh');
      expect(fresh).not.toBeNull();
      expect(fresh?.stale).toBeUndefined();
    } finally {
      conn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// freshPredicate semantics still hold (sanity)
// ---------------------------------------------------------------------------

describe('P2.2 — freshPredicate sanity', () => {
  it('hidden-stale rows are excluded; visible-stale and fresh rows pass', () => {
    const { qb, conn } = openFreshDb();
    try {
      qb.insertNode(makeNode({ id: 'fresh', filePath: 'F.cs', provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'hidden', filePath: 'H.cs', provenance: 'scip' }));
      qb.insertNode(makeNode({ id: 'visible', filePath: 'V.cs', provenance: 'scip' }));
      qb.markScipFileStale('H.cs', 0);
      qb.markScipFileStale('V.cs', 1);

      const all = qb.getAllNodes();
      const ids = all.map((n) => n.id).sort();
      expect(ids).toEqual(['fresh', 'visible']); // 'hidden' is filtered out

      // Sanity: derivation is correct.
      const visible = all.find((n) => n.id === 'visible');
      expect(visible?.stale).toBe(true);
      const fresh = all.find((n) => n.id === 'fresh');
      expect(fresh?.stale).toBeUndefined();

      // freshPredicate exports the canonical clause used here.
      expect(freshPredicate()).toBe('(stale = 0 OR staleness_visible = 1)');
    } finally {
      conn.close();
    }
  });
});
