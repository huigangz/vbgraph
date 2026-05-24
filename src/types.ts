/**
 * CodeGraph Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the knowledge graph.
 *
 * Defined as a runtime-iterable `as const` array so the same source
 * of truth backs both the TS type and any runtime validation
 * (e.g. the search query parser).
 */
export const NODE_KINDS = [
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
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  | 'contains'        // Parent contains child (file→class, class→method)
  | 'calls'           // Function/method calls another
  | 'imports'         // File imports from another
  | 'exports'         // File exports a symbol
  | 'extends'         // Class/interface extends another
  | 'implements'      // Class implements interface
  | 'references'      // Generic reference to another symbol
  | 'type_of'         // Variable/parameter has type
  | 'returns'         // Function returns type
  | 'instantiates'    // Creates instance of class
  | 'overrides'       // Method overrides parent method
  | 'decorates';      // Decorator applied to symbol

/**
 * Which extractor / resolution stage produced a node or edge.
 *
 * `framework:${string}` covers every framework resolver (`framework:aspnet`,
 * `framework:spring`, ...). Optional on `Node`/`Edge`; the absent value is
 * treated as `'tree-sitter'`.
 */
export type GraphProvenance =
  | 'tree-sitter'
  | 'tree-sitter (scip-empty-fallback)'
  | 'scope-resolved'
  | 'scip'
  | 'scip:external'
  | 'heuristic'
  | `framework:${string}`;

/**
 * Supported programming languages. See NODE_KINDS for why this is a
 * runtime-iterable const array.
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'liquid',
  'pascal',
  'scala',
  'vbnet',
  'external',
  'unknown',
] as const;

export type Language = (typeof LANGUAGES)[number];

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * A node in the knowledge graph representing a code symbol
 */
export interface Node {
  /** Unique identifier (hash of file path + qualified name) */
  id: string;

  /** Type of code element */
  kind: NodeKind;

  /** Simple name (e.g., "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g., "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language: Language;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Starting column (0-indexed) */
  startColumn: number;

  /** Ending column (0-indexed) */
  endColumn: number;

  /** Documentation string if present */
  docstring?: string;

  /** Function/method signature */
  signature?: string;

  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Whether symbol is abstract */
  isAbstract?: boolean;

  /** Decorators/annotations applied */
  decorators?: string[];

  /** Generic type parameters */
  typeParameters?: string[];

  /** Which extractor produced this node (defaults to `'tree-sitter'`). */
  provenance?: GraphProvenance;

  /** Original SCIP symbol string — set on SCIP-derived nodes only. */
  scipSymbol?: string;

  /**
   * Path of the `.scip` index that owns this node. Set on internal SCIP
   * nodes; NULL for external nodes (their ownership lives in
   * `scip_external_refs`) and for non-SCIP nodes.
   */
  scipIndexPath?: string;

  /** When the node was last updated */
  updatedAt: number;
}

/**
 * An edge representing a relationship between two nodes
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown>;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;

  /**
   * Primary (highest-priority) extractor that produced this edge.
   * Defaults to `'tree-sitter'` when absent.
   */
  provenance?: GraphProvenance;

  /**
   * Audit trail: every extractor that has independently observed this exact
   * edge fingerprint. Append-only; never shrinks. `provenance` above is the
   * highest-priority member of this set.
   */
  provenances?: GraphProvenance[];

  /** Resolution confidence in [0, 1]. */
  confidence?: number;

  /**
   * Edge subkind, e.g. `'di_binding'` / `'config'` / `'convention'` for
   * framework `references` edges. Free-form; does not extend `EdgeKind`.
   */
  subkind?: string;
}

// =============================================================================
// Provenance ranking and edge position invariant
// =============================================================================

/**
 * Confidence tier derived from `provenance` — a coarse, switchable view over
 * the continuous `confidence` value. Computed, never stored.
 */
export type ConfidenceTier =
  | 'compiler'
  | 'syntactic'
  | 'scope-resolved'
  | 'inferred'
  | 'ambiguous';

/** Derive the coarse `ConfidenceTier` for a node/edge `provenance`. */
export function deriveConfidenceTier(prov: GraphProvenance | undefined): ConfidenceTier {
  if (prov === undefined) return 'ambiguous';
  if (prov === 'scip' || prov === 'scip:external') return 'compiler';
  if (prov === 'tree-sitter' || prov === 'tree-sitter (scip-empty-fallback)') {
    return 'syntactic';
  }
  if (prov === 'scope-resolved') return 'scope-resolved';
  if (prov === 'heuristic') return 'inferred';
  if (prov.startsWith('framework:')) return 'inferred';
  return 'ambiguous';
}

/** Fixed-rank provenances; `framework:*` is handled by the prefix check below. */
const PROVENANCE_RANK: Readonly<Record<string, number>> = {
  scip: 100,
  'scip:external': 90,
  'scope-resolved': 80,
  'tree-sitter': 70,
  // framework:* => 60
  heuristic: 50,
  'tree-sitter (scip-empty-fallback)': 40,
};

/** Priority of a provenance for "which extractor is primary". Higher wins. */
export function provenanceRank(p: GraphProvenance): number {
  if (p.startsWith('framework:')) return 60; // all framework:* are equal-priority peers
  return PROVENANCE_RANK[p] ?? 0;
}

/**
 * The highest-priority provenance in a set. Stable: among equal-priority
 * peers (e.g. two `framework:*`), the first-occurring one wins.
 */
export function pickPrimaryProvenance(provs: GraphProvenance[]): GraphProvenance {
  if (provs.length === 0) {
    throw new Error('pickPrimaryProvenance: empty input');
  }
  return provs.reduce((best, p) => (provenanceRank(p) > provenanceRank(best) ? p : best));
}

/** Default `confidence` for an edge produced by a given provenance. */
export function defaultConfidence(prov: GraphProvenance): number {
  switch (prov) {
    case 'scip':
    case 'scip:external':
      return 1.0;
    case 'scope-resolved':
      return 0.75;
    case 'tree-sitter':
    case 'tree-sitter (scip-empty-fallback)':
      return 0.7;
    case 'heuristic':
      return 0.6;
    default:
      return prov.startsWith('framework:') ? 0.85 : 0.7;
  }
}

/**
 * `references` subkinds whose edges may legitimately carry no source
 * line/column (framework convention edges declared in config, not at a
 * source call site).
 */
export const REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION = new Set<string>([
  'di_binding',
  'config',
  'convention',
]);

/** Edge kinds that are pure symbol-to-symbol relations — never positioned. */
const POSITION_FORBIDDEN_KINDS = new Set<EdgeKind>([
  'contains',
  'extends',
  'type_of',
  'returns',
  'overrides',
  'decorates',
  'imports',
  'exports',
]);

/** Edge kinds that may carry a position but do not require one. */
const POSITION_OPTIONAL_KINDS = new Set<EdgeKind>(['instantiates', 'implements']);

/** True when `edge` carries a full source position (both line and column). */
function edgeHasLineAndColumn(edge: Edge): boolean {
  return (
    edge.line !== undefined &&
    edge.line !== null &&
    edge.column !== undefined &&
    edge.column !== null
  );
}

/** True when `edge` carries either a line or a column. */
function edgeHasAnyPosition(edge: Edge): boolean {
  return (
    (edge.line !== undefined && edge.line !== null) ||
    (edge.column !== undefined && edge.column !== null)
  );
}

/**
 * Strict three-tier edge line/column invariant check. Throws on violation.
 * Used by the SCIP persister and framework augmenters on edges they produce,
 * and by tests. `upsertGraphEdge` normalizes via `coerceEdgePosition` first,
 * so a forbidden-kind edge never reaches a strict caller with a stray position.
 *
 * Positioned kinds (`calls`, non-whitelisted `references`) require **both**
 * line and column; forbidden kinds must carry **neither**.
 */
export function validateEdgeLineColumn(edge: Edge): void {
  if (edge.kind === 'calls') {
    if (!edgeHasLineAndColumn(edge)) {
      throw new Error(
        `edge kind 'calls' requires a line and column (${edge.source} -> ${edge.target})`,
      );
    }
    return;
  }

  if (edge.kind === 'references') {
    if (edge.subkind && REFERENCES_SUBKINDS_ALLOWING_NULL_POSITION.has(edge.subkind)) {
      return; // framework convention edge — null position allowed
    }
    if (!edgeHasLineAndColumn(edge)) {
      throw new Error(
        `edge kind 'references'` +
          (edge.subkind ? ` subkind '${edge.subkind}'` : '') +
          ` requires a line and column (${edge.source} -> ${edge.target})`,
      );
    }
    return;
  }

  if (POSITION_OPTIONAL_KINDS.has(edge.kind)) {
    return;
  }

  if (POSITION_FORBIDDEN_KINDS.has(edge.kind)) {
    if (edgeHasAnyPosition(edge)) {
      throw new Error(`edge kind '${edge.kind}' must not carry a line/column`);
    }
    return;
  }
}

/**
 * Normalize an edge's position before persistence: strip line/column from
 * pure-relation kinds (which must never be positioned). Returns the input
 * unchanged when nothing needs stripping. Non-throwing — the lenient
 * counterpart to `validateEdgeLineColumn`, used by `upsertGraphEdge` so a
 * stray position from a legacy extractor cannot abort an index.
 */
export function coerceEdgePosition(edge: Edge): Edge {
  if (POSITION_FORBIDDEN_KINDS.has(edge.kind) && edgeHasAnyPosition(edge)) {
    const { line: _line, column: _column, ...rest } = edge;
    return rest;
  }
  return edge;
}

/**
 * Metadata about a tracked file
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: Language;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: ExtractionError[];
}

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * Result from parsing a source file
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * Error during code extraction
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** File path where the error occurred */
  filePath?: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';

  /** Error code for categorization */
  code?: string;
}

/**
 * A reference that couldn't be resolved during extraction
 */
export interface UnresolvedReference {
  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: EdgeKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for performance) */
  filePath?: string;

  /** Language of the source file (denormalized for performance) */
  language?: Language;

  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /** File path patterns to include */
  includePatterns?: string[];

  /** File path patterns to exclude */
  excludePatterns?: string[];

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;

  /**
   * Restrict results to nodes carrying this Phase 3 tag (e.g.
   * `spring:service`, `react:hook`, `route-handler`). Pushed into the
   * candidate SQL so FTS / LIKE / fuzzy / filter-only paths all return
   * at most `limit` already-tagged rows. Without this, post-filtering
   * after the FTS limit cuts off tagged matches ranked below the
   * window.
   */
  tag?: string;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /** Relevance score (0-1) */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];
}

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context information for code understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (file, class, etc.) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (who calls/uses this) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this calls/uses) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** Related type information */
  types: Node[];

  /** Relevant imports */
  imports: Node[];
}

/**
 * A block of code with context
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;
}

// =============================================================================
// Configuration Types
// =============================================================================

/**
 * Framework-specific hints for better extraction
 */
export interface FrameworkHint {
  /** Framework name (react, express, django, etc.) */
  name: string;

  /** Version constraint if relevant */
  version?: string;

  /** Custom patterns for this framework */
  patterns?: {
    /** Component detection patterns */
    components?: string[];
    /** Route detection patterns */
    routes?: string[];
    /** Model detection patterns */
    models?: string[];
  };
}

/**
 * Configuration for a CodeGraph project
 */
export interface CodeGraphConfig {
  /** Schema version for migrations */
  version: number;

  /** Root directory of the project */
  rootDir: string;

  /** Glob patterns for files to include */
  include: string[];

  /** Glob patterns for files to exclude */
  exclude: string[];

  /** Languages to process (auto-detected if empty) */
  languages: Language[];

  /** Framework hints for better extraction */
  frameworks: FrameworkHint[];

  /** Maximum file size to process (in bytes) */
  maxFileSize: number;

  /** Whether to extract docstrings */
  extractDocstrings: boolean;

  /** Whether to track call sites */
  trackCallSites: boolean;

  /** Custom symbol patterns to extract */
  customPatterns?: {
    /** Name for this pattern group */
    name: string;
    /** Regex pattern to match */
    pattern: string;
    /** Node kind to assign */
    kind: NodeKind;
  }[];

  /** Pre-built `.scip` index sources for explicit (`--scip`) ingestion. */
  scipSources?: {
    /** Explicit `.scip` file paths. */
    files?: string[];
    /** Glob for discovering `.scip` files (default `'./index.scip'`). */
    glob?: string;
  };

  /**
   * A SCIP document with zero occurrences but a source file larger than this
   * many bytes falls back to tree-sitter extraction. Defaults to 200.
   */
  emptyFallbackThresholdBytes?: number;

  /** When true, `codegraph index` auto-detects and spawns SCIP indexers. */
  scipAuto?: boolean;

  /** SCIP indexer names to skip in `--scip-auto` mode. */
  disabledScipIndexers?: string[];
}

/**
 * Default configuration values
 */
export const DEFAULT_CONFIG: CodeGraphConfig = {
  version: 1,
  rootDir: '.',
  include: [
    // TypeScript/JavaScript
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    // Python
    '**/*.py',
    // Go
    '**/*.go',
    // Rust
    '**/*.rs',
    // Java
    '**/*.java',
    // C/C++
    '**/*.c',
    '**/*.h',
    '**/*.cpp',
    '**/*.hpp',
    '**/*.cc',
    '**/*.cxx',
    // C#
    '**/*.cs',
    // VB.NET
    '**/*.vb',
    // PHP
    '**/*.php',
    // Ruby
    '**/*.rb',
    // Swift
    '**/*.swift',
    // Kotlin
    '**/*.kt',
    '**/*.kts',
    // Dart
    '**/*.dart',
    // Svelte
    '**/*.svelte',
    // Vue
    '**/*.vue',
    // Liquid (Shopify themes)
    '**/*.liquid',
    // Pascal / Delphi
    '**/*.pas',
    '**/*.dpr',
    '**/*.dpk',
    '**/*.lpr',
    '**/*.dfm',
    '**/*.fmx',
    // Scala
    '**/*.scala',
    '**/*.sc',
  ],
  exclude: [
    // Version control
    '**/.git/**',

    // Dependencies
    '**/node_modules/**',
    '**/vendor/**',
    '**/Pods/**',

    // Generic build outputs
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/bin/**',
    '**/obj/**',
    '**/target/**',

    // JavaScript/TypeScript
    '**/*.min.js',
    '**/*.bundle.js',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.output/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/.vite/**',
    '**/.astro/**',
    '**/.docusaurus/**',
    '**/.gatsby/**',
    '**/.webpack/**',
    '**/.nx/**',
    '**/.yarn/cache/**',
    '**/.pnpm-store/**',
    '**/storybook-static/**',

    // React Native / Expo
    '**/.expo/**',
    '**/web-build/**',
    '**/ios/Pods/**',
    '**/ios/build/**',
    '**/android/build/**',
    '**/android/.gradle/**',

    // Python
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/site-packages/**',
    '**/dist-packages/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/*.egg-info/**',
    '**/.eggs/**',

    // Go
    '**/go/pkg/mod/**',

    // Rust
    '**/target/debug/**',
    '**/target/release/**',

    // Java/Kotlin/Gradle
    '**/.gradle/**',
    '**/.m2/**',
    '**/generated-sources/**',
    '**/.kotlin/**',

    // Dart/Flutter
    '**/.dart_tool/**',

    // C#/.NET
    '**/.vs/**',
    '**/.nuget/**',
    '**/artifacts/**',
    '**/publish/**',

    // C/C++
    '**/cmake-build-*/**',
    '**/CMakeFiles/**',
    '**/bazel-*/**',
    '**/vcpkg_installed/**',
    '**/.conan/**',
    '**/Debug/**',
    '**/Release/**',
    '**/x64/**',
    '**/.pio/**',  // Platform.io (IoT/embedded build artifacts and library deps)

    // Electron
    '**/release/**',
    '**/*.app/**',
    '**/*.asar',

    // Swift/iOS/Xcode
    '**/DerivedData/**',
    '**/.build/**',
    '**/.swiftpm/**',
    '**/xcuserdata/**',
    '**/Carthage/Build/**',
    '**/SourcePackages/**',

    // Delphi/Pascal
    '**/__history/**',
    '**/__recovery/**',
    '**/*.dcu',

    // PHP
    '**/.composer/**',
    '**/storage/framework/**',
    '**/bootstrap/cache/**',

    // Ruby
    '**/.bundle/**',
    '**/tmp/cache/**',
    '**/public/assets/**',
    '**/public/packs/**',
    '**/.yardoc/**',

    // Testing/Coverage
    '**/coverage/**',
    '**/htmlcov/**',
    '**/.nyc_output/**',
    '**/test-results/**',
    '**/.coverage/**',

    // IDE/Editor
    '**/.idea/**',

    // Logs and temp
    '**/logs/**',
    '**/tmp/**',
    '**/temp/**',

    // Documentation build output
    '**/_build/**',
    '**/docs/_build/**',
    '**/site/**',
  ],
  languages: [],
  frameworks: [],
  maxFileSize: 1024 * 1024, // 1MB
  extractDocstrings: true,
  trackCallSites: true,
};

// =============================================================================
// Database Types
// =============================================================================

/**
 * Database schema version info
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}

// =============================================================================
// Task Context Types (for buildContext)
// =============================================================================

/**
 * Input for building task context
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown') */
  format?: 'markdown' | 'json';

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;
}

/**
 * Full context for a task, ready for Claude
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };
}

/**
 * Options for finding relevant context
 */
export interface FindRelevantContextOptions {
  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth (default: 2) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 50) */
  maxNodes?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];
}
