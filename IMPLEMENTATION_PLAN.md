# CodeGraph: Universal Code Knowledge Graph

## Overview

CodeGraph is a local-first code intelligence system that builds a semantic knowledge graph from any codebase. It provides structural understanding of code relationships—not just text similarity—enabling AI assistants to understand how code connects, what depends on what, and what breaks when something changes.

**Type:** Headless library (no UI components — purely an API)  
**Runtime:** Node.js (works standalone, in Electron, or any Node environment)  
**Distribution:** npm package, installable in any project  
**Per-Project Data:** `.codegraph/` directory in each indexed project
**Core Principle:** Deterministic extraction from AST, not AI-generated summaries

### Use Cases

1. **Beads Dashboard** — Integrated as a library to provide code intelligence
2. **Claude Code CLI users** — Install globally, run `codegraph init` in any project
3. **Any Node.js application** — Import as a library for code analysis
4. **MCP Server** — Expose as an MCP tool that Claude Code can query directly

---

## Goals

1. **Universal language support** via tree-sitter (PHP, Swift, Kotlin, Java, TypeScript, Python, Liquid, Ruby, Go, Rust, C#, etc.)
2. **Zero external API dependencies** for core functionality (local embeddings, local database)
3. **Portable per-project installation** — each project gets its own `.codegraph/` directory
4. **Incremental updates** via git hooks and hash-based change detection
5. **Rich structural queries** — callers, callees, impact radius, dependency chains
6. **Semantic search** — vector similarity to find entry points, then graph expansion

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         CONSUMERS                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │    Beads     │  │   Claude     │  │   Any Node.js App    │  │
│  │  Dashboard   │  │  Code CLI    │  │   / MCP Server       │  │
│  │  (Electron)  │  │  (Terminal)  │  │                      │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│         └─────────────────┼──────────────────────┘              │
│                           │                                     │
│                           ▼                                     │
├─────────────────────────────────────────────────────────────────┤
│                     CODEGRAPH LIBRARY                           │
│                      (npm package)                              │
│                                                                 │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │   Context   │  │   Query     │  │   Sync                  │ │
│  │   Builder   │  │   Engine    │  │   Manager               │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────────┘ │
│         │                │                     │                │
│         └────────────────┼─────────────────────┘                │
│                          │                                      │
│                          ▼                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                   STORAGE LAYER                             ││
│  │         SQLite + sqlite-vss (per project)                   ││
│  │              .codegraph/graph.db                        ││
│  └─────────────────────────────────────────────────────────────┘│
│                          ▲                                      │
│                          │                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                 EXTRACTION LAYER                            ││
│  │                                                             ││
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ ││
│  │  │ Tree-sitter │  │  Reference  │  │   Framework         │ ││
│  │  │   Parser    │  │  Resolver   │  │   Patterns          │ ││
│  │  └─────────────┘  └─────────────┘  └─────────────────────┘ ││
│  └─────────────────────────────────────────────────────────────┘│
│                          ▲                                      │
│                          │                                      │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                  EMBEDDING LAYER                            ││
│  │          Local ONNX Runtime + nomic-embed                   ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

Per-Project Installation (created by codegraph init):
┌─────────────────────────────────────────────────────────────────┐
│  my-laravel-app/                                                │
│  ├── .codegraph/                                           │
│  │   ├── graph.db            # SQLite database with vectors     │
│  │   ├── config.json         # Project-specific settings        │
│  │   └── .gitignore          # Ignore db, keep config           │
│  ├── .git/                                                      │
│  │   └── hooks/                                                 │
│  │       └── post-commit     # Triggers incremental reindex     │
│  ├── app/                                                       │
│  ├── routes/                                                    │
│  └── ...                                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## File Structure (npm package)

```
codegraph/
├── package.json
├── tsconfig.json
├── README.md
│
├── src/
│   ├── index.ts                    # Main CodeGraph class, public API
│   ├── types.ts                    # TypeScript interfaces
│   │
│   ├── db/
│   │   ├── index.ts                # Database initialization
│   │   ├── schema.sql              # Table definitions
│   │   ├── migrations.ts           # Schema versioning
│   │   └── queries.ts              # Prepared statements
│   │
│   ├── extraction/
│   │   ├── index.ts                # Extraction orchestrator
│   │   ├── tree-sitter.ts          # Universal parser wrapper
│   │   ├── grammars.ts             # Grammar loading and caching
│   │   └── queries/                # Tree-sitter query files (.scm)
│   │       ├── typescript.scm
│   │       ├── javascript.scm
│   │       ├── php.scm
│   │       ├── swift.scm
│   │       ├── kotlin.scm
│   │       ├── java.scm
│   │       ├── python.scm
│   │       ├── ruby.scm
│   │       ├── liquid.scm
│   │       ├── go.scm
│   │       └── csharp.scm
│   │
│   ├── resolution/
│   │   ├── index.ts                # Reference resolver orchestrator
│   │   ├── name-matcher.ts         # Symbol name matching
│   │   ├── import-resolver.ts      # Import path resolution
│   │   └── frameworks/             # Framework-specific patterns
│   │       ├── index.ts
│   │       ├── laravel.ts
│   │       ├── express.ts
│   │       ├── nextjs.ts
│   │       ├── rails.ts
│   │       ├── shopify.ts
│   │       ├── spring.ts
│   │       └── swiftui.ts
│   │
│   ├── graph/
│   │   ├── index.ts                # Graph query interface
│   │   ├── traversal.ts            # BFS/DFS, impact radius
│   │   └── serialize.ts            # Subgraph to context format
│   │
│   ├── vectors/
│   │   ├── index.ts                # Vector operations interface
│   │   ├── embedder.ts             # ONNX runtime + model
│   │   └── search.ts               # Similarity search
│   │
│   ├── sync/
│   │   ├── index.ts                # Sync orchestrator
│   │   ├── git-hooks.ts            # Hook installation
│   │   └── hasher.ts               # Content hashing for diffing
│   │
│   └── context/
│       ├── index.ts                # Context builder
│       └── formatter.ts            # Output formatting for Claude
│
├── bin/
│   └── codegraph.ts                # CLI entry point (optional standalone usage)
│
└── __tests__/                      # Test files mirror src structure
    ├── extraction/
    ├── resolution/
    ├── graph/
    └── fixtures/                   # Sample code files for testing
```

---

## Database Schema

**File: `src/db/schema.sql`**

```sql
-- ============================================================
-- CODEGRAPH SCHEMA v1
-- ============================================================

-- Metadata table for schema versioning and project info
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- ============================================================
-- NODES: Every significant code entity
-- ============================================================
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,                -- Unique ID: "func:src/auth.ts:validateToken:45"
    kind TEXT NOT NULL,                 -- file, function, method, class, interface, type, variable, route, component, config
    name TEXT NOT NULL,                 -- Human-readable: "validateToken"
    qualified_name TEXT,                -- Full path: "AuthService.validateToken"
    file_path TEXT NOT NULL,            -- Relative path: "src/services/auth.ts"
    start_line INTEGER,
    end_line INTEGER,
    start_column INTEGER,
    end_column INTEGER,
    language TEXT NOT NULL,             -- typescript, php, swift, etc.
    signature TEXT,                     -- For functions: "(token: string) => Promise<User>"
    docstring TEXT,                     -- Extracted documentation
    code_snippet TEXT,                  -- First ~500 chars of code for quick preview
    code_hash TEXT NOT NULL,            -- SHA256 of full code block
    metadata TEXT,                      -- JSON: extra language/framework-specific data
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- ============================================================
-- EDGES: Relationships between nodes
-- ============================================================
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    kind TEXT NOT NULL,                 -- imports, calls, extends, implements, returns_type, throws, reads, writes, renders, instantiates
    resolved INTEGER DEFAULT 0,         -- 0 = unresolved (name only), 1 = resolved to actual node
    target_name TEXT,                   -- Original name before resolution (for unresolved edges)
    line_number INTEGER,                -- Where this relationship occurs
    metadata TEXT,                      -- JSON: additional context
    UNIQUE(source_id, target_id, kind, line_number),
    FOREIGN KEY (source_id) REFERENCES nodes(id) ON DELETE CASCADE
    -- Note: target_id may reference non-existent node if unresolved/external
);

-- ============================================================
-- FILES: Track file-level state for incremental updates
-- ============================================================
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,              -- Relative file path
    content_hash TEXT NOT NULL,         -- SHA256 of file contents
    language TEXT NOT NULL,
    last_indexed INTEGER NOT NULL,      -- Unix timestamp
    node_count INTEGER DEFAULT 0,
    error TEXT                          -- Last indexing error, if any
);

-- ============================================================
-- VECTOR EMBEDDINGS (sqlite-vss)
-- ============================================================

-- Virtual table for vector similarity search
-- Dimension 384 for nomic-embed-text-v1.5
CREATE VIRTUAL TABLE IF NOT EXISTS node_vectors USING vss0(
    embedding(384)
);

-- Map vector rowids to nodes
CREATE TABLE IF NOT EXISTS vector_map (
    rowid INTEGER PRIMARY KEY,
    node_id TEXT NOT NULL UNIQUE,
    text_hash TEXT NOT NULL,            -- Hash of text that was embedded
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_nodes_file ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_resolved ON edges(resolved);
```

---

## Type Definitions

**File: `src/types.ts`**

```typescript
// ============================================================
// CORE TYPES
// ============================================================

export type NodeKind = 
  | 'file'
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'type'
  | 'variable'
  | 'constant'
  | 'route'
  | 'component'
  | 'config'
  | 'module'
  | 'namespace';

export type EdgeKind =
  | 'imports'
  | 'exports'
  | 'calls'
  | 'called_by'        // Reverse of calls, computed
  | 'extends'
  | 'implements'
  | 'returns_type'
  | 'throws'
  | 'reads'
  | 'writes'
  | 'renders'          // React/Vue component rendering
  | 'instantiates'
  | 'decorates'        // Decorators/attributes
  | 'depends_on';      // Generic dependency

export type Language =
  | 'typescript'
  | 'javascript'
  | 'php'
  | 'swift'
  | 'kotlin'
  | 'java'
  | 'python'
  | 'ruby'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'liquid'
  | 'vue'
  | 'svelte';

export interface Node {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  language: Language;
  signature?: string;
  docstring?: string;
  codeSnippet?: string;
  codeHash: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface Edge {
  id?: number;
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  resolved: boolean;
  targetName?: string;
  lineNumber?: number;
  metadata?: Record<string, unknown>;
}

export interface FileRecord {
  path: string;
  contentHash: string;
  language: Language;
  lastIndexed: number;
  nodeCount: number;
  error?: string;
}

// ============================================================
// EXTRACTION TYPES
// ============================================================

export interface ExtractionResult {
  nodes: Node[];
  edges: Edge[];
  errors: ExtractionError[];
}

export interface ExtractionError {
  filePath: string;
  line?: number;
  message: string;
  recoverable: boolean;
}

export interface UnresolvedReference {
  sourceId: string;
  targetName: string;
  kind: EdgeKind;
  lineNumber?: number;
  context?: string;       // Surrounding code for better resolution
}

// ============================================================
// QUERY TYPES
// ============================================================

export interface Subgraph {
  nodes: Node[];
  edges: Edge[];
  entryPoints: string[];  // Node IDs that initiated the query
  stats: {
    totalNodes: number;
    totalEdges: number;
    maxDepth: number;
  };
}

export interface TraversalOptions {
  maxDepth?: number;      // Default: 2
  maxNodes?: number;      // Default: 50
  edgeKinds?: EdgeKind[]; // Filter by edge type
  nodeKinds?: NodeKind[]; // Filter by node type
  direction?: 'outbound' | 'inbound' | 'both';
}

export interface SearchOptions {
  limit?: number;         // Default: 10
  nodeKinds?: NodeKind[]; // Filter results
  minScore?: number;      // Similarity threshold
}

export interface SearchResult {
  node: Node;
  score: number;
}

// ============================================================
// CONTEXT TYPES
// ============================================================

export interface Context {
  subgraph: Subgraph;
  codeBlocks: CodeBlock[];
  summary: string;
  relatedFiles: string[];
}

export interface CodeBlock {
  nodeId: string;
  nodeName: string;
  nodeKind: NodeKind;
  filePath: string;
  startLine: number;
  endLine: number;
  code: string;
  language: Language;
}

// ============================================================
// CONFIG TYPES
// ============================================================

export interface CodeGraphConfig {
  version: number;
  projectName?: string;
  languages: Language[];
  exclude: string[];              // Glob patterns to ignore
  include?: string[];             // Override: only index these
  frameworks: FrameworkHint[];    // Help with resolution
  embeddingModel: 'nomic-embed-text-v1.5' | 'all-MiniLM-L6-v2';
  chunkStrategy: 'ast' | 'hybrid';
  maxFileSize: number;            // Skip files larger than this (bytes)
  gitHooksEnabled: boolean;
}

export type FrameworkHint =
  | 'laravel'
  | 'express'
  | 'nextjs'
  | 'nuxt'
  | 'rails'
  | 'django'
  | 'flask'
  | 'spring'
  | 'swiftui'
  | 'uikit'
  | 'android'
  | 'shopify'
  | 'react'
  | 'vue'
  | 'svelte';

export const DEFAULT_CONFIG: CodeGraphConfig = {
  version: 1,
  languages: [],
  exclude: [
    'node_modules/**',
    'vendor/**',
    '.git/**',
    'dist/**',
    'build/**',
    '*.min.js',
    '*.bundle.js',
    '__pycache__/**',
    '.venv/**',
    'Pods/**',
    '.gradle/**',
  ],
  frameworks: [],
  embeddingModel: 'nomic-embed-text-v1.5',
  chunkStrategy: 'ast',
  maxFileSize: 1024 * 1024,  // 1MB
  gitHooksEnabled: true,
};
```

---

## Public API

**File: `src/index.ts`**

```typescript
export class CodeGraph {
  // ============================================================
  // LIFECYCLE
  // ============================================================
  
  /**
   * Initialize CodeGraph for a project directory.
   * Creates .codegraph/ if it doesn't exist.
   */
  static async init(projectPath: string, config?: Partial<CodeGraphConfig>): Promise<CodeGraph>;
  
  /**
   * Open existing CodeGraph for a project.
   * Throws if not initialized.
   */
  static async open(projectPath: string): Promise<CodeGraph>;
  
  /**
   * Check if a project has CodeGraph initialized.
   */
  static async isInitialized(projectPath: string): Promise<boolean>;
  
  /**
   * Close database connections and cleanup.
   */
  async close(): Promise<void>;

  // ============================================================
  // INDEXING
  // ============================================================
  
  /**
   * Full index of the entire project.
   * Use for initial setup or complete rebuild.
   */
  async indexAll(options?: {
    onProgress?: (progress: IndexProgress) => void;
    signal?: AbortSignal;
  }): Promise<IndexResult>;
  
  /**
   * Index specific files only.
   * Use for incremental updates.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult>;
  
  /**
   * Sync with current file state.
   * Detects changes via content hashing, reindexes only changed files.
   */
  async sync(): Promise<SyncResult>;
  
  /**
   * Get current index status.
   */
  async getStatus(): Promise<IndexStatus>;

  // ============================================================
  // GRAPH QUERIES
  // ============================================================
  
  /**
   * Get a node by ID.
   */
  async getNode(nodeId: string): Promise<Node | null>;
  
  /**
   * Find nodes by name (exact or fuzzy).
   */
  async findNodes(query: string, options?: {
    fuzzy?: boolean;
    kinds?: NodeKind[];
    limit?: number;
  }): Promise<Node[]>;
  
  /**
   * Get all edges from/to a node.
   */
  async getEdges(nodeId: string, direction?: 'outbound' | 'inbound' | 'both'): Promise<Edge[]>;
  
  /**
   * Get nodes that call this node.
   */
  async getCallers(nodeId: string): Promise<Node[]>;
  
  /**
   * Get nodes that this node calls.
   */
  async getCallees(nodeId: string): Promise<Node[]>;
  
  /**
   * Get nodes that this node depends on.
   */
  async getDependencies(nodeId: string): Promise<Node[]>;
  
  /**
   * Get nodes that depend on this node.
   */
  async getDependents(nodeId: string): Promise<Node[]>;
  
  /**
   * Traverse the graph from starting nodes.
   * Returns a subgraph of connected nodes up to maxDepth.
   */
  async traverse(startNodeIds: string[], options?: TraversalOptions): Promise<Subgraph>;
  
  /**
   * Get impact radius: what could be affected by changing this node.
   */
  async getImpactRadius(nodeId: string, options?: TraversalOptions): Promise<Subgraph>;
  
  /**
   * Find paths between two nodes.
   */
  async findPaths(fromId: string, toId: string, options?: {
    maxDepth?: number;
    maxPaths?: number;
  }): Promise<Path[]>;

  // ============================================================
  // SEMANTIC SEARCH
  // ============================================================
  
  /**
   * Search for nodes by semantic similarity.
   */
  async search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  
  /**
   * Find relevant subgraph for a natural language query.
   * Combines semantic search with graph traversal.
   */
  async findRelevantContext(query: string, options?: {
    searchLimit?: number;
    traversalDepth?: number;
    maxNodes?: number;
  }): Promise<Subgraph>;

  // ============================================================
  // CONTEXT BUILDING
  // ============================================================
  
  /**
   * Build context for a task/issue.
   * Returns structured context ready to inject into Claude.
   */
  async buildContext(input: string | { title: string; description?: string }, options?: {
    maxNodes?: number;
    includeCode?: boolean;
    format?: 'markdown' | 'json';
  }): Promise<Context>;
  
  /**
   * Get the full code for a node.
   */
  async getCode(nodeId: string): Promise<string | null>;

  // ============================================================
  // GIT INTEGRATION
  // ============================================================
  
  /**
   * Install git hooks for automatic incremental indexing.
   */
  async installGitHooks(): Promise<void>;
  
  /**
   * Remove git hooks.
   */
  async removeGitHooks(): Promise<void>;
  
  /**
   * Get files changed since last index.
   */
  async getChangedFiles(): Promise<string[]>;

  // ============================================================
  // UTILITIES
  // ============================================================
  
  /**
   * Get statistics about the indexed codebase.
   */
  async getStats(): Promise<GraphStats>;
  
  /**
   * Export the graph to JSON.
   */
  async export(): Promise<ExportedGraph>;
  
  /**
   * Update configuration.
   */
  async updateConfig(config: Partial<CodeGraphConfig>): Promise<void>;
  
  /**
   * Get current configuration.
   */
  getConfig(): CodeGraphConfig;
}

// ============================================================
// RESULT TYPES
// ============================================================

export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'resolving' | 'embedding';
  current: number;
  total: number;
  currentFile?: string;
}

export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  duration: number;
}

export interface SyncResult {
  filesChecked: number;
  filesChanged: number;
  filesAdded: number;
  filesRemoved: number;
  nodesUpdated: number;
  duration: number;
}

export interface IndexStatus {
  initialized: boolean;
  lastIndexed?: number;
  totalFiles: number;
  totalNodes: number;
  totalEdges: number;
  languages: Language[];
  unresolvedReferences: number;
}

export interface GraphStats {
  files: number;
  nodes: {
    total: number;
    byKind: Record<NodeKind, number>;
    byLanguage: Record<Language, number>;
  };
  edges: {
    total: number;
    byKind: Record<EdgeKind, number>;
    resolved: number;
    unresolved: number;
  };
  vectors: number;
}

export interface Path {
  nodes: Node[];
  edges: Edge[];
  length: number;
}

export interface ExportedGraph {
  version: number;
  exportedAt: number;
  config: CodeGraphConfig;
  stats: GraphStats;
  nodes: Node[];
  edges: Edge[];
}
```

---

## Tree-sitter Extraction Queries

These `.scm` files define what to extract from each language.

**File: `src/extraction/queries/typescript.scm`**

```scheme
; ============================================================
; TYPESCRIPT/JAVASCRIPT EXTRACTION QUERIES
; ============================================================

; Functions
(function_declaration
  name: (identifier) @function.name
  parameters: (formal_parameters) @function.params
  return_type: (type_annotation)? @function.return_type
  body: (statement_block) @function.body
) @function.definition

; Arrow functions assigned to variables
(lexical_declaration
  (variable_declarator
    name: (identifier) @function.name
    value: (arrow_function
      parameters: (formal_parameters) @function.params
      return_type: (type_annotation)? @function.return_type
      body: (_) @function.body
    )
  )
) @function.definition

; Classes
(class_declaration
  name: (type_identifier) @class.name
  (class_heritage
    (extends_clause
      value: (identifier) @class.extends
    )?
    (implements_clause
      (type_identifier) @class.implements
    )*
  )?
  body: (class_body) @class.body
) @class.definition

; Methods
(method_definition
  name: (property_identifier) @method.name
  parameters: (formal_parameters) @method.params
  return_type: (type_annotation)? @method.return_type
  body: (statement_block) @method.body
) @method.definition

; Interfaces
(interface_declaration
  name: (type_identifier) @interface.name
  (extends_type_clause
    (type_identifier) @interface.extends
  )?
  body: (interface_body) @interface.body
) @interface.definition

; Type aliases
(type_alias_declaration
  name: (type_identifier) @type.name
  value: (_) @type.value
) @type.definition

; Imports
(import_statement
  (import_clause
    (identifier)? @import.default
    (named_imports
      (import_specifier
        name: (identifier) @import.named
        alias: (identifier)? @import.alias
      )*
    )?
  )?
  source: (string) @import.source
) @import.statement

; Exports
(export_statement
  (export_clause
    (export_specifier
      name: (identifier) @export.name
    )*
  )?
  declaration: (_)? @export.declaration
) @export.statement

; Function calls
(call_expression
  function: [
    (identifier) @call.function
    (member_expression
      object: (_) @call.object
      property: (property_identifier) @call.method
    )
  ]
  arguments: (arguments) @call.args
) @call.expression

; Variable declarations (const/let with significant values)
(lexical_declaration
  (variable_declarator
    name: (identifier) @variable.name
    value: (_) @variable.value
  )
) @variable.declaration

; JSDoc comments
(comment) @comment
```

**File: `src/extraction/queries/php.scm`**

```scheme
; ============================================================
; PHP EXTRACTION QUERIES
; ============================================================

; Classes
(class_declaration
  name: (name) @class.name
  (base_clause
    (name) @class.extends
  )?
  (class_interface_clause
    (name) @class.implements
  )*
  body: (declaration_list) @class.body
) @class.definition

; Methods
(method_declaration
  (visibility_modifier)? @method.visibility
  name: (name) @method.name
  parameters: (formal_parameters) @method.params
  return_type: (return_type)? @method.return_type
  body: (compound_statement) @method.body
) @method.definition

; Functions
(function_definition
  name: (name) @function.name
  parameters: (formal_parameters) @function.params
  return_type: (return_type)? @function.return_type
  body: (compound_statement) @function.body
) @function.definition

; Interfaces
(interface_declaration
  name: (name) @interface.name
  (base_clause
    (name) @interface.extends
  )?
  body: (declaration_list) @interface.body
) @interface.definition

; Traits
(trait_declaration
  name: (name) @trait.name
  body: (declaration_list) @trait.body
) @trait.definition

; Use statements (imports)
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @import.name
    (namespace_aliasing_clause
      (name) @import.alias
    )?
  )
) @import.statement

; Static method calls (e.g., User::find())
(scoped_call_expression
  scope: (name) @call.class
  name: (name) @call.method
  arguments: (arguments) @call.args
) @call.static

; Instance method calls
(member_call_expression
  object: (_) @call.object
  name: (name) @call.method
  arguments: (arguments) @call.args
) @call.instance

; Function calls
(function_call_expression
  function: (name) @call.function
  arguments: (arguments) @call.args
) @call.expression

; Route definitions (Laravel-specific pattern)
(member_call_expression
  object: (name) @_route (#eq? @_route "Route")
  name: (name) @route.method
  arguments: (arguments
    (argument
      (string) @route.path
    )
  )
) @route.definition

; PHPDoc comments
(comment) @comment
```

**File: `src/extraction/queries/swift.scm`**

```scheme
; ============================================================
; SWIFT EXTRACTION QUERIES
; ============================================================

; Classes
(class_declaration
  name: (type_identifier) @class.name
  (type_inheritance_clause
    (type_identifier) @class.inherits
  )?
  body: (class_body) @class.body
) @class.definition

; Structs
(struct_declaration
  name: (type_identifier) @struct.name
  (type_inheritance_clause
    (type_identifier) @struct.conforms
  )?
  body: (struct_body) @struct.body
) @struct.definition

; Protocols
(protocol_declaration
  name: (type_identifier) @protocol.name
  body: (protocol_body) @protocol.body
) @protocol.definition

; Functions
(function_declaration
  name: (simple_identifier) @function.name
  (parameter_clause) @function.params
  (function_result
    (type_annotation) @function.return_type
  )?
  body: (function_body) @function.body
) @function.definition

; Methods (inside class/struct)
(function_declaration
  name: (simple_identifier) @method.name
  (parameter_clause) @method.params
  body: (function_body) @method.body
) @method.definition

; Properties
(property_declaration
  (pattern
    (simple_identifier) @property.name
  )
  (type_annotation)? @property.type
) @property.definition

; Imports
(import_declaration
  (identifier) @import.module
) @import.statement

; Function calls
(call_expression
  (simple_identifier) @call.function
  (call_suffix
    (value_arguments) @call.args
  )
) @call.expression

; Method calls
(call_expression
  (navigation_expression
    (_) @call.object
    (navigation_suffix
      (simple_identifier) @call.method
    )
  )
  (call_suffix
    (value_arguments) @call.args
  )
) @call.method

; SwiftUI View bodies
(computed_property
  name: (simple_identifier) @_body (#eq? @_body "body")
  (type_annotation
    (user_type
      (type_identifier) @_view (#match? @_view "View")
    )
  )?
  getter: (_) @view.body
) @view.definition

; Documentation comments
(comment) @comment
(multiline_comment) @comment.multiline
```

---

## Framework Pattern Resolvers

**File: `src/resolution/frameworks/laravel.ts`**

```typescript
import { FrameworkResolver, UnresolvedReference, ResolvedReference } from '../types';

export const laravelResolver: FrameworkResolver = {
  name: 'laravel',
  
  // Detect if this is a Laravel project
  detect: async (projectPath: string): Promise<boolean> => {
    return await fileExists(join(projectPath, 'artisan'));
  },
  
  patterns: [
    // Eloquent Model static calls: User::find(), Post::where()
    {
      pattern: /^([A-Z][a-zA-Z]+)::(\w+)$/,
      resolve: async (match, context) => {
        const [, className, methodName] = match;
        
        // Check app/Models first (Laravel 8+)
        let modelPath = `app/Models/${className}.php`;
        if (await context.fileExists(modelPath)) {
          return { filePath: modelPath, className, methodName };
        }
        
        // Fall back to app/ (Laravel 7 and below)
        modelPath = `app/${className}.php`;
        if (await context.fileExists(modelPath)) {
          return { filePath: modelPath, className, methodName };
        }
        
        return null;
      }
    },
    
    // Facade calls: Auth::user(), Cache::get()
    {
      pattern: /^(Auth|Cache|DB|Log|Mail|Queue|Session|Storage|Validator)::(\w+)$/,
      resolve: async (match, context) => {
        const [, facade, method] = match;
        // Facades resolve to underlying service - we can link to the facade for now
        return {
          filePath: `vendor/laravel/framework/src/Illuminate/Support/Facades/${facade}.php`,
          className: facade,
          methodName: method,
          isExternal: true
        };
      }
    },
    
    // Route helpers: route('checkout.store')
    {
      pattern: /route\(['"]([^'"]+)['"]\)/,
      resolve: async (match, context) => {
        const [, routeName] = match;
        // Search routes/web.php and routes/api.php for ->name('routeName')
        const routeFiles = ['routes/web.php', 'routes/api.php'];
        for (const file of routeFiles) {
          const content = await context.readFile(file);
          if (content?.includes(`name('${routeName}')`)) {
            return { filePath: file, routeName };
          }
        }
        return null;
      }
    },
    
    // View helpers: view('checkout.form')
    {
      pattern: /view\(['"]([^'"]+)['"]\)/,
      resolve: async (match, context) => {
        const [, viewName] = match;
        const viewPath = viewName.replace(/\./g, '/');
        
        // Check both .blade.php and .php
        const candidates = [
          `resources/views/${viewPath}.blade.php`,
          `resources/views/${viewPath}.php`
        ];
        
        for (const candidate of candidates) {
          if (await context.fileExists(candidate)) {
            return { filePath: candidate, viewName };
          }
        }
        return null;
      }
    },
    
    // Controller references in routes
    {
      pattern: /\[([A-Z][a-zA-Z]+Controller)::class,\s*['"](\w+)['"]\]/,
      resolve: async (match, context) => {
        const [, controller, method] = match;
        const controllerPath = `app/Http/Controllers/${controller}.php`;
        if (await context.fileExists(controllerPath)) {
          return { filePath: controllerPath, className: controller, methodName: method };
        }
        return null;
      }
    }
  ],
  
  // Additional node detection specific to Laravel
  extractNodes: async (filePath: string, content: string) => {
    const nodes: Node[] = [];
    
    // Detect route definitions
    const routePattern = /Route::(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = routePattern.exec(content)) !== null) {
      const [, method, path] = match;
      const line = content.slice(0, match.index).split('\n').length;
      nodes.push({
        id: `route:${filePath}:${method.toUpperCase()}:${path}`,
        kind: 'route',
        name: `${method.toUpperCase()} ${path}`,
        filePath,
        startLine: line,
        language: 'php',
        metadata: { httpMethod: method.toUpperCase(), path }
      });
    }
    
    return nodes;
  }
};
```

**File: `src/resolution/frameworks/shopify.ts`**

```typescript
import { FrameworkResolver } from '../types';

export const shopifyResolver: FrameworkResolver = {
  name: 'shopify',
  
  detect: async (projectPath: string): Promise<boolean> => {
    return await fileExists(join(projectPath, 'shopify.theme.toml')) ||
           await fileExists(join(projectPath, 'config/settings_schema.json'));
  },
  
  patterns: [
    // Render tags: {% render 'product-card' %}
    {
      pattern: /\{%\s*render\s+['"]([^'"]+)['"]/,
      resolve: async (match, context) => {
        const [, snippetName] = match;
        const snippetPath = `snippets/${snippetName}.liquid`;
        if (await context.fileExists(snippetPath)) {
          return { filePath: snippetPath, kind: 'renders' };
        }
        return null;
      }
    },
    
    // Include tags: {% include 'header' %}
    {
      pattern: /\{%\s*include\s+['"]([^'"]+)['"]/,
      resolve: async (match, context) => {
        const [, snippetName] = match;
        const snippetPath = `snippets/${snippetName}.liquid`;
        if (await context.fileExists(snippetPath)) {
          return { filePath: snippetPath, kind: 'includes' };
        }
        return null;
      }
    },
    
    // Section tags: {% section 'header' %}
    {
      pattern: /\{%\s*section\s+['"]([^'"]+)['"]/,
      resolve: async (match, context) => {
        const [, sectionName] = match;
        const sectionPath = `sections/${sectionName}.liquid`;
        if (await context.fileExists(sectionPath)) {
          return { filePath: sectionPath, kind: 'renders' };
        }
        return null;
      }
    },
    
    // Asset URLs: {{ 'style.css' | asset_url }}
    {
      pattern: /['"]([\w\-\.]+)['"]\s*\|\s*asset_url/,
      resolve: async (match, context) => {
        const [, assetName] = match;
        const assetPath = `assets/${assetName}`;
        if (await context.fileExists(assetPath)) {
          return { filePath: assetPath, kind: 'references' };
        }
        return null;
      }
    }
  ],
  
  extractNodes: async (filePath: string, content: string) => {
    const nodes: Node[] = [];
    
    // Detect schema in sections
    const schemaMatch = content.match(/\{%\s*schema\s*%\}([\s\S]*?)\{%\s*endschema\s*%\}/);
    if (schemaMatch) {
      try {
        const schema = JSON.parse(schemaMatch[1]);
        if (schema.name) {
          nodes.push({
            id: `section:${filePath}`,
            kind: 'component',
            name: schema.name,
            filePath,
            language: 'liquid',
            metadata: { 
              schemaSettings: schema.settings?.map(s => s.id),
              schemaBlocks: schema.blocks?.map(b => b.type)
            }
          });
        }
      } catch (e) {
        // Invalid JSON in schema
      }
    }
    
    return nodes;
  }
};
```

---

## Context Builder Output Format

**File: `src/context/formatter.ts`**

```typescript
export function formatContextAsMarkdown(context: Context): string {
  const lines: string[] = [];
  
  lines.push('## Code Context\n');
  
  // Graph structure section
  lines.push('### Structure\n');
  lines.push('```');
  for (const nodeId of context.subgraph.entryPoints) {
    const node = context.subgraph.nodes.find(n => n.id === nodeId);
    if (node) {
      lines.push(formatNodeTree(node, context.subgraph, 0));
    }
  }
  lines.push('```\n');
  
  // Code blocks section
  if (context.codeBlocks.length > 0) {
    lines.push('### Code\n');
    for (const block of context.codeBlocks) {
      lines.push(`#### ${block.nodeName} (${block.filePath}:${block.startLine})\n`);
      lines.push('```' + block.language);
      lines.push(block.code);
      lines.push('```\n');
    }
  }
  
  // Related files section
  if (context.relatedFiles.length > 0) {
    lines.push('### Related Files\n');
    for (const file of context.relatedFiles) {
      lines.push(`- ${file}`);
    }
  }
  
  return lines.join('\n');
}

function formatNodeTree(node: Node, subgraph: Subgraph, depth: number): string {
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  
  // Node header
  const location = node.startLine ? `:${node.startLine}` : '';
  lines.push(`${indent}${node.name} (${node.filePath}${location})`);
  
  // Outbound edges
  const outbound = subgraph.edges.filter(e => e.sourceId === node.id);
  for (const edge of outbound) {
    const target = subgraph.nodes.find(n => n.id === edge.targetId);
    const targetName = target?.name || edge.targetName || 'unknown';
    lines.push(`${indent}├── ${edge.kind} → ${targetName}`);
  }
  
  return lines.join('\n');
}

// Example output:
// 
// ## Code Context
// 
// ### Structure
// ```
// CheckoutController (app/Http/Controllers/CheckoutController.php:15)
// ├── calls → CartService.getCart
// ├── calls → PaymentService.processPayment
// ├── calls → OrderService.create
// ├── throws → PaymentException
// 
// PaymentService (app/Services/PaymentService.php:8)
// ├── calls → StripeClient.charge
// ├── calls → TransactionRepository.save
// ├── throws → PaymentException
// ├── throws → StripeTimeoutException
// ```
// 
// ### Code
// 
// #### store (app/Http/Controllers/CheckoutController.php:45)
// ```php
// public function store(Request $request)
// {
//     $cart = $this->cartService->getCart($request->user());
//     $payment = $this->paymentService->processPayment($cart);
//     ...
// }
// ```
```

---

## Installation & Integration

**How to use CodeGraph (headless library, no UI):**

### Option 1: CLI (for any project, no code required)

```bash
# Install globally
npm install -g codegraph

# Initialize in any project
cd /path/to/my-laravel-app
codegraph init

# Index the codebase
codegraph index

# Query the graph
codegraph query "what calls PaymentService"
codegraph impact "app/Services/AuthService.php"

# Build context for a task (outputs markdown)
codegraph context "Fix checkout silent failure"

# Check status
codegraph status

# Sync after changes
codegraph sync
```

### Option 2: Library (for integration into apps like Beads Dashboard)

```typescript
import { CodeGraph } from 'codegraph';

// Initialize for a project
const graph = await CodeGraph.init('/path/to/project');

// Full index with optional progress callback
await graph.indexAll({
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.current}/${progress.total}`);
  }
});

// Or open existing and sync
const graph = await CodeGraph.open('/path/to/project');
const syncResult = await graph.sync();

// Build context for a task (returns structured data)
const context = await graph.buildContext('Fix checkout silent failure');

// Query the graph directly
const callers = await graph.getCallers('func:src/payment.ts:processPayment:45');
const impact = await graph.getImpactRadius('class:AuthService', { maxDepth: 2 });

// Search semantically
const results = await graph.search('authentication middleware');

// Clean up
await graph.close();
```

### Option 3: MCP Server (for Claude Code CLI integration)

```bash
# Run as MCP server (Claude Code can query directly)
codegraph serve --mcp

# In Claude Code's MCP config, add:
# {
#   "codegraph": {
#     "command": "codegraph",
#     "args": ["serve", "--mcp", "--project", "/path/to/project"]
#   }
# }
```

Then Claude Code can use tools like:
- `codegraph_search` — semantic search
- `codegraph_context` — build context for a task
- `codegraph_callers` — who calls this function
- `codegraph_impact` — what's affected if I change this

**What gets created in the project:**

```
my-project/
├── .codegraph/
│   ├── graph.db          # SQLite database (gitignored)
│   ├── config.json       # User can customize (committed)
│   └── .gitignore        # Contains: graph.db
└── .git/
    └── hooks/
        └── post-commit   # Auto-installed hook
```

**Default `.codegraph/config.json`:**

```json
{
  "version": 1,
  "exclude": [
    "node_modules/**",
    "vendor/**",
    "dist/**",
    "build/**"
  ],
  "frameworks": ["laravel"],
  "gitHooksEnabled": true
}
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1)
- [ ] Project structure setup (npm package)
- [ ] SQLite database initialization with schema
- [ ] Basic types and interfaces
- [ ] Config file handling
- [ ] .codegraph/ directory management

### Phase 2: Tree-sitter Extraction (Week 1-2)
- [ ] Tree-sitter native bindings setup (works in Node.js, Electron, etc.)
- [ ] Grammar loading system
- [ ] TypeScript/JavaScript extraction queries
- [ ] PHP extraction queries
- [ ] Basic node/edge extraction from AST

### Phase 3: Reference Resolution (Week 2)
- [ ] Name-based symbol matching
- [ ] Import path resolution
- [ ] Laravel framework patterns
- [ ] Express/Next.js patterns
- [ ] Unresolved reference tracking

### Phase 4: Graph Queries (Week 2-3)
- [ ] Basic traversal (callers, callees)
- [ ] Impact radius calculation
- [ ] Path finding between nodes
- [ ] Subgraph extraction

### Phase 5: Vector Embeddings (Week 3)
- [ ] ONNX runtime integration
- [ ] nomic-embed-text model loading
- [ ] sqlite-vss setup
- [ ] Embedding generation for nodes
- [ ] Similarity search

### Phase 6: Context Builder (Week 3-4)
- [ ] Semantic search → graph expansion pipeline
- [ ] Context formatting for Claude
- [ ] Code snippet extraction
- [ ] Output size management

### Phase 7: Sync & Freshness (Week 4)
- [ ] Content hashing for change detection
- [ ] Incremental reindexing
- [ ] Git hook installation
- [ ] Post-commit handler

### Phase 8: Additional Languages (Week 4+)
- [ ] Swift extraction queries
- [ ] Kotlin extraction queries
- [ ] Java extraction queries
- [ ] Liquid/Shopify patterns
- [ ] Ruby/Rails patterns

### Phase 9: Polish & Hardening (Week 5)
- [ ] Error handling and recovery
- [ ] Performance optimization
- [ ] Memory management for large codebases
- [ ] Concurrent indexing safety
- [ ] API documentation and JSDoc comments

### Phase 10: CLI (Week 5-6, Optional)
- [ ] CLI argument parsing (commander or yargs)
- [ ] `codegraph init` command
- [ ] `codegraph index` command
- [ ] `codegraph query` command
- [ ] `codegraph context` command
- [ ] `codegraph status` command
- [ ] `codegraph sync` command

### Phase 11: MCP Server (Week 6, Optional)
- [ ] MCP protocol implementation
- [ ] `codegraph_search` tool
- [ ] `codegraph_context` tool
- [ ] `codegraph_callers` / `codegraph_callees` tools
- [ ] `codegraph_impact` tool
- [ ] Stdio transport for Claude Code integration

---

## Testing Strategy

```typescript
// Example test structure

describe('CodeGraph', () => {
  describe('extraction', () => {
    it('extracts functions from TypeScript', async () => {
      const code = `
        export function processPayment(amount: number): Promise<Receipt> {
          return stripe.charge(amount);
        }
      `;
      const result = await extract(code, 'typescript');
      
      expect(result.nodes).toContainEqual(expect.objectContaining({
        kind: 'function',
        name: 'processPayment',
        signature: '(amount: number): Promise<Receipt>'
      }));
      
      expect(result.edges).toContainEqual(expect.objectContaining({
        kind: 'calls',
        targetName: 'stripe.charge'
      }));
    });
    
    it('extracts Laravel routes from PHP', async () => {
      const code = `
        Route::post('/checkout', [CheckoutController::class, 'store'])->name('checkout.store');
      `;
      const result = await extract(code, 'php');
      
      expect(result.nodes).toContainEqual(expect.objectContaining({
        kind: 'route',
        name: 'POST /checkout'
      }));
    });
  });
  
  describe('resolution', () => {
    it('resolves Laravel model calls', async () => {
      const graph = await createTestGraph({
        'app/Models/User.php': 'class User extends Model { public static function find($id) {} }',
        'app/Http/Controllers/UserController.php': 'User::find($id);'
      });
      
      const edges = await graph.getEdges('controller:UserController:show');
      expect(edges).toContainEqual(expect.objectContaining({
        kind: 'calls',
        targetId: 'method:app/Models/User.php:find',
        resolved: true
      }));
    });
  });
  
  describe('traversal', () => {
    it('finds impact radius', async () => {
      const graph = await createTestGraph(/* ... */);
      const subgraph = await graph.getImpactRadius('class:PaymentService', { maxDepth: 2 });
      
      expect(subgraph.nodes.map(n => n.name)).toContain('CheckoutController');
      expect(subgraph.nodes.map(n => n.name)).toContain('OrderService');
    });
  });
});
```

---

## Open Questions / Decisions Needed

1. **Embedding model size vs quality**: nomic-embed-text-v1.5 (275MB) vs all-MiniLM-L6-v2 (90MB)?

2. **Tree-sitter WASM vs native**: WASM is easier for Electron distribution, native is faster. Start with WASM?

3. **Max context size**: How many nodes/code blocks before we truncate? Configurable?

4. **Unresolved references**: Show them in context (with "unresolved" marker) or hide them?

5. **Multi-language projects**: Projects mixing PHP + JS + Liquid — handle all simultaneously?

6. **Binary/asset files**: Track references to images, fonts, etc. or ignore?

---

## Success Criteria

1. **Accuracy**: >90% of function calls correctly linked to definitions
2. **Speed**: Full index of 10k file project in <60 seconds
3. **Freshness**: Incremental update after commit in <5 seconds
4. **Context quality**: Generated context helps Claude solve issues faster (qualitative)
5. **Portability**: Works on any macOS machine without additional setup

---

## Resources

- Tree-sitter: https://tree-sitter.github.io/tree-sitter/
- Tree-sitter WASM: https://github.com/nicolo-ribaudo/nicolo-nicolo-tree-sitter/tree-sitter-wasm-builds/tree/main
- sqlite-vss: https://github.com/asg017/sqlite-vss
- nomic-embed: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
- ONNX Runtime Node: https://onnxruntime.ai/docs/get-started/with-javascript.html
