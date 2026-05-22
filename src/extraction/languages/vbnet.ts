import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * VB.NET tree-sitter extractor — the Tier 0 backstop (~70% of SCIP precision).
 *
 * Covers Module / Class / Namespace / Interface / Structure / Enum containers,
 * Sub/Function (`method_declaration`) and Property signatures, fields, per-file
 * `Imports`, and file-local calls.
 *
 * NOT covered — Tier 1 (SCIP) only: `Inherits` / `Implements` edges (the
 * pinned community grammar misparses those statements — see worklog P0.6b),
 * and the compiler-magic features `My.*`, project-level `.vbproj` Imports,
 * `WithEvents`+`Handles`, late binding, conditional compilation, and
 * cross-project references.
 *
 * Grammar: CodeAnt-AI/tree-sitter-vb-dotnet, pinned in vbnet.wasm.sha256.
 */

/** Lowercased text of a node's `modifiers` field (VB keywords, case-insensitive). */
function modifierText(node: SyntaxNode): string {
  return (getChildByField(node, 'modifiers')?.text ?? '').toLowerCase();
}

export const vbnetExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: ['class_block'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_block'],
  structTypes: ['structure_block'],
  enumTypes: ['enum_block'],
  enumMemberTypes: ['enum_member'],
  typeAliasTypes: ['delegate_declaration'],
  moduleTypes: ['module_block'],
  namespaceTypes: ['namespace_block'],
  importTypes: ['imports_statement'],
  callTypes: ['invocation'],
  variableTypes: ['const_declaration'],
  fieldTypes: ['field_declaration', 'event_declaration'],
  propertyTypes: ['property_declaration'],

  // VB declarations expose members/statements as direct children — there is no
  // `body` field. `extractClass` already falls back to the node itself, but
  // `extractMethod` skips a method whose body field is absent; `resolveBody`
  // returns the declaration node so the method's statements (and the calls in
  // them) are walked.
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  resolveBody: (node) => node,

  getVisibility: (node) => {
    const text = modifierText(node);
    if (text.includes('public')) return 'public';
    if (text.includes('friend')) return 'internal'; // VB `Friend` == C# `internal`
    if (text.includes('protected')) return 'protected';
    if (text.includes('private')) return 'private';
    return undefined;
  },

  // VB `Shared` is the static modifier.
  isStatic: (node) => modifierText(node).includes('shared'),

  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const namespace = getChildByField(node, 'namespace');
    if (namespace) {
      return { moduleName: getNodeText(namespace, source), signature: importText };
    }
    return null;
  },
};
