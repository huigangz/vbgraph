/**
 * P1.5 PR-16 — cleanup verification gates.
 *
 * Asserts the post-cleanup invariants:
 *   - No registered framework resolver still defines `extract` (the
 *     legacy per-file hook). If anyone in P1.5 forgot to remove the
 *     field, this fails.
 *   - The orchestrator still type-checks against the post-cleanup
 *     interface (covered by tsc, but smoke-imported here for visibility).
 *   - `NODE_KINDS` is unchanged from P0 — Phase 3 must not extend it
 *     (R2-F1 invariant from the plan).
 *   - `getFrameworkEdgeContributionCounts` executes (regression for the
 *     ambiguous-id-column bug — `json_each` exposes its own `id`).
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAllFrameworkResolvers } from '../src/resolution/frameworks';
import { NODE_KINDS } from '../src/types';
import { Phase3Orchestrator } from '../src/resolution/phase3';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

describe('PR-16 cleanup gates', () => {
  it('no registered resolver defines a legacy `extract` field', () => {
    const violators = getAllFrameworkResolvers().filter((r) => r.extract !== undefined);
    expect(violators.map((r) => r.name)).toEqual([]);
  });

  it('NODE_KINDS is unchanged from P0 (no Phase 3-added kinds)', () => {
    // The P0 NODE_KINDS set. Phase 3 must NOT extend it (Node-kind
    // discipline). New framework concepts MUST become tags, not kinds.
    expect(NODE_KINDS).toEqual([
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'protocol',
      'function',
      'method',
      'property',
      'field',
      'variable',
      'constant',
      'constructor',
      'event',
      'enum',
      'enum_member',
      'type_alias',
      'namespace',
      'parameter',
      'import',
      'export',
      'route',
      'component',
    ]);
  });

  it('Phase3Orchestrator can be imported without crashing', () => {
    expect(Phase3Orchestrator).toBeDefined();
    expect(typeof Phase3Orchestrator).toBe('function');
  });

  it('all resolvers carry a name and at least one of detect+synthesize/augment/resolve', () => {
    for (const r of getAllFrameworkResolvers()) {
      expect(r.name).toBeTruthy();
      expect(typeof r.detect).toBe('function');
      const hasAtLeastOneHook =
        r.synthesize !== undefined || r.augment !== undefined || r.resolve !== undefined;
      expect(hasAtLeastOneHook).toBe(true);
    }
  });
});

describe('PR-16 — getFrameworkEdgeContributionCounts SQL', () => {
  let tmpDir: string;
  let conn: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-pr16-'));
    conn = DatabaseConnection.initialize(path.join(tmpDir, 'g.db'));
    q = new QueryBuilder(conn.getDb());
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mkNode(id: string, name: string): Node {
    return {
      id, kind: 'function', name, qualifiedName: name,
      filePath: '/x.ts', language: 'typescript',
      startLine: 1, endLine: 1, startColumn: 0, endColumn: 0,
      updatedAt: 0,
    };
  }

  it('executes without ambiguous-column error (json_each also has `id`)', () => {
    // Empty DB: no edges → returns empty object. The critical assertion is
    // that the SELECT doesn't error with `ambiguous column name: id`.
    expect(q.getFrameworkEdgeContributionCounts()).toEqual({});
  });

  it('counts each framework edge once even when provenances[] holds multiple framework entries', () => {
    q.insertNode(mkNode('a', 'a'));
    q.insertNode(mkNode('b', 'b'));
    const db = conn.getDb();
    db.prepare(
      `INSERT INTO edges (source, target, kind, line, col, provenance, provenances, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'a', 'b', 'references', 1, 0,
      'framework:spring-core',
      JSON.stringify(['framework:spring-core', 'framework:spring-temporal']),
      0.85,
    );

    const counts = q.getFrameworkEdgeContributionCounts();
    expect(counts['spring-core']).toBe(1);
    expect(counts['spring-temporal']).toBe(1);
  });

  it('drops merged framework-primary edge while preserving its lower-rank static contributor', () => {
    // framework:* outranks heuristic and tree-sitter(scip-empty-fallback),
    // so the merged edge had framework as primary. STAGE 0 must demote
    // the row to the heuristic primary, not delete it.
    q.insertNode(mkNode('a', 'a'));
    q.insertNode(mkNode('b', 'b'));
    const db = conn.getDb();
    db.prepare(
      `INSERT INTO edges (source, target, kind, line, col, provenance, provenances, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'a', 'b', 'calls', 1, 0,
      'framework:react',
      JSON.stringify(['heuristic', 'framework:react']),
      0.85,
    );

    // Pre-state: framework edge contributes
    expect(q.getFrameworkEdgeContributionCounts()).toEqual({ react: 1 });

    q.stripFrameworkContributionsFromEdges();

    // Post-state: row survives with heuristic primary, framework gone.
    const row = db.prepare(
      `SELECT provenance, provenances FROM edges WHERE source='a'`,
    ).get() as { provenance: string; provenances: string };
    expect(row.provenance).toBe('heuristic');
    expect(JSON.parse(row.provenances)).toEqual(['heuristic']);
    expect(q.getFrameworkEdgeContributionCounts()).toEqual({});
  });

  it('counts SCIP-primary edges where framework is a non-primary contributor (ship gate 9)', () => {
    q.insertNode(mkNode('a', 'a'));
    q.insertNode(mkNode('b', 'b'));
    const db = conn.getDb();
    db.prepare(
      `INSERT INTO edges (source, target, kind, line, col, provenance, provenances, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'a', 'b', 'calls', 10, 5,
      'scip',
      JSON.stringify(['scip', 'framework:aspnet']),
      1.0,
    );

    const counts = q.getFrameworkEdgeContributionCounts();
    expect(counts['aspnet']).toBe(1);
  });
});
