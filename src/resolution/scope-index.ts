/**
 * P0.5b — minimal scope index (file + class scope).
 *
 * The default Phase-2 resolution (`import-resolver` + `name-matcher`) is a
 * heuristic that yields ambiguous targets. The scope index narrows a use-site
 * name against the lexical containers it is actually visible in — file scope,
 * then enclosing-class scope — using the graph VBGraph already extracted
 * (`nodes` + `contains` edges). Because it works off that graph rather than
 * re-walking each language's AST, it is language-agnostic; it covers the
 * SCIP-priority languages (C#, VB.NET, Java, Python, TypeScript) uniformly.
 *
 * Out of scope (per the plan): lexical/block scope, generic-parameter scope,
 * conditional-compilation branches, and cross-module visibility — those are
 * SCIP territory.
 */

import type { NodeKind } from '../types';
import type { QueryBuilder } from '../db/queries';

/** A symbol the scope index can resolve a name to. */
export interface SymbolRef {
  nodeId: string;
  name: string;
  kind: NodeKind;
  qualifiedName: string;
}

/** Where a name is being used — its file and (optional) enclosing class. */
export interface ScopeUseSite {
  filePath: string;
  /** Qualified name of the enclosing class, when the use site is inside one. */
  enclosingClass?: string;
}

export interface ScopeIndex {
  /** Declarations visible at file scope (top-level declarations of a file). */
  fileScope(filePath: string): SymbolRef[];
  /** Declarations visible at class scope (members of a class). */
  classScope(classQualifiedName: string): SymbolRef[];
  /** Resolve a name from a use site, walking class scope then file scope. */
  resolve(name: string, useSite: ScopeUseSite): SymbolRef | null;
}

/** Node kinds that constitute a resolvable declaration. */
const DECLARATION_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
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
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'module',
  'constructor',
  'event',
  'component',
]);

function toSymbolRef(node: {
  id: string;
  name: string;
  kind: NodeKind;
  qualifiedName: string;
}): SymbolRef {
  return {
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    qualifiedName: node.qualifiedName,
  };
}

/**
 * Build a graph-backed scope index over an already-extracted project.
 *
 * Lookups are lazy and memoized for the lifetime of the returned index — call
 * it after extraction, discard it before the next.
 */
export function buildScopeIndex(qb: QueryBuilder): ScopeIndex {
  const fileScopeCache = new Map<string, SymbolRef[]>();
  const classScopeCache = new Map<string, SymbolRef[]>();

  function fileScope(filePath: string): SymbolRef[] {
    const cached = fileScopeCache.get(filePath);
    if (cached) {
      return cached;
    }
    const refs = qb
      .getNodesByFile(filePath)
      .filter((n) => DECLARATION_KINDS.has(n.kind))
      .map(toSymbolRef);
    fileScopeCache.set(filePath, refs);
    return refs;
  }

  function classScope(classQualifiedName: string): SymbolRef[] {
    const cached = classScopeCache.get(classQualifiedName);
    if (cached) {
      return cached;
    }
    const refs: SymbolRef[] = [];
    for (const classNode of qb.getNodesByQualifiedNameExact(classQualifiedName)) {
      for (const edge of qb.getOutgoingEdges(classNode.id, ['contains'])) {
        const member = qb.getNodeById(edge.target);
        if (member && DECLARATION_KINDS.has(member.kind)) {
          refs.push(toSymbolRef(member));
        }
      }
    }
    classScopeCache.set(classQualifiedName, refs);
    return refs;
  }

  function resolve(name: string, useSite: ScopeUseSite): SymbolRef | null {
    // Innermost-first: class scope shadows file scope.
    if (useSite.enclosingClass) {
      const inClass = classScope(useSite.enclosingClass).find((r) => r.name === name);
      if (inClass) {
        return inClass;
      }
    }
    const inFile = fileScope(useSite.filePath).find((r) => r.name === name);
    return inFile ?? null;
  }

  return { fileScope, classScope, resolve };
}
