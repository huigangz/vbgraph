/**
 * SCIP failure ledger — `.vbgraph/scip-failures.json`.
 *
 * Records the last run's SCIP failure modes per indexer so `vbgraph status`
 * can surface them. The hard invariant (P0.4c): no SCIP failure mode makes
 * VBGraph unusable — every failure degrades to tree-sitter for the affected
 * files and is recorded here; the overall `--scip-auto` run still exits 0.
 *
 * File semantics:
 *  - Overwritten (not appended) each run; long-term history lives in
 *    `.vbgraph/logs/*.log`.
 *  - Written atomically (`.tmp` + rename) so a partial write cannot corrupt it.
 *  - Carries a top-level `version`; a reader rejects unknown versions.
 */

import * as fs from 'fs';
import * as path from 'path';

/** How a SCIP indexer / `.scip` file failed. */
export type ScipFailureMode =
  | 'not-installed' // indexer binary absent from PATH
  | 'startup-failed' // indexer could not start (no .csproj/.sln, immediate non-zero exit)
  | 'restore-failed' // dependency restore failed (e.g. `dotnet restore`)
  | 'build-failed' // project build had errors — partial SCIP coverage
  | 'truncated' // `.scip` ended early (indexer OOM / mid-run crash)
  | 'corrupt' // `.scip` failed protobuf decode
  | 'version-mismatch'; // indexer older than the required minimum

export interface ScipFailure {
  /** Indexer name, e.g. `scip-dotnet`. */
  indexer: string;
  /** Affected language, e.g. `csharp`. */
  language: string;
  mode: ScipFailureMode;
  /** Number of source files that fell back, when known. */
  filesAffected?: number;
  /** What the affected files degraded to — always `'tree-sitter'` today. */
  fallback: string;
  /** A short, actionable remediation hint. */
  hint?: string;
}

export interface ScipFailureLedger {
  version: number;
  /** ISO-8601 timestamp of the run that produced this ledger. */
  runAt: string;
  failures: ScipFailure[];
}

const LEDGER_VERSION = 1;
const LEDGER_FILENAME = 'scip-failures.json';

function ledgerPath(vbgraphDir: string): string {
  return path.join(vbgraphDir, LEDGER_FILENAME);
}

/**
 * Write the failure ledger for the current run. Overwrites any previous ledger.
 * Atomic: writes a sibling `.tmp` then renames over the target (atomic on POSIX
 * and NTFS). `vbgraphDir` is assumed to exist.
 */
export function writeScipFailureLedger(
  vbgraphDir: string,
  failures: ScipFailure[],
): void {
  const ledger: ScipFailureLedger = {
    version: LEDGER_VERSION,
    runAt: new Date().toISOString(),
    failures,
  };
  const finalPath = ledgerPath(vbgraphDir);
  const tmpPath = `${finalPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, finalPath);
}

/**
 * Read the failure ledger. Returns null when no ledger exists.
 *
 * @throws when the ledger's schema version is newer than this build understands.
 */
export function readScipFailureLedger(vbgraphDir: string): ScipFailureLedger | null {
  const finalPath = ledgerPath(vbgraphDir);
  let raw: string;
  try {
    raw = fs.readFileSync(finalPath, 'utf8');
  } catch {
    return null;
  }
  const parsed = JSON.parse(raw) as Partial<ScipFailureLedger>;
  if (parsed.version !== LEDGER_VERSION) {
    throw new Error(
      `scip-failures.json schema version ${String(parsed.version)} unknown — ` +
        `vbgraph upgrade required`,
    );
  }
  return {
    version: parsed.version,
    runAt: typeof parsed.runAt === 'string' ? parsed.runAt : '',
    failures: Array.isArray(parsed.failures) ? parsed.failures : [],
  };
}

/**
 * Classify a thrown error or spawn outcome into a `ScipFailureMode`. Used by
 * the `--scip-auto` orchestrator (P0.6) to populate the ledger.
 */
export function classifyScipFailureMode(err: unknown): ScipFailureMode {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') {
    return 'not-installed';
  }
  const message = ((err as Error)?.message ?? '').toLowerCase();
  if (message.includes('unexpected eof') || message.includes('truncated')) {
    return 'truncated';
  }
  if (message.includes('restore failed')) {
    return 'restore-failed';
  }
  if (message.includes('corrupt') || message.includes('wire type')) {
    return 'corrupt';
  }
  return 'startup-failed';
}
