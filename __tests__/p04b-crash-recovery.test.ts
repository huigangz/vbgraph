/**
 * P0.4b — open-time cleanup of SCIP ingestions left incomplete by a crash.
 *
 * A crash before STAGE F leaves an `scip_ingestions` row with `completed_at`
 * NULL and a partially-mutated graph. `CodeGraph.open()/openSync()` must
 * garbage-collect that partial data; a completed ingestion must survive.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CodeGraph } from '../src';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { persistScipIndex } from '../src/extraction/scip/persister';
import { writeSyntheticScip } from './helpers/scip-fixtures';

const DEF = 1;
const CLASS = 7;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p04b-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Init a project and ingest a small synthetic `.scip` into its database. */
async function initAndIngest(scipPath: string): Promise<void> {
  CodeGraph.initSync(tmpDir).close();
  await writeSyntheticScip(scipPath, {
    metadata: {},
    documents: [
      {
        relativePath: 'src/A.cs',
        occurrences: [{ range: [0, 0, 5, 0], symbol: 'csharp . . . N/A#', symbolRoles: DEF }],
        symbols: [{ symbol: 'csharp . . . N/A#', kind: CLASS, displayName: 'A' }],
      },
    ],
  });
  const db = DatabaseConnection.open(getDatabasePath(tmpDir));
  const qb = new QueryBuilder(db.getDb());
  await persistScipIndex({ scipPath, projectRoot: tmpDir, db: db.getDb(), qb });
  db.close();
}

/** Force the most recent ingestion to look crashed (`completed_at` NULL). */
function markIngestionCrashed(): void {
  const db = DatabaseConnection.open(getDatabasePath(tmpDir));
  db.getDb().prepare(`UPDATE scip_ingestions SET completed_at = NULL`).run();
  db.close();
}

describe('open-time incomplete-ingestion cleanup', () => {
  it('garbage-collects a crashed ingestion on openSync', async () => {
    await initAndIngest(path.join(tmpDir, 'a.scip'));
    markIngestionCrashed();

    const cg = CodeGraph.openSync(tmpDir);
    try {
      expect(cg.getStats().nodeCount).toBe(0);
      expect(cg.getStats().edgeCount).toBe(0);
    } finally {
      cg.close();
    }

    const db = DatabaseConnection.open(getDatabasePath(tmpDir));
    try {
      const ingestions = db
        .getDb()
        .prepare(`SELECT COUNT(*) c FROM scip_ingestions`)
        .get() as { c: number };
      const documents = db
        .getDb()
        .prepare(`SELECT COUNT(*) c FROM scip_documents`)
        .get() as { c: number };
      expect(ingestions.c).toBe(0);
      expect(documents.c).toBe(0);
    } finally {
      db.close();
    }
  });

  it('leaves a completed ingestion intact on openSync', async () => {
    await initAndIngest(path.join(tmpDir, 'a.scip'));
    // No crash simulation — the ingestion completed normally.

    const cg = CodeGraph.openSync(tmpDir);
    try {
      // file node + class A node survive.
      expect(cg.getStats().nodeCount).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('garbage-collects a crashed ingestion on async open', async () => {
    await initAndIngest(path.join(tmpDir, 'a.scip'));
    markIngestionCrashed();

    const cg = await CodeGraph.open(tmpDir);
    try {
      expect(cg.getStats().nodeCount).toBe(0);
    } finally {
      cg.close();
    }
  });
});
