/**
 * P2.3 — scip-refresh helpers + post-ingest assertion + supersede widening.
 *
 * Covers:
 *  1. `supersedeTreeSitter` predicate widening (P2.3.1) — re-ingest cleans
 *     both `'tree-sitter'` AND `'tree-sitter (scip-empty-fallback)'` rows
 *     for the per-doc sweep.
 *  2. STAGE E's empty-fallback recreation still works AFTER the broader
 *     supersede (the round-trip the design specifically calls out).
 *  3. `countShadowRowsForFile` semantics (narrow exact-match).
 *  4. `getScipDocumentsForIndex` returns the file list for an index.
 *  5. The post-ingest assertion catches a synthetic shadow leak.
 *
 * Driving the full `CodeGraph.refreshScip` flow would require spawning a
 * real indexer subprocess — out of scope. P2.6 (cron / e2e) can add that.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';
import { persistScipIndex } from '../src/extraction/scip/persister';
import { writeSyntheticScip } from './helpers/scip-fixtures';
import type { Node } from '../src/types';

let tmpDir: string;
let conn: DatabaseConnection;
let db: SqliteDatabase;
let qb: QueryBuilder;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p23-'));
  conn = DatabaseConnection.initialize(path.join(tmpDir, 'graph.db'));
  db = conn.getDb();
  qb = new QueryBuilder(db);
});

afterEach(() => {
  conn.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(overrides: Partial<Node> & { id: string; filePath: string }): Node {
  return {
    id: overrides.id,
    kind: 'function',
    name: 'fn_' + overrides.id,
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

function rowCount(provenance: string, filePath: string): number {
  return (
    db
      .prepare(`SELECT COUNT(*) c FROM nodes WHERE provenance = ? AND file_path = ?`)
      .get(provenance, filePath) as { c: number }
  ).c;
}

// ---------------------------------------------------------------------------
// countShadowRowsForFile
// ---------------------------------------------------------------------------

describe('P2.3 — countShadowRowsForFile', () => {
  it('counts exact `tree-sitter` rows, not fallback variant', () => {
    qb.insertNode(makeNode({ id: 'a', filePath: 'F.cs', provenance: 'tree-sitter' }));
    qb.insertNode(makeNode({ id: 'b', filePath: 'F.cs', provenance: 'tree-sitter' }));
    qb.insertNode(makeNode({
      id: 'c',
      filePath: 'F.cs',
      provenance: 'tree-sitter (scip-empty-fallback)',
    }));
    qb.insertNode(makeNode({ id: 'd', filePath: 'F.cs', provenance: 'scip' }));

    // Only the two exact-`'tree-sitter'` rows are counted.
    expect(qb.countShadowRowsForFile('F.cs')).toBe(2);
  });

  it('returns 0 when no shadow rows exist (typical post-refresh state)', () => {
    qb.insertNode(makeNode({
      id: 'fb',
      filePath: 'F.cs',
      provenance: 'tree-sitter (scip-empty-fallback)',
    }));
    qb.insertNode(makeNode({ id: 's', filePath: 'F.cs', provenance: 'scip' }));

    expect(qb.countShadowRowsForFile('F.cs')).toBe(0);
  });

  it('returns 0 for files with no rows at all', () => {
    expect(qb.countShadowRowsForFile('nonexistent.cs')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getScipDocumentsForIndex
// ---------------------------------------------------------------------------

describe('P2.3 — getScipDocumentsForIndex', () => {
  it('returns files covered by a given scip_index_path', () => {
    db.prepare(
      `INSERT INTO scip_documents (source_file_path, scip_index_path, source_hash, ingested_at)
       VALUES (?, ?, '', 0)`,
    ).run('A.cs', 'index.scip');
    db.prepare(
      `INSERT INTO scip_documents (source_file_path, scip_index_path, source_hash, ingested_at)
       VALUES (?, ?, '', 0)`,
    ).run('B.cs', 'index.scip');
    db.prepare(
      `INSERT INTO scip_documents (source_file_path, scip_index_path, source_hash, ingested_at)
       VALUES (?, ?, '', 0)`,
    ).run('C.cs', 'other.scip');

    const files = qb.getScipDocumentsForIndex('index.scip').sort();
    expect(files).toEqual(['A.cs', 'B.cs']);
  });

  it('returns empty array for an unknown index path', () => {
    expect(qb.getScipDocumentsForIndex('does-not-exist.scip')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// supersedeTreeSitter widening + STAGE E fallback recreation round-trip
// ---------------------------------------------------------------------------

describe('P2.3 — supersedeTreeSitter widening (P2.3.1)', () => {
  it('re-ingest clears both tree-sitter AND fallback rows for a doc', async () => {
    const scipPath = path.join(tmpDir, 'fixture.scip');
    // A synthetic empty-doc SCIP — STAGE E will run maybeEmptyFallback for it.
    // Empty `occurrences` triggers the fallback path; the broader supersede
    // ensures the post-ingest state has ONLY freshly-minted fallback rows.
    await writeSyntheticScip(scipPath, {
      documents: [
        { relativePath: 'src/Empty.cs', occurrences: [] },
      ],
    });

    // Seed both kinds of stale tree-sitter rows for the same file.
    qb.insertNode(makeNode({
      id: 'stale-ts',
      filePath: 'src/Empty.cs',
      provenance: 'tree-sitter',
    }));
    qb.insertNode(makeNode({
      id: 'stale-fb',
      filePath: 'src/Empty.cs',
      provenance: 'tree-sitter (scip-empty-fallback)',
    }));

    expect(rowCount('tree-sitter', 'src/Empty.cs')).toBe(1);
    expect(rowCount('tree-sitter (scip-empty-fallback)', 'src/Empty.cs')).toBe(1);

    // Re-ingest. supersedeTreeSitter (P2.3.1's wider predicate) wipes BOTH.
    // For non-empty SCIP docs, STAGE E re-creates nothing; for empty docs,
    // maybeEmptyFallback re-emits fresh fallback rows (when file size >
    // threshold). We're testing the supersede path; with no fallback callback
    // configured, the empty doc gets no fallback re-creation.
    await persistScipIndex({
      scipPath,
      projectRoot: tmpDir,
      db,
      qb,
      // No extractFallback supplied — STAGE E's maybeEmptyFallback is a no-op.
    });

    // Both seeded stale rows are gone (supersede broadened from = to LIKE).
    expect(rowCount('tree-sitter', 'src/Empty.cs')).toBe(0);
    expect(rowCount('tree-sitter (scip-empty-fallback)', 'src/Empty.cs')).toBe(0);
  });

  it('STAGE E maybeEmptyFallback re-creates fresh fallback rows after supersede', async () => {
    // Write a fixture with one empty SCIP doc + a real file on disk.
    const fileRel = 'src/Big.cs';
    const fileAbs = path.join(tmpDir, fileRel);
    fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
    // File must exceed emptyFallbackThresholdBytes (default 200).
    fs.writeFileSync(fileAbs, 'public class Big { ' + 'a'.repeat(300) + ' }');

    const scipPath = path.join(tmpDir, 'fixture.scip');
    await writeSyntheticScip(scipPath, {
      documents: [{ relativePath: fileRel, occurrences: [] }],
    });

    // Seed an old fallback row from a hypothetical prior generation.
    qb.insertNode(makeNode({
      id: 'old-fb',
      filePath: fileRel,
      provenance: 'tree-sitter (scip-empty-fallback)',
    }));

    // Mock fallback that produces one fresh node.
    const extractFallback = (absPath: string, relPath: string) => ({
      nodes: [
        {
          id: 'fresh-fb',
          kind: 'function' as const,
          name: 'fresh_fn',
          qualifiedName: 'fresh.fn',
          filePath: relPath,
          language: 'csharp' as const,
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: 0,
        },
      ],
      edges: [],
      unresolvedReferences: [],
      errors: [],
      durationMs: 0,
      __absPath: absPath, // for the closure to reference absPath
    });

    await persistScipIndex({
      scipPath,
      projectRoot: tmpDir,
      db,
      qb,
      extractFallback,
    });

    // Old fallback row deleted by supersede; new one created by maybeEmptyFallback.
    const fallbackIds = (
      db
        .prepare(
          `SELECT id FROM nodes WHERE file_path = ? AND provenance = 'tree-sitter (scip-empty-fallback)'`,
        )
        .all(fileRel) as Array<{ id: string }>
    ).map((r) => r.id);
    expect(fallbackIds).toContain('fresh-fb');
    expect(fallbackIds).not.toContain('old-fb');
  });
});

// ---------------------------------------------------------------------------
// Post-ingest assertion semantics
// ---------------------------------------------------------------------------

describe('P2.3 — post-ingest assertion semantics', () => {
  it('countShadowRowsForFile returns 0 when only fallback exists (assertion passes)', () => {
    // Simulating post-ingest state: SCIP rows + fallback rows. NO 'tree-sitter'.
    qb.insertNode(makeNode({ id: 's1', filePath: 'F.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({
      id: 'f1',
      filePath: 'F.cs',
      provenance: 'tree-sitter (scip-empty-fallback)',
    }));

    expect(qb.countShadowRowsForFile('F.cs')).toBe(0);
  });

  it('countShadowRowsForFile returns >0 when a shadow row leaked (assertion fails)', () => {
    // Simulating a regression where supersedeTreeSitter failed to clean.
    qb.insertNode(makeNode({ id: 's', filePath: 'F.cs', provenance: 'scip' }));
    qb.insertNode(makeNode({ id: 'leak', filePath: 'F.cs', provenance: 'tree-sitter' }));

    expect(qb.countShadowRowsForFile('F.cs')).toBe(1);
    // This is the count `refreshScip` checks; non-zero → 'ingest-failed'.
  });

  it('the assertion is narrow: a fallback row alone is NOT a leak', () => {
    qb.insertNode(makeNode({
      id: 'fb',
      filePath: 'F.cs',
      provenance: 'tree-sitter (scip-empty-fallback)',
    }));

    // If the assertion mistakenly used LIKE 'tree-sitter%', this would be 1.
    // The narrow predicate keeps it at 0.
    expect(qb.countShadowRowsForFile('F.cs')).toBe(0);
  });
});
