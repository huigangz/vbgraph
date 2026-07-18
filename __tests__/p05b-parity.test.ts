/**
 * P0.5b — resolution-parity harness + scope index.
 *
 * The harness verifies "same edge from either backend = same semantics", with
 * per-fingerprint call-site accounting and an allowed-divergence list for
 * compiler-magic features. The scope index narrows a name against file and
 * class scope from the extracted graph.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

import type { Edge, Node } from '../src/types';
import { VBGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { buildScopeIndex } from '../src/resolution/scope-index';
import {
  buildParityReport,
  assertEdgesEquivalent,
  qualifiedNameResolver,
  VBNET_ALLOWED_DIVERGENCE,
  runParity,
  type ParityReport,
} from '../src/parity';

// --- parity harness -------------------------------------------------------

/** Two nodes A and B with qualified names, for fingerprinting. */
const qnOf = (id: string): string | undefined =>
  ({ A: 'pkg.A', B: 'pkg.B', C: 'pkg.C' })[id];

function callEdge(source: string, target: string, line: number): Edge {
  return { source, target, kind: 'calls', line, column: 0, provenance: 'scip' };
}

describe('parity harness', () => {
  it('classifies shared / scipOnly / treeSitterOnly fingerprints', () => {
    const scip = [callEdge('A', 'B', 1), callEdge('A', 'C', 2)];
    const tree = [callEdge('A', 'B', 1)];
    const report = buildParityReport(scip, tree, qnOf);

    expect(report.shared).toHaveLength(1);
    expect(report.scipOnly).toHaveLength(1);
    expect(report.scipOnly[0]?.targetQualifiedName).toBe('pkg.C');
    expect(report.treeSitterOnly).toHaveLength(0);
  });

  it('counts per-fingerprint call sites and flags missed ones', () => {
    // SCIP sees A->B called at two lines; tree-sitter at only one.
    const scip = [callEdge('A', 'B', 10), callEdge('A', 'B', 20)];
    const tree = [callEdge('A', 'B', 10)];
    const report = buildParityReport(scip, tree, qnOf);

    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.scipCallSites).toBe(2);
    expect(report.rows[0]?.treeSitterCallSites).toBe(1);
    expect(report.rows[0]?.missedSites).toBe(1);
  });

  it('assertEdgesEquivalent passes for equivalent edge sets', () => {
    const edges = [callEdge('A', 'B', 1)];
    expect(() => assertEdgesEquivalent(edges, edges, qnOf)).not.toThrow();
  });

  it('assertEdgesEquivalent fails on a missed call site', () => {
    const scip = [callEdge('A', 'B', 1), callEdge('A', 'B', 2)];
    const tree = [callEdge('A', 'B', 1)];
    expect(() => assertEdgesEquivalent(scip, tree, qnOf)).toThrow(/missed 1 call site/);
  });

  it('assertEdgesEquivalent fails on an unexpected SCIP-only edge', () => {
    const scip = [callEdge('A', 'B', 1)];
    expect(() => assertEdgesEquivalent(scip, [], qnOf)).toThrow(/SCIP-only edge/);
  });

  it('accepts SCIP-only compiler-magic edges via allowed divergence', () => {
    const scip = [callEdge('A', 'B', 1)]; // a 'calls' edge — VB My.* / Handles territory
    expect(() =>
      assertEdgesEquivalent(scip, [], qnOf, {
        allowedDivergence: VBNET_ALLOWED_DIVERGENCE,
      }),
    ).not.toThrow();
  });

  it('always rejects a tree-sitter-only edge', () => {
    const tree = [callEdge('A', 'B', 1)];
    expect(() =>
      assertEdgesEquivalent([], tree, qnOf, {
        allowedDivergence: VBNET_ALLOWED_DIVERGENCE,
      }),
    ).toThrow(/tree-sitter-only edge/);
  });
});

// --- scope index ----------------------------------------------------------

describe('scope index', () => {
  let tmpDir: string;
  let conn: DatabaseConnection;
  let qb: QueryBuilder;

  function node(id: string, kind: Node['kind'], name: string, qn: string): Node {
    return {
      id,
      kind,
      name,
      qualifiedName: qn,
      filePath: 'src/M.cs',
      language: 'csharp',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p05b-'));
    conn = DatabaseConnection.initialize(path.join(tmpDir, 'g.db'));
    qb = new QueryBuilder(conn.getDb());
    // A class Widget with a method Render, plus a top-level function helper.
    qb.insertNode(node('cls', 'class', 'Widget', 'N.Widget'));
    qb.insertNode(node('m', 'method', 'Render', 'N.Widget.Render'));
    qb.insertNode(node('fn', 'function', 'helper', 'N.helper'));
    qb.upsertGraphEdge({ source: 'cls', target: 'm', kind: 'contains', provenance: 'scip' });
  });

  afterEach(() => {
    conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports file-scope declarations', () => {
    const scope = buildScopeIndex(qb);
    const names = scope.fileScope('src/M.cs').map((s) => s.name).sort();
    expect(names).toEqual(['Render', 'Widget', 'helper']);
  });

  it('reports class-scope members', () => {
    const scope = buildScopeIndex(qb);
    expect(scope.classScope('N.Widget').map((s) => s.name)).toEqual(['Render']);
  });

  it('resolves a name against class scope then file scope', () => {
    const scope = buildScopeIndex(qb);
    expect(
      scope.resolve('Render', { filePath: 'src/M.cs', enclosingClass: 'N.Widget' })?.nodeId,
    ).toBe('m');
    expect(scope.resolve('helper', { filePath: 'src/M.cs' })?.nodeId).toBe('fn');
    expect(scope.resolve('Missing', { filePath: 'src/M.cs' })).toBeNull();
  });

  it('exposes a qualified-name resolver helper', () => {
    const resolver = qualifiedNameResolver([
      qb.getNodeById('cls')!,
      qb.getNodeById('m')!,
    ]);
    expect(resolver('cls')).toBe('N.Widget');
    expect(resolver('unknown')).toBeUndefined();
  });
});

// --- parity on the real VB.NET fixture ------------------------------------

/**
 * P0.10 — run the parity harness over the committed `scip-dotnet` index and
 * the tree-sitter Tier-0 extraction of the same `.vb` files.
 *
 * Edges are fingerprinted by node *name* (the two backends mint different
 * qualified-name shapes — `Catalog.ShapeCatalog` vs `Catalog::ShapeCatalog`).
 * The point this asserts: the Tier-0 graph never resolves a semantic edge SCIP
 * lacks — tree-sitter contributes only the containment backbone, and every
 * `calls` / `extends` / `overrides` edge is the SCIP path's compiler-grade
 * uplift. (The community VB grammar cannot resolve calls or inheritance — see
 * worklog P0.6b — so a strict edge-for-edge subset is not the right frame.)
 */
describe('parity — real scip-dotnet VB.NET fixture vs tree-sitter Tier 0', () => {
  const fixtureDir = fileURLToPath(new URL('./fixtures/vbnet-sample', import.meta.url));
  let report: ParityReport;
  let files: string[];

  beforeAll(async () => {
    const result = await runParity(fixtureDir);
    report = result.report;
    files = result.files;
  });

  it('compares the three .vb documents of the committed index', () => {
    expect(files.sort()).toEqual(['Catalog.vb', 'Geometry.vb', 'Shapes.vb']);
  });

  it('agrees with tree-sitter on a substantial containment backbone', () => {
    expect(report.shared.length).toBeGreaterThanOrEqual(12);
    // Both backends resolve containment; nothing else overlaps.
    expect(report.shared.every((fp) => fp.kind === 'contains')).toBe(true);
  });

  it('attributes every semantic edge to the SCIP path alone', () => {
    // Tier-0 resolves only structural `contains` — it never produces a
    // `calls` / `extends` / `overrides` edge, so none can be tree-sitter-only.
    expect(report.treeSitterOnly.every((fp) => fp.kind === 'contains')).toBe(true);

    const scipOnlyKinds = new Set(report.scipOnly.map((fp) => fp.kind));
    expect(scipOnlyKinds.has('calls')).toBe(true);
    expect(scipOnlyKinds.has('extends')).toBe(true);
    expect(scipOnlyKinds.has('overrides')).toBe(true);
  });

  it('counts both cross-file call sites of Summary -> TotalArea', () => {
    const row = report.rows.find(
      (r) =>
        r.fingerprint.kind === 'calls' &&
        r.fingerprint.sourceQualifiedName === 'Summary' &&
        r.fingerprint.targetQualifiedName === 'TotalArea',
    );
    expect(row?.scipCallSites).toBe(2);
    expect(row?.treeSitterCallSites).toBe(0);
  });
});

// --- scope-resolution pass (P0.5b integration) ----------------------------

/**
 * P0.5b — the scope-resolved pass wired into `vbgraph index`. A bare name
 * declared in the use site's own class/module (or, for top-level declarations,
 * its file) resolves against the extracted `nodes` + `contains` graph; the
 * resulting edge carries `provenance='scope-resolved'`.
 */
describe('scope-resolved resolution pass', () => {
  let tmpDir: string;
  let cg: VBGraph | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p05b-scope-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const callable = (graph: VBGraph, name: string): Node | undefined =>
    [...graph.getNodesByKind('method'), ...graph.getNodesByKind('function')].find(
      (n) => n.name === name,
    );

  it('scope-resolves a same-module VB.NET call', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.vb'),
      [
        'Module M',
        '  Sub Foo()',
        '    Bar()',
        '  End Sub',
        '  Sub Bar()',
        '  End Sub',
        'End Module',
      ].join('\n'),
    );
    cg = await VBGraph.init(tmpDir, { index: true });

    const foo = callable(cg, 'Foo');
    const bar = callable(cg, 'Bar');
    expect(foo && bar).toBeTruthy();
    const callEdge = cg
      .getOutgoingEdges(foo!.id)
      .find((e) => e.kind === 'calls' && e.target === bar!.id);
    expect(callEdge?.provenance).toBe('scope-resolved');
    expect(callEdge?.confidence).toBe(0.75);
  });

  it('scope-resolves a call to a top-level TypeScript function via file scope', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'app.ts'),
      ['function helper(): void {}', '', 'function main(): void {', '  helper();', '}', ''].join(
        '\n',
      ),
    );
    cg = await VBGraph.init(tmpDir, { index: true });

    const main = callable(cg, 'main');
    const helper = callable(cg, 'helper');
    expect(main && helper).toBeTruthy();
    const callEdge = cg
      .getOutgoingEdges(main!.id)
      .find((e) => e.kind === 'calls' && e.target === helper!.id);
    expect(callEdge?.provenance).toBe('scope-resolved');
  });

  it('does not leak a class member into another class via file scope', async () => {
    // A bare `Bar()` in module A must NOT bind to module B's `Bar`: members
    // are reachable only through class scope, never file scope.
    fs.writeFileSync(
      path.join(tmpDir, 'two.vb'),
      [
        'Module A',
        '  Sub Foo()',
        '    Bar()',
        '  End Sub',
        'End Module',
        '',
        'Module B',
        '  Sub Bar()',
        '  End Sub',
        'End Module',
      ].join('\n'),
    );
    cg = await VBGraph.init(tmpDir, { index: true });

    const foo = callable(cg, 'Foo');
    expect(foo).toBeTruthy();
    const scopeEdges = cg
      .getOutgoingEdges(foo!.id)
      .filter((e) => e.provenance === 'scope-resolved');
    expect(scopeEdges).toEqual([]);
  });
});
