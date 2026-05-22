/**
 * P0.8 — Node provenance / SCIP-ownership columns round-trip.
 *
 * Verifies the QueryBuilder touch points: a node inserted with
 * `provenance` / `scipSymbol` / `scipIndexPath` survives a write -> read
 * cycle, and a node without them falls back to the schema defaults.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

let tmpDir: string;
let conn: DatabaseConnection;
let qb: QueryBuilder;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p08-'));
  conn = DatabaseConnection.initialize(path.join(tmpDir, 'p08.db'));
  qb = new QueryBuilder(conn.getDb());
});

afterEach(() => {
  conn.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function baseNode(id: string): Node {
  return {
    id,
    kind: 'class',
    name: id,
    qualifiedName: id,
    filePath: 'src/X.cs',
    language: 'csharp',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

describe('node provenance / SCIP columns', () => {
  it('round-trips provenance, scipSymbol and scipIndexPath', () => {
    qb.insertNode({
      ...baseNode('scip:abc'),
      provenance: 'scip',
      scipSymbol: 'scip-dotnet nuget P 1.0.0 N/X#',
      scipIndexPath: '/repo/index.scip',
    });

    const got = qb.getNodeById('scip:abc');
    expect(got).not.toBeNull();
    expect(got?.provenance).toBe('scip');
    expect(got?.scipSymbol).toBe('scip-dotnet nuget P 1.0.0 N/X#');
    expect(got?.scipIndexPath).toBe('/repo/index.scip');
  });

  it("defaults provenance to 'tree-sitter' and leaves SCIP fields unset", () => {
    qb.insertNode(baseNode('plain'));

    const got = qb.getNodeById('plain');
    expect(got?.provenance).toBe('tree-sitter');
    expect(got?.scipSymbol).toBeUndefined();
    expect(got?.scipIndexPath).toBeUndefined();
  });

  it('accepts a framework provenance value', () => {
    qb.insertNode({ ...baseNode('fw'), provenance: 'framework:aspnet' });
    expect(qb.getNodeById('fw')?.provenance).toBe('framework:aspnet');
  });
});
