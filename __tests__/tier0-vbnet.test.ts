/**
 * P0.6b — VB.NET Tier 0 extractor (tree-sitter, no .NET SDK required).
 *
 * Verifies the bundled VB.NET WASM grammar + `vbnetExtractor` produce a usable
 * graph. The pinned grammar (CodeAnt-AI/tree-sitter-vb-dotnet @ cfca210) is a
 * community grammar with known gaps — see the skipped cases and worklog P0.6b.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { Node } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['vbnet']);
});

function names(nodes: Node[], kind: string): string[] {
  return nodes
    .filter((n) => n.kind === kind)
    .map((n) => n.name)
    .sort();
}

describe('VB.NET Tier 0 extraction', () => {
  it('extracts a Module and its Sub members', () => {
    const code = [
      'Module Foo',
      '  Sub Main()',
      '    Helper()',
      '  End Sub',
      '  Sub Helper()',
      '  End Sub',
      'End Module',
    ].join('\n');
    const result = extractFromSource('app.vb', code);

    expect(result.errors).toEqual([]);
    expect(names(result.nodes, 'module')).toEqual(['Foo']);
    const callables = result.nodes
      .filter((n) => n.kind === 'function' || n.kind === 'method')
      .map((n) => n.name)
      .sort();
    expect(callables).toEqual(['Helper', 'Main']);
    // File-local call: Sub Main calls Helper().
    expect(
      result.unresolvedReferences.some(
        (r) => r.referenceKind === 'calls' && r.referenceName === 'Helper',
      ),
    ).toBe(true);
  });

  it('extracts a Class with a Property, a method and Friend visibility', () => {
    const code = [
      'Class Widget',
      '  Public Property Title As String',
      '  Friend Sub Reset()',
      '  End Sub',
      'End Class',
    ].join('\n');
    const result = extractFromSource('widget.vb', code);

    expect(names(result.nodes, 'class')).toEqual(['Widget']);
    expect(names(result.nodes, 'property')).toEqual(['Title']);
    const reset = result.nodes.find((n) => n.name === 'Reset');
    expect(reset).toBeDefined();
    expect(reset?.visibility).toBe('internal'); // VB `Friend` -> internal
  });

  it('extracts a Namespace and an Interface', () => {
    const code = [
      'Namespace App',
      '  Interface IService',
      '  End Interface',
      'End Namespace',
    ].join('\n');
    const result = extractFromSource('model.vb', code);

    expect(names(result.nodes, 'namespace')).toEqual(['App']);
    expect(names(result.nodes, 'interface')).toEqual(['IService']);
  });

  it('extracts a per-file Imports statement', () => {
    const code = ['Imports System.IO', '', 'Module M', 'End Module'].join('\n');
    const result = extractFromSource('imports.vb', code);
    const importNode = result.nodes.find((n) => n.kind === 'import');
    const importEdge = result.edges.find((e) => e.kind === 'imports');
    expect(importNode !== undefined || importEdge !== undefined).toBe(true);
  });

  it('extracts a Structure with fields and an Enum with members', () => {
    const code = [
      'Structure Point',
      '  Public X As Integer',
      '  Public Y As Integer',
      'End Structure',
      '',
      'Enum Color',
      '  Red',
      '  Green',
      'End Enum',
    ].join('\n');
    const result = extractFromSource('types.vb', code);

    expect(names(result.nodes, 'struct')).toEqual(['Point']);
    expect(names(result.nodes, 'field')).toEqual(['X', 'Y']);
    expect(names(result.nodes, 'enum')).toEqual(['Color']);
    expect(names(result.nodes, 'enum_member')).toEqual(['Green', 'Red']);
  });

  // SETTLED — VB inheritance is Tier-1 (SCIP) only, by decision (P0 ship
  // gate 1). The pinned community grammar (cfca210) cannot parse `Inherits` /
  // `Implements`: it misparses them into `field_declaration` nodes with
  // MISSING / ERROR tokens (verified), so no `extends` / `implements` edge is
  // recoverable from the Tier-0 tree. `extractInheritance` stays wired for an
  // `inherits_clause` node, so a future grammar that emits one lights this up
  // with no code change. See worklog P0.6b / P0.10.
  it.skip('extracts Inherits / Implements — Tier-1 (SCIP) only, see worklog P0.6b', () => {
    /* intentionally skipped — VB inheritance edges are SCIP-only by decision */
  });
});
