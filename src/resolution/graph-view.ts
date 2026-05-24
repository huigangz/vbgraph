/**
 * GraphView — read-only snapshot interface for Phase 3 framework resolvers.
 *
 * `GraphView` is a strict superset of `ResolutionContext` (`./types.ts`).
 * It exposes edge lookups (`getOutgoingEdges` / `getIncomingEdges`) and tag
 * lookups (`getNodesByTag`) — exactly the queries framework `synthesize` /
 * `augment` implementations need to walk the static graph and the inherent
 * tag set persisted in STAGE B.
 *
 * Snapshot timing (see Phase3Orchestrator):
 *   - `view1` is built AFTER STAGE 0 purge, BEFORE any `synthesize()` runs.
 *     Reflects the clean static layer (SCIP + tree-sitter + scope-resolved +
 *     heuristic) with zero framework rows.
 *   - `view2` is built AFTER STAGE B persistence (synthesized nodes +
 *     inherent tags), BEFORE any `augment()` runs. Reflects view1 plus
 *     every newly synthesized node AND every inherent tag.
 *
 * A view is a VALUE SNAPSHOT: it caches what it has read; subsequent DB
 * mutations are not reflected. Resolvers must not assume cross-call
 * mutation visibility within a single stage.
 *
 * Mutation discipline: resolvers MUST NOT mutate the arrays returned by
 * these methods. In dev mode (`process.env.CODEGRAPH_DEV === '1'`) the top
 * level of each returned array is frozen to catch accidental mutation;
 * production paths skip the freeze for the obvious perf reason.
 */

import { Edge, EdgeKind, Node, NodeKind } from '../types';
import { QueryBuilder } from '../db/queries';
import { CommentLang, stripCommentsForRegex } from './strip-comments';

export interface GraphView {
  // ── Node lookups ────────────────────────────────────────────────
  getNode(id: string): Node | null;
  hasNode(id: string): boolean;
  getNodesByKind(kind: NodeKind): readonly Node[];
  getNodesByQualifiedName(qn: string): readonly Node[];
  getNodesByName(name: string): readonly Node[];
  getNodesByLowerName(lower: string): readonly Node[];
  getNodesByFile(filePath: string): readonly Node[];
  getNodesByTag(tag: string): readonly Node[];
  /**
   * Generator over every node in the database. Memory-safe for huge graphs.
   * Resolvers SHOULD prefer kind / tag / file filtered queries; this is the
   * escape hatch for the rare "walk everything" case.
   */
  getAllNodes(): IterableIterator<Node>;

  // ── Edge lookups ────────────────────────────────────────────────
  getOutgoingEdges(nodeId: string, kinds?: readonly EdgeKind[]): readonly Edge[];
  getIncomingEdges(nodeId: string, kinds?: readonly EdgeKind[]): readonly Edge[];

  // ── File-system context ─────────────────────────────────────────
  getAllFiles(): readonly string[];
  fileExists(filePath: string): boolean;
  readFile(filePath: string): string | null;
  /**
   * Read the file and run the per-language comment / string-literal stripper
   * (`./strip-comments.ts`) before returning the content. Offsets are
   * preserved (stripper replaces with spaces, never deletes), so a regex
   * `match.index` over the stripped output maps to the same line/column as
   * over the original source. Returns `null` if the file cannot be read.
   */
  readFileStripped(filePath: string, language: CommentLang): string | null;
  getProjectRoot(): string;
}

/**
 * QueryGraphView — thin GraphView wrapper over a QueryBuilder.
 *
 * Per-instance caches: name / lowerName / qualifiedName / kind / file / tag.
 * Caches live on the view instance, NOT on the underlying QueryBuilder, so
 * constructing a fresh view (the STAGE C rebuild) gives clean cache state.
 * The view does NOT mutate QueryBuilder's caches; it reads through them.
 * STAGE 0 / STAGE B writes that need to be visible to a subsequent view
 * construction depend on `QueryBuilder.invalidatePhase3Caches()` — see
 * Phase3Orchestrator.
 *
 * All reads go through existing prepared statements. No new SQL indexes are
 * required at this stage.
 */
export class QueryGraphView implements GraphView {
  private readonly queries: QueryBuilder;
  private readonly projectRoot: string;
  private readonly fsExists: (path: string) => boolean;
  private readonly fsReadFile: (path: string) => string | null;
  private readonly devFreeze: boolean;

  private readonly nodeByIdCache = new Map<string, Node | null>();
  private readonly nodesByKindCache = new Map<string, readonly Node[]>();
  private readonly nodesByNameCache = new Map<string, readonly Node[]>();
  private readonly nodesByLowerNameCache = new Map<string, readonly Node[]>();
  private readonly nodesByQualifiedNameCache = new Map<string, readonly Node[]>();
  private readonly nodesByFileCache = new Map<string, readonly Node[]>();
  private readonly nodesByTagCache = new Map<string, readonly Node[]>();
  private readonly outgoingEdgesCache = new Map<string, readonly Edge[]>();
  private readonly incomingEdgesCache = new Map<string, readonly Edge[]>();
  private readonly fileContentCache = new Map<string, string | null>();
  private readonly strippedContentCache = new Map<string, string | null>();
  private allFilesCache: readonly string[] | null = null;

  constructor(
    queries: QueryBuilder,
    projectRoot: string,
    fs: {
      exists(path: string): boolean;
      readFile(path: string): string | null;
    },
  ) {
    this.queries = queries;
    this.projectRoot = projectRoot;
    this.fsExists = fs.exists;
    this.fsReadFile = fs.readFile;
    this.devFreeze = process.env.CODEGRAPH_DEV === '1';
  }

  private freeze<T>(arr: readonly T[]): readonly T[] {
    return this.devFreeze ? Object.freeze(arr.slice()) : arr;
  }

  // ── Node lookups ──────────────────────────────────────────────────────

  getNode(id: string): Node | null {
    if (this.nodeByIdCache.has(id)) return this.nodeByIdCache.get(id)!;
    const node = this.queries.getNodeById(id);
    this.nodeByIdCache.set(id, node);
    return node;
  }

  hasNode(id: string): boolean {
    return this.getNode(id) !== null;
  }

  getNodesByKind(kind: NodeKind): readonly Node[] {
    const hit = this.nodesByKindCache.get(kind);
    if (hit) return hit;
    const fresh = this.freeze(this.queries.getNodesByKind(kind));
    this.nodesByKindCache.set(kind, fresh);
    return fresh;
  }

  getNodesByQualifiedName(qn: string): readonly Node[] {
    const hit = this.nodesByQualifiedNameCache.get(qn);
    if (hit) return hit;
    const fresh = this.freeze(this.queries.getNodesByQualifiedNameExact(qn));
    this.nodesByQualifiedNameCache.set(qn, fresh);
    return fresh;
  }

  getNodesByName(name: string): readonly Node[] {
    const hit = this.nodesByNameCache.get(name);
    if (hit) return hit;
    const fresh = this.freeze(this.queries.getNodesByName(name));
    this.nodesByNameCache.set(name, fresh);
    return fresh;
  }

  getNodesByLowerName(lower: string): readonly Node[] {
    const hit = this.nodesByLowerNameCache.get(lower);
    if (hit) return hit;
    const fresh = this.freeze(this.queries.getNodesByLowerName(lower));
    this.nodesByLowerNameCache.set(lower, fresh);
    return fresh;
  }

  getNodesByFile(filePath: string): readonly Node[] {
    const hit = this.nodesByFileCache.get(filePath);
    if (hit) return hit;
    const fresh = this.freeze(this.queries.getNodesByFile(filePath));
    this.nodesByFileCache.set(filePath, fresh);
    return fresh;
  }

  getNodesByTag(tag: string): readonly Node[] {
    const hit = this.nodesByTagCache.get(tag);
    if (hit) return hit;
    const fresh = this.freeze(this.queries.getNodesByTag(tag));
    this.nodesByTagCache.set(tag, fresh);
    return fresh;
  }

  *getAllNodes(): IterableIterator<Node> {
    yield* this.queries.getAllNodes();
  }

  // ── Edge lookups ──────────────────────────────────────────────────────

  getOutgoingEdges(nodeId: string, kinds?: readonly EdgeKind[]): readonly Edge[] {
    const key = `${nodeId}\x00${kinds ? [...kinds].sort().join(',') : ''}`;
    const hit = this.outgoingEdgesCache.get(key);
    if (hit) return hit;
    const fresh = this.freeze(
      this.queries.getOutgoingEdges(nodeId, kinds ? [...kinds] : undefined),
    );
    this.outgoingEdgesCache.set(key, fresh);
    return fresh;
  }

  getIncomingEdges(nodeId: string, kinds?: readonly EdgeKind[]): readonly Edge[] {
    const key = `${nodeId}\x00${kinds ? [...kinds].sort().join(',') : ''}`;
    const hit = this.incomingEdgesCache.get(key);
    if (hit) return hit;
    const fresh = this.freeze(
      this.queries.getIncomingEdges(nodeId, kinds ? [...kinds] : undefined),
    );
    this.incomingEdgesCache.set(key, fresh);
    return fresh;
  }

  // ── File-system context ───────────────────────────────────────────────

  getAllFiles(): readonly string[] {
    if (this.allFilesCache) return this.allFilesCache;
    const fresh = this.freeze(this.queries.getAllFiles().map(f => f.path));
    this.allFilesCache = fresh;
    return fresh;
  }

  fileExists(filePath: string): boolean {
    return this.fsExists(filePath);
  }

  readFile(filePath: string): string | null {
    if (this.fileContentCache.has(filePath)) return this.fileContentCache.get(filePath)!;
    const content = this.fsReadFile(filePath);
    this.fileContentCache.set(filePath, content);
    return content;
  }

  readFileStripped(filePath: string, language: CommentLang): string | null {
    const key = `${filePath}\x00${language}`;
    if (this.strippedContentCache.has(key)) return this.strippedContentCache.get(key)!;
    const raw = this.readFile(filePath);
    const stripped = raw === null ? null : stripCommentsForRegex(raw, language);
    this.strippedContentCache.set(key, stripped);
    return stripped;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }
}
