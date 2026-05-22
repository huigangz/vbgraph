/**
 * P0.3 — SCIP symbol-string parser.
 *
 * Exercises the SCIP symbol grammar (scheme/package/descriptors, local
 * symbols, backtick-escaped identifiers, space escaping, method
 * disambiguators), the symbol -> NodeKind mapping, and the stable hash.
 */

import { describe, it, expect } from 'vitest';
import {
  parseScipSymbol,
  hashScipSymbol,
  nodeKindForScipSymbol,
  descriptorSuffixToNodeKind,
  ScipSymbolParseError,
} from '../src/extraction/scip/symbol-parser';

describe('parseScipSymbol — global symbols', () => {
  it('parses scheme, package and descriptors', () => {
    const p = parseScipSymbol(
      'scip-dotnet nuget MyProject 1.2.3 MyNamespace/MyClass#MyMethod().',
    );
    expect(p.isLocal).toBe(false);
    expect(p.scheme).toBe('scip-dotnet');
    expect(p.package).toEqual({ manager: 'nuget', name: 'MyProject', version: '1.2.3' });
    expect(p.descriptors).toEqual([
      { name: 'MyNamespace', suffix: 'namespace' },
      { name: 'MyClass', suffix: 'type' },
      { name: 'MyMethod', suffix: 'method' },
    ]);
    expect(p.qualifiedName).toBe('MyNamespace.MyClass.MyMethod');
  });

  it("treats '.' package fields as empty", () => {
    const p = parseScipSymbol('dotnet . . . System/Console#WriteLine().');
    expect(p.package).toEqual({ manager: '', name: '', version: '' });
    expect(p.descriptors.map((d) => d.name)).toEqual(['System', 'Console', 'WriteLine']);
  });

  it('handles every descriptor suffix', () => {
    const p = parseScipSymbol('s p n v Ns/Ty#term.meta:mac!');
    expect(p.descriptors).toEqual([
      { name: 'Ns', suffix: 'namespace' },
      { name: 'Ty', suffix: 'type' },
      { name: 'term', suffix: 'term' },
      { name: 'meta', suffix: 'meta' },
      { name: 'mac', suffix: 'macro' },
    ]);
  });

  it('parses type-parameter and parameter descriptors', () => {
    const p = parseScipSymbol('s p n v Box#[T](value)');
    expect(p.descriptors).toEqual([
      { name: 'Box', suffix: 'type' },
      { name: 'T', suffix: 'type-parameter' },
      { name: 'value', suffix: 'parameter' },
    ]);
  });

  it('captures a method disambiguator', () => {
    const p = parseScipSymbol('s p n v C#overloaded(+1).');
    expect(p.descriptors).toEqual([
      { name: 'C', suffix: 'type' },
      { name: 'overloaded', suffix: 'method', disambiguator: '+1' },
    ]);
  });

  it('omits the disambiguator when the method has none', () => {
    const p = parseScipSymbol('s p n v plain().');
    expect(p.descriptors[0]).toEqual({ name: 'plain', suffix: 'method' });
    expect(p.descriptors[0]).not.toHaveProperty('disambiguator');
  });
});

describe('parseScipSymbol — escaping', () => {
  it('unescapes doubled spaces in package fields', () => {
    const p = parseScipSymbol('a  b . p v Foo#');
    expect(p.scheme).toBe('a b');
    expect(p.descriptors[0]).toEqual({ name: 'Foo', suffix: 'type' });
  });

  it('reads a backtick-escaped identifier containing spaces', () => {
    const p = parseScipSymbol('scip x . . `weird name`#');
    expect(p.descriptors[0]).toEqual({ name: 'weird name', suffix: 'type' });
  });

  it('unescapes a doubled backtick inside an escaped identifier', () => {
    const p = parseScipSymbol('scip x . . `a``b`#');
    expect(p.descriptors[0]?.name).toBe('a`b');
  });
});

describe('parseScipSymbol — local symbols', () => {
  it('parses a local symbol', () => {
    const p = parseScipSymbol('local 42');
    expect(p.isLocal).toBe(true);
    expect(p.scheme).toBe('local');
    expect(p.descriptors).toEqual([{ name: '42', suffix: 'local' }]);
    expect(p.qualifiedName).toBe('42');
  });
});

describe('parseScipSymbol — malformed input', () => {
  it.each([
    ['', 'empty string'],
    ['scip x . . `unterminated', 'unterminated escape'],
    ['scip x . . Foo%', 'unknown suffix'],
    ['scip x . . ', 'no descriptors'],
    ['  pkg n v Foo#', 'empty scheme'],
  ])('rejects %j (%s)', (symbol) => {
    expect(() => parseScipSymbol(symbol)).toThrow(ScipSymbolParseError);
  });
});

describe('hashScipSymbol', () => {
  it('is deterministic and scip-prefixed', () => {
    const s = 'scip-dotnet nuget P 1.0.0 N/C#m().';
    expect(hashScipSymbol(s)).toBe(hashScipSymbol(s));
    expect(hashScipSymbol(s)).toMatch(/^scip:[0-9a-f]{32}$/);
  });

  it('distinguishes different symbols', () => {
    expect(hashScipSymbol('scip x . . A#')).not.toBe(hashScipSymbol('scip x . . B#'));
  });
});

describe('nodeKindForScipSymbol', () => {
  it('falls back to the trailing descriptor suffix', () => {
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v C#'))).toBe('class');
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v C#m().'))).toBe('method');
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v Ns/'))).toBe('namespace');
  });

  it('lets SymbolInformation.kind override the descriptor default', () => {
    // 29 = Module — load-bearing for VB.NET (a `#` descriptor would default to class).
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v MyModule#'), 29)).toBe('module');
    // 17 = Function.
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v free().'), 17)).toBe('function');
    // 9 = Constructor.
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v C#`<init>`().'), 9)).toBe(
      'constructor',
    );
  });

  it('ignores Unspecified (0) and unknown kinds, using the descriptor', () => {
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v C#'), 0)).toBe('class');
    expect(nodeKindForScipSymbol(parseScipSymbol('s p n v C#'), 9999)).toBe('class');
  });
});

describe('descriptorSuffixToNodeKind', () => {
  it('maps each suffix to a NodeKind', () => {
    expect(descriptorSuffixToNodeKind('type')).toBe('class');
    expect(descriptorSuffixToNodeKind('method')).toBe('method');
    expect(descriptorSuffixToNodeKind('namespace')).toBe('namespace');
    expect(descriptorSuffixToNodeKind('parameter')).toBe('parameter');
    expect(descriptorSuffixToNodeKind('macro')).toBe('function');
    expect(descriptorSuffixToNodeKind('local')).toBe('variable');
  });
});
