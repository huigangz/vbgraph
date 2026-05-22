/**
 * P0.0 — SCIP toolchain detection + `--scip-auto` advisory lock.
 *
 * Covers the standalone, pipeline-independent half of P0.0: the indexer
 * detection module and the process lock. The full `--scip-auto` integration
 * tests (mock `which` -> run a real index -> assert provenance) require the
 * P0.1-P0.6 pipeline and land with P0.10.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

vi.mock('which', () => ({ default: vi.fn() }));
import which from 'which';

import {
  detectInstalledScipIndexers,
  clearScipIndexerDetectionCache,
  buildScipCoverageMap,
  formatUninstalledIndexerHints,
  SCIP_INDEXERS,
} from '../src/extraction/scip/detect-indexers';
import {
  acquireScipAutoLock,
  ScipAutoLockError,
} from '../src/extraction/scip/scip-auto-lock';

const whichMock = vi.mocked(which);

/** Make `which` resolve only the given command names; everything else misses. */
function installOnly(...cmds: string[]): void {
  const found = new Set(cmds);
  whichMock.mockImplementation((cmd: string) =>
    Promise.resolve(found.has(cmd) ? `/usr/local/bin/${cmd}` : null) as never,
  );
}

describe('detectInstalledScipIndexers', () => {
  beforeEach(() => {
    clearScipIndexerDetectionCache();
    whichMock.mockReset();
  });

  it('detects only the indexers present on PATH', async () => {
    installOnly('scip-dotnet');
    const detected = await detectInstalledScipIndexers();
    expect(detected.map((d) => d.name)).toEqual(['scip-dotnet']);
    expect(detected[0]?.resolvedPath).toBe('/usr/local/bin/scip-dotnet');
    expect(detected[0]?.languages).toContain('vbnet');
  });

  it('returns an empty list when no SCIP indexer is installed', async () => {
    installOnly();
    const detected = await detectInstalledScipIndexers();
    expect(detected).toEqual([]);
  });

  it('detects every known indexer when all are present', async () => {
    installOnly(...SCIP_INDEXERS.map((s) => s.cmd));
    const detected = await detectInstalledScipIndexers();
    expect(detected).toHaveLength(SCIP_INDEXERS.length);
  });

  it('never excludes a detected indexer over an unparseable version probe', async () => {
    // The fake resolved path cannot be exec'd, so the version probe fails;
    // the invariant is that the indexer is still detected, version 'unknown'.
    installOnly('scip-go');
    const detected = await detectInstalledScipIndexers();
    expect(detected).toHaveLength(1);
    expect(detected[0]?.version).toBe('unknown');
  });

  it('caches the result per process and re-probes only when forced', async () => {
    installOnly('scip-rust');
    await detectInstalledScipIndexers();
    const callsAfterFirst = whichMock.mock.calls.length;

    await detectInstalledScipIndexers();
    expect(whichMock.mock.calls.length).toBe(callsAfterFirst);

    await detectInstalledScipIndexers({ force: true });
    expect(whichMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe('buildScipCoverageMap', () => {
  beforeEach(() => {
    clearScipIndexerDetectionCache();
    whichMock.mockReset();
  });

  it('maps each covered language to its indexer', async () => {
    installOnly('scip-dotnet', 'scip-java');
    const detected = await detectInstalledScipIndexers();
    const coverage = buildScipCoverageMap(detected);
    expect(coverage.get('csharp')?.name).toBe('scip-dotnet');
    expect(coverage.get('vbnet')?.name).toBe('scip-dotnet');
    expect(coverage.get('kotlin')?.name).toBe('scip-java');
    expect(coverage.has('python')).toBe(false);
  });
});

describe('formatUninstalledIndexerHints', () => {
  beforeEach(() => {
    clearScipIndexerDetectionCache();
    whichMock.mockReset();
  });

  it('omits installed indexers and lists install hints for the rest', async () => {
    installOnly('scip-dotnet');
    const detected = await detectInstalledScipIndexers();
    const hints = formatUninstalledIndexerHints(detected);
    expect(hints.some((h) => h.includes('scip-dotnet'))).toBe(false);
    expect(hints.some((h) => h.includes('scip-typescript'))).toBe(true);
  });

  it('narrows hints to indexers relevant to the languages in the repo', async () => {
    installOnly();
    const detected = await detectInstalledScipIndexers();
    const hints = formatUninstalledIndexerHints(detected, new Set(['python']));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('scip-python');
  });
});

describe('acquireScipAutoLock', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lock-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a lock file and removes it on release', () => {
    const lockFile = path.join(tmpDir, '.scip-auto.lock');
    const release = acquireScipAutoLock(tmpDir);
    expect(fs.existsSync(lockFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
    release();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  it('is idempotent on release', () => {
    const release = acquireScipAutoLock(tmpDir);
    release();
    expect(() => release()).not.toThrow();
  });

  it('reclaims a stale lock whose owning PID is dead', () => {
    const lockFile = path.join(tmpDir, '.scip-auto.lock');
    // PID 2^31-1 is effectively guaranteed not to be a live process.
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: 2147483647, acquiredAt: new Date().toISOString() }),
    );
    const release = acquireScipAutoLock(tmpDir);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('reclaims a corrupt lock file', () => {
    const lockFile = path.join(tmpDir, '.scip-auto.lock');
    fs.writeFileSync(lockFile, 'not json at all');
    const release = acquireScipAutoLock(tmpDir);
    expect(JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid).toBe(process.pid);
    release();
  });

  it('rejects acquisition when another live process holds the lock', async () => {
    const lockFile = path.join(tmpDir, '.scip-auto.lock');
    // Spawn a real, live child process to own the lock.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)']);
    try {
      fs.writeFileSync(
        lockFile,
        JSON.stringify({ pid: child.pid, acquiredAt: new Date().toISOString() }),
      );
      expect(() => acquireScipAutoLock(tmpDir)).toThrow(ScipAutoLockError);
    } finally {
      child.kill();
    }
  });
});
