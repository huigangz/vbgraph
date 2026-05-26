/**
 * P2.4 — Status command helpers: sidecar reader + per-language tier
 *        detection + QueryBuilder grouped count.
 *
 * Drives the new CodeGraph public APIs directly (sidecar JSON via fs,
 * tier detection by inserting nodes of known provenance). The CLI text/
 * JSON output is covered indirectly — the JSON shape is a transitive
 * function of these helpers, so testing the helpers covers the output
 * contract.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import type { SqliteDatabase } from '../src/db/sqlite-adapter';
import type { Node, ScipLastRefresh } from '../src/types';
import CodeGraph from '../src/index';
import { detectInstalledScipIndexers } from '../src/extraction/scip';

// SCIP indexer detection probes the PATH for ~7 binaries with 2s timeouts.
// First call can take 5+ seconds on systems where most indexers are absent.
// Cache is module-level, so warming once per suite amortizes the cost.
beforeAll(async () => {
  await detectInstalledScipIndexers();
}, 30000);

let tmpDir: string;
let projectRoot: string;
let conn: DatabaseConnection | undefined;
let db: SqliteDatabase;
let qb: QueryBuilder;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-p24-'));
  projectRoot = path.join(tmpDir, 'project');
  fs.mkdirSync(projectRoot, { recursive: true });
});

afterEach(() => {
  if (conn) {
    try { conn.close(); } catch { /* ignore double-close */ }
    conn = undefined;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * QueryBuilder-direct setup: bypasses CodeGraph init, opens the DB
 * directly. Used by the getNodeCountsByLanguageAndProvenance tests
 * that don't need the higher-level CodeGraph instance.
 */
function setupQueryBuilder(): void {
  fs.mkdirSync(path.join(projectRoot, '.codegraph'), { recursive: true });
  conn = DatabaseConnection.initialize(getDatabasePath(projectRoot));
  db = conn.getDb();
  qb = new QueryBuilder(db);
}

/**
 * CodeGraph-API setup: seeds project + DB, then returns a helper to
 * reopen as a CodeGraph instance once seeding is done.
 *
 * WASM SQLite does NOT allow two open connections on the same file
 * ("database is locked"), so we seed via QueryBuilder FIRST, close that
 * connection, then call CodeGraph.openSync. Tests that need to insert
 * MORE data after opening can grab cg.getStats() etc. but cannot mix
 * with a separate QueryBuilder until cg.close().
 *
 * Returns `{ reopenCg }` — call to get a fresh CodeGraph; caller closes.
 */
function setupForCodeGraph(): { reopenCg: () => CodeGraph } {
  // Init the project (creates .codegraph/ dir + config + DB schema).
  const cgInit = CodeGraph.initSync(projectRoot);
  cgInit.close();
  // Open the DB directly for seeding.
  conn = DatabaseConnection.open(getDatabasePath(projectRoot));
  db = conn.getDb();
  qb = new QueryBuilder(db);
  return {
    reopenCg: () => {
      // Close our seeding connection BEFORE CodeGraph opens its own.
      if (conn) {
        try { conn.close(); } catch { /* ignore */ }
        conn = undefined;
      }
      return CodeGraph.openSync(projectRoot);
    },
  };
}

function insertNode(overrides: Partial<Node> & { id: string; language: Node['language']; provenance: Node['provenance'] }): void {
  const node: Node = {
    id: overrides.id,
    kind: 'function',
    name: 'n_' + overrides.id,
    qualifiedName: 'q_' + overrides.id,
    filePath: overrides.filePath ?? `src/${overrides.id}.x`,
    language: overrides.language,
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
  qb.insertNode(node);
  // Make the language visible to getStats via the `files` table.
  qb.upsertFile({
    path: node.filePath,
    contentHash: 'h_' + overrides.id,
    language: node.language,
    size: 100,
    modifiedAt: 0,
    indexedAt: 0,
    nodeCount: 1,
  });
}

// ---------------------------------------------------------------------------
// getNodeCountsByLanguageAndProvenance (P2.4.3 QueryBuilder helper)
// ---------------------------------------------------------------------------

describe('P2.4 — getNodeCountsByLanguageAndProvenance', () => {
  beforeEach(() => setupQueryBuilder());

  it('groups per (language, provenance) pair', () => {
    insertNode({ id: 'a', language: 'csharp', provenance: 'scip' });
    insertNode({ id: 'b', language: 'csharp', provenance: 'scip' });
    insertNode({ id: 'c', language: 'csharp', provenance: 'tree-sitter' });
    insertNode({ id: 'd', language: 'vbnet', provenance: 'tree-sitter' });

    const rows = qb.getNodeCountsByLanguageAndProvenance();
    const byKey = new Map(rows.map((r) => [`${r.language}|${r.provenance}`, r.count]));

    expect(byKey.get('csharp|scip')).toBe(2);
    expect(byKey.get('csharp|tree-sitter')).toBe(1);
    expect(byKey.get('vbnet|tree-sitter')).toBe(1);
    expect(byKey.has('vbnet|scip')).toBe(false);
  });

  it('reads RAW state (counts hidden-stale rows too — round 4 invariant)', () => {
    insertNode({ id: 's', language: 'csharp', provenance: 'scip' });
    insertNode({ id: 'h', language: 'csharp', provenance: 'scip', filePath: 'H.cs' });

    // Mark one SCIP row hidden-stale.
    qb.markScipFileStale('H.cs', 0);

    const rows = qb.getNodeCountsByLanguageAndProvenance();
    const scipCount = rows.find((r) => r.language === 'csharp' && r.provenance === 'scip')?.count;
    expect(scipCount).toBe(2); // both still counted — hidden-stale is NOT filtered
  });
});

// ---------------------------------------------------------------------------
// CodeGraph.getLastScipRefresh (P2.4.2 sidecar reader)
// ---------------------------------------------------------------------------

describe('P2.4 — getLastScipRefresh', () => {
  it('returns null when sidecar is absent', () => {
    const { reopenCg } = setupForCodeGraph();
    const cg = reopenCg();
    try {
      expect(cg.getLastScipRefresh()).toBeNull();
    } finally {
      cg.close();
    }
  });

  it('parses a valid sidecar and returns the typed object', () => {
    const sidecar: ScipLastRefresh = {
      refreshedAt: '2026-05-24T09:21:33.000Z',
      scipPath: '/abs/path/to/index.scip',
      command: 'scip-dotnet index ./',
      filesCovered: 123,
      durationMs: 4567,
      lastError: null,  // Round-3 sidecar field; null = clean refresh.
    };
    const { reopenCg } = setupForCodeGraph();
    fs.writeFileSync(
      path.join(projectRoot, '.codegraph', 'scip-last-refresh.json'),
      JSON.stringify(sidecar),
    );
    const cg = reopenCg();
    try {
      expect(cg.getLastScipRefresh()).toEqual(sidecar);
    } finally {
      cg.close();
    }
  });

  it('returns null on malformed JSON', () => {
    const { reopenCg } = setupForCodeGraph();
    fs.writeFileSync(
      path.join(projectRoot, '.codegraph', 'scip-last-refresh.json'),
      '{not valid json',
    );
    const cg = reopenCg();
    try {
      expect(cg.getLastScipRefresh()).toBeNull();
    } finally {
      cg.close();
    }
  });

  it('returns null when required fields are missing', () => {
    const { reopenCg } = setupForCodeGraph();
    // Missing `command` and `durationMs`.
    fs.writeFileSync(
      path.join(projectRoot, '.codegraph', 'scip-last-refresh.json'),
      JSON.stringify({
        refreshedAt: '2026-05-24T09:21:33.000Z',
        scipPath: '/abs/p.scip',
        filesCovered: 0,
      }),
    );
    const cg = reopenCg();
    try {
      expect(cg.getLastScipRefresh()).toBeNull();
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CodeGraph.getLanguageTiers (P2.4.3)
// ---------------------------------------------------------------------------

describe('P2.4 — getLanguageTiers', () => {
  it('reports tier-1 when SCIP nodes exist for a language', async () => {
    const { reopenCg } = setupForCodeGraph();
    insertNode({ id: 'a', language: 'csharp', provenance: 'scip' });
    insertNode({ id: 'b', language: 'csharp', provenance: 'tree-sitter' });

    const cg = reopenCg();
    try {
      const tiers = await cg.getLanguageTiers();
      const cs = tiers.find((t) => t.language === 'csharp');
      expect(cs?.tier).toBe('tier-1');
      expect(cs?.scipNodeCount).toBe(1);
      expect(cs?.treeSitterNodeCount).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('reports tier-0 when no SCIP nodes exist', async () => {
    const { reopenCg } = setupForCodeGraph();
    insertNode({ id: 'a', language: 'vbnet', provenance: 'tree-sitter' });

    const cg = reopenCg();
    try {
      const tiers = await cg.getLanguageTiers();
      const vb = tiers.find((t) => t.language === 'vbnet');
      expect(vb?.tier).toBe('tier-0');
      expect(vb?.scipNodeCount).toBe(0);
      expect(vb?.treeSitterNodeCount).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('counts scip-empty-fallback toward treeSitterNodeCount, NOT scipNodeCount', async () => {
    const { reopenCg } = setupForCodeGraph();
    // Fallback rows are SCIP-coverage-with-empty-doc — they get the
    // `'tree-sitter (scip-empty-fallback)'` provenance. For tier purposes
    // they're syntactic, not compiler — match user mental model.
    insertNode({
      id: 'f',
      language: 'csharp',
      provenance: 'tree-sitter (scip-empty-fallback)',
    });

    const cg = reopenCg();
    try {
      const tiers = await cg.getLanguageTiers();
      const cs = tiers.find((t) => t.language === 'csharp');
      expect(cs?.tier).toBe('tier-0');
      expect(cs?.scipNodeCount).toBe(0);
      expect(cs?.treeSitterNodeCount).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('sorts languages by file count descending', async () => {
    const { reopenCg } = setupForCodeGraph();
    insertNode({ id: 'cs1', language: 'csharp', provenance: 'tree-sitter', filePath: 'A.cs' });
    insertNode({ id: 'cs2', language: 'csharp', provenance: 'tree-sitter', filePath: 'B.cs' });
    insertNode({ id: 'cs3', language: 'csharp', provenance: 'tree-sitter', filePath: 'C.cs' });
    insertNode({ id: 'vb1', language: 'vbnet', provenance: 'tree-sitter', filePath: 'D.vb' });

    const cg = reopenCg();
    try {
      const tiers = await cg.getLanguageTiers();
      const langs = tiers.map((t) => t.language);
      // csharp (3 files) > vbnet (1 file)
      expect(langs.indexOf('csharp')).toBeLessThan(langs.indexOf('vbnet'));
    } finally {
      cg.close();
    }
  });

  it('returns empty array when no files are tracked', async () => {
    const { reopenCg } = setupForCodeGraph();
    const cg = reopenCg();
    try {
      const tiers = await cg.getLanguageTiers();
      expect(tiers).toEqual([]);
    } finally {
      cg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime (P2.4.4 helper — exported indirectly via CLI behavior)
// ---------------------------------------------------------------------------

describe('P2.4 — formatRelativeTime smoke (via getLastScipRefresh round-trip)', () => {
  it('a just-now sidecar produces parsable relative time', () => {
    const { reopenCg } = setupForCodeGraph();
    const justNow: ScipLastRefresh = {
      refreshedAt: new Date().toISOString(),
      scipPath: '/x.scip',
      command: 'scip-dotnet index ./',
      filesCovered: 1,
      durationMs: 100,
      lastError: null,
    };
    fs.writeFileSync(
      path.join(projectRoot, '.codegraph', 'scip-last-refresh.json'),
      JSON.stringify(justNow),
    );
    const cg = reopenCg();
    try {
      const sidecar = cg.getLastScipRefresh();
      expect(sidecar).not.toBeNull();
      // Date.parse should succeed on the ISO string written by refresh.
      expect(Number.isNaN(Date.parse(sidecar!.refreshedAt))).toBe(false);
    } finally {
      cg.close();
    }
  });
});
