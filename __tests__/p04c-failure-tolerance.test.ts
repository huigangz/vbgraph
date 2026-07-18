/**
 * P0.4c — build-failure tolerance.
 *
 * Covers the standalone, pipeline-independent half: the failure ledger
 * (atomic write, version rejection, classification) and ship gate 12a — an
 * explicit `--scip <bad-path>` corrupt/truncated file is rejected at STAGE A
 * with the database left completely unchanged.
 *
 * The spawn-driven failure modes (`not-installed`, `restore-failed`,
 * `build-failed`) are exercised end-to-end with the `--scip-auto` orchestrator
 * in P0.6 / P0.10.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  writeScipFailureLedger,
  readScipFailureLedger,
  classifyScipFailureMode,
} from '../src/extraction/scip/failure-ledger';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { persistScipIndex } from '../src/extraction/scip/persister';
import { ScipDecodeError } from '../src/extraction/scip/streaming-decoder';
import { writeSyntheticScip, truncateScipFile } from './helpers/scip-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p04c-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scip failure ledger', () => {
  it('round-trips failures and overwrites the previous ledger', () => {
    writeScipFailureLedger(tmpDir, [
      {
        indexer: 'scip-dotnet',
        language: 'csharp',
        mode: 'build-failed',
        filesAffected: 47,
        fallback: 'tree-sitter',
        hint: "Run 'dotnet build' to see errors.",
      },
    ]);
    writeScipFailureLedger(tmpDir, []); // a clean later run overwrites

    const ledger = readScipFailureLedger(tmpDir);
    expect(ledger?.version).toBe(1);
    expect(ledger?.failures).toEqual([]);
    expect(typeof ledger?.runAt).toBe('string');
  });

  it('returns null when no ledger exists', () => {
    expect(readScipFailureLedger(tmpDir)).toBeNull();
  });

  it('rejects an unknown schema version', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'scip-failures.json'),
      JSON.stringify({ version: 99, runAt: '', failures: [] }),
    );
    expect(() => readScipFailureLedger(tmpDir)).toThrow(/schema version 99 unknown/);
  });

  it('leaves no .tmp residue after an atomic write', () => {
    writeScipFailureLedger(tmpDir, []);
    expect(fs.existsSync(path.join(tmpDir, 'scip-failures.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'scip-failures.json.tmp'))).toBe(false);
  });

  it('classifies failure modes from errors', () => {
    expect(classifyScipFailureMode({ code: 'ENOENT' })).toBe('not-installed');
    expect(classifyScipFailureMode(new Error('unexpected EOF while reading a varint'))).toBe(
      'truncated',
    );
    expect(classifyScipFailureMode(new Error('dotnet restore failed'))).toBe(
      'restore-failed',
    );
    expect(classifyScipFailureMode(new Error('unsupported wire type 7'))).toBe('corrupt');
  });
});

describe('ship gate 12a — explicit --scip on a corrupt file', () => {
  it('rejects a truncated .scip at STAGE A and leaves the DB unchanged', async () => {
    const conn = DatabaseConnection.initialize(path.join(tmpDir, 'graph.db'));
    const db = conn.getDb();
    const qb = new QueryBuilder(db);
    try {
      const scipPath = path.join(tmpDir, 'bad.scip');
      await writeSyntheticScip(scipPath, {
        metadata: {},
        documents: [
          { relativePath: 'src/A.cs', occurrences: [] },
          { relativePath: 'src/B.cs', occurrences: [] },
        ],
      });
      // Lop off the tail so a declared submessage runs past EOF.
      truncateScipFile(scipPath, fs.statSync(scipPath).size - 15);

      const nodesBefore = (
        db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }
      ).c;

      await expect(
        persistScipIndex({ scipPath, projectRoot: tmpDir, db, qb }),
      ).rejects.toThrow(ScipDecodeError);

      // STAGE A runs before any persistent write — DB is byte-for-byte unchanged.
      const nodesAfter = (
        db.prepare('SELECT COUNT(*) c FROM nodes').get() as { c: number }
      ).c;
      expect(nodesAfter).toBe(nodesBefore);
      expect(
        db.prepare('SELECT COUNT(*) c FROM scip_ingestions').get(),
      ).toEqual({ c: 0 });
    } finally {
      conn.close();
    }
  });
});
