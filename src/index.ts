/**
 * CodeGraph
 *
 * A local-first code intelligence system that builds a semantic
 * knowledge graph from any codebase.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  CodeGraphConfig,
  Node,
  Edge,
  FileRecord,
  ExtractionResult,
  Subgraph,
  TraversalOptions,
  SearchOptions,
  SearchResult,
  Context,
  GraphStats,
  TaskInput,
  TaskContext,
  BuildContextOptions,
  FindRelevantContextOptions,
  Language,
  ScipRefreshOptions,
  ScipRefreshResult,
  ScipLastRefresh,
  LanguageTier,
  StaleSummary,
  ConfidenceTier,
  GraphProvenance,
} from './types';
import { deriveConfidenceTier } from './types';
import { DatabaseConnection, getDatabasePath } from './db';
import { QueryBuilder } from './db/queries';
import { loadConfig, saveConfig, createDefaultConfig } from './config';
import {
  isInitialized,
  createDirectory,
  removeDirectory,
  validateDirectory,
  getCodeGraphDir,
} from './directory';
import {
  ExtractionOrchestrator,
  IndexProgress,
  IndexResult,
  SyncResult,
  extractFromSource,
  initGrammars,
  loadGrammarsForLanguages,
  isLanguageSupported,
  scanDirectory,
} from './extraction';
import { detectLanguage } from './extraction/grammars';
import {
  ingestScipFile,
  iterateScipDocuments,
  runScipAutoSpawn,
  MultiIndexConflictError,
  writeScipFailureLedger,
  classifyScipFailureMode,
  detectInstalledScipIndexers,
  buildScipCoverageMap,
  SCIP_INDEXERS,
  type ScipFailure,
  type EmptyDocumentFallback,
} from './extraction/scip';
import {
  ReferenceResolver,
  createResolver,
  ResolutionResult,
} from './resolution';
import { Phase3Orchestrator } from './resolution/phase3';
import { GraphTraverser, GraphQueryManager } from './graph';
import { ContextBuilder, createContextBuilder } from './context';
import { Mutex, FileLock, normalizePath } from './utils';
import { FileWatcher, WatchOptions } from './sync';

// Re-export types for consumers
export * from './types';
export { getDatabasePath } from './db';
export { getConfigPath } from './config';
export {
  getCodeGraphDir,
  isInitialized,
  findNearestCodeGraphRoot,
  CODEGRAPH_DIR,
} from './directory';
export { IndexProgress, IndexResult, SyncResult } from './extraction';
export { detectLanguage, isLanguageSupported, isGrammarLoaded, getSupportedLanguages, initGrammars, loadGrammarsForLanguages, loadAllGrammars } from './extraction';
export { ResolutionResult } from './resolution';
export {
  CodeGraphError,
  FileError,
  ParseError,
  DatabaseError,
  SearchError,
  VectorError,
  ConfigError,
  Logger,
  setLogger,
  getLogger,
  silentLogger,
  defaultLogger,
} from './errors';
export { Mutex, FileLock, processInBatches, debounce, throttle, MemoryMonitor } from './utils';
export { FileWatcher, WatchOptions } from './sync';
export { MCPServer } from './mcp';

/**
 * Options for initializing a new CodeGraph project
 */
export interface InitOptions {
  /** Custom configuration overrides */
  config?: Partial<CodeGraphConfig>;

  /** Whether to run initial indexing after init */
  index?: boolean;

  /** Progress callback for indexing */
  onProgress?: (progress: IndexProgress) => void;
}

/**
 * Options for opening an existing CodeGraph project
 */
export interface OpenOptions {
  /** Whether to run sync if files have changed */
  sync?: boolean;

  /** Whether to run in read-only mode */
  readOnly?: boolean;
}

/**
 * Options for indexing
 */
export interface IndexOptions {
  /** Progress callback */
  onProgress?: (progress: IndexProgress) => void;

  /** Abort signal for cancellation */
  signal?: AbortSignal;

  /** Enable verbose logging (worker lifecycle, memory, timeouts) */
  verbose?: boolean;

  /** Explicit pre-built `.scip` index paths to ingest (CI / cron). */
  scip?: string[];

  /** Detect installed SCIP indexers, spawn them, and ingest the output. */
  scipAuto?: boolean;

  /** Force Tier 0 (tree-sitter only) even if SCIP indexers are present. */
  noScip?: boolean;

  /** Restrict `--scip-auto` to this language subset (by language name). */
  languages?: string[];
}

/**
 * Tokenize a shell command string into argv tokens, respecting quoted
 * substrings so paths with spaces survive. Used by `refreshScip` when
 * `scipRefreshCommand` is provided as a string rather than an array.
 *
 * Supported:
 *  - whitespace separates tokens
 *  - "double" and 'single' quoted runs are kept intact (quotes stripped)
 *  - inside double quotes, `\"` escapes a literal `"`; `\\` escapes `\`
 *  - inside single quotes, content is literal (no escapes — POSIX shell rule)
 *
 * Not supported (and not needed for the indexer-command use case):
 *  - $variable expansion
 *  - backtick command substitution
 *  - redirection / pipes
 *
 * If users hit anything more elaborate, they should use the array form.
 */
function tokenizeShellCommand(input: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let hasBuf = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inSingle) {
      if (c === "'") { inSingle = false; continue; }
      buf += c; hasBuf = true; continue;
    }
    if (inDouble) {
      if (c === '\\' && i + 1 < input.length) {
        const next = input[i + 1]!;
        if (next === '"' || next === '\\') { buf += next; hasBuf = true; i++; continue; }
        // Unknown escape — preserve the backslash so Windows paths
        // (e.g. "C:\path") don't lose characters when quoted.
        buf += c; hasBuf = true; continue;
      }
      if (c === '"') { inDouble = false; continue; }
      buf += c; hasBuf = true; continue;
    }
    if (c === "'") { inSingle = true; hasBuf = true; continue; }
    if (c === '"') { inDouble = true; hasBuf = true; continue; }
    if (/\s/.test(c)) {
      if (hasBuf) { out.push(buf); buf = ''; hasBuf = false; }
      continue;
    }
    buf += c; hasBuf = true;
  }
  if (hasBuf) out.push(buf);
  return out;
}

/**
 * Main CodeGraph class
 *
 * Provides the primary interface for interacting with the code knowledge graph.
 */
export class CodeGraph {
  private db: DatabaseConnection;
  private queries: QueryBuilder;
  private config: CodeGraphConfig;
  private projectRoot: string;
  private orchestrator: ExtractionOrchestrator;
  private resolver: ReferenceResolver;
  private graphManager: GraphQueryManager;
  private traverser: GraphTraverser;
  private contextBuilder: ContextBuilder;

  // Mutex for preventing concurrent indexing operations (in-process)
  private indexMutex = new Mutex();

  // File lock for preventing concurrent writes across processes (CLI, MCP, git hooks)
  private fileLock: FileLock;

  // File watcher for auto-sync on file changes
  private watcher: FileWatcher | null = null;

  private constructor(
    db: DatabaseConnection,
    queries: QueryBuilder,
    config: CodeGraphConfig,
    projectRoot: string
  ) {
    this.db = db;
    this.queries = queries;
    this.config = config;
    this.projectRoot = projectRoot;
    this.fileLock = new FileLock(
      path.join(projectRoot, '.codegraph', 'codegraph.lock')
    );
    this.orchestrator = new ExtractionOrchestrator(projectRoot, config, queries);
    this.resolver = createResolver(projectRoot, queries);
    this.graphManager = new GraphQueryManager(queries);
    this.traverser = new GraphTraverser(queries);
    this.contextBuilder = createContextBuilder(
      projectRoot,
      queries,
      this.traverser
    );
  }

  // ===========================================================================
  // Lifecycle Methods
  // ===========================================================================

  /**
   * Initialize a new CodeGraph project
   *
   * Creates the .CodeGraph directory, database, and configuration.
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Initialization options
   * @returns A new CodeGraph instance
   */
  static async init(projectRoot: string, options: InitOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration
    const config = createDefaultConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    saveConfig(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, config, resolvedRoot);

    // Run initial indexing if requested
    if (options.index) {
      await instance.indexAll({ onProgress: options.onProgress });
    }

    return instance;
  }

  /**
   * Initialize synchronously (without indexing)
   */
  static initSync(projectRoot: string, options: Omit<InitOptions, 'index' | 'onProgress'> = {}): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if already initialized
    if (isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph already initialized in ${resolvedRoot}`);
    }

    // Create directory structure
    createDirectory(resolvedRoot);

    // Create and save configuration
    const config = createDefaultConfig(resolvedRoot);
    if (options.config) {
      Object.assign(config, options.config);
    }
    saveConfig(resolvedRoot, config);

    // Initialize database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    return new CodeGraph(db, queries, config, resolvedRoot);
  }

  /**
   * Open an existing CodeGraph project
   *
   * @param projectRoot - Path to the project root directory
   * @param options - Open options
   * @returns A CodeGraph instance
   */
  static async open(projectRoot: string, options: OpenOptions = {}): Promise<CodeGraph> {
    await initGrammars();
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, config, resolvedRoot);
    instance.cleanupIncompleteIngestions();

    // Sync if requested
    if (options.sync) {
      await instance.sync();
    }

    return instance;
  }

  /**
   * Open synchronously (without sync)
   */
  static openSync(projectRoot: string): CodeGraph {
    const resolvedRoot = path.resolve(projectRoot);

    // Check if initialized
    if (!isInitialized(resolvedRoot)) {
      throw new Error(`CodeGraph not initialized in ${resolvedRoot}. Run init() first.`);
    }

    // Validate directory structure
    const validation = validateDirectory(resolvedRoot);
    if (!validation.valid) {
      throw new Error(`Invalid CodeGraph directory: ${validation.errors.join(', ')}`);
    }

    // Load configuration
    const config = loadConfig(resolvedRoot);

    // Open database
    const dbPath = getDatabasePath(resolvedRoot);
    const db = DatabaseConnection.open(dbPath);
    const queries = new QueryBuilder(db.getDb());

    const instance = new CodeGraph(db, queries, config, resolvedRoot);
    instance.cleanupIncompleteIngestions();
    return instance;
  }

  /**
   * Check if a directory has been initialized as a CodeGraph project
   */
  static isInitialized(projectRoot: string): boolean {
    return isInitialized(path.resolve(projectRoot));
  }

  /**
   * Build the `extractFallback` callback passed to `ingestScipFile`, used
   * by `persistScipIndex` STAGE E for SCIP documents with zero occurrences.
   * Shared between `runScipPrePass` (called from `indexAll`) and
   * `refreshScip` (P2.3) so both paths recreate empty-doc fallback rows
   * after the broader `supersedeTreeSitter` (P2.3.1) wipes them.
   *
   * Loads grammars for the requested languages first because the fallback
   * runs synchronously inside the persister — grammars must be in process
   * memory before ingest begins. Pass an empty / single-element set when
   * the caller doesn't know the full language list; `loadGrammarsForLanguages`
   * is no-op for already-loaded grammars.
   */
  private async buildEmptyDocFallback(
    coveredLanguages: ReadonlySet<Language>,
  ): Promise<EmptyDocumentFallback> {
    const fallbackLanguages = [...coveredLanguages].filter(
      (lang) => lang !== 'unknown' && lang !== 'external' && isLanguageSupported(lang)
    );
    if (fallbackLanguages.length > 0) {
      await initGrammars();
      await loadGrammarsForLanguages(fallbackLanguages);
    }
    return (absFilePath, relativePath) => {
      try {
        const content = fs.readFileSync(absFilePath, 'utf-8');
        // Use the relative path for extraction so node `filePath`s match the
        // rest of the graph; read the content from the resolved absolute path.
        const extracted = extractFromSource(relativePath, content);
        // Pass `unresolvedReferences` through too — the resolver pass turns
        // them into call/import/type edges, so an empty-fallback file is
        // indexed exactly like a normal tree-sitter file.
        return {
          nodes: extracted.nodes,
          edges: extracted.edges,
          unresolvedReferences: extracted.unresolvedReferences,
        };
      } catch {
        return null;
      }
    };
  }

  /**
   * SCIP pre-pass for `indexAll`: resolve `.scip` sources (explicit `--scip`
   * paths, config `scipSources`, and `--scip-auto` spawn output), ingest them,
   * and return the set of repo-relative source files now covered by SCIP — the
   * tree-sitter pass skips those (dual-backend dispatch).
   *
   * A **batch pre-scan** runs before any ingestion: it streams every explicit
   * `.scip` (which surfaces corruption and overlapping coverage) so a
   * `MultiIndexConflictError` or a corrupt explicit path aborts with the DB
   * completely unchanged (ship gates 5 + 12a). Explicit coverage takes
   * precedence over `--scip-auto`: an auto-spawned `.scip` whose files an
   * explicit path already covers is skipped, not treated as a conflict. An
   * auto-spawned `.scip` that fails degrades to tree-sitter via the ledger.
   */
  private async runScipPrePass(options: IndexOptions): Promise<ReadonlySet<string>> {
    const covered = new Set<string>();
    if (options.noScip) {
      return covered;
    }

    const db = this.db.getDb();
    const explicitPaths = [
      ...new Set(
        [...(options.scip ?? []), ...(this.config.scipSources?.files ?? [])].map((p) =>
          path.resolve(this.projectRoot, p)
        )
      ),
    ];

    const autoMode = options.scipAuto ?? this.config.scipAuto ?? false;
    const autoPaths: string[] = [];
    const failures: ScipFailure[] = [];

    if (autoMode) {
      try {
        const repoFiles = scanDirectory(this.projectRoot, this.config);
        const languagesInRepo = new Set<Language>(
          repoFiles.map((f) => detectLanguage(f))
        );
        const languageFilter =
          options.languages && options.languages.length > 0
            ? new Set(options.languages as Language[])
            : undefined;
        const spawnResult = await runScipAutoSpawn({
          projectRoot: this.projectRoot,
          codegraphDir: getCodeGraphDir(this.projectRoot),
          languagesInRepo,
          languageFilter,
          disabledIndexers: new Set(this.config.disabledScipIndexers ?? []),
        });
        autoPaths.push(...spawnResult.scipPaths);
        failures.push(...spawnResult.failures);
      } catch (err) {
        // Lock contention or detection failure — degrade to tree-sitter.
        console.error(
          `[codegraph] --scip-auto skipped: ${(err as Error).message}`
        );
      }
    }

    // --- Batch pre-scan (no DB mutation) ---------------------------------
    // Existing coverage from prior runs — re-ingesting the same path is fine
    // (STAGE B replaces it), so a clash only counts against a *different* path.
    const coverageOwner = new Map<string, string>();
    for (const row of db
      .prepare('SELECT source_file_path, scip_index_path FROM scip_documents')
      .all() as Array<{ source_file_path: string; scip_index_path: string }>) {
      coverageOwner.set(normalizePath(row.source_file_path), row.scip_index_path);
    }

    // Languages of every SCIP-covered file — drives the grammar pre-load that
    // makes the empty-document tree-sitter fallback usable (see below).
    const coveredLanguages = new Set<Language>();

    // Explicit paths: a conflict or a corrupt file here is fatal. Streaming
    // throws on corruption, so a bad explicit path aborts before any ingest.
    const explicitCoverage = new Set<string>();
    for (const scipPath of explicitPaths) {
      for await (const doc of iterateScipDocuments(scipPath)) {
        const rel = normalizePath(doc.relativePath);
        const owner = coverageOwner.get(rel);
        if (owner && owner !== scipPath) {
          throw new MultiIndexConflictError(rel, owner, scipPath);
        }
        coverageOwner.set(rel, scipPath);
        explicitCoverage.add(rel);
        coveredLanguages.add(detectLanguage(doc.relativePath));
      }
    }

    // Auto paths vs explicit coverage:
    //   - no overlap            -> ingest the auto artifact
    //   - fully covered already -> skip it (explicit-over-auto precedence)
    //   - partial overlap       -> fatal: the combination is ambiguous, and
    //                              silently skipping the whole artifact would
    //                              downgrade its non-overlapping files to
    //                              tree-sitter without telling the user.
    const acceptedAutoPaths: string[] = [];
    for (const scipPath of new Set(autoPaths)) {
      let overlapCount = 0;
      let nonOverlapCount = 0;
      const autoLanguages: Language[] = [];
      try {
        for await (const doc of iterateScipDocuments(scipPath)) {
          if (explicitCoverage.has(normalizePath(doc.relativePath))) {
            overlapCount++;
          } else {
            nonOverlapCount++;
          }
          autoLanguages.push(detectLanguage(doc.relativePath));
        }
      } catch (err) {
        failures.push({
          indexer: path.basename(scipPath, '.scip'),
          language: 'unknown',
          mode: classifyScipFailureMode(err),
          fallback: 'tree-sitter',
        });
        continue;
      }
      if (overlapCount > 0 && nonOverlapCount > 0) {
        throw new Error(
          `Cannot combine pre-built --scip path with --scip-auto for ` +
            `partially-overlapping coverage: ${path.basename(scipPath)} shares ` +
            `${overlapCount} file(s) with an explicit --scip path and adds ` +
            `${nonOverlapCount} more. Resolve the ambiguity — drop one, or make ` +
            `their coverage disjoint.`
        );
      }
      if (overlapCount > 0) {
        console.error(
          `[codegraph] --scip-auto: skipping ${path.basename(scipPath)} — ` +
            `its coverage is fully provided by an explicit --scip path.`
        );
        continue;
      }
      acceptedAutoPaths.push(scipPath);
      for (const lang of autoLanguages) {
        coveredLanguages.add(lang);
      }
    }

    // --- Empty-document tree-sitter fallback -----------------------------
    // A SCIP document with zero occurrences for a real file (e.g. a build
    // error on that one file) should still get a tree-sitter graph rather
    // than an empty SCIP-covered slot the tree-sitter pass then skips.
    // `persistScipIndex` does this via `extractFallback` — but the fallback
    // runs synchronously inside the persister, so the grammars for the
    // covered languages must be loaded into this process first.
    const extractFallback = await this.buildEmptyDocFallback(coveredLanguages);
    const ingestOptions = {
      db,
      qb: this.queries,
      extractFallback,
      emptyFallbackThresholdBytes: this.config.emptyFallbackThresholdBytes,
    };

    // --- Ingest (pre-scan ruled out explicit conflicts and corruption) ---
    for (const scipPath of explicitPaths) {
      await ingestScipFile(scipPath, this.projectRoot, ingestOptions);
    }
    // Auto-spawned artifacts are CodeGraph's own output — any failure here
    // (including a late conflict) degrades to tree-sitter rather than aborting.
    for (const scipPath of acceptedAutoPaths) {
      try {
        await ingestScipFile(scipPath, this.projectRoot, ingestOptions);
      } catch (err) {
        failures.push({
          indexer: path.basename(scipPath, '.scip'),
          language: 'unknown',
          mode: classifyScipFailureMode(err),
          fallback: 'tree-sitter',
        });
      }
    }

    if (failures.length > 0) {
      try {
        writeScipFailureLedger(getCodeGraphDir(this.projectRoot), failures);
      } catch {
        /* the ledger is best-effort surfacing, never fatal */
      }
    }

    const rows = db
      .prepare('SELECT DISTINCT source_file_path FROM scip_documents')
      .all() as Array<{ source_file_path: string }>;
    for (const row of rows) {
      covered.add(normalizePath(row.source_file_path));
    }
    return covered;
  }

  /**
   * Garbage-collect SCIP ingestions left incomplete by a prior crash.
   *
   * A crash mid-ingest leaves an `scip_ingestions` row with `completed_at`
   * NULL and a partially-mutated graph. This runs at `open()` / `openSync()`
   * time (migrations have already run) and scoped-deletes that partial data.
   * The cleanup is destructive, not restorative — SCIP coverage for the
   * affected indexes must be regenerated (`codegraph index --scip` /
   * `codegraph scip-refresh`).
   */
  private cleanupIncompleteIngestions(): void {
    const incomplete = this.queries.getIncompleteScipIngestions();
    if (incomplete.length === 0) {
      return;
    }
    console.error(
      `[codegraph] Found ${incomplete.length} incomplete SCIP ingestion(s) from a ` +
        `prior crash. Cleaning up partial data; re-run 'codegraph index --scip' or ` +
        `'codegraph scip-refresh' to restore SCIP coverage.`,
    );
    for (const scipIndexPath of incomplete) {
      this.queries.cleanupIncompleteScipIngestion(scipIndexPath);
    }
  }

  /**
   * Close the CodeGraph instance and release resources
   */
  close(): void {
    this.unwatch();
    // Release file lock if held
    this.fileLock.release();
    this.db.close();
  }

  // ===========================================================================
  // Configuration
  // ===========================================================================

  /**
   * Get the current configuration
   */
  getConfig(): CodeGraphConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(updates: Partial<CodeGraphConfig>): void {
    Object.assign(this.config, updates);
    saveConfig(this.projectRoot, this.config);
    // Recreate orchestrator and resolver with new config
    this.orchestrator = new ExtractionOrchestrator(
      this.projectRoot,
      this.config,
      this.queries
    );
    this.resolver = createResolver(this.projectRoot, this.queries);
  }

  /**
   * Get the project root directory
   */
  getProjectRoot(): string {
    return this.projectRoot;
  }

  // ===========================================================================
  // Indexing
  // ===========================================================================

  /**
   * Index all files in the project
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexAll(options: IndexOptions = {}): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        // SCIP pre-pass: ingest .scip backends, then exclude their files from
        // the tree-sitter pass (dual-backend dispatch).
        let scipCoveredFiles: ReadonlySet<string>;
        try {
          scipCoveredFiles = await this.runScipPrePass(options);
        } catch (err) {
          // A caller-supplied `--scip <path>` that is corrupt, or a
          // MultiIndexConflictError, is fatal — but the persister's STAGE A
          // pre-scan ran before any mutation, so the DB is unchanged.
          return {
            success: false,
            filesIndexed: 0,
            filesSkipped: 0,
            filesErrored: 0,
            nodesCreated: 0,
            edgesCreated: 0,
            errors: [
              {
                message: `SCIP ingestion failed: ${(err as Error).message}`,
                severity: 'error' as const,
              },
            ],
            durationMs: 0,
          };
        }

        const result = await this.orchestrator.indexAll(
          options.onProgress,
          options.signal,
          options.verbose,
          scipCoveredFiles
        );

        // Resolve references to create call/import/extends edges. Gate on the
        // unresolved-ref count, not `filesIndexed`: the SCIP empty-document
        // fallback inserts unresolved refs during `runScipPrePass`, so refs can
        // exist even when the tree-sitter pass indexed zero files (every file
        // SCIP-covered). `getUnresolvedReferencesCount` is a cheap COUNT(*).
        const unresolvedCount = this.queries.getUnresolvedReferencesCount();
        if (result.success && unresolvedCount > 0) {
          options.onProgress?.({
            phase: 'resolving',
            current: 0,
            total: unresolvedCount,
          });

          await this.resolveReferencesBatched((current, total) => {
            options.onProgress?.({
              phase: 'resolving',
              current,
              total,
            });
          });
        }

        // Phase 3 — framework synthesize/augment. UNCONDITIONAL on extraction
        // success, OUTSIDE the resolution gate: tag-only and synthesize-only
        // resolvers must run even when there are zero unresolved refs.
        // STAGE 0 purge inside the orchestrator handles re-index of a
        // populated DB.
        if (result.success) {
          const phase3 = new Phase3Orchestrator(this.projectRoot, this.queries);
          const phase3Result = await phase3.run();
          result.errors.push(...phase3Result.errors);
          result.nodesCreated += phase3Result.nodesAdded;
          result.edgesCreated += phase3Result.edgesAdded;
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Index specific files
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { success: false, filesIndexed: 0, filesSkipped: 0, filesErrored: 0, nodesCreated: 0, edgesCreated: 0, errors: [{ message: 'Could not acquire file lock - another process may be indexing', severity: 'error' as const }], durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.indexFiles(filePaths);

        // Phase 3 — UNCONDITIONAL when extraction succeeded. Without this,
        // direct callers of `indexFiles()` would lose every Phase 3
        // contribution (routes / components / tags / DI bindings) on the
        // touched files. STAGE 0 purge inside the orchestrator handles the
        // re-index case; the cost on a small file set is bounded by the
        // framework_node_count / framework_edge_count for the whole project.
        if (result.success) {
          const phase3 = new Phase3Orchestrator(this.projectRoot, this.queries);
          const phase3Result = await phase3.run();
          result.errors.push(...phase3Result.errors);
          result.nodesCreated += phase3Result.nodesAdded;
          result.edgesCreated += phase3Result.edgesAdded;
        }

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Sync with current file state (incremental update)
   *
   * Uses a mutex to prevent concurrent indexing operations.
   */
  async sync(options: IndexOptions = {}): Promise<SyncResult> {
    return this.indexMutex.withLock(async () => {
      try {
        this.fileLock.acquire();
      } catch {
        return { filesChecked: 0, filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 0 };
      }
      try {
        const result = await this.orchestrator.sync(options.onProgress);

        // Resolve references if files were updated
        if (result.filesAdded > 0 || result.filesModified > 0) {
          if (result.changedFilePaths) {
            // Scope resolution to changed files (git fast path — bounded set)
            const unresolvedRefs = this.queries.getUnresolvedReferencesByFiles(result.changedFilePaths);

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedRefs.length,
            });

            this.resolver.resolveAndPersist(unresolvedRefs, (current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          } else {
            // No git info — use batched resolution to avoid OOM
            const unresolvedCount = this.queries.getUnresolvedReferencesCount();

            options.onProgress?.({
              phase: 'resolving',
              current: 0,
              total: unresolvedCount,
            });

            await this.resolveReferencesBatched((current, total) => {
              options.onProgress?.({
                phase: 'resolving',
                current,
                total,
              });
            });
          }
        }

        // Phase 3 — full recompute (STAGE 0 purge + re-synthesize). Runs
        // UNCONDITIONALLY: a sync where no files changed can still leave
        // stale framework facts behind (a previously-detecting resolver
        // that no longer detects, or a merged-edge contribution that's no
        // longer valid). Incremental Phase 3 sync is deferred to P2/P3.
        const phase3 = new Phase3Orchestrator(this.projectRoot, this.queries);
        const phase3Result = await phase3.run();
        result.phase3 = {
          nodesAdded: phase3Result.nodesAdded,
          edgesAdded: phase3Result.edgesAdded,
          tagsAdded: phase3Result.tagsAdded,
          errors: phase3Result.errors,
        };

        return result;
      } finally {
        this.fileLock.release();
      }
    });
  }

  /**
   * Check if an indexing operation is currently in progress
   */
  isIndexing(): boolean {
    return this.indexMutex.isLocked();
  }

  // ===========================================================================
  // SCIP refresh (P2.3)
  // ===========================================================================

  /**
   * Build the per-run log file's WriteStream. Exists as a separate instance
   * method (rather than an inlined `fs.createWriteStream` call inside
   * `refreshScip`) purely as a test seam: refresh's log-stream failure
   * paths (open / mid-stream / flush-time errors) are unreachable from
   * the real filesystem in a portable way, so the regression test
   * (`p2-review-fixes.test.ts`) monkey-patches this method on a single
   * CodeGraph instance to inject a synthetic failure shape.
   *
   * Not part of the public API. Production behavior is identical to
   * `fs.createWriteStream(logPath, { flags: 'w' })`.
   */
  private createRefreshLogStream(logPath: string): fs.WriteStream {
    return fs.createWriteStream(logPath, { flags: 'w' });
  }

  /**
   * Spawn the configured SCIP indexer (`config.scipRefreshCommand`,
   * default `'scip-dotnet index ./'`) and re-ingest its output. After
   * ingest, runs the post-ingest assertion (narrow — exact-match
   * `provenance = 'tree-sitter'` rows must be 0 for each refreshed
   * file; fallback rows are legitimately re-created), then reruns
   * resolution + Phase 3 so derived data stays consistent. Recoverable
   * Phase 3 errors surface via `result.error` (stderr + per-run log
   * append + sidecar `lastError`) without demoting `phase` from `'ok'`.
   *
   * Concurrency: serialized by the in-process `indexMutex` AND the
   * cross-process `FileLock` at `.codegraph/codegraph.lock`. Two
   * processes invoking refresh concurrently: the late arrival returns
   * `phase = 'lock-failed'` without touching the database.
   *
   * Writes spawn stdout/stderr to `.codegraph/logs/scip-refresh-<ts>.log`
   * and a status sidecar at `.codegraph/scip-last-refresh.json`.
   *
   * @returns ScipRefreshResult with phase + counts. The caller (CLI) maps
   *          phase to exit code:
   *            - `'ok'`            → 0
   *            - `'spawn-failed'`  → 1
   *            - `'lock-failed'`   → 1 (cross-process FileLock contended)
   *            - `'ingest-failed'` → 2
   */
  async refreshScip(options: ScipRefreshOptions = {}): Promise<ScipRefreshResult> {
    return this.indexMutex.withLock(async () => {
      const startedAt = Date.now();
      // Cross-process safety: indexMutex covers in-process concurrency, but
      // two `codegraph` processes (e.g. CLI + scheduled refresh, or two
      // scheduled jobs that overlapped) would otherwise race STAGE B
      // deletes against each other. Same FileLock pattern as indexAll / sync.
      try {
        this.fileLock.acquire();
      } catch {
        return {
          phase: 'lock-failed',
          error: 'Could not acquire file lock — another codegraph process is indexing or refreshing',
          spawnExitCode: null,
          scipPath: null,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath: null,
        };
      }
      try {
      const codegraphDir = path.join(this.projectRoot, '.codegraph');
      const logsDir = path.join(codegraphDir, 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      // 1. Spawn the configured indexer.
      const commandSpec =
        options.command ?? this.config.scipRefreshCommand ?? 'scip-dotnet index ./';
      // Single-string form gets tokenized respecting double + single quotes.
      // Previously a naive split(/\s+/) mis-tokenized paths with spaces — e.g.
      // `"C:\\Program Files\\scip\\scip-dotnet" index ./` would split into 4
      // tokens, none of which is a valid executable. Array form bypasses this
      // entirely (each element is one argv slot). Documented in the config
      // type's JSDoc.
      const [cmd, ...args] = Array.isArray(commandSpec)
        ? commandSpec
        : tokenizeShellCommand(commandSpec);
      if (!cmd) {
        return {
          phase: 'spawn-failed',
          error: 'scipRefreshCommand is empty',
          spawnExitCode: null,
          scipPath: null,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath: null,
        };
      }

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const logPath = path.join(logsDir, `scip-refresh-${ts}.log`);
      const { spawn } = await import('child_process');
      // Indirection via instance method (not inlined fs.createWriteStream)
      // so refresh's log-stream failure paths can be exercised in tests by
      // monkey-patching this single method on the CodeGraph instance.
      // Production callers never touch this — it has the same behavior as
      // `fs.createWriteStream(logPath, { flags: 'w' })` and is not part of
      // the public API surface.
      const logStream = this.createRefreshLogStream(logPath);

      // Attach the error listener BEFORE anything pipes into the stream.
      // createWriteStream resolves the underlying open() on a microtask;
      // an EACCES/ENOSPC/EROFS/ENOENT or any later write failure will
      // emit 'error' asynchronously. Without a listener attached
      // synchronously, Node treats it as an unhandled emitter error and
      // crashes the whole process — exactly the failure mode a scheduled
      // `scip-refresh --quiet` cannot tolerate.
      //
      // A mid-run log-stream error (logStream errors while the child is
      // still spewing output) creates a second hazard: pipe() auto-unpipes
      // on downstream error, the child's stdout/stderr have no consumer,
      // their kernel pipe buffers fill, the child blocks on write, and
      // our `await child.close()` never resolves → refresh hangs forever.
      // The handler below addresses that by killing the child and
      // resuming its stdio readables (so any in-flight pipe-buffer bytes
      // drain to a no-op consumer) the moment logStream errors.
      let logStreamError: Error | null = null;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let childRef: any = null;
      logStream.on('error', (err) => {
        if (!logStreamError) logStreamError = err;
        // Defense against the noisy-child hang. If the child is still
        // running, kill it and drain its readables so the spawn Promise
        // resolves promptly with a non-zero exit. If the child has
        // already exited, this is a no-op.
        if (childRef) {
          try { childRef.stdout?.resume(); } catch { /* ignore */ }
          try { childRef.stderr?.resume(); } catch { /* ignore */ }
          if (childRef.exitCode === null && !childRef.killed) {
            try { childRef.kill(); } catch { /* ignore */ }
          }
        }
      });

      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: this.projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        childRef = child;
        // Absorb pipe-source errors so they don't bubble up. When
        // logStream errors, the upstream readable's `pipe()` machinery
        // unpipes and emits 'error' on the source; the real cause is
        // captured in logStreamError above.
        child.stdout.on('error', () => { /* absorbed */ });
        child.stderr.on('error', () => { /* absorbed */ });
        child.stdout.pipe(logStream, { end: false });
        child.stderr.pipe(logStream, { end: false });
        child.on('close', (code) => resolve(code));
        child.on('error', () => resolve(null));
      });

      // If the log stream errored at any point (file open failure or
      // mid-stream write failure such as disk-full), bail out with a
      // structured result instead of letting later code race the
      // half-dead stream.
      if (logStreamError) {
        try { logStream.end(); } catch { /* ignore */ }
        const lse: Error = logStreamError;
        return {
          phase: 'spawn-failed',
          error: `Refresh log file unwritable (${lse.message}); refresh aborted before ingest`,
          spawnExitCode: exitCode,
          scipPath: null,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath,
        };
      }

      // Close the pipe stream and WAIT for the OS to flush all buffered
      // stdout/stderr bytes to disk before we (potentially) appendFileSync
      // a derived-data warning to the same path. logStream.end() returns
      // synchronously but the underlying fd close is async — without
      // waiting, the appendFileSync below can interleave with pending
      // pipe writes, scrambling the log order or truncating indexer output.
      //
      // The on('error') listener attached above stays in scope here, so
      // a flush-time write failure (ENOSPC, EDQUOT, EIO on close) is
      // captured into logStreamError rather than crashing the process.
      // The local 'error' listener inside this Promise resolves the wait
      // promptly without unhandled-rejection noise.
      await new Promise<void>((resolve) => {
        logStream.once('finish', resolve);
        logStream.once('error', () => resolve());
        logStream.end();
      });

      // Re-check AFTER the flush wait: an error event during final
      // buffer drain or fd close would have populated logStreamError
      // post-spawn-promise. If we let refresh continue here, ingest
      // proceeds and `phase: 'ok'` would be returned despite the per-run
      // log being silently incomplete — exactly the failure mode that
      // makes scheduled-refresh diagnosis impossible.
      if (logStreamError) {
        const lse: Error = logStreamError;
        return {
          phase: 'spawn-failed',
          error: `Refresh log file flush failed (${lse.message}); refresh aborted before ingest`,
          spawnExitCode: exitCode,
          scipPath: null,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath,
        };
      }

      if (exitCode !== 0) {
        return {
          phase: 'spawn-failed',
          error: `Indexer exited with code ${exitCode}`,
          spawnExitCode: exitCode,
          scipPath: null,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath,
        };
      }

      // 2. Ingest the produced `.scip`.
      const outputRel =
        options.scipOutputPath ?? this.config.scipRefreshOutputPath ?? './index.scip';
      const scipPath = path.resolve(this.projectRoot, outputRel);
      if (!fs.existsSync(scipPath)) {
        return {
          phase: 'spawn-failed',
          error: `Indexer succeeded but expected output not found at ${scipPath}`,
          spawnExitCode: exitCode,
          scipPath,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath,
        };
      }

      // Review fix #1: build the empty-doc fallback the persister needs.
      // Scan the .scip ahead of ingest to learn which languages its
      // documents cover, then load those grammars so `maybeEmptyFallback`
      // can synchronously call `extractFromSource` per empty doc. Without
      // this, `supersedeTreeSitter` (LIKE 'tree-sitter%') wipes prior
      // fallback rows and they're not recreated.
      const coveredLanguages = new Set<Language>();
      try {
        for await (const doc of iterateScipDocuments(scipPath)) {
          coveredLanguages.add(detectLanguage(doc.relativePath));
        }
      } catch (err) {
        return {
          phase: 'ingest-failed',
          error: `Failed to pre-scan .scip for fallback languages: ${err instanceof Error ? err.message : String(err)}`,
          spawnExitCode: exitCode,
          scipPath,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath,
        };
      }
      const extractFallback = await this.buildEmptyDocFallback(coveredLanguages);

      try {
        await ingestScipFile(scipPath, this.projectRoot, {
          db: this.db.getDb(),
          qb: this.queries,
          emptyFallbackThresholdBytes: this.config.emptyFallbackThresholdBytes,
          extractFallback,
        });
      } catch (err) {
        return {
          phase: 'ingest-failed',
          error: err instanceof Error ? err.message : String(err),
          spawnExitCode: exitCode,
          scipPath,
          filesCovered: 0,
          durationMs: Date.now() - startedAt,
          logPath,
        };
      }

      // Review fix #2: ingestion did raw DELETE / INSERT OR REPLACE on
      // nodes (via STAGE B and STAGE E's supersedeTreeSitter). Those
      // bypass the per-row cache invalidation that insertNode/deleteNode
      // perform inline. Flush wholesale so getNodeById doesn't serve
      // pre-refresh cached entries from any caller that warmed the cache
      // before this refresh started.
      this.queries.invalidatePhase3Caches();

      // 3. Post-ingest assertion (narrow — round 3 finding 1):
      //    for every file covered by this scip_index_path, count exact-match
      //    `provenance = 'tree-sitter'` rows. Must be zero. Fallback rows
      //    (`'tree-sitter (scip-empty-fallback)'`) are legitimately created
      //    by STAGE E for empty docs and are NOT counted.
      const filesCovered = this.queries.getScipDocumentsForIndex(scipPath);
      const leaked: Array<{ file: string; count: number }> = [];
      for (const file of filesCovered) {
        const count = this.queries.countShadowRowsForFile(file);
        if (count > 0) leaked.push({ file, count });
      }
      if (leaked.length > 0) {
        return {
          phase: 'ingest-failed',
          error: `scip-refresh leaked shadow nodes for ${leaked.length} file(s): ` +
            leaked.slice(0, 5).map((l) => `${l.file} (${l.count})`).join(', ') +
            (leaked.length > 5 ? `, … (+${leaked.length - 5} more)` : ''),
          spawnExitCode: exitCode,
          scipPath,
          filesCovered: filesCovered.length,
          durationMs: Date.now() - startedAt,
          logPath,
        };
      }

      // Review fix #3: rebuild derived data. SCIP re-ingest replaces
      // nodes wholesale via STAGE B. Two layers of derived data must
      // re-run to stay consistent (this matches what indexAll + sync do
      // after their own extraction phases):
      //
      //  (a) Resolution — the empty-doc fallback inserts unresolved refs
      //      (since fix #1 wired extractFallback through). Without
      //      resolving, they sit unprocessed and dependent edges are
      //      missing.
      //
      //  (b) Phase 3 — STAGE 0 inside Phase3Orchestrator purges all
      //      framework tags + framework-primary edges, then re-runs
      //      synthesize/augment against the post-refresh graph. Without
      //      this, framework tags from before the refresh may reference
      //      nodes whose ids changed (function renamed in the source).
      //
      // Errors here are recorded in the result.error string but do NOT
      // demote the phase to 'ingest-failed' — the SCIP data itself is
      // fresh; only derived state failed. Caller can inspect logs.
      const derivedErrors: string[] = [];
      try {
        const unresolvedCount = this.queries.getUnresolvedReferencesCount();
        if (unresolvedCount > 0) {
          await this.resolveReferencesBatched();
        }
      } catch (err) {
        derivedErrors.push(
          `resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      try {
        const phase3 = new Phase3Orchestrator(this.projectRoot, this.queries);
        // Round-2 review fix: Phase3Orchestrator returns recoverable
        // per-resolver errors in `result.errors` rather than throwing.
        // The previous version ignored them — a refresh that dropped
        // framework contributions could exit `'ok'` with no warning,
        // including under scheduled `--quiet` operation. Capture them
        // into `derivedErrors` so they reach `result.error` and the CLI
        // surfaces them on the success path.
        const phase3Result = await phase3.run();
        for (const e of phase3Result.errors) {
          derivedErrors.push(
            `phase 3 ${e.severity}: ${e.message}` + (e.code ? ` (${e.code})` : ''),
          );
        }
      } catch (err) {
        derivedErrors.push(
          `phase 3 threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      const errorString = derivedErrors.length > 0 ? derivedErrors.join('; ') : null;

      // Round-3 review fix: defense-in-depth for scheduled-refresh warning
      // capture. The CLI writes the warning to stderr (covers launchd
      // StandardErrorPath + systemd journald), but Task Scheduler XML
      // doesn't redirect either stream by default. Persist the same
      // warning in TWO files schedulers always preserve:
      //   (a) Append to the per-run log file (which Task Scheduler at
      //       least pointed users at).
      //   (b) Write `lastError` into the sidecar so `codegraph status`
      //       and `cat .codegraph/scip-last-refresh.json` both surface it.
      if (errorString) {
        try {
          fs.appendFileSync(
            logPath,
            `\n[codegraph derived-data warning ${new Date().toISOString()}]\n${errorString}\n`,
          );
        } catch {
          // Log append failure is non-fatal — stderr still has it.
        }
      }

      // 4. Update the status sidecar.
      const sidecarPath = path.join(codegraphDir, 'scip-last-refresh.json');
      const sidecar = {
        refreshedAt: new Date().toISOString(),
        scipPath,
        command: Array.isArray(commandSpec) ? commandSpec.join(' ') : commandSpec,
        filesCovered: filesCovered.length,
        durationMs: Date.now() - startedAt,
        // Round-3 review fix: persistent diagnostic across runs. Null
        // on a clean refresh; otherwise the same semicolon-joined string
        // returned as result.error. Surveying tools can poll the sidecar.
        lastError: errorString,
      };
      try {
        fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
      } catch {
        // Sidecar write failure is non-fatal — refresh itself succeeded.
      }

      return {
        phase: 'ok',
        error: errorString,
        spawnExitCode: exitCode,
        scipPath,
        filesCovered: filesCovered.length,
        durationMs: Date.now() - startedAt,
        logPath,
      };
      } finally {
        this.fileLock.release();
      }
    });
  }

  // ===========================================================================
  // File Watching
  // ===========================================================================

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux 19+,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   *
   * @param options - Watch options (debounce delay, callbacks)
   * @returns true if watching started successfully
   */
  watch(options: WatchOptions = {}): boolean {
    if (this.watcher?.isActive()) return true;

    this.watcher = new FileWatcher(
      this.projectRoot,
      this.config,
      async () => {
        const result = await this.sync();
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options
    );

    return this.watcher.start();
  }

  /**
   * Stop watching for file changes.
   */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.stop();
      this.watcher = null;
    }
  }

  /**
   * Check if the file watcher is active.
   */
  isWatching(): boolean {
    return this.watcher?.isActive() ?? false;
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    return this.orchestrator.getChangedFiles();
  }

  /**
   * Extract nodes and edges from source code (without storing)
   */
  extractFromSource(filePath: string, source: string): ExtractionResult {
    return extractFromSource(filePath, source);
  }

  // ===========================================================================
  // Reference Resolution
  // ===========================================================================

  /**
   * Resolve unresolved references and create edges
   *
   * This method takes unresolved references from extraction and attempts
   * to resolve them using multiple strategies:
   * - Framework-specific patterns (React, Express, Laravel)
   * - Import-based resolution
   * - Name-based symbol matching
   */
  resolveReferences(onProgress?: (current: number, total: number) => void): ResolutionResult {
    // Get all unresolved references from the database
    const unresolvedRefs = this.queries.getUnresolvedReferences();
    return this.resolver.resolveAndPersist(unresolvedRefs, onProgress);
  }

  /**
   * Resolve references in batches to keep memory bounded on large codebases.
   * Processes chunks of unresolved refs, persisting results after each batch.
   */
  async resolveReferencesBatched(onProgress?: (current: number, total: number) => void): Promise<ResolutionResult> {
    return this.resolver.resolveAndPersistBatched(onProgress);
  }

  /**
   * Get detected frameworks in the project
   */
  getDetectedFrameworks(): string[] {
    return this.resolver.getDetectedFrameworks();
  }

  /**
   * Re-initialize the resolver (useful after adding new files)
   */
  reinitializeResolver(): void {
    this.resolver.initialize();
  }

  // ===========================================================================
  // Graph Statistics
  // ===========================================================================

  /**
   * Get statistics about the knowledge graph. Applies the default freshness
   * filter (excludes hidden-stale rows and edges with hidden-stale endpoints,
   * per P2.1.7 / design Decision 5).
   *
   * @see {@link getStatsIncludingStale} for raw totals.
   * @see {@link getStaleSummary} for the hidden/visible/fresh breakdown.
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  /**
   * Raw graph statistics WITHOUT the default freshness filter — includes
   * hidden-stale rows and edges with hidden-stale endpoints. Use for status
   * diagnostics or parity checking; do not use as a substitute for `getStats`
   * unless you specifically need the raw count.
   *
   * @see design doc Decision 5 — three-surface model.
   */
  getStatsIncludingStale(): GraphStats {
    const stats = this.queries.getStatsIncludingStale();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
  }

  /**
   * Decomposed staleness counts — hidden-stale (shadow active) vs visible-stale
   * (needs refresh, no grammar) vs fresh. Read raw `stale`/`staleness_visible`
   * columns; designed for `codegraph status` (P2.4) and diagnostics. The
   * three categories together cover every row.
   */
  getStaleSummary(): StaleSummary {
    return this.queries.getStaleSummary();
  }

  /**
   * Edge counts grouped by derived confidence tier (P0.4d) — `compiler`
   * (SCIP), `scope-resolved`, `syntactic` (tree-sitter), `inferred`
   * (heuristic / framework), `ambiguous` (no provenance). Counts follow the
   * default freshness + endpoint-visibility contract, so they sum to
   * `getStats().edgeCount`. Used by `codegraph status`.
   */
  getEdgeConfidenceTierCounts(): Record<ConfidenceTier, number> {
    const counts: Record<ConfidenceTier, number> = {
      compiler: 0,
      syntactic: 0,
      'scope-resolved': 0,
      inferred: 0,
      ambiguous: 0,
    };
    for (const row of this.queries.getEdgeCountsByProvenance()) {
      const tier = deriveConfidenceTier(
        (row.provenance ?? undefined) as GraphProvenance | undefined,
      );
      counts[tier] += row.count;
    }
    return counts;
  }

  /**
   * Review fix #4 (Decision 7 — required diagnostic): count of edges
   * hidden ONLY because at least one endpoint node is hidden-stale.
   * Edge-row freshness still applies. Used by `codegraph status` to
   * report the "Dangling against stale" line — the count of public-API
   * results suppressed by the endpoint-visibility filter beyond what
   * row-level staleness alone would hide.
   */
  countDanglingEdgesAgainstHiddenStale(): number {
    return this.queries.countDanglingEdgesAgainstHiddenStale();
  }

  /**
   * Read the SCIP refresh sidecar at `.codegraph/scip-last-refresh.json` —
   * the status record written by the most recent successful
   * `CodeGraph.refreshScip` call.
   *
   * Returns `null` if the file is absent, unreadable, or malformed.
   * Status (P2.4.4) treats all three cases as "never refreshed"; users
   * needing the distinction can read the sidecar directly.
   */
  getLastScipRefresh(): ScipLastRefresh | null {
    const sidecarPath = path.join(this.projectRoot, '.codegraph', 'scip-last-refresh.json');
    try {
      if (!fs.existsSync(sidecarPath)) return null;
      const raw = fs.readFileSync(sidecarPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<ScipLastRefresh>;
      // Minimal shape validation — reject if any required field missing.
      if (
        typeof parsed.refreshedAt !== 'string' ||
        typeof parsed.scipPath !== 'string' ||
        typeof parsed.command !== 'string' ||
        typeof parsed.filesCovered !== 'number' ||
        typeof parsed.durationMs !== 'number'
      ) {
        return null;
      }
      return {
        refreshedAt: parsed.refreshedAt,
        scipPath: parsed.scipPath,
        command: parsed.command,
        filesCovered: parsed.filesCovered,
        durationMs: parsed.durationMs,
        // `lastError` added in round-3 review. Older sidecars without it
        // surface as null (backward-compatible). Validate to a string-or-null
        // shape so a malformed value can't leak through as `undefined`.
        lastError: typeof parsed.lastError === 'string' ? parsed.lastError : null,
      };
    } catch {
      // Malformed JSON, FS error, permission denied — all treated as "never".
      return null;
    }
  }

  /**
   * Per-language tier summary — one entry per language with files in the
   * repo. Combines:
   *  - DB-side node counts per (language, provenance) — what tier the
   *    language is actually at.
   *  - Installed SCIP indexer detection — which languages have an
   *    available indexer (whether or not Tier 1 is currently active).
   *  - `SCIP_INDEXERS` spec — install hints for languages where no
   *    indexer is currently installed.
   *
   * Used by `codegraph status` (P2.4.4) to render the per-language tier
   * display. Returns languages sorted by file count descending.
   *
   * Cost: one grouped SQL query (`getNodeCountsByLanguageAndProvenance`)
   * plus one (cached) `detectInstalledScipIndexers` call. Typical
   * latency on a fresh process: ~250ms for indexer detection +
   * sub-ms SQL. Subsequent calls within the same process use the
   * indexer-detection cache.
   */
  async getLanguageTiers(): Promise<LanguageTier[]> {
    const stats = this.queries.getStats();
    const filesByLanguage = stats.filesByLanguage;

    // (language, provenance) → count, from one grouped query.
    const rawCounts = this.queries.getNodeCountsByLanguageAndProvenance();
    const perLang = new Map<Language, { scip: number; treeSitter: number }>();
    for (const row of rawCounts) {
      const entry = perLang.get(row.language) ?? { scip: 0, treeSitter: 0 };
      if (row.provenance === 'scip') {
        entry.scip += row.count;
      } else if (row.provenance.startsWith('tree-sitter')) {
        // Catches 'tree-sitter' AND 'tree-sitter (scip-empty-fallback)'.
        entry.treeSitter += row.count;
      }
      // 'scip:external' / 'scope-resolved' / 'framework:*' / 'heuristic' — ignored.
      perLang.set(row.language, entry);
    }

    const detected = await detectInstalledScipIndexers();
    const coverage = buildScipCoverageMap(detected);

    const out: LanguageTier[] = [];
    for (const [lang, filesInRepo] of Object.entries(filesByLanguage)) {
      if (filesInRepo <= 0) continue;
      const language = lang as Language;
      const counts = perLang.get(language) ?? { scip: 0, treeSitter: 0 };
      const installedIndexer = coverage.get(language);

      // Hint: only when no installed indexer covers this language AND a
      // SCIP indexer spec exists for it.
      let installHint: string | null = null;
      if (!installedIndexer) {
        const spec = SCIP_INDEXERS.find((s) => s.languages.includes(language));
        if (spec) installHint = spec.installHint;
      }

      out.push({
        language,
        filesInRepo,
        tier: counts.scip > 0 ? 'tier-1' : 'tier-0',
        scipNodeCount: counts.scip,
        treeSitterNodeCount: counts.treeSitter,
        scipIndexerAvailable: installedIndexer !== undefined,
        scipIndexerInstalled: installedIndexer?.cmd ?? null,
        installHint,
      });
    }

    out.sort((a, b) => b.filesInRepo - a.filesInRepo);
    return out;
  }

  /**
   * Active SQLite backend for this project's connection. `wasm` means
   * the native better-sqlite3 install failed and the WASM fallback is
   * serving requests at 5-10x the latency. Surfaced via `codegraph
   * status` and the `codegraph_status` MCP tool.
   */
  getBackend(): import('./db').SqliteBackend {
    return this.db.getBackend();
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Get a node by ID
   */
  getNode(id: string): Node | null {
    return this.queries.getNodeById(id);
  }

  /**
   * Get all nodes in a file
   */
  getNodesInFile(filePath: string): Node[] {
    return this.queries.getNodesByFile(filePath);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: Node['kind']): Node[] {
    return this.queries.getNodesByKind(kind);
  }

  /**
   * Get all nodes carrying a Phase 3 tag (e.g. 'spring:service',
   * 'react:hook', 'route-handler').
   */
  getNodesByTag(tag: string): Node[] {
    return this.queries.getNodesByTag(tag);
  }

  /**
   * For each `framework:<name>` provenance ever observed on an edge in the
   * graph, return the count of edges in which that provenance contributes
   * (counts membership in `provenances[]`, NOT primary `provenance`). Used by
   * `codegraph status` to surface per-framework edge contributions including
   * merged-edge cases where SCIP / tree-sitter is the primary provenance and
   * a framework resolver is a non-primary contributor.
   */
  getFrameworkEdgeContributionCounts(): Record<string, number> {
    return this.queries.getFrameworkEdgeContributionCounts();
  }

  /**
   * Search nodes by text
   */
  searchNodes(query: string, options?: SearchOptions): SearchResult[] {
    return this.queries.searchNodes(query, options);
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(nodeId: string): Edge[] {
    return this.queries.getOutgoingEdges(nodeId);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(nodeId: string): Edge[] {
    return this.queries.getIncomingEdges(nodeId);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Get a file record by path
   */
  getFile(filePath: string): FileRecord | null {
    return this.queries.getFileByPath(filePath);
  }

  /**
   * Get all tracked files
   */
  getFiles(): FileRecord[] {
    return this.queries.getAllFiles();
  }

  // ===========================================================================
  // Graph Query Methods
  // ===========================================================================

  /**
   * Get the context for a node (ancestors, children, references)
   *
   * Returns comprehensive context about a node including its containment
   * hierarchy, children, incoming/outgoing references, type information,
   * and relevant imports.
   *
   * @param nodeId - ID of the focal node
   * @returns Context object with all related information
   */
  getContext(nodeId: string): Context {
    return this.graphManager.getContext(nodeId);
  }

  /**
   * Traverse the graph from a starting node
   *
   * Uses breadth-first search by default. Supports filtering by edge types,
   * node types, and traversal direction.
   *
   * @param startId - Starting node ID
   * @param options - Traversal options
   * @returns Subgraph containing traversed nodes and edges
   */
  traverse(startId: string, options?: TraversalOptions): Subgraph {
    return this.traverser.traverseBFS(startId, options);
  }

  /**
   * Get the call graph for a function
   *
   * Returns both callers (functions that call this function) and
   * callees (functions called by this function) up to the specified depth.
   *
   * @param nodeId - ID of the function/method node
   * @param depth - Maximum depth in each direction (default: 2)
   * @returns Subgraph containing the call graph
   */
  getCallGraph(nodeId: string, depth: number = 2): Subgraph {
    return this.traverser.getCallGraph(nodeId, depth);
  }

  /**
   * Get the type hierarchy for a class/interface
   *
   * Returns both ancestors (types this extends/implements) and
   * descendants (types that extend/implement this).
   *
   * @param nodeId - ID of the class/interface node
   * @returns Subgraph containing the type hierarchy
   */
  getTypeHierarchy(nodeId: string): Subgraph {
    return this.traverser.getTypeHierarchy(nodeId);
  }

  /**
   * Find all usages of a symbol
   *
   * Returns all nodes that reference the specified symbol through
   * any edge type (calls, references, type_of, etc.).
   *
   * @param nodeId - ID of the symbol node
   * @returns Array of nodes and edges that reference this symbol
   */
  findUsages(nodeId: string): Array<{ node: Node; edge: Edge }> {
    return this.traverser.findUsages(nodeId);
  }

  /**
   * Get callers of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes that call this function
   */
  getCallers(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallers(nodeId, maxDepth);
  }

  /**
   * Get callees of a function/method
   *
   * @param nodeId - ID of the function/method node
   * @param maxDepth - Maximum depth to traverse (default: 1)
   * @returns Array of nodes called by this function
   */
  getCallees(nodeId: string, maxDepth: number = 1): Array<{ node: Node; edge: Edge }> {
    return this.traverser.getCallees(nodeId, maxDepth);
  }

  /**
   * Calculate the impact radius of a node
   *
   * Returns all nodes that could be affected by changes to this node.
   *
   * @param nodeId - ID of the node
   * @param maxDepth - Maximum depth to traverse (default: 3)
   * @returns Subgraph containing potentially impacted nodes
   */
  getImpactRadius(nodeId: string, maxDepth: number = 3): Subgraph {
    return this.traverser.getImpactRadius(nodeId, maxDepth);
  }

  /**
   * Find the shortest path between two nodes
   *
   * @param fromId - Starting node ID
   * @param toId - Target node ID
   * @param edgeKinds - Edge types to consider (all if empty)
   * @returns Array of nodes and edges forming the path, or null if no path exists
   */
  findPath(
    fromId: string,
    toId: string,
    edgeKinds?: Edge['kind'][]
  ): Array<{ node: Node; edge: Edge | null }> | null {
    return this.traverser.findPath(fromId, toId, edgeKinds);
  }

  /**
   * Get ancestors of a node in the containment hierarchy
   *
   * @param nodeId - ID of the node
   * @returns Array of ancestor nodes from immediate parent to root
   */
  getAncestors(nodeId: string): Node[] {
    return this.traverser.getAncestors(nodeId);
  }

  /**
   * Get immediate children of a node
   *
   * @param nodeId - ID of the node
   * @returns Array of child nodes
   */
  getChildren(nodeId: string): Node[] {
    return this.traverser.getChildren(nodeId);
  }

  /**
   * Get dependencies of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths this file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return this.graphManager.getFileDependencies(filePath);
  }

  /**
   * Get dependents of a file
   *
   * @param filePath - Path to the file
   * @returns Array of file paths that depend on this file
   */
  getFileDependents(filePath: string): string[] {
    return this.graphManager.getFileDependents(filePath);
  }

  /**
   * Find circular dependencies in the codebase
   *
   * @returns Array of cycles, each cycle is an array of file paths
   */
  findCircularDependencies(): string[][] {
    return this.graphManager.findCircularDependencies();
  }

  /**
   * Find dead code (unreferenced symbols)
   *
   * @param kinds - Node kinds to check (default: functions, methods, classes)
   * @returns Array of unreferenced nodes
   */
  findDeadCode(kinds?: Node['kind'][]): Node[] {
    return this.graphManager.findDeadCode(kinds);
  }

  /**
   * Get complexity metrics for a node
   *
   * @param nodeId - ID of the node
   * @returns Object containing various complexity metrics
   */
  getNodeMetrics(nodeId: string): {
    incomingEdgeCount: number;
    outgoingEdgeCount: number;
    callCount: number;
    callerCount: number;
    childCount: number;
    depth: number;
  } {
    return this.graphManager.getNodeMetrics(nodeId);
  }

  // ===========================================================================
  // Context Building
  // ===========================================================================

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    return this.contextBuilder.getCode(nodeId);
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal to find the most
   * relevant nodes and their relationships for a given query.
   *
   * @param query - Natural language query describing the task
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options?: FindRelevantContextOptions
  ): Promise<Subgraph> {
    return this.contextBuilder.findRelevantContext(query, options);
  }

  /**
   * Build context for a task
   *
   * Creates comprehensive context by:
   * 1. Running FTS search to find entry points
   * 2. Expanding the graph around entry points
   * 3. Extracting code blocks for key nodes
   * 4. Formatting output for Claude
   *
   * @param input - Task description (string or {title, description})
   * @param options - Build options (maxNodes, includeCode, format, etc.)
   * @returns TaskContext object or formatted string (markdown/JSON)
   */
  async buildContext(
    input: TaskInput,
    options?: BuildContextOptions
  ): Promise<TaskContext | string> {
    return this.contextBuilder.buildContext(input, options);
  }

  // ===========================================================================
  // Database Management
  // ===========================================================================

  /**
   * Optimize the database (vacuum and analyze)
   */
  optimize(): void {
    this.db.optimize();
  }

  /**
   * Clear all data from the graph
   */
  clear(): void {
    this.queries.clear();
  }

  /**
   * Alias for close() for backwards compatibility.
   * @deprecated Use close() instead
   */
  destroy(): void {
    this.close();
  }

  /**
   * Completely remove CodeGraph from the project.
   * This closes the database and deletes the .CodeGraph directory.
   *
   * WARNING: This permanently deletes all CodeGraph data for the project.
   */
  uninitialize(): void {
    this.close();
    removeDirectory(this.projectRoot);
  }
}

// Default export
export default CodeGraph;
