-- CodeGraph SQLite Schema
-- This file is the full current schema (applied verbatim to fresh databases).
-- Existing databases are upgraded incrementally by src/db/migrations.ts —
-- every change here must have a matching migration entry there.
-- Current schema version: 5 (see CURRENT_SCHEMA_VERSION in migrations.ts).

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
);

-- Insert initial version
INSERT INTO schema_versions (version, applied_at, description)
VALUES (1, strftime('%s', 'now') * 1000, 'Initial schema');

-- =============================================================================
-- Core Tables
-- =============================================================================

-- Nodes: Code symbols (functions, classes, variables, etc.)
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    docstring TEXT,
    signature TEXT,
    visibility TEXT,
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    is_abstract INTEGER DEFAULT 0,
    decorators TEXT, -- JSON array
    type_parameters TEXT, -- JSON array
    -- Provenance / SCIP ownership (schema v5)
    provenance TEXT DEFAULT 'tree-sitter',
    scip_symbol TEXT,                       -- original SCIP symbol string (internal + external nodes)
    scip_index_path TEXT,                   -- internal-symbol nodes only; NULL for external (ownership is in scip_external_refs)
    -- Stale flags (schema v5): reserved here so upsertGraphEdge can clear them
    -- uniformly; only P2's sync path ever sets them to 1.
    stale INTEGER DEFAULT 0,
    staleness_visible INTEGER DEFAULT 0,
    updated_at INTEGER NOT NULL
);

-- Edges: Relationships between nodes
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    kind TEXT NOT NULL,
    metadata TEXT, -- JSON object
    line INTEGER,
    col INTEGER,
    provenance TEXT DEFAULT NULL,           -- primary (highest-priority) extractor
    provenances TEXT,                       -- JSON array: every extractor that observed this edge (schema v5)
    confidence REAL DEFAULT 0.7,            -- resolution confidence (schema v5)
    subkind TEXT,                           -- edge subkind, e.g. 'di_binding' (schema v5)
    -- Stale flags (schema v5): reserved here; only P2's sync path sets them to 1.
    stale INTEGER DEFAULT 0,
    staleness_visible INTEGER DEFAULT 0,
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
);

-- Files: Tracked source files
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT -- JSON array
);

-- Unresolved References: References that need resolution after full indexing
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT, -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);

-- =============================================================================
-- Indexes for Query Performance
-- =============================================================================

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));

-- Full-text search index on node names, docstrings, and signatures
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id,
    name,
    qualified_name,
    docstring,
    signature,
    content='nodes',
    content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;

-- Edge indexes.
-- idx_edges_source / idx_edges_target are intentionally omitted —
-- the (source, kind) and (target, kind) composites below cover the
-- corresponding source-only / target-only lookups via SQLite's
-- left-prefix scan, so the narrow indexes are dead weight on writes.
-- Migration v4 drops them on existing databases.
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

-- File indexes
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);

-- Unresolved refs indexes
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);
CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);

-- SCIP provenance indexes (schema v5)
CREATE INDEX IF NOT EXISTS idx_nodes_provenance ON nodes(provenance);
CREATE INDEX IF NOT EXISTS idx_nodes_scip_symbol ON nodes(scip_symbol) WHERE scip_symbol IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_nodes_scip_index ON nodes(scip_index_path) WHERE scip_index_path IS NOT NULL;

-- Edge dedup unique index (schema v5): includes line/col so the same
-- caller->callee at different source positions stays a distinct row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_dedup ON edges(
    source, target, kind,
    COALESCE(subkind, ''),
    COALESCE(line, -1),
    COALESCE(col, -1)
);

-- Project metadata for version/provenance tracking
CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

-- =============================================================================
-- SCIP ingestion tables (schema v5)
-- =============================================================================

-- One row per source file covered by an ingested .scip index.
CREATE TABLE IF NOT EXISTS scip_documents (
    source_file_path TEXT NOT NULL,
    scip_index_path  TEXT NOT NULL,
    source_hash      TEXT NOT NULL,
    ingested_at      INTEGER NOT NULL,
    PRIMARY KEY (source_file_path, scip_index_path)
);
CREATE INDEX IF NOT EXISTS idx_scip_documents_index ON scip_documents(scip_index_path);

-- One row per .scip index ingestion; completed_at IS NULL means a crash mid-ingest.
CREATE TABLE IF NOT EXISTS scip_ingestions (
    scip_index_path  TEXT PRIMARY KEY,
    started_at       INTEGER NOT NULL,
    completed_at     INTEGER,
    intended_files   TEXT                   -- JSON array, for crash recovery
);

-- Many-to-many ownership of globally-unique external SCIP nodes by .scip indexes.
CREATE TABLE IF NOT EXISTS scip_external_refs (
    scip_index_path  TEXT NOT NULL,
    external_node_id TEXT NOT NULL,
    PRIMARY KEY (scip_index_path, external_node_id),
    FOREIGN KEY (external_node_id) REFERENCES nodes(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_scip_external_refs_index ON scip_external_refs(scip_index_path);
CREATE INDEX IF NOT EXISTS idx_scip_external_refs_node ON scip_external_refs(external_node_id);
