/**
 * Reference Resolution Types
 *
 * Types for the reference resolution system.
 */

import { Edge, EdgeKind, ExtractionError, Language, Node } from '../types';
import { GraphView } from './graph-view';

/**
 * An unresolved reference from extraction
 */
export interface UnresolvedRef {
  /** ID of the source node containing the reference */
  fromNodeId: string;
  /** The name being referenced */
  referenceName: string;
  /** Type of reference */
  referenceKind: EdgeKind;
  /** Line where reference occurs */
  line: number;
  /** Column where reference occurs */
  column: number;
  /** File path where reference occurs */
  filePath: string;
  /** Language of the source file */
  language: Language;
  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

/**
 * A resolved reference
 */
export interface ResolvedRef {
  /** Original unresolved reference */
  original: UnresolvedRef;
  /** ID of the target node */
  targetNodeId: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** How it was resolved */
  resolvedBy: 'exact-match' | 'import' | 'qualified-name' | 'framework' | 'fuzzy' | 'instance-method' | 'file-path' | 'scope';
}

/**
 * Result of resolution attempt
 */
export interface ResolutionResult {
  /** Successfully resolved references */
  resolved: ResolvedRef[];
  /** References that couldn't be resolved */
  unresolved: UnresolvedRef[];
  /** Statistics */
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    byMethod: Record<string, number>;
  };
}

/**
 * Context for resolution - provides access to the graph
 */
export interface ResolutionContext {
  /** Get all nodes in a file */
  getNodesInFile(filePath: string): Node[];
  /** Get all nodes by name */
  getNodesByName(name: string): Node[];
  /** Get all nodes by qualified name */
  getNodesByQualifiedName(qualifiedName: string): Node[];
  /** Get all nodes of a kind */
  getNodesByKind(kind: Node['kind']): Node[];
  /** Check if a file exists */
  fileExists(filePath: string): boolean;
  /** Read file content */
  readFile(filePath: string): string | null;
  /** Get project root */
  getProjectRoot(): string;
  /** Get all files */
  getAllFiles(): string[];
  /** Get nodes by lowercase name (O(1) lookup for fuzzy matching) */
  getNodesByLowerName(lowerName: string): Node[];
  /** Get cached import mappings for a file */
  getImportMappings(filePath: string, language: Language): ImportMapping[];
  /**
   * Project import-path aliases (tsconfig/jsconfig `paths`). Returns
   * `null` when the project doesn't define any. Cached per resolver
   * instance — safe to call from any resolver code path. Optional so
   * existing test fixtures and external context implementations
   * compile without modification; production resolver implements it.
   */
  getProjectAliases?(): import('./path-aliases').AliasMap | null;
  /**
   * Re-exports declared by a file (`export { x } from './other'`,
   * `export * from './other'`). Empty array when the file has none.
   * Optional so older callers compile; the import resolver follows
   * re-export chains when this is provided.
   */
  getReExports?(filePath: string, language: Language): ReExport[];
  /**
   * List immediate subdirectories of `relativePath` (relative to the
   * project root). Returns an empty array when the path doesn't exist
   * or isn't a directory. Used by framework resolvers that need to
   * walk build-system metadata (e.g. Cargo workspace globs). Optional
   * so external context implementations and test fixtures compile
   * without modification.
   */
  listDirectories?(relativePath: string): string[];
}

/**
 * Result of framework-specific file extraction.
 */
export interface FrameworkExtractionResult {
  /** Framework-specific nodes (e.g. routes) */
  nodes: Node[];
  /** Framework-specific unresolved references (e.g. route -> handler) */
  references: UnresolvedRef[];
}

/**
 * Framework-specific resolver.
 *
 * P1 introduces `synthesize` / `augment` — project-level hooks that run
 * against the complete static graph (SCIP + tree-sitter + scope-resolved)
 * after extraction. The per-file `extract` and per-ref `resolve` hooks
 * remain during the migration window and will be removed in a P3 cleanup
 * once every resolver has migrated.
 */
export interface FrameworkResolver {
  /** Framework name. Equals the `framework:<name>` provenance suffix. */
  name: string;
  /** Languages this framework applies to. If omitted, applies to all languages. */
  languages?: Language[];
  /** Detect if project uses this framework (project-level, called once at startup) */
  detect(context: ResolutionContext): boolean;

  // ── Legacy API. Retained during migration; removed in P3. ────────────

  /** @deprecated Use synthesize() + augment() instead. Slated for P3 removal. */
  resolve?(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;

  /**
   * @deprecated Use synthesize() instead. Slated for P3 removal.
   *
   * Extract framework-specific nodes and references from a file. Returns
   * route nodes, middleware nodes, etc., plus unresolved references that
   * link those nodes to handlers (view classes, controller methods,
   * included modules). Unresolved references flow into the normal
   * resolution pipeline.
   */
  extract?(filePath: string, content: string): FrameworkExtractionResult;

  // ── New API ─────────────────────────────────────────────────────────

  /**
   * Project-level node and inherent-tag synthesis. Sees the complete
   * static graph (SCIP + tree-sitter + scope-resolved). Produces:
   *
   *   - framework-specific nodes whose `kind` is one of `route` or
   *     `component` ONLY. Never `bean` / `hook` / `workflow` / similar
   *     role-tags that already have a source-code counterpart — those
   *     are emitted as tags on the existing node (see "Node-kind
   *     discipline" in the plan).
   *   - INHERENT tags on existing nodes (annotations, naming conventions
   *     — e.g. `spring:service` on a `@Service`-annotated class). These
   *     are persisted in STAGE B and visible to every resolver's
   *     `augment()` via view2.
   *
   * Does NOT produce edges — edges live in `augment()` so all resolvers'
   * synthesized nodes are visible to every augment pass.
   *
   * Each Node MUST carry `provenance = 'framework:<this.name>'` and a
   * deterministic `id` namespaced `framework:<name>:<deterministic-suffix>`.
   * `Phase3Orchestrator` rejects violations with a warning-severity
   * `ExtractionError`.
   *
   * A thrown `synthesize` quarantines this resolver's output and records
   * one `ExtractionError`; sibling resolvers complete normally.
   */
  synthesize?(graph: GraphView): SynthesizeResult;

  /**
   * Project-level edge + derived-tag synthesis. Runs after all
   * `synthesize()` calls AND a view rebuild, so it sees every
   * synthesize's nodes AND inherent tags.
   *
   * Edges MUST carry `provenance = 'framework:<this.name>'`. Convention
   * edges use `kind='references'` plus one of the P0 allowlist subkinds
   * (`di_binding` / `config` / `convention`) and may carry NULL
   * line/column. Real call sites (Temporal dispatch) use `kind='calls'`
   * plus `subkind='temporal_dispatch'` and MUST carry line/col.
   *
   * Edges MUST NOT carry `metadata`. Metadata is owned by the static
   * extractor that first produced the edge; augment-time writes have no
   * place to go on retraction. `Phase3Orchestrator`'s edge pre-flight
   * rejects framework edges with non-empty metadata.
   *
   * Tags emitted here are DERIVED from edge construction (e.g.
   * `route-handler` on a method that just became the target of a route
   * edge). They are persisted in STAGE E and are NOT visible to other
   * augments in the same run — only post-Phase-3 queries see them.
   * If a resolver needs another resolver to see its tags during augment,
   * the source resolver MUST emit those tags in `synthesize`, not
   * `augment`.
   *
   * A thrown `augment` quarantines this resolver's output and records one
   * `ExtractionError`; sibling resolvers complete normally.
   */
  augment?(graph: GraphView): AugmentResult;
}

/**
 * Result of a resolver's `synthesize()` call.
 */
export interface SynthesizeResult {
  /** Framework-synthesized nodes; each MUST have `provenance = 'framework:<resolver.name>'`. */
  nodes: Node[];
  /**
   * INHERENT tags on existing nodes — annotations or naming conventions
   * that hold regardless of edges (e.g. `spring:service` on a
   * `@Service`-annotated class). Persisted in STAGE B; visible to every
   * augment pass via view2. Tag strings MUST be kebab-case (matching the
   * regex enforced by `Phase3Orchestrator.isValidTagFormat`).
   */
  tags?: Array<{ nodeId: string; tags: string[] }>;
  /** Diagnostics surfaced through the normal ExtractionError channel. */
  errors?: ExtractionError[];
}

/**
 * Result of a resolver's `augment()` call.
 */
export interface AugmentResult {
  /**
   * Framework-derived edges. Each MUST have
   * `provenance = 'framework:<resolver.name>'` and MUST NOT carry
   * `metadata` — see `FrameworkResolver.augment` doc.
   */
  edges: Edge[];
  /**
   * DERIVED tags that follow from an edge this resolver just emitted
   * (e.g. `route-handler`). Persisted in STAGE E; NOT visible to sibling
   * augments in the same Phase 3 run.
   */
  tags?: Array<{ nodeId: string; tags: string[] }>;
  /** Diagnostics surfaced through the normal ExtractionError channel. */
  errors?: ExtractionError[];
}

/**
 * Import mapping from a file
 */
export interface ImportMapping {
  /** Local name used in the file */
  localName: string;
  /** Original exported name (may differ due to aliasing) */
  exportedName: string;
  /** Source module/path */
  source: string;
  /** Whether it's a default import */
  isDefault: boolean;
  /** Whether it's a namespace import (import * as X) */
  isNamespace: boolean;
  /** Resolved file path (if local) */
  resolvedPath?: string;
}

/**
 * Re-export from a file: `export { x } from './other'` or
 * `export * from './other'`. Used by the resolver to chase
 * symbols through barrel files.
 */
export type ReExport =
  | {
      kind: 'named';
      /** Name as exported by THIS file. */
      exportedName: string;
      /** Name in the upstream module (differs when renamed: `as`). */
      originalName: string;
      /** Module specifier of the upstream module. */
      source: string;
    }
  | {
      kind: 'wildcard';
      /** Module specifier of the upstream module. */
      source: string;
    };
