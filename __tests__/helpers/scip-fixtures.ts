/**
 * Test helper: synthesize valid (and deliberately invalid) `.scip` files.
 *
 * Files are written **streaming** — each `Document` / `SymbolInformation` is
 * encoded and flushed independently — so a multi-hundred-MB fixture can be
 * produced without the generator itself buffering the whole `Index` in memory.
 * That is exactly the property the P0.1 streaming decoder is tested against.
 *
 * Wire layout produced: a bare `Index` message —
 *   field 1 (metadata)         : one length-delimited `Metadata`
 *   field 2 (documents)        : repeated length-delimited `Document`
 *   field 3 (external_symbols) : repeated length-delimited `SymbolInformation`
 */

import * as fs from 'fs';
import { loadScipProtoTypes } from '../../src/extraction/scip/proto-loader';

export interface SyntheticOccurrence {
  range: number[];
  symbol: string;
  symbolRoles?: number;
}

export interface SyntheticRelationship {
  symbol: string;
  isImplementation?: boolean;
  isReference?: boolean;
  isTypeDefinition?: boolean;
}

export interface SyntheticSymbolInfo {
  symbol: string;
  kind?: number;
  displayName?: string;
  documentation?: string[];
  enclosingSymbol?: string;
  relationships?: SyntheticRelationship[];
}

export interface SyntheticDocument {
  relativePath: string;
  language?: string;
  occurrences?: SyntheticOccurrence[];
  symbols?: SyntheticSymbolInfo[];
}

export interface SyntheticScipSpec {
  metadata?: { toolName?: string; toolVersion?: string; projectRoot?: string };
  documents?: SyntheticDocument[];
  externalSymbols?: SyntheticSymbolInfo[];
  /** Emit `external_symbols` (field 3) before `documents` (field 2). */
  externalSymbolsFirst?: boolean;
  /** Emit `metadata` (field 1) last, after documents/symbols. */
  metadataLast?: boolean;
}

/** Encode an unsigned integer as a protobuf base-128 varint. */
function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value;
  do {
    let b = v & 0x7f;
    v = Math.floor(v / 128);
    if (v > 0) {
      b |= 0x80;
    }
    bytes.push(b);
  } while (v > 0);
  return Buffer.from(bytes);
}

/** Frame `payload` as a length-delimited field: `tag | length | payload`. */
function lengthDelimitedField(fieldNumber: number, payload: Buffer): Buffer {
  const tag = encodeVarint((fieldNumber << 3) | 2);
  return Buffer.concat([tag, encodeVarint(payload.length), payload]);
}

/** Drain-aware streaming write of an iterable of buffers. */
async function writeBuffers(
  scipPath: string,
  parts: AsyncIterable<Buffer> | Iterable<Buffer>,
): Promise<number> {
  const ws = fs.createWriteStream(scipPath);
  let total = 0;
  for await (const part of parts as AsyncIterable<Buffer>) {
    total += part.length;
    if (!ws.write(part)) {
      await new Promise<void>((resolve) => ws.once('drain', resolve));
    }
  }
  await new Promise<void>((resolve, reject) => {
    ws.on('error', reject);
    ws.end(resolve);
  });
  return total;
}

/**
 * Write a small, fully-specified `.scip` file. Intended for correctness
 * fixtures where every document/symbol is enumerated explicitly.
 */
export async function writeSyntheticScip(
  scipPath: string,
  spec: SyntheticScipSpec,
): Promise<void> {
  const { Metadata, Document, SymbolInformation } = await loadScipProtoTypes();

  const metadataParts: Buffer[] = [];
  if (spec.metadata) {
    const meta = Metadata.encode(
      Metadata.create({
        version: 1,
        projectRoot: spec.metadata.projectRoot ?? 'file:///synthetic',
        toolInfo: {
          name: spec.metadata.toolName ?? 'synthetic-indexer',
          version: spec.metadata.toolVersion ?? '0.0.0',
        },
      }),
    ).finish();
    metadataParts.push(lengthDelimitedField(1, Buffer.from(meta)));
  }

  const documentParts: Buffer[] = (spec.documents ?? []).map((doc) => {
    const encoded = Document.encode(
      Document.create({
        relativePath: doc.relativePath,
        language: doc.language ?? '',
        occurrences: doc.occurrences ?? [],
        symbols: doc.symbols ?? [],
      }),
    ).finish();
    return lengthDelimitedField(2, Buffer.from(encoded));
  });

  const externalParts: Buffer[] = (spec.externalSymbols ?? []).map((sym) => {
    const encoded = SymbolInformation.encode(
      SymbolInformation.create({
        symbol: sym.symbol,
        kind: sym.kind ?? 0,
        displayName: sym.displayName ?? '',
        documentation: sym.documentation ?? [],
        enclosingSymbol: sym.enclosingSymbol ?? '',
      }),
    ).finish();
    return lengthDelimitedField(3, Buffer.from(encoded));
  });

  const body = spec.externalSymbolsFirst
    ? [...externalParts, ...documentParts]
    : [...documentParts, ...externalParts];
  const parts = spec.metadataLast
    ? [...body, ...metadataParts]
    : [...metadataParts, ...body];

  await writeBuffers(scipPath, parts);
}

export interface LargeScipResult {
  documentCount: number;
  externalSymbolCount: number;
  /** Total bytes written to disk. */
  bytes: number;
}

/**
 * Stream-generate a large `.scip` file without buffering it. Each synthetic
 * document carries `occurrencesPerDoc` occurrences so the on-disk size is a
 * meaningful multiple of the decoder's working set.
 */
export async function writeLargeSyntheticScip(
  scipPath: string,
  opts: {
    documentCount: number;
    occurrencesPerDoc?: number;
    externalSymbolCount?: number;
  },
): Promise<LargeScipResult> {
  const { Metadata, Document, SymbolInformation } = await loadScipProtoTypes();
  const occurrencesPerDoc = opts.occurrencesPerDoc ?? 24;
  const externalSymbolCount = opts.externalSymbolCount ?? 0;

  async function* generate(): AsyncGenerator<Buffer> {
    const meta = Metadata.encode(
      Metadata.create({
        version: 1,
        projectRoot: 'file:///synthetic-large',
        toolInfo: { name: 'synthetic-indexer', version: '0.0.0' },
      }),
    ).finish();
    yield lengthDelimitedField(1, Buffer.from(meta));

    for (let d = 0; d < opts.documentCount; d++) {
      const occurrences: SyntheticOccurrence[] = [];
      for (let o = 0; o < occurrencesPerDoc; o++) {
        occurrences.push({
          range: [o, 0, o, 32],
          symbol: `scip-typescript npm synthetic 1.0.0 \`mod${d}\`/sym${o}().`,
          symbolRoles: o === 0 ? 1 : 0,
        });
      }
      const encoded = Document.encode(
        Document.create({
          relativePath: `src/generated/mod${d}.ts`,
          language: 'TypeScript',
          occurrences,
        }),
      ).finish();
      yield lengthDelimitedField(2, Buffer.from(encoded));
    }

    for (let e = 0; e < externalSymbolCount; e++) {
      const encoded = SymbolInformation.encode(
        SymbolInformation.create({
          symbol: `scip-typescript npm @types/node 1.0.0 \`ext${e}\`/Member#`,
          kind: 0,
          displayName: `ExternalMember${e}`,
        }),
      ).finish();
      yield lengthDelimitedField(3, Buffer.from(encoded));
    }
  }

  const bytes = await writeBuffers(scipPath, generate());
  return { documentCount: opts.documentCount, externalSymbolCount, bytes };
}

/** Truncate an existing file to `byteLength` bytes — for corruption tests. */
export function truncateScipFile(scipPath: string, byteLength: number): void {
  fs.truncateSync(scipPath, byteLength);
}
