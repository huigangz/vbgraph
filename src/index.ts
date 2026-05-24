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
} from './types';
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
    const fallbackLanguages = [...coveredLanguages].filter(
      (lang) => lang !== 'unknown' && lang !== 'external' && isLanguageSupported(lang)
    );
    if (fallbackLanguages.length > 0) {
      await initGrammars();
      await loadGrammarsForLanguages(fallbackLanguages);
    }
    const extractFallback: EmptyDocumentFallback = (absFilePath, relativePath) => {
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
   * Get statistics about the knowledge graph
   */
  getStats(): GraphStats {
    const stats = this.queries.getStats();
    stats.dbSizeBytes = this.db.getSize();
    return stats;
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
