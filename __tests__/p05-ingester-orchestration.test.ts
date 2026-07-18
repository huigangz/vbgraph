/**
 * P0.5 — ingester orchestration (`ingestScipFile`).
 *
 * The thin seam over the persister: metadata is validated up front, then the
 * pipeline runs. A corrupt file is rejected before any DB mutation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { ingestScipFile, ScipDecodeError } from '../src/extraction/scip';
import { writeSyntheticScip, truncateScipFile } from './helpers/scip-fixtures';

let tmpDir: string;
let conn: DatabaseConnection;
let qb: QueryBuilder;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p05-'));
  conn = DatabaseConnection.initialize(path.join(tmpDir, 'graph.db'));
  qb = new QueryBuilder(conn.getDb());
});

afterEach(() => {
  conn.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ingestScipFile', () => {
  it('ingests a .scip and returns ingestion statistics', async () => {
    const scipPath = path.join(tmpDir, 'a.scip');
    await writeSyntheticScip(scipPath, {
      metadata: { toolName: 'scip-dotnet' },
      documents: [
        {
          relativePath: 'src/A.cs',
          occurrences: [
            { range: [0, 0, 4, 0], symbol: 'csharp . . . N/A#', symbolRoles: 1 },
          ],
          symbols: [{ symbol: 'csharp . . . N/A#', kind: 7, displayName: 'A' }],
        },
      ],
    });

    const stats = await ingestScipFile(scipPath, tmpDir, { db: conn.getDb(), qb });
    expect(stats.documentCount).toBe(1);
    expect(stats.nodeCount).toBeGreaterThan(0);
    expect(stats.scipPath).toBe(path.resolve(scipPath));
  });

  it('rejects a corrupt file before mutating the database', async () => {
    const scipPath = path.join(tmpDir, 'bad.scip');
    await writeSyntheticScip(scipPath, {
      metadata: {},
      documents: [{ relativePath: 'src/A.cs', occurrences: [] }],
    });
    truncateScipFile(scipPath, 2); // keep only a stub of the header

    const db = conn.getDb();
    const before = (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c;
    await expect(
      ingestScipFile(scipPath, tmpDir, { db, qb }),
    ).rejects.toThrow(ScipDecodeError);
    const after = (db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
