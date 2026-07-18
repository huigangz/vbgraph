/**
 * P1.1 + P1.2 — node_tags table (schema v6) + GraphView smoke.
 *
 * Covers:
 *   - Fresh schema.sql ships node_tags + its two indexes at schema_version=6.
 *   - v5 → v6 migration adds node_tags + indexes idempotently.
 *   - insertNodeTag/getNodesByTag round-trip.
 *   - First-writer-wins on added_by.
 *   - QueryGraphView reads through to the underlying QueryBuilder.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection } from '../src/db';
import { createDatabase } from '../src/db/sqlite-adapter';
import { runMigrations, CURRENT_SCHEMA_VERSION, getCurrentVersion } from '../src/db/migrations';
import { QueryBuilder } from '../src/db/queries';
import { QueryGraphView } from '../src/resolution/graph-view';
import type { Node } from '../src/types';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p1-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function objectExists(db: SqliteDatabase, type: string, name: string): boolean {
  // Resilient to better-sqlite3 (returns undefined) and node-sqlite3-wasm
  // (returns null) for "no row".
  const row = db
    .prepare(`SELECT 1 AS one FROM sqlite_master WHERE type=? AND name=?`)
    .get(type, name);
  return row !== undefined && row !== null;
}

function makeNode(id: string, name: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: '/x.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('P1.1 — schema v6 + node_tags', () => {
  it('CURRENT_SCHEMA_VERSION is at least 6 (v6 artifacts ship in every later version)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
  });

  it('fresh database includes node_tags + indexes', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'fresh.db'));
    try {
      const db = conn.getDb();
      expect(objectExists(db, 'table', 'node_tags')).toBe(true);
      expect(objectExists(db, 'index', 'idx_node_tags_tag')).toBe(true);
      expect(objectExists(db, 'index', 'idx_node_tags_added_by')).toBe(true);
      expect(conn.getSchemaVersion()?.version).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      conn.close();
    }
  });

  it('v5 → current migration adds v6 node_tags + indexes (and any later artifacts)', () => {
    const dbPath = path.join(tmpDir, 'v5.db');
    const { db } = createDatabase(dbPath);
    try {
      // Seed a minimal v5-shaped database. Needs at least `nodes` and `edges`
      // tables for the v7 migration's `CREATE INDEX ... ON nodes/edges WHERE
      // stale = 1` to succeed — those columns were added in v5 with DEFAULT 0,
      // so the fixture must include them too.
      db.exec(`
        CREATE TABLE schema_versions (
          version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT
        );
        INSERT INTO schema_versions VALUES (5, 0, 'v5 baseline');
        CREATE TABLE nodes (
          id TEXT PRIMARY KEY, file_path TEXT,
          stale INTEGER DEFAULT 0, staleness_visible INTEGER DEFAULT 0
        );
        CREATE TABLE edges (
          id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, target TEXT,
          stale INTEGER DEFAULT 0, staleness_visible INTEGER DEFAULT 0
        );
      `);

      expect(objectExists(db, 'table', 'node_tags')).toBe(false);
      runMigrations(db, 5);
      // v5 → CURRENT runs every pending migration in order (v6, v7, …).
      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
      expect(objectExists(db, 'table', 'node_tags')).toBe(true);
      expect(objectExists(db, 'index', 'idx_node_tags_tag')).toBe(true);
      expect(objectExists(db, 'index', 'idx_node_tags_added_by')).toBe(true);

      // Idempotent: re-running with the recorded version is a no-op
      // (filter `m.version > fromVersion` keeps nothing).
      runMigrations(db, getCurrentVersion(db));
      expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it('insertNodeTag + getNodesByTag round-trip', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'tags.db'));
    try {
      const q = new QueryBuilder(conn.getDb());
      q.insertNode(makeNode('n1', 'foo'));
      q.insertNode(makeNode('n2', 'bar'));
      q.insertNodeTag('n1', 'spring:service', 'framework:spring-core');
      q.insertNodeTag('n2', 'spring:service', 'framework:spring-core');
      q.insertNodeTag('n1', 'route-handler', 'framework:aspnet');

      const services = q.getNodesByTag('spring:service');
      expect(services.map((n) => n.id).sort()).toEqual(['n1', 'n2']);

      const handlers = q.getNodesByTag('route-handler');
      expect(handlers.map((n) => n.id)).toEqual(['n1']);
    } finally {
      conn.close();
    }
  });

  it('first-writer-wins on added_by; second insert is no-op', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'firstwins.db'));
    try {
      const db = conn.getDb();
      const q = new QueryBuilder(db);
      q.insertNode(makeNode('n1', 'foo'));
      q.insertNodeTag('n1', 'route-handler', 'framework:spring-core');
      q.insertNodeTag('n1', 'route-handler', 'framework:aspnet');

      const rows = db
        .prepare(`SELECT added_by FROM node_tags WHERE node_id = 'n1' AND tag = 'route-handler'`)
        .all() as Array<{ added_by: string }>;
      expect(rows).toEqual([{ added_by: 'framework:spring-core' }]);
    } finally {
      conn.close();
    }
  });

  it('cascade delete: node removal drops its tags', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'cascade.db'));
    try {
      const db = conn.getDb();
      const q = new QueryBuilder(db);
      // FKs aren't ON by default on every adapter; force.
      db.exec('PRAGMA foreign_keys = ON');
      q.insertNode(makeNode('n1', 'foo'));
      q.insertNodeTag('n1', 'spring:service', 'framework:spring-core');
      expect(q.getNodesByTag('spring:service')).toHaveLength(1);
      q.deleteNode('n1');
      expect(q.getNodesByTag('spring:service')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });
});

describe('P1.2 — QueryGraphView', () => {
  it('exposes nodes via getNode / hasNode / getNodesByKind', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'view.db'));
    try {
      const q = new QueryBuilder(conn.getDb());
      q.insertNode(makeNode('n1', 'foo', { kind: 'function' }));
      q.insertNode(makeNode('n2', 'Bar', { kind: 'class' }));

      const view = new QueryGraphView(q, tmpDir, {
        exists: () => false,
        readFile: () => null,
      });
      expect(view.hasNode('n1')).toBe(true);
      expect(view.hasNode('n2')).toBe(true);
      expect(view.hasNode('does-not-exist')).toBe(false);

      expect(view.getNode('n1')?.name).toBe('foo');
      expect(view.getNodesByKind('class').map((n) => n.id)).toEqual(['n2']);
      expect(view.getNodesByName('foo').map((n) => n.id)).toEqual(['n1']);
    } finally {
      conn.close();
    }
  });

  it('exposes tags via getNodesByTag (P1.1 + P1.2 join)', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'view-tags.db'));
    try {
      const q = new QueryBuilder(conn.getDb());
      q.insertNode(makeNode('n1', 'foo'));
      q.insertNodeTag('n1', 'spring:service', 'framework:spring-core');

      const view = new QueryGraphView(q, tmpDir, {
        exists: () => false,
        readFile: () => null,
      });
      expect(view.getNodesByTag('spring:service').map((n) => n.id)).toEqual(['n1']);
      expect(view.getNodesByTag('does-not-exist')).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it('caches per-instance: a second call hits the cache', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'cache.db'));
    try {
      const q = new QueryBuilder(conn.getDb());
      q.insertNode(makeNode('n1', 'foo'));

      const view = new QueryGraphView(q, tmpDir, {
        exists: () => false,
        readFile: () => null,
      });
      const first = view.getNodesByName('foo');
      const second = view.getNodesByName('foo');
      // Same reference — proves the cache returned the previously stored array.
      expect(second).toBe(first);
    } finally {
      conn.close();
    }
  });

  it('readFileStripped runs comment stripping (offsets preserved)', () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'strip.db'));
    try {
      const q = new QueryBuilder(conn.getDb());
      const view = new QueryGraphView(q, tmpDir, {
        exists: () => true,
        readFile: () => 'x = 1  # path("/fake/", V)\nreal = 2',
      });
      const stripped = view.readFileStripped('/x.py', 'python');
      expect(stripped).not.toBeNull();
      // Comments replaced with spaces (offsets preserved). The 'real = 2' line is intact.
      expect(stripped!.includes('real = 2')).toBe(true);
      expect(stripped!.includes("path(\"/fake/\"")).toBe(false);
    } finally {
      conn.close();
    }
  });
});
