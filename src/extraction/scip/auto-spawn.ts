/**
 * `codegraph index --scip-auto` spawn orchestration.
 *
 * Detects installed SCIP indexers, spawns each one (sequentially, lightest
 * toolchain first) for the languages present in the repo, and returns the
 * `.scip` files produced plus a failure ledger for the ones that did not.
 *
 * Per-indexer failure isolation: a failed indexer never aborts the run — its
 * languages simply fall back to tree-sitter. Only `MultiIndexConflictError`
 * from the *ingest* side (handled by the caller) aborts.
 *
 * NOTE: the per-indexer CLI invocation uses the common `index --output <path>`
 * convention (`defaultScipIndexArgs`). No SCIP indexer is installed in this
 * dev environment, so real-indexer arg compatibility is best-effort — override
 * `ScipIndexerSpec.indexArgs` per indexer as their exact CLIs are confirmed.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

import type { Language } from '../../types';
import {
  detectInstalledScipIndexers,
  defaultScipIndexArgs,
  type DetectedIndexer,
} from './detect-indexers';
import { acquireScipAutoLock } from './scip-auto-lock';
import { classifyScipFailureMode, type ScipFailure } from './failure-ledger';

/** Spawn order — lightest toolchain first; `.NET` (slowest) last. */
const SPAWN_ORDER = [
  'scip-typescript',
  'scip-python',
  'scip-go',
  'scip-ruby',
  'scip-rust',
  'scip-java',
  'scip-dotnet',
];

function spawnRank(name: string): number {
  const i = SPAWN_ORDER.indexOf(name);
  return i === -1 ? SPAWN_ORDER.length : i;
}

export interface ScipAutoSpawnOptions {
  /** Repo root the indexers run in. */
  projectRoot: string;
  /** The project's `.codegraph/` directory. */
  codegraphDir: string;
  /** Languages actually present in the repo. */
  languagesInRepo: ReadonlySet<Language>;
  /** Restrict to this language subset (`--languages`); omit for no restriction. */
  languageFilter?: ReadonlySet<Language>;
  /** Indexer names to skip (`config.disabledScipIndexers`). */
  disabledIndexers?: ReadonlySet<string>;
  /** Pre-detected indexers — bypasses PATH detection (tests). */
  detected?: DetectedIndexer[];
}

export interface ScipAutoSpawnResult {
  /** Paths of the `.scip` files produced — ready to ingest. */
  scipPaths: string[];
  /** Failures to fold into the P0.4c failure ledger. */
  failures: ScipFailure[];
}

interface SpawnOutcome {
  ok: boolean;
  error?: unknown;
}

/** Spawn one indexer, capturing its output to a log file. */
function spawnIndexer(
  indexer: DetectedIndexer,
  outputPath: string,
  projectRoot: string,
  logPath: string,
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const args = (indexer.indexArgs ?? defaultScipIndexArgs)(outputPath);
    const chunks: Buffer[] = [];
    let child;
    try {
      child = spawn(indexer.resolvedPath, args, {
        cwd: projectRoot,
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err });
      return;
    }
    const collect = (d: Buffer): void => {
      chunks.push(d);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const flushLog = (trailer: string): void => {
      try {
        fs.writeFileSync(logPath, Buffer.concat([...chunks, Buffer.from(trailer)]));
      } catch {
        /* logging is best-effort */
      }
    };

    child.on('error', (err) => {
      flushLog(`\n[spawn error] ${(err as Error).message}\n`);
      resolve({ ok: false, error: err });
    });
    child.on('close', (code) => {
      flushLog(`\n[exit code] ${String(code)}\n`);
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve({ ok: true });
      } else {
        resolve({
          ok: false,
          error: new Error(`${indexer.name} exited with code ${String(code)}`),
        });
      }
    });
  });
}

/**
 * Detect and spawn SCIP indexers for the languages present in the repo.
 *
 * @throws {ScipAutoLockError} when another `--scip-auto` run holds the lock.
 */
export async function runScipAutoSpawn(
  opts: ScipAutoSpawnOptions,
): Promise<ScipAutoSpawnResult> {
  const release = acquireScipAutoLock(opts.codegraphDir);
  try {
    const detected = opts.detected ?? (await detectInstalledScipIndexers());
    const cacheDir = path.join(opts.codegraphDir, 'scip-cache');
    const logsDir = path.join(opts.codegraphDir, 'logs');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    const ordered = [...detected].sort(
      (a, b) => spawnRank(a.name) - spawnRank(b.name),
    );

    const scipPaths: string[] = [];
    const failures: ScipFailure[] = [];

    for (const indexer of ordered) {
      if (opts.disabledIndexers?.has(indexer.name)) {
        continue;
      }
      const relevantLanguages = indexer.languages.filter(
        (lang) =>
          opts.languagesInRepo.has(lang) &&
          (opts.languageFilter === undefined || opts.languageFilter.has(lang)),
      );
      if (relevantLanguages.length === 0) {
        continue; // indexer covers no language present in this repo
      }

      const outputPath = path.join(cacheDir, `${indexer.name}.scip`);
      const logPath = path.join(logsDir, `${indexer.name}-${Date.now()}.log`);

      // Remove any stale artifact from a prior run. The cache path is
      // deterministic, so without this an indexer that exits 0 *without*
      // writing output would leave the old `.scip` in place and
      // `spawnIndexer`'s `existsSync` check would mistake it for success.
      fs.rmSync(outputPath, { force: true });

      const outcome = await spawnIndexer(
        indexer,
        outputPath,
        opts.projectRoot,
        logPath,
      );

      if (outcome.ok) {
        scipPaths.push(outputPath);
      } else {
        failures.push({
          indexer: indexer.name,
          language: relevantLanguages[0]!,
          mode: classifyScipFailureMode(outcome.error),
          filesAffected: undefined,
          fallback: 'tree-sitter',
          hint: `${indexer.installHint}`,
        });
      }
    }

    return { scipPaths, failures };
  } finally {
    release();
  }
}
