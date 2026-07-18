/**
 * Directory Management
 *
 * Manages the .vbgraph/ directory structure for VBGraph data.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * VBGraph directory name
 */
export const VBGRAPH_DIR = '.vbgraph';

/**
 * Contents of `.vbgraph/.gitignore`. Single source of truth — both
 * `createDirectory` and `validateDirectory`'s auto-repair write this exact
 * string, so the two paths cannot drift (e.g. one omitting `scip-cache/`).
 */
const VBGRAPH_GITIGNORE = `# VBGraph data files
# These are local to each machine and should not be committed

# Database
*.db
*.db-wal
*.db-shm

# Cache
cache/

# SCIP indexer artifacts (.scip files can be large; local to each machine)
scip-cache/

# Logs
*.log

# Hook markers
.dirty
`;

/**
 * Get the .vbgraph directory path for a project
 */
export function getVBGraphDir(projectRoot: string): string {
  return path.join(projectRoot, VBGRAPH_DIR);
}

/**
 * Check if a project has been initialized with VBGraph
 * Requires both .vbgraph/ directory AND vbgraph.db to exist
 */
export function isInitialized(projectRoot: string): boolean {
  const vbgraphDir = getVBGraphDir(projectRoot);
  if (!fs.existsSync(vbgraphDir) || !fs.statSync(vbgraphDir).isDirectory()) {
    return false;
  }
  // Must have vbgraph.db, not just .vbgraph folder
  const dbPath = path.join(vbgraphDir, 'vbgraph.db');
  return fs.existsSync(dbPath);
}

/**
 * Find the nearest parent directory containing .vbgraph/
 *
 * Walks up from the given path to find a VBGraph-initialized project,
 * similar to how git finds .git/ directories.
 *
 * @param startPath - Directory to start searching from
 * @returns The project root containing .vbgraph/, or null if not found
 */
export function findNearestVBGraphRoot(startPath: string): string | null {
  let current = path.resolve(startPath);
  const root = path.parse(current).root;

  while (current !== root) {
    if (isInitialized(current)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break; // Reached filesystem root
    current = parent;
  }

  // Check root as well
  if (isInitialized(current)) {
    return current;
  }

  return null;
}

/**
 * Create the .vbgraph directory structure
 * Note: Only throws if vbgraph.db already exists, not just if .vbgraph/ exists.
 */
export function createDirectory(projectRoot: string): void {
  const vbgraphDir = getVBGraphDir(projectRoot);
  const dbPath = path.join(vbgraphDir, 'vbgraph.db');

  // Only throw if VBGraph is actually initialized (db exists)
  // .vbgraph/ folder alone is fine
  if (fs.existsSync(dbPath)) {
    throw new Error(`VBGraph already initialized in ${projectRoot}`);
  }

  // Create main directory (if it doesn't exist)
  fs.mkdirSync(vbgraphDir, { recursive: true });

  // Create .gitignore inside .vbgraph (if it doesn't exist)
  const gitignorePath = path.join(vbgraphDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, VBGRAPH_GITIGNORE, 'utf-8');
  }
}

/**
 * Remove the .vbgraph directory
 */
export function removeDirectory(projectRoot: string): void {
  const vbgraphDir = getVBGraphDir(projectRoot);

  if (!fs.existsSync(vbgraphDir)) {
    return;
  }

  // Verify .vbgraph is a real directory, not a symlink pointing elsewhere
  const lstat = fs.lstatSync(vbgraphDir);
  if (lstat.isSymbolicLink()) {
    // Only remove the symlink itself, never follow it for recursive delete
    fs.unlinkSync(vbgraphDir);
    return;
  }

  if (!lstat.isDirectory()) {
    // Not a directory - remove the single file
    fs.unlinkSync(vbgraphDir);
    return;
  }

  // Recursively remove directory
  fs.rmSync(vbgraphDir, { recursive: true, force: true });
}

/**
 * Get all files in the .vbgraph directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const vbgraphDir = getVBGraphDir(projectRoot);

  if (!fs.existsSync(vbgraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Skip symlinks to prevent following links outside .vbgraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(vbgraphDir);
  return files;
}

/**
 * Get the total size of the .vbgraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const vbgraphDir = getVBGraphDir(projectRoot);

  if (!fs.existsSync(vbgraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip symlinks to prevent following links outside .vbgraph
      if (entry.isSymbolicLink()) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(vbgraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .vbgraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getVBGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .vbgraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const vbgraphDir = getVBGraphDir(projectRoot);

  if (!fs.existsSync(vbgraphDir)) {
    errors.push('VBGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(vbgraphDir).isDirectory()) {
    errors.push('.vbgraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Auto-repair missing .gitignore (non-critical file)
  const gitignorePath = path.join(vbgraphDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    try {
      fs.writeFileSync(gitignorePath, VBGRAPH_GITIGNORE, 'utf-8');
    } catch {
      // Non-fatal: warn but don't block
      errors.push('.gitignore missing in .vbgraph directory and could not be created');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
