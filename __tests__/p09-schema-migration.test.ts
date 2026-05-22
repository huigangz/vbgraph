/**
 * P0.9 — DB schema migration to version 5.
 *
 * Verifies both halves of the schema change: a fresh database built from
 * `schema.sql` and an existing v4 database upgraded by the v5 migration —
 * including the historical-edge de-duplication that the new unique index
 * depends on.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '../src/db/migrations';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mig-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function columnNames(db: SqliteDatabase, table: string): string[] {
  return (
    db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

function objectExists(db: SqliteDatabase, type: string, name: string): boolean {
  return (
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type=? AND name=?`).get(type, name) !==
    undefined
  );
}

describe('fresh database (schema.sql)', () => {
  it('has all v5 columns, tables, indexes and is recorded at version 5', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'fresh.db'));
    try {
      const db = conn.getDb();

      expect(columnNames(db, 'nodes')).toEqual(
        expect.arrayContaining([
          'provenance',
          'scip_symbol',
          'scip_index_path',
          'stale',
          'staleness_visible',
        ]),
      );
      expect(columnNames(db, 'edges')).toEqual(
        expect.arrayContaining([
          'provenances',
          'confidence',
          'subkind',
          'stale',
          'staleness_visible',
        ]),
      );

      for (const table of ['scip_documents', 'scip_ingestions', 'scip_external_refs']) {
        expect(objectExists(db, 'table', table)).toBe(true);
      }
      expect(objectExists(db, 'index', 'idx_edges_dedup')).toBe(true);
      expect(objectExists(db, 'index', 'idx_nodes_provenance')).toBe(true);

      expect(conn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
      expect(CURRENT_SCHEMA_VERSION).toBe(5);
    } finally {
      conn.close();
    }
  });

  it("declares nodes.provenance default 'tree-sitter'", () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'fresh2.db'));
    try {
      const info = conn
        .getDb()
        .prepare(`SELECT name, dflt_value FROM pragma_table_info('nodes')`)
        .all() as Array<{ name: string; dflt_value: string | null }>;
      const provenance = info.find((c) => c.name === 'provenance');
      expect(provenance?.dflt_value).toBe("'tree-sitter'");
    } finally {
      conn.close();
    }
  });
});

describe('v4 -> v5 migration', () => {
  /** Build a minimal pre-v5 database (nodes/edges/schema_versions at v4). */
  function makeV4Database(dbPath: string): SqliteDatabase {
    const { db } = createDatabase(dbPath);
    db.exec(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT
      );
      INSERT INTO schema_versions VALUES (4, 0, 'v4 baseline');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL,
        docstring TEXT, signature TEXT, visibility TEXT,
        is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0,
        decorators TEXT, type_parameters TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL,
        kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER,
        provenance TEXT DEFAULT NULL
      );
    `);
    return db;
  }

  it('adds v5 columns, tables and the dedup index', () => {
    const dbPath = path.join(tmpDir, 'old.db');
    const db = makeV4Database(dbPath);
    try {
      runMigrations(db, 4);

      expect(columnNames(db, 'nodes')).toEqual(
        expect.arrayContaining(['provenance', 'scip_symbol', 'scip_index_path', 'stale']),
      );
      expect(columnNames(db, 'edges')).toEqual(
        expect.arrayContaining(['provenances', 'confidence', 'subkind', 'stale']),
      );
      for (const table of ['scip_documents', 'scip_ingestions', 'scip_external_refs']) {
        expect(objectExists(db, 'table', table)).toBe(true);
      }
      expect(objectExists(db, 'index', 'idx_edges_dedup')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('de-duplicates historical edges, keeping the newest row', () => {
    const dbPath = path.join(tmpDir, 'dup.db');
    const db = makeV4Database(dbPath);
    try {
      db.exec(`
        INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column, updated_at)
        VALUES ('n1','function','a','a','f.ts','typescript',1,1,0,0,0),
               ('n2','function','b','b','f.ts','typescript',2,2,0,0,0);
      `);
      // Two identical edges at line 5 (the older has tree-sitter provenance,
      // the newer has scip) and one distinct edge at line 10.
      const ins = db.prepare(
        `INSERT INTO edges (source, target, kind, line, col, provenance) VALUES (?,?,?,?,?,?)`,
      );
      ins.run('n1', 'n2', 'calls', 5, 0, 'tree-sitter');
      ins.run('n1', 'n2', 'calls', 5, 0, 'scip');
      ins.run('n1', 'n2', 'calls', 10, 0, 'tree-sitter');
      expect((db.prepare('SELECT COUNT(*) c FROM edges').get() as { c: number }).c).toBe(3);

      runMigrations(db, 4);

      // The line-5 pair collapsed to one row; line-10 survived.
      const rows = db
        .prepare('SELECT line, provenance FROM edges ORDER BY line')
        .all() as Array<{ line: number; provenance: string }>;
      expect(rows).toEqual([
        { line: 5, provenance: 'scip' }, // newest of the duplicate pair won
        { line: 10, provenance: 'tree-sitter' },
      ]);
    } finally {
      db.close();
    }
  });
});
