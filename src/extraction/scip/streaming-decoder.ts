/**
 * True streaming SCIP decoder.
 *
 * A `.scip` file is a single protobuf `Index` message. It can be 500 MB+ with
 * a million `Document` submessages, so it must never be loaded whole. This
 * module parses the top-level `Index` wire format **by hand** — reading one
 * length-delimited submessage at a time — and uses `protobufjs` only to decode
 * each individual `Document` / `SymbolInformation` / `Metadata` submessage.
 *
 * Memory profile: the process holds the chunked read buffer (~64 KB) plus the
 * single submessage currently being decoded. Nothing is buffered globally.
 *
 * The three public entry points each open an independent read stream:
 *   - `readScipMetadata`        — scans for `Index.metadata` (field 1), early-exit.
 *   - `iterateScipDocuments`    — streams `Index.documents` (field 2).
 *   - `iterateScipExternalSymbols` — streams `Index.external_symbols` (field 3).
 */

import * as fs from 'fs';
import * as protobuf from 'protobufjs';
import { loadScipProtoTypes } from './proto-loader';

/** Thrown when a `.scip` file is truncated, corrupt, or otherwise undecodable. */
export class ScipDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScipDecodeError';
  }
}

// ---------------------------------------------------------------------------
// Decoded shapes (camelCase — protobufjs camelCases proto field names).
// Only the fields downstream phases consume are typed; `toObject` still
// returns every field, so unlisted fields are present but untyped.
// ---------------------------------------------------------------------------

export interface ScipToolInfo {
  name?: string;
  version?: string;
  arguments?: string[];
}

export interface ScipMetadata {
  /** `ProtocolVersion` enum, as a number. */
  version?: number;
  toolInfo?: ScipToolInfo;
  projectRoot?: string;
  /** `TextEncoding` enum, as a number. */
  textDocumentEncoding?: number;
}

export interface ScipOccurrence {
  /** `[startLine, startCol, endLine, endCol]` or 3-element single-line form. */
  range: number[];
  symbol: string;
  /** Bitset of `SymbolRole` values. */
  symbolRoles?: number;
  overrideDocumentation?: string[];
  /** `SyntaxKind` enum, as a number. */
  syntaxKind?: number;
  enclosingRange?: number[];
}

export interface ScipRelationship {
  symbol: string;
  isReference?: boolean;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  documentation: string[];
  relationships: ScipRelationship[];
  /** `SymbolInformation.Kind` enum, as a number. */
  kind?: number;
  displayName?: string;
  enclosingSymbol?: string;
}

export interface ScipDocument {
  relativePath: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
  language?: string;
  text?: string;
  /** `PositionEncoding` enum, as a number. */
  positionEncoding?: number;
}

// ---------------------------------------------------------------------------
// Protobuf wire-format constants
// ---------------------------------------------------------------------------

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LEN = 2;
const WIRE_FIXED32 = 5;

/** `Index` message field numbers (see `scip.proto`). */
const FIELD_METADATA = 1;
const FIELD_DOCUMENTS = 2;
const FIELD_EXTERNAL_SYMBOLS = 3;

/** Plain detached objects — easier on GC and free of protobufjs prototypes. */
const TO_OBJECT_OPTS: protobuf.IConversionOptions = {
  longs: Number,
  enums: Number,
  bytes: String,
  defaults: true,
  arrays: true,
  objects: true,
};

// ---------------------------------------------------------------------------
// Chunked byte reader over a file read stream
// ---------------------------------------------------------------------------

/**
 * Pull-based reader over `fs.createReadStream`. Exposes exactly the primitives
 * the wire parser needs: varint, fixed-width skip, length-delimited read.
 */
class StreamByteReader {
  private readonly stream: fs.ReadStream;
  private readonly chunks: AsyncIterator<Buffer>;
  /** Unconsumed bytes pulled from the stream so far. */
  private buf: Buffer = Buffer.alloc(0);
  private eof = false;

  constructor(scipPath: string) {
    this.stream = fs.createReadStream(scipPath);
    this.chunks = this.stream[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }

  /** Append the next stream chunk to `buf`; returns false at EOF. */
  private async pull(): Promise<boolean> {
    if (this.eof) {
      return false;
    }
    const next = await this.chunks.next();
    if (next.done || next.value === undefined) {
      this.eof = true;
      return false;
    }
    this.buf =
      this.buf.length === 0 ? next.value : Buffer.concat([this.buf, next.value]);
    return true;
  }

  /** True once every byte has been consumed and the stream is exhausted. */
  async atEnd(): Promise<boolean> {
    while (this.buf.length === 0 && !this.eof) {
      await this.pull();
    }
    return this.buf.length === 0 && this.eof;
  }

  /** Read a base-128 varint. Throws `ScipDecodeError` on truncation. */
  async readVarint(): Promise<number> {
    let result = 0;
    let multiplier = 1;
    for (let i = 0; i < 10; i++) {
      while (this.buf.length === 0) {
        if (!(await this.pull())) {
          throw new ScipDecodeError('unexpected EOF while reading a varint');
        }
      }
      const byte = this.buf[0]!;
      this.buf = this.buf.subarray(1);
      result += (byte & 0x7f) * multiplier;
      if ((byte & 0x80) === 0) {
        return result;
      }
      multiplier *= 128;
    }
    throw new ScipDecodeError('varint exceeds 10 bytes (corrupt .scip)');
  }

  /** Read exactly `n` bytes. Throws `ScipDecodeError` on truncation. */
  async readBytes(n: number): Promise<Buffer> {
    while (this.buf.length < n) {
      if (!(await this.pull())) {
        throw new ScipDecodeError(
          `unexpected EOF: needed ${n} bytes, only ${this.buf.length} available`,
        );
      }
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  /** Discard exactly `n` bytes without materializing them. */
  async skipBytes(n: number): Promise<void> {
    let remaining = n;
    while (remaining > 0) {
      while (this.buf.length === 0) {
        if (!(await this.pull())) {
          throw new ScipDecodeError(
            `unexpected EOF while skipping ${n} bytes (corrupt .scip)`,
          );
        }
      }
      const take = Math.min(remaining, this.buf.length);
      this.buf = this.buf.subarray(take);
      remaining -= take;
    }
  }

  /** Release the underlying file handle. Safe to call more than once. */
  close(): void {
    this.stream.destroy();
  }
}

/**
 * Scan the top-level `Index` message, yielding the raw bytes of every
 * length-delimited submessage whose field number is requested in `want`.
 * Fields not requested are skipped without allocation; non-`LEN` fields and
 * unknown field numbers are skipped too, so field ordering is irrelevant and
 * forward-compatible additions to the SCIP schema do not break the parser.
 */
async function* scanIndexFields(
  scipPath: string,
  want: { metadata?: boolean; documents?: boolean; externalSymbols?: boolean },
): AsyncGenerator<{ field: number; bytes: Buffer }> {
  const reader = new StreamByteReader(scipPath);
  try {
    while (!(await reader.atEnd())) {
      const tag = await reader.readVarint();
      const field = tag >>> 3;
      const wireType = tag & 0x7;

      if (wireType === WIRE_LEN) {
        const length = await reader.readVarint();
        const wanted =
          (field === FIELD_METADATA && want.metadata === true) ||
          (field === FIELD_DOCUMENTS && want.documents === true) ||
          (field === FIELD_EXTERNAL_SYMBOLS && want.externalSymbols === true);
        if (wanted) {
          yield { field, bytes: await reader.readBytes(length) };
        } else {
          await reader.skipBytes(length);
        }
      } else if (wireType === WIRE_VARINT) {
        await reader.readVarint();
      } else if (wireType === WIRE_FIXED64) {
        await reader.skipBytes(8);
      } else if (wireType === WIRE_FIXED32) {
        await reader.skipBytes(4);
      } else {
        throw new ScipDecodeError(
          `unsupported wire type ${wireType} at field ${field} (corrupt .scip)`,
        );
      }
    }
  } finally {
    reader.close();
  }
}

// ---------------------------------------------------------------------------
// Public streaming API
// ---------------------------------------------------------------------------

/**
 * Read the `Index.metadata` block. Scans from the start and returns as soon as
 * the metadata field is seen (SCIP writes it first), so this does not read the
 * whole file in the common case — but it tolerates any field ordering.
 *
 * @throws {ScipDecodeError} when the file is corrupt or has no metadata field.
 */
export async function readScipMetadata(scipPath: string): Promise<ScipMetadata> {
  const { Metadata } = await loadScipProtoTypes();
  for await (const { bytes } of scanIndexFields(scipPath, { metadata: true })) {
    return Metadata.toObject(Metadata.decode(bytes), TO_OBJECT_OPTS) as ScipMetadata;
  }
  throw new ScipDecodeError(`${scipPath}: no Index.metadata field found`);
}

/**
 * Stream every `Document` in the index. Each document is decoded, yielded, and
 * then eligible for GC before the next is read.
 *
 * @throws {ScipDecodeError} when the file is truncated or corrupt.
 */
export async function* iterateScipDocuments(
  scipPath: string,
): AsyncGenerator<ScipDocument> {
  const { Document } = await loadScipProtoTypes();
  for await (const { bytes } of scanIndexFields(scipPath, { documents: true })) {
    yield Document.toObject(Document.decode(bytes), TO_OBJECT_OPTS) as ScipDocument;
  }
}

/**
 * Stream every external `SymbolInformation` in the index — symbols referenced
 * by the indexed code but defined outside it (e.g. `System.Console.WriteLine`).
 *
 * @throws {ScipDecodeError} when the file is truncated or corrupt.
 */
export async function* iterateScipExternalSymbols(
  scipPath: string,
): AsyncGenerator<ScipSymbolInformation> {
  const { SymbolInformation } = await loadScipProtoTypes();
  for await (const { bytes } of scanIndexFields(scipPath, {
    externalSymbols: true,
  })) {
    yield SymbolInformation.toObject(
      SymbolInformation.decode(bytes),
      TO_OBJECT_OPTS,
    ) as ScipSymbolInformation;
  }
}
