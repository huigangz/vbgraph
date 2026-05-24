/**
 * Database Migrations
 *
 * Schema versioning and migration support.
 */

import { SqliteDatabase } from './sqlite-adapter';

/**
 * Current schema version
 */
export const CURRENT_SCHEMA_VERSION = 6;

/**
 * Migration definition
 */
interface Migration {
  version: number;
  description: string;
  up: (db: SqliteDatabase) => void;
}

/**
 * All migrations in order
 *
 * Note: Version 1 is the initial schema, handled by schema.sql
 * Future migrations go here.
 */
const migrations: Migration[] = [
  {
    version: 2,
    description: 'Add project metadata, provenance tracking, and unresolved ref context',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS project_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
        ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
        ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
        CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
        CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
      `);
    },
  },
  {
    version: 3,
    description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
      `);
    },
  },
  {
    version: 4,
    description:
      'Drop redundant idx_edges_source / idx_edges_target (covered by source_kind / target_kind composites)',
    up: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_edges_source;
        DROP INDEX IF EXISTS idx_edges_target;
      `);
    },
  },
  {
    version: 5,
    description:
      'SCIP ingestion: node/edge provenance columns, reserved stale flags, edge dedup unique index, scip_* tables',
    up: (db) => {
      // Provenance / SCIP-ownership columns on nodes.
      db.exec(`
        ALTER TABLE nodes ADD COLUMN provenance TEXT DEFAULT 'tree-sitter';
        ALTER TABLE nodes ADD COLUMN scip_symbol TEXT;
        ALTER TABLE nodes ADD COLUMN scip_index_path TEXT;
        ALTER TABLE nodes ADD COLUMN stale INTEGER DEFAULT 0;
        ALTER TABLE nodes ADD COLUMN staleness_visible INTEGER DEFAULT 0;
      `);
      // Edge extensions. `subkind` must exist before the dedup step below,
      // which COALESCEs it.
      db.exec(`
        ALTER TABLE edges ADD COLUMN provenances TEXT;
        ALTER TABLE edges ADD COLUMN confidence REAL DEFAULT 0.7;
        ALTER TABLE edges ADD COLUMN subkind TEXT;
        ALTER TABLE edges ADD COLUMN stale INTEGER DEFAULT 0;
        ALTER TABLE edges ADD COLUMN staleness_visible INTEGER DEFAULT 0;
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_provenance ON nodes(provenance);
        CREATE INDEX IF NOT EXISTS idx_nodes_scip_symbol ON nodes(scip_symbol) WHERE scip_symbol IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_nodes_scip_index ON nodes(scip_index_path) WHERE scip_index_path IS NOT NULL;
      `);
      // De-duplicate historical edges, keeping the newest (MAX rowid) row —
      // most likely to carry up-to-date provenance/metadata — then enforce
      // uniqueness on the call-site-preserving fingerprint.
      db.exec(`
        DELETE FROM edges WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM edges
          GROUP BY source, target, kind,
                   COALESCE(subkind, ''),
                   COALESCE(line, -1),
                   COALESCE(col, -1)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_dedup ON edges(
          source, target, kind,
          COALESCE(subkind, ''),
          COALESCE(line, -1),
          COALESCE(col, -1)
        );
      `);
      // SCIP ingestion bookkeeping tables.
      db.exec(`
        CREATE TABLE IF NOT EXISTS scip_documents (
          source_file_path TEXT NOT NULL,
          scip_index_path  TEXT NOT NULL,
          source_hash      TEXT NOT NULL,
          ingested_at      INTEGER NOT NULL,
          PRIMARY KEY (source_file_path, scip_index_path)
        );
        CREATE INDEX IF NOT EXISTS idx_scip_documents_index ON scip_documents(scip_index_path);
        CREATE TABLE IF NOT EXISTS scip_ingestions (
          scip_index_path  TEXT PRIMARY KEY,
          started_at       INTEGER NOT NULL,
          completed_at     INTEGER,
          intended_files   TEXT
        );
        CREATE TABLE IF NOT EXISTS scip_external_refs (
          scip_index_path  TEXT NOT NULL,
          external_node_id TEXT NOT NULL,
          PRIMARY KEY (scip_index_path, external_node_id),
          FOREIGN KEY (external_node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_scip_external_refs_index ON scip_external_refs(scip_index_path);
        CREATE INDEX IF NOT EXISTS idx_scip_external_refs_node ON scip_external_refs(external_node_id);
      `);
      // Existing edges keep their original provenances — scope-resolution is
      // not back-filled (would require a full re-index). See plan P0.9.
      console.error(
        "[codegraph] Migrated DB to schema v5 (SCIP ingestion). Existing edges " +
          "retain their original provenances; run 'codegraph index' to upgrade incrementally.",
      );
    },
  },
  {
    version: 6,
    description:
      'Phase 3 framework synthesis: node_tags table for many-to-one tag attachment to nodes',
    up: (db) => {
      // No data migration — P0 produces zero tags.
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_tags (
          node_id   TEXT NOT NULL,
          tag       TEXT NOT NULL,
          added_by  TEXT NOT NULL,
          PRIMARY KEY (node_id, tag),
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_node_tags_tag      ON node_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_node_tags_added_by ON node_tags(added_by);
      `);
    },
  },
];

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db
      .prepare('SELECT MAX(version) as version FROM schema_versions')
      .get() as { version: number | null } | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare(
    'INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)'
  ).run(version, Date.now(), description);
}

/**
 * Run all pending migrations
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number): void {
  const pending = migrations.filter((m) => m.version > fromVersion);

  if (pending.length === 0) {
    return;
  }

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  // Run each migration in a transaction
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      recordMigration(db, migration.version, migration.description);
    })();
  }
}

/**
 * Check if the database needs migration
 */
export function needsMigration(db: SqliteDatabase): boolean {
  const current = getCurrentVersion(db);
  return current < CURRENT_SCHEMA_VERSION;
}

/**
 * Get list of pending migrations
 */
export function getPendingMigrations(db: SqliteDatabase): Migration[] {
  const current = getCurrentVersion(db);
  return migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
}

/**
 * Get migration history from database
 */
export function getMigrationHistory(
  db: SqliteDatabase
): Array<{ version: number; appliedAt: number; description: string | null }> {
  const rows = db
    .prepare('SELECT version, applied_at, description FROM schema_versions ORDER BY version')
    .all() as Array<{ version: number; applied_at: number; description: string | null }>;

  return rows.map((row) => ({
    version: row.version,
    appliedAt: row.applied_at,
    description: row.description,
  }));
}
