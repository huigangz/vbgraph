/**
 * SCIP indexer toolchain detection.
 *
 * Probes PATH for installed Sourcegraph SCIP indexers so that
 * `vbgraph index --scip-auto` can enable compiler-grade indexing only for
 * languages whose toolchain is actually present. Detection never throws and
 * never excludes an indexer based on its version probe — version is purely
 * informational (see the invariant on `detectInstalledScipIndexers`).
 */

import { execFile } from 'child_process';
import which from 'which';
import type { Language } from '../../types';

/** Static description of a known SCIP indexer. */
export interface ScipIndexerSpec {
  /** Display name, e.g. 'scip-dotnet'. */
  name: string;
  /** Binary name looked up on PATH. */
  cmd: string;
  /** Languages this indexer can produce SCIP for. */
  languages: Language[];
  /** Human-facing install instruction shown when the indexer is absent. */
  installHint: string;
  /** Flag used to probe the indexer version; defaults to '--version'. */
  versionFlag?: string;
  /**
   * CLI args to produce a `.scip` at `outputPath`. Defaults to the common
   * `index --output <path>` convention when omitted; override per indexer
   * when its CLI differs.
   */
  indexArgs?: (outputPath: string) => string[];
}

/** Default `.scip`-producing CLI args — the common SCIP indexer convention. */
export function defaultScipIndexArgs(outputPath: string): string[] {
  return ['index', '--output', outputPath];
}

/** A SCIP indexer that was found on PATH. */
export interface DetectedIndexer extends ScipIndexerSpec {
  /** Absolute path the binary resolved to. */
  resolvedPath: string;
  /** Parsed version string, or 'unknown' if it could not be determined. */
  version?: string;
}

/**
 * The known SCIP indexers VBGraph can auto-detect. Hardcoded by design;
 * a `customScipIndexers` config extension point is deferred (see plan
 * "Out of scope").
 */
export const SCIP_INDEXERS: ScipIndexerSpec[] = [
  {
    name: 'scip-dotnet',
    cmd: 'scip-dotnet',
    languages: ['csharp', 'vbnet'],
    installHint: 'dotnet tool install -g scip-dotnet',
  },
  {
    name: 'scip-java',
    cmd: 'scip-java',
    languages: ['java', 'kotlin', 'scala'],
    installHint: 'brew install sourcegraph/sourcegraph/scip-java',
  },
  {
    name: 'scip-typescript',
    cmd: 'scip-typescript',
    languages: ['typescript', 'javascript'],
    installHint: 'npm install -g @sourcegraph/scip-typescript',
  },
  {
    name: 'scip-python',
    cmd: 'scip-python',
    languages: ['python'],
    installHint: 'npm install -g @sourcegraph/scip-python',
  },
  {
    name: 'scip-go',
    cmd: 'scip-go',
    languages: ['go'],
    installHint: 'go install github.com/sourcegraph/scip-go/cmd/scip-go@latest',
  },
  {
    name: 'scip-rust',
    cmd: 'scip-rust',
    languages: ['rust'],
    installHint: 'cargo install scip-rust',
  },
  {
    name: 'scip-ruby',
    cmd: 'scip-ruby',
    languages: ['ruby'],
    installHint: 'gem install scip-ruby',
  },
];

/** 2-second budget for the `--version` probe, per the spec. */
const VERSION_PROBE_TIMEOUT_MS = 2000;

/** Matches a semver-ish token anywhere in the probe output. */
const VERSION_RE = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/;

/**
 * In-memory cache for the lifetime of a single `vbgraph` process. Toolchain
 * state can change between invocations, so this is deliberately not persisted.
 */
let detectionCache: DetectedIndexer[] | null = null;

/**
 * Probe `<cmd> --version`. Returns the parsed version, or 'unknown' when the
 * probe fails, times out, or produces output we cannot parse.
 *
 * Invariant: this never causes the indexer to be excluded — it only annotates.
 */
function probeVersion(spec: ScipIndexerSpec, resolvedPath: string): Promise<string> {
  return new Promise((resolve) => {
    const flag = spec.versionFlag ?? '--version';
    execFile(
      resolvedPath,
      [flag],
      { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          resolve('unknown');
          return;
        }
        const match = VERSION_RE.exec(`${stdout}\n${stderr}`);
        resolve(match?.[0] ?? 'unknown');
      },
    );
  });
}

/**
 * Detect SCIP indexers installed on PATH.
 *
 * - An indexer is included iff its binary resolves on PATH.
 * - A detected indexer is NEVER excluded based on the version probe; version
 *   is informational only (used for warnings about old indexers).
 * - The result is cached per process; pass `{ force: true }` to re-probe.
 *
 * Detection is sequential — each `which` lookup is sub-millisecond, so there
 * is no benefit to concurrency.
 */
export async function detectInstalledScipIndexers(
  opts: { force?: boolean } = {},
): Promise<DetectedIndexer[]> {
  if (detectionCache !== null && !opts.force) {
    return detectionCache;
  }

  const detected: DetectedIndexer[] = [];
  for (const spec of SCIP_INDEXERS) {
    const resolvedPath = await which(spec.cmd, { nothrow: true });
    if (!resolvedPath) {
      continue;
    }
    const version = await probeVersion(spec, resolvedPath);
    detected.push({ ...spec, resolvedPath, version });
  }

  detectionCache = detected;
  return detected;
}

/**
 * Clear the in-process detection cache. Intended for tests that mock `which`
 * between cases; production code relies on the natural per-process cache.
 */
export function clearScipIndexerDetectionCache(): void {
  detectionCache = null;
}

/**
 * Build the effective SCIP coverage map: `language -> indexer that covers it`.
 * When two indexers claim the same language, the first detected wins (the
 * `SCIP_INDEXERS` declaration order is the tie-break).
 */
export function buildScipCoverageMap(
  detected: DetectedIndexer[],
): Map<Language, DetectedIndexer> {
  const coverage = new Map<Language, DetectedIndexer>();
  for (const indexer of detected) {
    for (const lang of indexer.languages) {
      if (!coverage.has(lang)) {
        coverage.set(lang, indexer);
      }
    }
  }
  return coverage;
}

/**
 * Render the "install these for compiler-grade indexing" hint shown after a
 * Tier 0 index. `languagesInRepo` narrows the hint to indexers that would
 * actually help the current repo; pass `undefined` to list every uninstalled
 * indexer.
 */
export function formatUninstalledIndexerHints(
  detected: DetectedIndexer[],
  languagesInRepo?: ReadonlySet<string>,
): string[] {
  const installedCmds = new Set(detected.map((d) => d.cmd));
  const hints: string[] = [];
  for (const spec of SCIP_INDEXERS) {
    if (installedCmds.has(spec.cmd)) {
      continue;
    }
    const relevant =
      languagesInRepo === undefined ||
      spec.languages.some((lang) => languagesInRepo.has(lang));
    if (!relevant) {
      continue;
    }
    hints.push(
      `${spec.languages.join('/')}: install ${spec.name} for compiler-grade ` +
        `indexing — ${spec.installHint}`,
    );
  }
  return hints;
}
