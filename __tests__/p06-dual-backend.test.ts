/**
 * P0.6 — orchestrator dual-backend dispatch.
 *
 * `vbgraph index --scip <path>` ingests the SCIP backend and the tree-sitter
 * pass skips the SCIP-covered files; `--no-scip` forces Tier 0. The
 * `--scip-auto` spawn loop is exercised directly with a fake indexer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { VBGraph } from '../src';
import { runScipAutoSpawn } from '../src/extraction/scip';
import type { DetectedIndexer } from '../src/extraction/scip';
import { writeSyntheticScip } from './helpers/scip-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-p06-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Write a source file under the project root. */
function writeSource(rel: string, content: string): void {
  const abs = path.join(tmpDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** A synthetic `.scip` covering `src/A.cs` with one class. */
async function writeCsScip(scipPath: string): Promise<void> {
  await writeSyntheticScip(scipPath, {
    metadata: { toolName: 'scip-dotnet' },
    documents: [
      {
        relativePath: 'src/A.cs',
        occurrences: [
          { range: [0, 0, 8, 0], symbol: 'csharp . . . N/A#', symbolRoles: 1 },
        ],
        symbols: [{ symbol: 'csharp . . . N/A#', kind: 7, displayName: 'A' }],
      },
    ],
  });
}

describe('dual-backend dispatch via vbgraph index --scip', () => {
  it('ingests SCIP for covered files and tree-sitters the rest', async () => {
    writeSource('src/A.cs', 'namespace N { class A { void M() {} } }\n');
    writeSource('src/util.ts', 'export function helper() { return 1; }\n');
    const scipPath = path.join(tmpDir, 'index.scip');
    await writeCsScip(scipPath);

    const cg = VBGraph.initSync(tmpDir);
    try {
      const result = await cg.indexAll({ scip: [scipPath] });
      expect(result.success).toBe(true);

      const csNodes = cg.getNodesInFile('src/A.cs');
      const tsNodes = cg.getNodesInFile('src/util.ts');

      // src/A.cs came from SCIP — every node is compiler-grade.
      expect(csNodes.length).toBeGreaterThan(0);
      expect(csNodes.every((n) => n.provenance === 'scip')).toBe(true);
      // ...and was NOT re-extracted by tree-sitter.
      expect(csNodes.some((n) => n.provenance === 'tree-sitter')).toBe(false);
      expect(csNodes.some((n) => n.name === 'A' && n.kind === 'class')).toBe(true);

      // src/util.ts is not SCIP-covered — tree-sitter extracted it.
      expect(tsNodes.length).toBeGreaterThan(0);
      expect(tsNodes.some((n) => n.name === 'helper')).toBe(true);
    } finally {
      cg.close();
    }
  });

  it('--no-scip forces tree-sitter even when a .scip is supplied', async () => {
    writeSource('src/A.cs', 'namespace N { class A { void M() {} } }\n');
    const scipPath = path.join(tmpDir, 'index.scip');
    await writeCsScip(scipPath);

    const cg = VBGraph.initSync(tmpDir);
    try {
      await cg.indexAll({ scip: [scipPath], noScip: true });
      const csNodes = cg.getNodesInFile('src/A.cs');
      // SCIP was skipped — the .cs file went through the tree-sitter backend.
      expect(csNodes.length).toBeGreaterThan(0);
      expect(csNodes.every((n) => n.provenance !== 'scip')).toBe(true);
    } finally {
      cg.close();
    }
  });

  it('rejects two overlapping explicit --scip paths, leaving the DB unchanged', async () => {
    writeSource('src/A.cs', 'namespace N { class A {} }\n');
    const aScip = path.join(tmpDir, 'a.scip');
    const bScip = path.join(tmpDir, 'b.scip');
    await writeCsScip(aScip); // covers src/A.cs
    await writeCsScip(bScip); // also covers src/A.cs — overlap

    const cg = VBGraph.initSync(tmpDir);
    try {
      const result = await cg.indexAll({ scip: [aScip, bScip] });
      expect(result.success).toBe(false);
      // The batch pre-scan detects the overlap before ingesting either index,
      // so neither a.scip nor b.scip is committed (ship gate 5).
      expect(cg.getStats().nodeCount).toBe(0);
      expect(cg.getStats().edgeCount).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('fails the index when an explicit --scip path is corrupt (DB unchanged)', async () => {
    writeSource('src/util.ts', 'export const x = 1;\n');
    const badScip = path.join(tmpDir, 'bad.scip');
    fs.writeFileSync(badScip, Buffer.from([0x01, 0x02, 0x03]));

    const cg = VBGraph.initSync(tmpDir);
    try {
      const result = await cg.indexAll({ scip: [badScip] });
      expect(result.success).toBe(false);
      expect(result.errors[0]?.message).toMatch(/SCIP ingestion failed/);
      expect(cg.getStats().nodeCount).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('a forced reindex re-indexes a file a prior SCIP run covered', async () => {
    writeSource('src/A.cs', 'namespace N { class A { void M() {} } }\n');
    const scipPath = path.join(tmpDir, 'index.scip');
    await writeCsScip(scipPath);

    const cg = VBGraph.initSync(tmpDir);
    try {
      await cg.indexAll({ scip: [scipPath] });
      expect(cg.getNodesInFile('src/A.cs').every((n) => n.provenance === 'scip')).toBe(true);

      // `vbgraph index --force` clears the graph, then re-indexes Tier 0.
      // clear() must also wipe scip_documents — otherwise src/A.cs stays
      // "SCIP-covered", the tree-sitter pass skips it, and it ends unindexed.
      cg.clear();
      await cg.indexAll();

      const csNodes = cg.getNodesInFile('src/A.cs');
      expect(csNodes.length).toBeGreaterThan(0);
      expect(csNodes.every((n) => n.provenance !== 'scip')).toBe(true);
    } finally {
      cg.close();
    }
  });

  it('tree-sitters an empty SCIP document, refs and all, through index --scip', async () => {
    // A real, over-threshold .cs file SCIP produced an empty document for
    // (e.g. a build error isolated to this file). Alpha calls Beta — a
    // file-local call that flows through `unresolvedReferences`.
    writeSource(
      'src/Wide.cs',
      'namespace N {\n' +
        '  // This file is comfortably over the empty-fallback byte threshold\n' +
        '  // so the empty-document tree-sitter fallback path is exercised.\n' +
        '  class Wide {\n' +
        '    void Alpha() { Beta(); }\n' +
        '    void Beta() {}\n' +
        '    void Gamma() {}\n' +
        '  }\n}\n',
    );
    const scipPath = path.join(tmpDir, 'index.scip');
    await writeSyntheticScip(scipPath, {
      metadata: { toolName: 'scip-dotnet' },
      documents: [{ relativePath: 'src/Wide.cs', occurrences: [] }],
    });

    const cg = VBGraph.initSync(tmpDir);
    try {
      const result = await cg.indexAll({ scip: [scipPath] });
      expect(result.success).toBe(true);

      const nodes = cg.getNodesInFile('src/Wide.cs');
      expect(nodes.length).toBeGreaterThan(0);
      expect(
        nodes.some((n) => n.provenance === 'tree-sitter (scip-empty-fallback)'),
      ).toBe(true);

      // The file-local Alpha -> Beta call must survive: `unresolvedReferences`
      // flow through the fallback into the resolver pass, exactly as for a
      // normal tree-sitter file. Symbols+containment alone is not enough.
      const alpha = nodes.find((n) => n.name === 'Alpha');
      const beta = nodes.find((n) => n.name === 'Beta');
      expect(alpha && beta).toBeTruthy();
      const callEdge = cg
        .getOutgoingEdges(alpha!.id)
        .find((e) => e.kind === 'calls' && e.target === beta!.id);
      expect(callEdge).toBeDefined();
    } finally {
      cg.close();
    }
  });
});

describe('runScipAutoSpawn', () => {
  /** A fake indexer: `node fake.js <srcScip> <outPath>` copies srcScip -> outPath. */
  function makeFakeIndexer(
    name: string,
    languages: DetectedIndexer['languages'],
    srcScip: string,
    opts: { exitCode?: number } = {},
  ): DetectedIndexer {
    const script = path.join(tmpDir, `${name}-fake.js`);
    fs.writeFileSync(
      script,
      // `exitCode` defined -> exit with it and write nothing (covers the
      // exit-0-without-output case); otherwise copy srcScip -> outPath.
      opts.exitCode !== undefined
        ? `process.exit(${opts.exitCode});\n`
        : `require('fs').copyFileSync(process.argv[2], process.argv[3]);\n`,
    );
    return {
      name,
      cmd: name,
      languages,
      installHint: `install ${name}`,
      resolvedPath: process.execPath,
      version: 'unknown',
      indexArgs: (out: string) => [script, srcScip, out],
    };
  }

  it('spawns a detected indexer and returns the produced .scip', async () => {
    const vbgraphDir = path.join(tmpDir, '.vbgraph');
    fs.mkdirSync(vbgraphDir, { recursive: true });
    const srcScip = path.join(tmpDir, 'src.scip');
    await writeCsScip(srcScip);

    const result = await runScipAutoSpawn({
      projectRoot: tmpDir,
      vbgraphDir,
      languagesInRepo: new Set(['csharp']),
      detected: [makeFakeIndexer('scip-fake', ['csharp'], srcScip)],
    });

    expect(result.scipPaths).toHaveLength(1);
    expect(fs.existsSync(result.scipPaths[0]!)).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('records a failure (no .scip) when an indexer exits non-zero', async () => {
    const vbgraphDir = path.join(tmpDir, '.vbgraph');
    fs.mkdirSync(vbgraphDir, { recursive: true });

    const result = await runScipAutoSpawn({
      projectRoot: tmpDir,
      vbgraphDir,
      languagesInRepo: new Set(['csharp']),
      detected: [makeFakeIndexer('scip-fail', ['csharp'], 'unused', { exitCode: 1 })],
    });

    expect(result.scipPaths).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.indexer).toBe('scip-fail');
    expect(result.failures[0]?.fallback).toBe('tree-sitter');
  });

  it('skips an indexer whose languages are absent from the repo', async () => {
    const vbgraphDir = path.join(tmpDir, '.vbgraph');
    fs.mkdirSync(vbgraphDir, { recursive: true });
    const srcScip = path.join(tmpDir, 'src.scip');
    await writeCsScip(srcScip);

    const result = await runScipAutoSpawn({
      projectRoot: tmpDir,
      vbgraphDir,
      languagesInRepo: new Set(['csharp']), // no java
      detected: [makeFakeIndexer('scip-java', ['java'], srcScip)],
    });

    expect(result.scipPaths).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('ignores a stale cached .scip when the indexer writes no output', async () => {
    const vbgraphDir = path.join(tmpDir, '.vbgraph');
    const cacheDir = path.join(vbgraphDir, 'scip-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    // A stale artifact from a prior run sits at the deterministic cache path.
    await writeCsScip(path.join(cacheDir, 'scip-stale.scip'));

    const result = await runScipAutoSpawn({
      projectRoot: tmpDir,
      vbgraphDir,
      languagesInRepo: new Set(['csharp']),
      // Exits 0 but writes nothing — must be a failure, not a stale ingest.
      detected: [makeFakeIndexer('scip-stale', ['csharp'], 'unused', { exitCode: 0 })],
    });

    expect(result.scipPaths).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.indexer).toBe('scip-stale');
  });
});
