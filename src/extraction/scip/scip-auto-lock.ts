/**
 * Advisory process lock for `codegraph index --scip-auto`.
 *
 * Prevents two concurrent --scip-auto runs from spawning indexers and
 * ingesting into the same `.codegraph/` database. The lock is a single file
 * (`.codegraph/.scip-auto.lock`) containing the owning PID and a timestamp.
 * A stale lock — one whose owning PID is no longer alive — is reclaimed
 * automatically so a crashed run does not wedge the project permanently.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Thrown when another live `--scip-auto` process already holds the lock. */
export class ScipAutoLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScipAutoLockError';
  }
}

interface LockPayload {
  pid: number;
  acquiredAt: string;
}

/** Release the lock; calling more than once is a no-op. */
export type ReleaseScipAutoLock = () => void;

const LOCK_FILE_NAME = '.scip-auto.lock';

function lockFilePath(codegraphDir: string): string {
  return path.join(codegraphDir, LOCK_FILE_NAME);
}

/** True when `pid` refers to a live process this user can observe. */
function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the existence/permission check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but is owned by another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPayload(file: string): LockPayload | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockPayload>;
    if (typeof parsed.pid === 'number') {
      return { pid: parsed.pid, acquiredAt: String(parsed.acquiredAt ?? '') };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Acquire the `--scip-auto` lock for `codegraphDir` (the project's
 * `.codegraph/` directory). Returns a release function that is also wired to
 * run on SIGINT/SIGTERM so an interrupted run does not leave a live lock.
 *
 * @throws {ScipAutoLockError} when another live process holds the lock.
 */
export function acquireScipAutoLock(codegraphDir: string): ReleaseScipAutoLock {
  const file = lockFilePath(codegraphDir);

  if (fs.existsSync(file)) {
    const payload = readLockPayload(file);
    if (payload && payload.pid !== process.pid && isPidAlive(payload.pid)) {
      throw new ScipAutoLockError(
        `Another codegraph --scip-auto is running (PID ${payload.pid}). ` +
          `Wait or remove ${file} manually.`,
      );
    }
    // Lock is stale (no payload, or owning PID is dead) — safe to reclaim.
  }

  fs.mkdirSync(codegraphDir, { recursive: true });
  const payload: LockPayload = {
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload), 'utf8');

  let released = false;
  const release: ReleaseScipAutoLock = () => {
    if (released) {
      return;
    }
    released = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // Only remove the file if it is still ours — a reclaimed lock may now
    // belong to a different process.
    const current = readLockPayload(file);
    if (current && current.pid === process.pid) {
      fs.rmSync(file, { force: true });
    }
  };

  function onSignal(): void {
    release();
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return release;
}
