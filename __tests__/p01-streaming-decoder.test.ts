/**
 * P0.1 — True streaming SCIP decoder.
 *
 * Verifies the wire-level `Index` reader: round-trip correctness, truncation /
 * corruption rejection, field-order independence, and — the implementation
 * red line — that iterating a large `.scip` keeps the resident set far below
 * the file size (i.e. the file is genuinely streamed, never buffered whole).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  readScipMetadata,
  iterateScipDocuments,
  iterateScipExternalSymbols,
  ScipDecodeError,
} from '../src/extraction/scip/streaming-decoder';
import {
  writeSyntheticScip,
  writeLargeSyntheticScip,
  truncateScipFile,
} from './helpers/scip-fixtures';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-scip-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of it) {
    out.push(item);
  }
  return out;
}

describe('streaming decoder — correctness', () => {
  it('round-trips documents, occurrences and nested symbols', async () => {
    const file = path.join(tmpDir, 'ok.scip');
    await writeSyntheticScip(file, {
      metadata: { toolName: 'scip-dotnet', toolVersion: '0.5.4' },
      documents: [
        {
          relativePath: 'src/A.cs',
          language: 'C#',
          occurrences: [
            { range: [1, 0, 1, 10], symbol: 'csharp . . A#', symbolRoles: 1 },
            { range: [2, 4, 2, 7], symbol: 'csharp . . A#foo().' },
          ],
          symbols: [{ symbol: 'csharp . . A#', kind: 9, displayName: 'A' }],
        },
        { relativePath: 'src/B.cs', language: 'C#' },
      ],
    });

    const docs = await collect(iterateScipDocuments(file));
    expect(docs.map((d) => d.relativePath)).toEqual(['src/A.cs', 'src/B.cs']);
    expect(docs[0]?.occurrences).toHaveLength(2);
    expect(docs[0]?.occurrences[0]?.symbol).toBe('csharp . . A#');
    expect(docs[0]?.occurrences[0]?.range).toEqual([1, 0, 1, 10]);
    expect(docs[0]?.occurrences[0]?.symbolRoles).toBe(1);
    expect(docs[0]?.symbols[0]?.displayName).toBe('A');
    expect(docs[1]?.occurrences).toEqual([]);
  });

  it('reads Index.metadata with tool info', async () => {
    const file = path.join(tmpDir, 'meta.scip');
    await writeSyntheticScip(file, {
      metadata: {
        toolName: 'scip-dotnet',
        toolVersion: '0.5.4',
        projectRoot: 'file:///proj',
      },
      documents: [{ relativePath: 'X.cs' }],
    });

    const meta = await readScipMetadata(file);
    expect(meta.toolInfo?.name).toBe('scip-dotnet');
    expect(meta.toolInfo?.version).toBe('0.5.4');
    expect(meta.projectRoot).toBe('file:///proj');
  });

  it('streams external symbols without yielding documents', async () => {
    const file = path.join(tmpDir, 'ext.scip');
    await writeSyntheticScip(file, {
      metadata: {},
      documents: [{ relativePath: 'X.cs' }, { relativePath: 'Y.cs' }],
      externalSymbols: [
        { symbol: 'dotnet System.Console#WriteLine().', displayName: 'WriteLine' },
        { symbol: 'dotnet System.String#', displayName: 'String', kind: 9 },
      ],
    });

    const externals = await collect(iterateScipExternalSymbols(file));
    expect(externals.map((s) => s.symbol)).toEqual([
      'dotnet System.Console#WriteLine().',
      'dotnet System.String#',
    ]);
    expect(externals[1]?.displayName).toBe('String');
    // The document stream over the same file is independent.
    const docs = await collect(iterateScipDocuments(file));
    expect(docs).toHaveLength(2);
  });

  it('yields nothing for an empty file and refuses metadata', async () => {
    const file = path.join(tmpDir, 'empty.scip');
    fs.writeFileSync(file, Buffer.alloc(0));
    expect(await collect(iterateScipDocuments(file))).toEqual([]);
    expect(await collect(iterateScipExternalSymbols(file))).toEqual([]);
    await expect(readScipMetadata(file)).rejects.toThrow(ScipDecodeError);
  });
});

describe('streaming decoder — field ordering', () => {
  it('decodes documents and externals regardless of field order', async () => {
    const file = path.join(tmpDir, 'reordered.scip');
    await writeSyntheticScip(file, {
      metadata: { toolName: 'scip-go' },
      documents: [{ relativePath: 'a.go' }, { relativePath: 'b.go' }],
      externalSymbols: [{ symbol: 'go fmt#Println().' }],
      externalSymbolsFirst: true,
      metadataLast: true,
    });

    expect((await collect(iterateScipDocuments(file))).map((d) => d.relativePath)).toEqual([
      'a.go',
      'b.go',
    ]);
    expect(await collect(iterateScipExternalSymbols(file))).toHaveLength(1);
    // metadata appears last in the wire stream — full scan still finds it.
    expect((await readScipMetadata(file)).toolInfo?.name).toBe('scip-go');
  });
});

describe('streaming decoder — corruption / truncation', () => {
  it('rejects a file truncated mid-document', async () => {
    const file = path.join(tmpDir, 'truncated.scip');
    await writeSyntheticScip(file, {
      metadata: {},
      documents: [
        { relativePath: 'a.cs', occurrences: [{ range: [0, 0, 0, 5], symbol: 's' }] },
        { relativePath: 'b.cs', occurrences: [{ range: [1, 0, 1, 5], symbol: 't' }] },
        { relativePath: 'c.cs', occurrences: [{ range: [2, 0, 2, 5], symbol: 'u' }] },
      ],
    });
    // Lop off the tail so the last declared submessage runs past EOF.
    truncateScipFile(file, fs.statSync(file).size - 20);

    await expect(collect(iterateScipDocuments(file))).rejects.toThrow(ScipDecodeError);
  });

  it('rejects a file truncated inside the leading varint header', async () => {
    const file = path.join(tmpDir, 'stub.scip');
    await writeSyntheticScip(file, {
      metadata: {},
      documents: [{ relativePath: 'a.cs' }],
    });
    // Keep only the field tag — the length varint / payload are gone.
    truncateScipFile(file, 1);

    await expect(readScipMetadata(file)).rejects.toThrow(ScipDecodeError);
  });
});

describe('streaming decoder — memory', () => {
  it(
    'streams a large .scip with resident memory far below the file size',
    async () => {
      const file = path.join(tmpDir, 'large.scip');
      const result = await writeLargeSyntheticScip(file, {
        documentCount: 60_000,
        occurrencesPerDoc: 30,
        externalSymbolCount: 8_000,
      });
      // Sanity: the fixture is genuinely large (streaming proof needs headroom).
      expect(result.bytes).toBeGreaterThan(80 * 1024 * 1024);

      const baseline = process.memoryUsage().rss;
      let peakDelta = 0;
      let docCount = 0;
      for await (const _doc of iterateScipDocuments(file)) {
        docCount++;
        if ((docCount & 0xff) === 0) {
          const delta = process.memoryUsage().rss - baseline;
          if (delta > peakDelta) {
            peakDelta = delta;
          }
        }
      }
      expect(docCount).toBe(result.documentCount);

      // The whole file is >80 MB; a true streaming decoder holds only the
      // working set. 64 MB leaves generous room for V8 heap + ungc'd garbage
      // while still failing loudly if the file were buffered whole.
      expect(peakDelta).toBeLessThan(64 * 1024 * 1024);

      // External symbols stream from an independent pass.
      let externalCount = 0;
      for await (const _sym of iterateScipExternalSymbols(file)) {
        externalCount++;
      }
      expect(externalCount).toBe(result.externalSymbolCount);

      // When the harness exposes gc (--expose-gc), assert no net leak.
      const gc = (globalThis as { gc?: () => void }).gc;
      if (typeof gc === 'function') {
        gc();
        const settled = process.memoryUsage().rss - baseline;
        expect(settled).toBeLessThan(32 * 1024 * 1024);
      }
    },
    120_000,
  );
});
