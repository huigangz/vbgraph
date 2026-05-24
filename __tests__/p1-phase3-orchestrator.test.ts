/**
 * P1.4 — Phase3Orchestrator tests.
 *
 * Covers the load-bearing invariants from plan § P1.6 that don't require
 * real resolver migrations:
 *
 *   #1  synthesize → augment visibility
 *   #2  resolver exception isolation
 *   #5  NULL-position framework edge accepted via the allowlist
 *  #15  edge metadata rejection
 *  #16  unconditional STAGE 0 on re-index without --force
 *  #18  cross-resolver inherent tag visibility (synthesize tags visible to augment)
 *  #19  derived tags NOT visible to sibling augments in the same run
 *  #20  synthesize sees CLEAN view1 (purge ran first)
 *  #21  tag preflight — bad nodeId in synthesize
 *  #22  tag preflight — malformed tag string
 *  #23  cache invalidation after purge
 *  #24  STAGE 0 confidence CASE matches defaultConfidence
 *  #25  exactly one matched BEGIN/COMMIT pair (no nested tx)
 *
 * Tests that require fixtures (Spring DI, Temporal) or actual migrated
 * resolvers (#3 SCIP dedup with framework, #11–#13 STAGE 0 against real
 * resolvers) land alongside their PR.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { Phase3Orchestrator, isValidTagFormat } from '../src/resolution/phase3';
import {
  registerFrameworkResolver,
  unregisterFrameworkResolver,
} from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';
import type { Node, GraphProvenance } from '../src/types';
import {
  defaultConfidence,
  pickPrimaryProvenance,
  REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION,
} from '../src/types';

let tmpDir: string;
let conn: DatabaseConnection;
let q: QueryBuilder;
let registeredFakeNames: string[] = [];

function registerFake(r: FrameworkResolver): FrameworkResolver {
  registerFrameworkResolver(r);
  registeredFakeNames.push(r.name);
  return r;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p1-orch-'));
  conn = DatabaseConnection.initialize(path.join(tmpDir, 'g.db'));
  q = new QueryBuilder(conn.getDb());
});

afterEach(() => {
  for (const n of registeredFakeNames) unregisterFrameworkResolver(n);
  registeredFakeNames = [];
  conn.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeNode(id: string, name: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: '/x.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('Phase3Orchestrator — base invariants', () => {
  it('isValidTagFormat accepts kebab + framework:role; rejects garbage', () => {
    expect(isValidTagFormat('route-handler')).toBe(true);
    expect(isValidTagFormat('spring:service')).toBe(true);
    expect(isValidTagFormat('a:b:c')).toBe(true);
    expect(isValidTagFormat('Foo')).toBe(false);
    expect(isValidTagFormat('snake_case')).toBe(false);
    expect(isValidTagFormat('a b')).toBe(false);
    expect(isValidTagFormat('')).toBe(false);
    expect(isValidTagFormat(':foo')).toBe(false);
  });

  it('runs with zero resolvers on a populated DB and returns empty counts', async () => {
    q.insertNode(makeNode('n1', 'foo'));
    const orch = new Phase3Orchestrator(tmpDir, q);
    const result = await orch.run();
    expect(result.nodesAdded).toBe(0);
    expect(result.edgesAdded).toBe(0);
    expect(result.tagsAdded).toBe(0);
    expect(result.errors).toEqual([]);
  });
});

describe('#1 synthesize → augment visibility', () => {
  it('node synthesized by resolver A is visible to resolver B augment', async () => {
    registerFake({
      name: 'fake-a',
      detect: () => true,
      synthesize: () => ({
        nodes: [
          makeNode('framework:fake-a:n', 'a-node', {
            kind: 'route',
            provenance: 'framework:fake-a',
          }),
        ],
      }),
    });
    let augmentSawNode = false;
    registerFake({
      name: 'fake-b',
      detect: () => true,
      augment: (g) => {
        augmentSawNode = g.getNode('framework:fake-a:n') !== null;
        return { edges: [] };
      },
    });

    const orch = new Phase3Orchestrator(tmpDir, q);
    await orch.run();
    expect(augmentSawNode).toBe(true);
  });
});

describe('#2 resolver exception isolation', () => {
  it('thrown synthesize quarantines A and B completes normally', async () => {
    registerFake({
      name: 'fake-thrower',
      detect: () => true,
      synthesize: () => {
        throw new Error('boom');
      },
    });
    q.insertNode(makeNode('host', 'host'));
    registerFake({
      name: 'fake-good',
      detect: () => true,
      augment: () => ({
        edges: [],
        tags: [{ nodeId: 'host', tags: ['route-handler'] }],
      }),
    });

    const orch = new Phase3Orchestrator(tmpDir, q);
    const result = await orch.run();
    expect(result.errors.some((e) => e.code === 'phase3.synthesize.throw')).toBe(true);
    expect(result.tagsAdded).toBe(1);
    expect(q.getNodesByTag('route-handler').map((n) => n.id)).toEqual(['host']);
  });
});

describe('#5 NULL-position framework edge accepted via allowlist', () => {
  it('references + subkind in allowlist with NULL line/col persists', async () => {
    q.insertNode(makeNode('src', 'src'));
    q.insertNode(makeNode('tgt', 'tgt'));
    expect(REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION.has('convention')).toBe(true);

    registerFake({
      name: 'fake-conv',
      detect: () => true,
      augment: () => ({
        edges: [
          {
            source: 'src',
            target: 'tgt',
            kind: 'references',
            subkind: 'convention',
            provenance: 'framework:fake-conv',
            confidence: 0.85,
          },
        ],
      }),
    });

    const orch = new Phase3Orchestrator(tmpDir, q);
    const result = await orch.run();
    expect(result.edgesAdded).toBe(1);
    expect(result.errors).toEqual([]);
    const out = q.getOutgoingEdges('src');
    expect(out).toHaveLength(1);
    expect(out[0]!.subkind).toBe('convention');
    expect(out[0]!.provenance).toBe('framework:fake-conv');
    expect(out[0]!.line).toBeUndefined();
  });
});

describe('#15 edge metadata rejection', () => {
  it('framework edge carrying metadata is dropped with a warning', async () => {
    q.insertNode(makeNode('src', 'src'));
    q.insertNode(makeNode('tgt', 'tgt'));
    registerFake({
      name: 'fake-meta',
      detect: () => true,
      augment: () => ({
        edges: [
          {
            source: 'src',
            target: 'tgt',
            kind: 'references',
            subkind: 'convention',
            metadata: { foo: 'bar' },
            provenance: 'framework:fake-meta',
            confidence: 0.85,
          },
        ],
      }),
    });

    const orch = new Phase3Orchestrator(tmpDir, q);
    const result = await orch.run();
    expect(result.edgesAdded).toBe(0);
    expect(result.errors.some((e) => e.code === 'phase3.augment.edge_metadata')).toBe(true);
    expect(q.getOutgoingEdges('src')).toHaveLength(0);
  });
});

describe('#16 unconditional STAGE 0 on re-index without --force', () => {
  it('re-running Phase 3 against a populated DB clears + re-derives', async () => {
    q.insertNode(makeNode('host', 'host'));
    let synthCalls = 0;
    registerFake({
      name: 'fake-stable',
      detect: () => true,
      synthesize: () => {
        synthCalls += 1;
        return {
          nodes: [
            makeNode('framework:fake-stable:r', 'r', {
              kind: 'route',
              provenance: 'framework:fake-stable',
            }),
          ],
          tags: [{ nodeId: 'host', tags: ['route-handler'] }],
        };
      },
    });

    await new Phase3Orchestrator(tmpDir, q).run();
    expect(q.getNodesByKind('route')).toHaveLength(1);
    expect(q.getNodesByTag('route-handler')).toHaveLength(1);

    await new Phase3Orchestrator(tmpDir, q).run();
    expect(synthCalls).toBe(2);
    // No duplication — purge ran before re-synthesize.
    expect(q.getNodesByKind('route')).toHaveLength(1);
    expect(q.getNodesByTag('route-handler')).toHaveLength(1);
  });
});

describe('#18 inherent tag visibility — synthesize tags visible to augment', () => {
  it('tag emitted in synthesize is visible to a different resolver augment via view2', async () => {
    q.insertNode(makeNode('host', 'host', { kind: 'class' }));
    registerFake({
      name: 'fake-tagger',
      detect: () => true,
      synthesize: () => ({
        nodes: [],
        tags: [{ nodeId: 'host', tags: ['team-internal:bean'] }],
      }),
    });
    let augmentSawTag = false;
    registerFake({
      name: 'fake-reader',
      detect: () => true,
      augment: (g) => {
        augmentSawTag = g.getNodesByTag('team-internal:bean').some((n) => n.id === 'host');
        return { edges: [] };
      },
    });

    await new Phase3Orchestrator(tmpDir, q).run();
    expect(augmentSawTag).toBe(true);
  });
});

describe('#19 derived tags NOT visible to sibling augments', () => {
  it('augment-emitted tag is invisible to another augment in the same run; visible post-Phase-3', async () => {
    q.insertNode(makeNode('host', 'host'));
    registerFake({
      name: 'fake-derive-a',
      detect: () => true,
      augment: () => ({
        edges: [],
        tags: [{ nodeId: 'host', tags: ['route-handler'] }],
      }),
    });
    let siblingSawTag = false;
    registerFake({
      name: 'fake-derive-b',
      detect: () => true,
      augment: (g) => {
        // Runs AFTER fake-derive-a in iteration order but BEFORE STAGE E
        // commits its tags (per the augment visibility contract).
        siblingSawTag = g.getNodesByTag('route-handler').length > 0;
        return { edges: [] };
      },
    });

    await new Phase3Orchestrator(tmpDir, q).run();
    expect(siblingSawTag).toBe(false);
    // Post-Phase-3, the tag IS persisted.
    expect(q.getNodesByTag('route-handler').map((n) => n.id)).toEqual(['host']);
  });
});

describe('#20 synthesize sees CLEAN view1 — no stale framework rows', () => {
  it('on re-index, view1 has no framework nodes from prior generation', async () => {
    const observedRouteCounts: number[] = [];
    registerFake({
      name: 'fake-clean',
      detect: () => true,
      synthesize: (g) => {
        observedRouteCounts.push(g.getNodesByKind('route').length);
        return {
          nodes: [
            makeNode('framework:fake-clean:r', 'r', {
              kind: 'route',
              provenance: 'framework:fake-clean',
            }),
          ],
        };
      },
    });

    await new Phase3Orchestrator(tmpDir, q).run();
    await new Phase3Orchestrator(tmpDir, q).run();

    expect(observedRouteCounts).toEqual([0, 0]); // Second run also saw zero — purge worked.
  });
});

describe('#21 tag preflight — bad nodeId in synthesize', () => {
  it('valid node persists; bad-nodeId tag is dropped with a warning; no rollback', async () => {
    registerFake({
      name: 'fake-mixed',
      detect: () => true,
      synthesize: () => ({
        nodes: [
          makeNode('framework:fake-mixed:n', 'n', {
            kind: 'route',
            provenance: 'framework:fake-mixed',
          }),
        ],
        tags: [{ nodeId: 'nonexistent', tags: ['foo'] }],
      }),
    });

    const result = await new Phase3Orchestrator(tmpDir, q).run();
    expect(result.nodesAdded).toBe(1);
    expect(result.tagsAdded).toBe(0);
    expect(result.errors.some((e) => e.code === 'phase3.synthesize.bad_nodeid')).toBe(true);
    expect(q.getNodesByKind('route').map((n) => n.id)).toEqual(['framework:fake-mixed:n']);
  });
});

describe('#22 tag preflight — malformed tag strings dropped', () => {
  it('malformed tag strings logged + dropped; well-formed sibling tag persists', async () => {
    q.insertNode(makeNode('host', 'host'));
    registerFake({
      name: 'fake-badtags',
      detect: () => true,
      augment: () => ({
        edges: [],
        tags: [{ nodeId: 'host', tags: ['Foo Bar', 'snake_case', '', 'good-tag'] }],
      }),
    });

    const result = await new Phase3Orchestrator(tmpDir, q).run();
    expect(q.getNodesByTag('good-tag').map((n) => n.id)).toEqual(['host']);
    expect(q.getNodesByTag('Foo Bar')).toHaveLength(0);
    expect(q.getNodesByTag('snake_case')).toHaveLength(0);
    const badTagErrors = result.errors.filter((e) => e.code === 'phase3.augment.bad_tag');
    expect(badTagErrors).toHaveLength(3); // 'Foo Bar', 'snake_case', ''
  });
});

describe('#23 cache invalidation after purge', () => {
  it('post-purge getNodeById returns null (no cached pre-delete value)', async () => {
    // Pre-seed a framework node directly so we can purge it.
    q.insertNode(
      makeNode('framework:premade:r', 'r', {
        kind: 'route',
        provenance: 'framework:premade',
      }),
    );
    // Warm the cache by querying.
    const before = q.getNodeById('framework:premade:r');
    expect(before).not.toBeNull();
    expect(before!.kind).toBe('route');

    // Purge.
    q.deleteFrameworkNodes();
    q.invalidatePhase3Caches();
    expect(q.getNodeById('framework:premade:r')).toBeNull();
  });
});

describe('#24 STAGE 0 confidence CASE matches defaultConfidence', () => {
  it('for every GraphProvenance literal, SQL CASE ladder matches defaultConfidence', () => {
    const literals: GraphProvenance[] = [
      'scip',
      'scip:external',
      'scope-resolved',
      'tree-sitter',
      'tree-sitter (scip-empty-fallback)',
      'heuristic',
      'framework:spring-core',
      'framework:aspnet',
    ];
    const db = conn.getDb();
    const stmt = db.prepare(`
      SELECT CASE
        WHEN ? IN ('scip', 'scip:external')                           THEN 1.00
        WHEN ? = 'scope-resolved'                                      THEN 0.75
        WHEN ? IN ('tree-sitter', 'tree-sitter (scip-empty-fallback)') THEN 0.70
        WHEN ? LIKE 'framework:%'                                      THEN 0.85
        WHEN ? = 'heuristic'                                           THEN 0.60
        ELSE 0.50
      END AS conf
    `);
    for (const lit of literals) {
      const row = stmt.get(lit, lit, lit, lit, lit) as { conf: number };
      expect(row.conf).toBeCloseTo(defaultConfidence(lit), 5);
    }
  });

  it('STAGE 0 SQL 0.1 recomputes confidence after stripping framework provenance', async () => {
    // Pre-seed nodes and a merged tree-sitter + framework edge.
    q.insertNode(makeNode('src', 'src'));
    q.insertNode(makeNode('tgt', 'tgt'));
    const db = conn.getDb();
    db.prepare(
      `INSERT INTO edges (source, target, kind, line, col, provenance, provenances, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'src',
      'tgt',
      'calls',
      10,
      5,
      pickPrimaryProvenance(['tree-sitter', 'framework:fake-x'] as GraphProvenance[]),
      JSON.stringify(['tree-sitter', 'framework:fake-x']),
      0.85,
    );

    q.stripFrameworkContributionsFromEdges();

    const row = db
      .prepare(`SELECT confidence, provenances FROM edges WHERE source='src'`)
      .get() as { confidence: number; provenances: string };
    expect(row.confidence).toBeCloseTo(0.7, 5);
    expect(JSON.parse(row.provenances)).toEqual(['tree-sitter']);
  });

  it('STAGE 0 SQL 0.1 preserves merged edge where framework is PRIMARY but a lower-rank static contributor survives', async () => {
    // `framework:*` rank (60) outranks `heuristic` (50) and
    // `tree-sitter (scip-empty-fallback)` (40). In a merged edge
    // [heuristic, framework:x] the primary is framework, but the heuristic
    // contribution is load-bearing static info that must survive the
    // strip — the row must be demoted (not deleted).
    q.insertNode(makeNode('src', 'src'));
    q.insertNode(makeNode('tgt', 'tgt'));
    const db = conn.getDb();
    db.prepare(
      `INSERT INTO edges (source, target, kind, line, col, provenance, provenances, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'src',
      'tgt',
      'calls',
      11,
      5,
      pickPrimaryProvenance(['heuristic', 'framework:fake-y'] as GraphProvenance[]),
      JSON.stringify(['heuristic', 'framework:fake-y']),
      0.85,
    );

    q.stripFrameworkContributionsFromEdges();

    const row = db
      .prepare(`SELECT provenance, confidence, provenances FROM edges WHERE source='src'`)
      .get() as { provenance: string; confidence: number; provenances: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.provenance).toBe('heuristic');
    expect(JSON.parse(row!.provenances)).toEqual(['heuristic']);
    expect(row!.confidence).toBeCloseTo(0.6, 5);
  });

  it('STAGE 0 SQL 0.1 deletes edges whose only contributor is framework', async () => {
    q.insertNode(makeNode('src', 'src'));
    q.insertNode(makeNode('tgt', 'tgt'));
    const db = conn.getDb();
    db.prepare(
      `INSERT INTO edges (source, target, kind, line, col, provenance, provenances, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'src', 'tgt', 'references', 12, 0,
      'framework:fake-z',
      JSON.stringify(['framework:fake-z']),
      0.85,
    );

    q.stripFrameworkContributionsFromEdges();

    const row = db
      .prepare(`SELECT id FROM edges WHERE source='src'`)
      .get();
    // WASM adapter returns null; better-sqlite3 returns undefined. Both
    // mean "no row".
    expect(row == null).toBe(true);
  });
});

describe('#25 exactly one transaction per Phase 3 run', () => {
  it('orchestrator opens one transaction boundary, no nesting', async () => {
    // Spy on QueryBuilder.transaction — Phase 3's sole transaction
    // surface. Any inner helper that opens its own tx would call
    // `q.transaction` again (or `this.db.transaction(...)()` — see below).
    let txCount = 0;
    const origTx = q.transaction.bind(q);
    (q as unknown as { transaction: typeof q.transaction }).transaction = ((
      fn: () => unknown,
    ) => {
      txCount += 1;
      return origTx(fn as () => never);
    }) as typeof q.transaction;

    // Also spy on the lower-level db.transaction to catch inner helpers
    // like insertNodes that bypass the QueryBuilder.transaction wrapper.
    let lowTxCount = 0;
    const db = conn.getDb();
    const origLowTx = db.transaction.bind(db);
    (db as unknown as { transaction: typeof db.transaction }).transaction = ((
      fn: (...args: unknown[]) => unknown,
    ) => {
      lowTxCount += 1;
      return origLowTx(fn);
    }) as typeof db.transaction;

    try {
      q.insertNode(makeNode('host', 'host'));
      registerFake({
        name: 'fake-tx',
        detect: () => true,
        synthesize: () => ({
          nodes: [
            makeNode('framework:fake-tx:r', 'r', {
              kind: 'route',
              provenance: 'framework:fake-tx',
            }),
          ],
        }),
        augment: () => ({
          edges: [],
          tags: [{ nodeId: 'host', tags: ['route-handler'] }],
        }),
      });

      await new Phase3Orchestrator(tmpDir, q).run();
      // QueryBuilder.transaction called exactly once: Phase 3's boundary.
      expect(txCount).toBe(1);
      // Lower-level db.transaction called exactly once (from the QueryBuilder
      // wrapper) — no inner helper opened its own.
      expect(lowTxCount).toBe(1);
    } finally {
      (q as unknown as { transaction: typeof q.transaction }).transaction = origTx;
      (db as unknown as { transaction: typeof db.transaction }).transaction = origLowTx;
    }
  });
});
