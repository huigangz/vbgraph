/**
 * Phase 3 — framework synthesize / augment orchestration.
 *
 * Runs UNCONDITIONALLY after extraction completes. STAGE 0 purges stale
 * framework facts; STAGE A invokes `synthesize()` on every detected
 * resolver; STAGE B persists synthesized nodes + inherent tags; STAGE C
 * rebuilds the GraphView; STAGE D invokes `augment()` on every detected
 * resolver; STAGE E persists framework edges + derived tags.
 *
 * The whole flow runs INSIDE A SINGLE TRANSACTION opened via
 * `QueryBuilder.transaction(...)`. Per-resolver `synthesize` / `augment`
 * throws are caught and become one `warning`-severity `ExtractionError`
 * apiece; sibling resolvers complete normally. Per-write pre-flight
 * failures (bad node kind, malformed tag, edge with metadata, FK
 * violation) are caught at the write call site and DO NOT trigger
 * rollback — they're logged and skipped.
 *
 * See docs/plans/phase2/vbgraph-framework-synthesize-augment.md § P1.4.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  ExtractionError,
  Node,
  NODE_KINDS,
  validateEdgeLineColumn,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { logDebug } from '../errors';
import { detectFrameworks } from './frameworks';
import { QueryGraphView } from './graph-view';
import type {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from './types';

export interface Phase3Result {
  nodesAdded: number;
  edgesAdded: number;
  tagsAdded: number;
  errors: ExtractionError[];
  /** Frameworks that detected during the Phase 3 fresh re-detection pass. */
  detectedFrameworks: string[];
}

export type Phase3ProgressCb = (phase: string, current: number, total: number) => void;

/**
 * `<framework>:<role>` form OR cross-framework unprefixed `role` (e.g.
 * `route-handler`). Lowercase, kebab-case, length-bounded.
 */
const TAG_RE = /^[a-z0-9][a-z0-9-]*(?::[a-z0-9][a-z0-9-]*)*$/;
export function isValidTagFormat(tag: string): boolean {
  return tag.length > 0 && tag.length <= 64 && TAG_RE.test(tag);
}

const NODE_KIND_SET = new Set<string>(NODE_KINDS);

export class Phase3Orchestrator {
  private readonly queries: QueryBuilder;
  private readonly projectRoot: string;
  private readonly resolvers: FrameworkResolver[];
  private readonly fileCache = new Map<string, string | null>();

  constructor(projectRoot: string, queries: QueryBuilder) {
    this.queries = queries;
    this.projectRoot = projectRoot;
    // Detection runs AGAINST THE POST-EXTRACTION DB, not the constructor-time
    // ReferenceResolver context. ReferenceResolver.initialize() runs in the
    // VBGraph constructor before any file is indexed, so its detect set is
    // built against an empty `getAllFiles()`. Phase 3 must re-detect to catch
    // scan-based resolvers (e.g. java spring scans for @SpringBootApplication).
    const ctx = this.buildPostExtractionContext();
    this.resolvers = detectFrameworks(ctx);
  }

  /**
   * Run Phase 3. Returns a result counting what was added and any
   * diagnostics. The single SQLite transaction is opened internally.
   */
  async run(onProgress?: Phase3ProgressCb): Promise<Phase3Result> {
    // Sync inside; the async wrapper exists only to match indexAll/sync
    // callsites' Promise shape. There's no awaitable work.
    return this.queries.transaction(() => this.runSync(onProgress));
  }

  private runSync(onProgress?: Phase3ProgressCb): Phase3Result {
    const errors: ExtractionError[] = [];
    let edgesAdded = 0;
    let tagsAdded = 0;

    const detectedFrameworks = this.resolvers.map((r) => r.name);

    // ── STAGE 0 ────────────────────────────────────────────────────────
    // Purge stale framework facts BEFORE constructing view1 so synthesize
    // sees a clean static layer. Each helper is single-statement raw SQL.
    onProgress?.('phase3:purge', 0, 1);
    // 0.1 — strip framework contributions; demote primary to surviving
    // non-framework provenance OR delete framework-only edges. Critically
    // preserves merged edges where framework was primary (because it
    // outranks a heuristic / scip-empty-fallback contributor) but a
    // load-bearing static contributor must survive.
    this.queries.stripFrameworkContributionsFromEdges();
    this.queries.deleteAllFrameworkTags(); // 0.2
    // 0.3 — safety net for malformed rows (NULL/empty provenances[] with
    // framework primary). 0.1 handles the well-formed case.
    this.queries.deleteFrameworkPrimaryEdges();
    this.queries.deleteFrameworkNodes(); // 0.4
    this.queries.invalidatePhase3Caches();
    onProgress?.('phase3:purge', 1, 1);

    // ── view1 ──────────────────────────────────────────────────────────
    const view1 = this.makeView();

    // ── STAGE A — synthesize (sequential, sync, per-resolver isolation) ──
    const resultsA: Array<{ name: string; result: SynthesizeResult }> = [];
    const synthResolvers = this.resolvers.filter((r) => !!r.synthesize);
    synthResolvers.forEach((r, i) => {
      onProgress?.('phase3:synthesize', i, synthResolvers.length);
      try {
        const result = r.synthesize!(view1);
        resultsA.push({ name: r.name, result });
        if (result.errors) errors.push(...result.errors);
      } catch (e) {
        errors.push(this.toError(e, r.name, 'synthesize'));
        resultsA.push({ name: r.name, result: { nodes: [], tags: [] } });
      }
    });
    onProgress?.('phase3:synthesize', synthResolvers.length, synthResolvers.length);

    // ── STAGE B — persist synthesized nodes, then inherent tags ──
    const stagedNodes = new Map<string, Node>();
    for (const { name, result } of resultsA) {
      for (const node of result.nodes) {
        const reason = this.assertSynthesizedNode(node, name);
        if (reason) {
          errors.push({
            severity: 'warning',
            message: `framework:${name} node rejected: ${reason}`,
            code: 'phase3.synthesize.bad_node',
          });
          continue;
        }
        const existing = stagedNodes.get(node.id);
        if (existing && existing.provenance !== node.provenance) {
          errors.push({
            severity: 'warning',
            message: `framework:${name} node id collision on ${node.id} — first-occurrence wins`,
            code: 'phase3.synthesize.id_collision',
          });
          continue;
        }
        stagedNodes.set(node.id, node);
      }
    }
    // Single-row writes ONLY — never insertNodes (opens an inner transaction).
    for (const node of stagedNodes.values()) {
      try {
        this.queries.insertNode(node);
      } catch (e) {
        errors.push({
          severity: 'warning',
          message: `framework:${node.provenance} node insert failed for ${node.id}: ${this.errMsg(e)}`,
          code: 'phase3.synthesize.insert_failed',
        });
      }
    }
    this.queries.invalidatePhase3Caches();

    // Inherent tag pre-flight + insert.
    const synthNodeIds = new Set(stagedNodes.keys());
    for (const { name, result } of resultsA) {
      for (const { nodeId, tags } of result.tags ?? []) {
        if (!view1.hasNode(nodeId) && !synthNodeIds.has(nodeId)) {
          errors.push({
            severity: 'warning',
            message: `framework:${name} tag targets unknown nodeId ${nodeId} — dropped`,
            code: 'phase3.synthesize.bad_nodeid',
          });
          continue;
        }
        for (const tag of tags) {
          if (!isValidTagFormat(tag)) {
            errors.push({
              severity: 'warning',
              message: `framework:${name} tag "${tag}" is not kebab-case — dropped`,
              code: 'phase3.synthesize.bad_tag',
            });
            continue;
          }
          try {
            this.queries.insertNodeTag(nodeId, tag, `framework:${name}`);
            tagsAdded += 1;
          } catch (e) {
            errors.push({
              severity: 'warning',
              message: `framework:${name} tag insert failed: ${this.errMsg(e)}`,
              code: 'phase3.synthesize.tag_insert_failed',
            });
          }
        }
      }
    }

    // ── STAGE C — rebuild view inside the transaction ──
    const view2 = this.makeView();

    // ── STAGE D — augment ──
    const resultsD: Array<{ name: string; result: AugmentResult }> = [];
    const augmentResolvers = this.resolvers.filter((r) => !!r.augment);
    augmentResolvers.forEach((r, i) => {
      onProgress?.('phase3:augment', i, augmentResolvers.length);
      try {
        const result = r.augment!(view2);
        resultsD.push({ name: r.name, result });
        if (result.errors) errors.push(...result.errors);
      } catch (e) {
        errors.push(this.toError(e, r.name, 'augment'));
        resultsD.push({ name: r.name, result: { edges: [], tags: [] } });
      }
    });
    onProgress?.('phase3:augment', augmentResolvers.length, augmentResolvers.length);

    // ── STAGE E — persist edges + derived tags ──
    for (const { name, result } of resultsD) {
      for (const edge of result.edges) {
        if (edge.metadata !== undefined && Object.keys(edge.metadata).length > 0) {
          errors.push({
            severity: 'warning',
            message: `framework:${name} edge has metadata — rejected (metadata is owned by static extractors)`,
            code: 'phase3.augment.edge_metadata',
          });
          continue;
        }
        if (!edge.provenance || edge.provenance !== `framework:${name}`) {
          errors.push({
            severity: 'warning',
            message: `framework:${name} edge has wrong provenance ${edge.provenance ?? 'undefined'} — rejected`,
            code: 'phase3.augment.bad_provenance',
          });
          continue;
        }
        try {
          validateEdgeLineColumn(edge);
          this.queries.upsertGraphEdge(edge);
          edgesAdded += 1;
        } catch (e) {
          errors.push({
            severity: 'warning',
            message: `framework:${name} edge rejected: ${this.errMsg(e)}`,
            code: 'phase3.augment.edge_invalid',
          });
        }
      }
      for (const { nodeId, tags } of result.tags ?? []) {
        if (!view2.hasNode(nodeId)) {
          errors.push({
            severity: 'warning',
            message: `framework:${name} tag targets unknown nodeId ${nodeId} — dropped`,
            code: 'phase3.augment.bad_nodeid',
          });
          continue;
        }
        for (const tag of tags) {
          if (!isValidTagFormat(tag)) {
            errors.push({
              severity: 'warning',
              message: `framework:${name} tag "${tag}" is not kebab-case — dropped`,
              code: 'phase3.augment.bad_tag',
            });
            continue;
          }
          try {
            this.queries.insertNodeTag(nodeId, tag, `framework:${name}`);
            tagsAdded += 1;
          } catch (e) {
            errors.push({
              severity: 'warning',
              message: `framework:${name} tag insert failed: ${this.errMsg(e)}`,
              code: 'phase3.augment.tag_insert_failed',
            });
          }
        }
      }
    }

    return {
      nodesAdded: stagedNodes.size,
      edgesAdded,
      tagsAdded,
      errors,
      detectedFrameworks,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  private makeView(): QueryGraphView {
    return new QueryGraphView(this.queries, this.projectRoot, {
      exists: (p) => this.fsExists(p),
      readFile: (p) => this.fsRead(p),
    });
  }

  /**
   * Mirrors `ReferenceResolver.createContext` shape but is DB-backed
   * post-extraction (so detect()s that consult `getAllFiles` actually see
   * indexed files).
   */
  private buildPostExtractionContext(): ResolutionContext {
    return {
      getNodesInFile: (filePath) => this.queries.getNodesByFile(filePath),
      getNodesByName: (name) => this.queries.getNodesByName(name),
      getNodesByQualifiedName: (qn) => this.queries.getNodesByQualifiedNameExact(qn),
      getNodesByKind: (kind) => this.queries.getNodesByKind(kind),
      fileExists: (p) => this.fsExists(p),
      readFile: (p) => this.fsRead(p),
      getProjectRoot: () => this.projectRoot,
      getAllFiles: () => this.queries.getAllFilePaths(),
      getNodesByLowerName: (lower) => this.queries.getNodesByLowerName(lower),
      getImportMappings: () => [],
      listDirectories: (relativePath: string) => {
        const target =
          relativePath === '.' || relativePath === ''
            ? this.projectRoot
            : path.join(this.projectRoot, relativePath);
        try {
          return fs
            .readdirSync(target, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          return [];
        }
      },
    };
  }

  private fsExists(filePath: string): boolean {
    const full = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    try {
      return fs.existsSync(full);
    } catch {
      return false;
    }
  }

  private fsRead(filePath: string): string | null {
    if (this.fileCache.has(filePath)) return this.fileCache.get(filePath)!;
    const full = path.isAbsolute(filePath) ? filePath : path.join(this.projectRoot, filePath);
    try {
      const content = fs.readFileSync(full, 'utf-8');
      this.fileCache.set(filePath, content);
      return content;
    } catch (error) {
      logDebug('Phase3: failed to read file', { filePath, error: String(error) });
      this.fileCache.set(filePath, null);
      return null;
    }
  }

  /**
   * Returns a non-empty reason string if the node should be rejected;
   * empty string / null if the node passes. Enforces:
   *   - kind ∈ NODE_KINDS
   *   - provenance === `framework:<resolverName>`
   *   - id starts with `framework:<resolverName>:`
   */
  private assertSynthesizedNode(node: Node, resolverName: string): string | null {
    if (!NODE_KIND_SET.has(node.kind)) {
      return `unknown node kind "${node.kind}" (allowed: ${NODE_KINDS.join(', ')})`;
    }
    const expectedProv = `framework:${resolverName}`;
    if (node.provenance !== expectedProv) {
      return `provenance must equal "${expectedProv}" but is "${node.provenance ?? 'undefined'}"`;
    }
    const expectedPrefix = `framework:${resolverName}:`;
    if (!node.id.startsWith(expectedPrefix)) {
      return `id must start with "${expectedPrefix}" but is "${node.id}"`;
    }
    return null;
  }

  private toError(e: unknown, resolverName: string, hook: string): ExtractionError {
    return {
      severity: 'warning',
      message: `framework:${resolverName} ${hook} threw: ${this.errMsg(e)}`,
      code: `phase3.${hook}.throw`,
    };
  }

  private errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
}
