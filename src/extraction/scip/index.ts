/**
 * SCIP ingestion — module entry point.
 *
 * `ingestScipFile` is the orchestration seam between a `.scip` file on disk
 * and the persister: it reads the index metadata first (an early, cheap
 * validation that surfaces a corrupt/unreadable file before any database
 * mutation) and then runs the six-stage `persistScipIndex` pipeline.
 *
 * This file also re-exports the SCIP module's public surface.
 */

import type { SqliteDatabase } from '../../db/sqlite-adapter';
import type { QueryBuilder } from '../../db/queries';
import { readScipMetadata, type ScipMetadata } from './streaming-decoder';
import {
  persistScipIndex,
  type EmptyDocumentFallback,
  type IngestStats,
} from './persister';

export interface IngestScipFileOptions {
  db: SqliteDatabase;
  qb: QueryBuilder;
  /** Empty-document fallback threshold in bytes (default 200). */
  emptyFallbackThresholdBytes?: number;
  /** Tree-sitter fallback for SCIP documents with zero occurrences. */
  extractFallback?: EmptyDocumentFallback;
}

/**
 * Ingest one `.scip` file into the database.
 *
 * Reading the metadata up front is deliberate: it fails fast on a corrupt or
 * unreadable file (a caller-supplied `--scip <path>` mistake, ship gate 12a)
 * *before* `persistScipIndex` touches the database, so a rejected ingest
 * leaves the DB completely unchanged.
 */
export async function ingestScipFile(
  scipPath: string,
  projectRoot: string,
  opts: IngestScipFileOptions,
): Promise<IngestStats> {
  // Early validation — throws ScipDecodeError on a corrupt/empty file.
  const metadata: ScipMetadata = await readScipMetadata(scipPath);
  void metadata; // reserved for future indexer version-mismatch warnings

  return persistScipIndex({
    scipPath,
    projectRoot,
    db: opts.db,
    qb: opts.qb,
    emptyFallbackThresholdBytes: opts.emptyFallbackThresholdBytes,
    extractFallback: opts.extractFallback,
  });
}

// ---------------------------------------------------------------------------
// Public re-exports
// ---------------------------------------------------------------------------

export {
  detectInstalledScipIndexers,
  buildScipCoverageMap,
  formatUninstalledIndexerHints,
  clearScipIndexerDetectionCache,
  SCIP_INDEXERS,
  type DetectedIndexer,
  type ScipIndexerSpec,
} from './detect-indexers';
export {
  acquireScipAutoLock,
  ScipAutoLockError,
  type ReleaseScipAutoLock,
} from './scip-auto-lock';
export {
  readScipMetadata,
  iterateScipDocuments,
  iterateScipExternalSymbols,
  ScipDecodeError,
  type ScipDocument,
  type ScipMetadata,
  type ScipOccurrence,
  type ScipSymbolInformation,
} from './streaming-decoder';
export {
  parseScipSymbol,
  hashScipSymbol,
  nodeKindForScipSymbol,
  ScipSymbolParseError,
  type ParsedScipSymbol,
} from './symbol-parser';
export {
  persistScipIndex,
  externalSymbolToNode,
  MultiIndexConflictError,
  SameIndexDuplicateDocumentError,
  type EmptyDocumentFallback,
  type IngestStats,
  type ScipPersistOptions,
} from './persister';
export {
  writeScipFailureLedger,
  readScipFailureLedger,
  classifyScipFailureMode,
  type ScipFailure,
  type ScipFailureLedger,
  type ScipFailureMode,
} from './failure-ledger';
export {
  runScipAutoSpawn,
  type ScipAutoSpawnOptions,
  type ScipAutoSpawnResult,
} from './auto-spawn';
