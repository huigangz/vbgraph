/**
 * P0.4 — edge-write infrastructure: provenance ranking, the three-tier
 * line/column invariant, and the `upsertGraphEdge` merge semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  pickPrimaryProvenance,
  provenanceRank,
  defaultConfidence,
  deriveConfidenceTier,
  validateEdgeLineColumn,
  coerceEdgePosition,
} from '../src/types';
import type { Edge, Node } from '../src/types';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

describe('pickPrimaryProvenance', () => {
  it('ranks scip above tree-sitter above heuristic', () => {
    expect(pickPrimaryProvenance(['tree-sitter', 'scip', 'heuristic'])).toBe('scip');
    expect(pickPrimaryProvenance(['heuristic', 'tree-sitter'])).toBe('tree-sitter');
  });

  it('keeps the first occurrence among equal-priority framework peers', () => {
    expect(pickPrimaryProvenance(['framework:aspnet', 'framework:spring'])).toBe(
      'framework:aspnet',
    );
  });

  it('throws on empty input', () => {
    expect(() => pickPrimaryProvenance([])).toThrow();
  });

  it('ranks the empty-fallback provenance lowest', () => {
    expect(provenanceRank('tree-sitter (scip-empty-fallback)')).toBeLessThan(
      provenanceRank('heuristic'),
    );
  });
});

describe('defaultConfidence / deriveConfidenceTier', () => {
  it('assigns compiler-grade confidence to SCIP', () => {
    expect(defaultConfidence('scip')).toBe(1.0);
    expect(defaultConfidence('heuristic')).toBe(0.6);
    expect(defaultConfidence('framework:aspnet')).toBe(0.85);
  });

  it('derives the confidence tier from provenance', () => {
    expect(deriveConfidenceTier('scip')).toBe('compiler');
    expect(deriveConfidenceTier('tree-sitter')).toBe('syntactic');
    expect(deriveConfidenceTier('scope-resolved')).toBe('scope-resolved');
    expect(deriveConfidenceTier('framework:spring')).toBe('inferred');
    expect(deriveConfidenceTier(undefined)).toBe('ambiguous');
  });
});

describe('validateEdgeLineColumn', () => {
  const base = { source: 'a', target: 'b' };

  it("requires a line and column on 'calls'", () => {
    expect(() =>
      validateEdgeLineColumn({ ...base, kind: 'calls', line: 3, column: 0 }),
    ).not.toThrow();
    // Missing column (or line) is a violation — the spec requires both.
    expect(() => validateEdgeLineColumn({ ...base, kind: 'calls', line: 3 })).toThrow();
    expect(() => validateEdgeLineColumn({ ...base, kind: 'calls' })).toThrow();
  });

  it("allows a null position on whitelisted 'references' subkinds", () => {
    expect(() =>
      validateEdgeLineColumn({ ...base, kind: 'references', subkind: 'di_binding' }),
    ).not.toThrow();
    expect(() => validateEdgeLineColumn({ ...base, kind: 'references' })).toThrow();
  });

  it("forbids a position on pure-relation kinds", () => {
    expect(() => validateEdgeLineColumn({ ...base, kind: 'contains' })).not.toThrow();
    expect(() => validateEdgeLineColumn({ ...base, kind: 'contains', line: 1 })).toThrow();
  });

  it("treats 'instantiates' / 'implements' position as optional", () => {
    expect(() => validateEdgeLineColumn({ ...base, kind: 'implements' })).not.toThrow();
    expect(() =>
      validateEdgeLineColumn({ ...base, kind: 'instantiates', line: 9 }),
    ).not.toThrow();
  });
});

describe('coerceEdgePosition', () => {
  it('strips line/column from forbidden-kind edges', () => {
    const coerced = coerceEdgePosition({
      source: 'a',
      target: 'b',
      kind: 'contains',
      line: 5,
      column: 2,
    });
    expect(coerced.line).toBeUndefined();
    expect(coerced.column).toBeUndefined();
  });

  it('leaves positioned kinds untouched', () => {
    const edge: Edge = { source: 'a', target: 'b', kind: 'calls', line: 5, column: 2 };
    expect(coerceEdgePosition(edge)).toBe(edge);
  });
});

describe('upsertGraphEdge', () => {
  let tmpDir: string;
  let conn: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p04edge-'));
    conn = DatabaseConnection.initialize(path.join(tmpDir, 'e.db'));
    qb = new QueryBuilder(conn.getDb());
    for (const id of ['A', 'B']) {
      const n: Node = {
        id,
        kind: 'function',
        name: id,
        qualifiedName: id,
        filePath: 'f.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 0,
      };
      qb.insertNode(n);
    }
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('merges two extractors at the same fingerprint into one row', () => {
    qb.upsertGraphEdge({
      source: 'A', target: 'B', kind: 'calls', line: 10, column: 5,
      provenance: 'tree-sitter',
    });
    qb.upsertGraphEdge({
      source: 'A', target: 'B', kind: 'calls', line: 10, column: 5,
      provenance: 'scip',
    });

    const edges = qb.getOutgoingEdges('A');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.provenance).toBe('scip'); // highest-priority primary
    expect(edges[0]?.provenances?.sort()).toEqual(['scip', 'tree-sitter']);
    expect(edges[0]?.confidence).toBe(1.0); // max(0.7, 1.0)
  });

  it('keeps the same caller->callee at different lines as distinct rows', () => {
    qb.upsertGraphEdge({ source: 'A', target: 'B', kind: 'calls', line: 10, provenance: 'scip' });
    qb.upsertGraphEdge({ source: 'A', target: 'B', kind: 'calls', line: 20, provenance: 'scip' });
    expect(qb.getOutgoingEdges('A')).toHaveLength(2);
  });

  it('strips a stray position from a forbidden-kind edge', () => {
    qb.upsertGraphEdge({ source: 'A', target: 'B', kind: 'contains', line: 7, provenance: 'scip' });
    const edges = qb.getOutgoingEdges('A');
    expect(edges).toHaveLength(1);
    expect(edges[0]?.line).toBeUndefined();
  });

  it('exposes the audit trail via getEdgesByContributingProvenance', () => {
    qb.upsertGraphEdge({ source: 'A', target: 'B', kind: 'calls', line: 1, provenance: 'tree-sitter' });
    qb.upsertGraphEdge({ source: 'A', target: 'B', kind: 'calls', line: 1, provenance: 'scip' });
    expect(qb.getEdgesByContributingProvenance('tree-sitter')).toHaveLength(1);
    expect(qb.getEdgesByContributingProvenance('scip')).toHaveLength(1);
    expect(qb.getEdgesByContributingProvenance('heuristic')).toHaveLength(0);
  });
});
