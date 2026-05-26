/**
 * SCIP persister — six-stage ingestion pipeline.
 *
 *   STAGE A  Validation pre-scan (no persistent writes; TEMP table in try/finally).
 *   STAGE B  Destructive setup: scoped delete of prior data, scip_ingestions row,
 *            TEMP tables.
 *   STAGE C  Stream external symbols into a TEMP table.
 *   STAGE D  Pass 1: build the symbol map AND insert all internal nodes — every
 *            internal edge target must exist before STAGE E inserts edges,
 *            because `edges` has a foreign key to `nodes` and the DB runs with
 *            `foreign_keys=ON`. (This is a deliberate deviation from the plan's
 *            "Pass 1 = symbol_map only" — see worklog P0.4.)
 *   STAGE E  Pass 2: insert edges (contains / calls / references / imports /
 *            extends / implements), external nodes, files rows, scip_documents.
 *   STAGE F  Completion: mark scip_ingestions complete; drop TEMP tables.
 *
 * Any failure after STAGE A leaves `scip_ingestions.completed_at` NULL, so the
 * next `open()` (P0.4b) garbage-collects the partial graph.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

import type { SqliteDatabase } from '../../db/sqlite-adapter';
import { QueryBuilder } from '../../db/queries';
import { EXTENSION_MAP } from '../grammars';
import {
  type Edge,
  type Language,
  type Node,
  type NodeKind,
  type UnresolvedReference,
  validateEdgeLineColumn,
} from '../../types';
import {
  iterateScipDocuments,
  iterateScipExternalSymbols,
  type ScipDocument,
  type ScipOccurrence,
  type ScipSymbolInformation,
} from './streaming-decoder';
import {
  hashScipSymbol,
  nodeKindForScipSymbol,
  parseScipSymbol,
  type ParsedScipSymbol,
} from './symbol-parser';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A source file is already covered by a different `.scip` index. */
export class MultiIndexConflictError extends Error {
  constructor(
    readonly sourceFilePath: string,
    readonly existingIndex: string,
    readonly incomingIndex: string,
  ) {
    super(
      `SCIP coverage conflict: "${sourceFilePath}" is already covered by ` +
        `"${existingIndex}"; cannot also ingest it from "${incomingIndex}".`,
    );
    this.name = 'MultiIndexConflictError';
  }
}

/** The same `.scip` index lists the same `Document.relativePath` twice. */
export class SameIndexDuplicateDocumentError extends Error {
  constructor(
    readonly sourceFilePath: string,
    readonly scipIndexPath: string,
  ) {
    super(
      `SCIP index "${scipIndexPath}" contains duplicate Document "${sourceFilePath}".`,
    );
    this.name = 'SameIndexDuplicateDocumentError';
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Optional tree-sitter fallback for SCIP documents with zero occurrences.
 *
 * Returns the full tree-sitter extraction — `unresolvedReferences` included —
 * so an empty-document fallback file is indexed identically to a normal
 * tree-sitter file: its file-local calls / imports / type refs still flow
 * through the resolver pass rather than being silently dropped.
 */
export type EmptyDocumentFallback = (
  absFilePath: string,
  relativePath: string,
) => {
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences?: UnresolvedReference[];
} | null;

export interface ScipPersistOptions {
  /** Path to the `.scip` file (also the `scip_index_path` ownership key). */
  scipPath: string;
  /** Project root that `Document.relativePath` values are relative to. */
  projectRoot: string;
  db: SqliteDatabase;
  qb: QueryBuilder;
  /** Empty-document fallback threshold; defaults to 200 bytes. */
  emptyFallbackThresholdBytes?: number;
  /** Tree-sitter fallback for empty documents; omitted -> empty docs skipped. */
  extractFallback?: EmptyDocumentFallback;
}

export interface IngestStats {
  scipPath: string;
  documentCount: number;
  nodeCount: number;
  edgeCount: number;
  externalNodeCount: number;
  emptyFallbackCount: number;
  unresolvedCount: number;
}

// ---------------------------------------------------------------------------
// SCIP wire constants / small helpers
// ---------------------------------------------------------------------------

/** `SymbolRole` bitset values (scip.proto). */
const ROLE_DEFINITION = 0x1;
const ROLE_IMPORT = 0x2;

const DOC_BATCH_SIZE = 50;
const EXTERNAL_BATCH_SIZE = 1000;

interface Position {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** SCIP ranges are 0-indexed `[sl, sc, el, ec]` or single-line `[sl, sc, ec]`. */
function scipRangeToPosition(range: number[]): Position {
  const sl = range[0] ?? 0;
  const sc = range[1] ?? 0;
  if (range.length >= 4) {
    return {
      startLine: sl + 1,
      startColumn: sc,
      endLine: (range[2] ?? sl) + 1,
      endColumn: range[3] ?? sc,
    };
  }
  return {
    startLine: sl + 1,
    startColumn: sc,
    endLine: sl + 1,
    endColumn: range[2] ?? sc,
  };
}

/** True when range `outer` strictly encloses range `inner` (and they differ). */
function strictlyEncloses(outer: Position, inner: Position): boolean {
  const startsBefore =
    outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startColumn <= inner.startColumn);
  const endsAfter =
    outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endColumn >= inner.endColumn);
  const identical =
    outer.startLine === inner.startLine &&
    outer.startColumn === inner.startColumn &&
    outer.endLine === inner.endLine &&
    outer.endColumn === inner.endColumn;
  return startsBefore && endsAfter && !identical;
}

/** Area of a range in (line, column) units — used to pick the innermost parent. */
function rangeSpan(p: Position): number {
  return (p.endLine - p.startLine) * 100000 + (p.endColumn - p.startColumn);
}

function languageForPath(relativePath: string): Language {
  return EXTENSION_MAP[path.extname(relativePath).toLowerCase()] ?? 'unknown';
}

function occurrenceIsDefinition(occ: ScipOccurrence): boolean {
  return ((occ.symbolRoles ?? 0) & ROLE_DEFINITION) !== 0;
}

function occurrenceIsImport(occ: ScipOccurrence): boolean {
  return ((occ.symbolRoles ?? 0) & ROLE_IMPORT) !== 0;
}

function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

/** Node id for a SCIP symbol — local symbols are salted with the doc path. */
function nodeIdForSymbol(symbol: string, relativePath: string): string {
  return isLocalSymbol(symbol)
    ? hashScipSymbol(`local ${relativePath} ${symbol}`)
    : hashScipSymbol(symbol);
}

/** Synthetic file node id for a SCIP document. */
function fileNodeId(relativePath: string): string {
  return hashScipSymbol(`<file> ${relativePath}`);
}

interface SourceMeta {
  exists: boolean;
  size: number;
  mtime: number;
  hash: string;
}

function readSourceMeta(absPath: string): SourceMeta {
  try {
    const stat = fs.statSync(absPath);
    const content = fs.readFileSync(absPath);
    return {
      exists: true,
      size: stat.size,
      mtime: stat.mtimeMs,
      hash: crypto.createHash('sha256').update(content).digest('hex'),
    };
  } catch {
    return { exists: false, size: 0, mtime: 0, hash: '' };
  }
}

/** Build a `Node` for an external SCIP symbol (defined outside the index). */
export function externalSymbolToNode(sym: ScipSymbolInformation): Node | null {
  let parsed;
  try {
    parsed = parseScipSymbol(sym.symbol);
  } catch {
    return null; // malformed external symbol — skip it
  }
  const lastDescriptor = parsed.descriptors[parsed.descriptors.length - 1];
  const doc =
    sym.documentation && sym.documentation.length > 0
      ? sym.documentation.join('\n')
      : undefined;
  return {
    id: hashScipSymbol(sym.symbol), // global — never per-index salted
    kind: nodeKindForScipSymbol(parsed, sym.kind),
    name: sym.displayName || lastDescriptor?.name || sym.symbol,
    qualifiedName: parsed.qualifiedName,
    filePath: `<external:${parsed.scheme}/${parsed.package.name || '.'}>`,
    language: 'external',
    startLine: 0,
    endLine: 0,
    startColumn: 0,
    endColumn: 0,
    docstring: doc,
    provenance: 'scip:external',
    scipSymbol: sym.symbol,
    updatedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Per-document node derivation (shared by Pass 1 and Pass 2 — deterministic)
// ---------------------------------------------------------------------------

interface DocDefinition {
  symbol: string;
  nodeId: string;
  node: Node;
  position: Position;
  /** Parsed SCIP symbol — drives descriptor-path containment derivation. */
  parsed: ParsedScipSymbol;
}

interface DocNodes {
  fileNode: Node;
  definitions: DocDefinition[];
}

/**
 * Derive the file node and every definition node for a document. Pure and
 * deterministic, so Pass 1 (which inserts) and Pass 2 (which rebuilds the same
 * ids/positions to attach edges) agree without carrying state between passes.
 */
function deriveDocNodes(doc: ScipDocument, scipPath: string): DocNodes {
  const relativePath = doc.relativePath;
  const language = languageForPath(relativePath);
  const now = Date.now();

  const fileNode: Node = {
    id: fileNodeId(relativePath),
    kind: 'file',
    name: path.basename(relativePath),
    qualifiedName: relativePath,
    filePath: relativePath,
    language,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    provenance: 'scip',
    scipIndexPath: scipPath,
    updatedAt: now,
  };

  const symbolInfoByString = new Map<string, ScipSymbolInformation>();
  for (const info of doc.symbols ?? []) {
    symbolInfoByString.set(info.symbol, info);
  }

  const definitions: DocDefinition[] = [];
  const seen = new Set<string>();
  for (const occ of doc.occurrences ?? []) {
    if (!occurrenceIsDefinition(occ) || !occ.symbol) {
      continue;
    }
    if (seen.has(occ.symbol)) {
      continue; // a symbol is defined once per document
    }
    seen.add(occ.symbol);

    let parsed;
    try {
      parsed = parseScipSymbol(occ.symbol);
    } catch {
      continue; // malformed symbol — skip this definition
    }
    const info = symbolInfoByString.get(occ.symbol);
    const lastDescriptor = parsed.descriptors[parsed.descriptors.length - 1];
    const position = scipRangeToPosition(occ.range ?? []);
    const docString =
      info?.documentation && info.documentation.length > 0
        ? info.documentation.join('\n')
        : undefined;
    const node: Node = {
      id: nodeIdForSymbol(occ.symbol, relativePath),
      kind: nodeKindForScipSymbol(parsed, info?.kind),
      name: info?.displayName || lastDescriptor?.name || occ.symbol,
      qualifiedName: parsed.qualifiedName,
      filePath: relativePath,
      language,
      startLine: position.startLine,
      endLine: position.endLine,
      startColumn: position.startColumn,
      endColumn: position.endColumn,
      docstring: docString,
      provenance: 'scip',
      scipSymbol: occ.symbol,
      scipIndexPath: scipPath,
      updatedAt: now,
    };
    definitions.push({ symbol: occ.symbol, nodeId: node.id, node, position, parsed });
  }

  return { fileNode, definitions };
}

/** Innermost definition strictly enclosing `position`, or null. */
function enclosingDefinition(
  position: Position,
  definitions: DocDefinition[],
): DocDefinition | null {
  let best: DocDefinition | null = null;
  for (const def of definitions) {
    if (strictlyEncloses(def.position, position)) {
      if (best === null || rangeSpan(def.position) < rangeSpan(best.position)) {
        best = def;
      }
    }
  }
  return best;
}

/**
 * Node kinds that can lexically enclose a reference occurrence. Used by the
 * nearest-preceding-container fallback.
 */
const SCOPE_NODE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum',
  'module', 'namespace', 'function', 'method', 'constructor', 'property',
]);

/**
 * Stable key for a SCIP symbol's descriptor path truncated to `depth`
 * descriptors. Two symbols share a key iff they denote the same structural
 * path (scheme + package + descriptor prefix) — exactly the containment
 * relation SCIP encodes directly in the symbol string.
 */
function descriptorPathKey(parsed: ParsedScipSymbol, depth: number): string {
  const path = parsed.descriptors
    .slice(0, depth)
    .map((d) => `${d.suffix} ${d.name} ${d.disambiguator ?? ''}`);
  return JSON.stringify([
    parsed.scheme,
    parsed.package.manager,
    parsed.package.name,
    parsed.package.version,
    path,
  ]);
}

/**
 * Structural parent of a definition, derived from its SCIP symbol descriptor
 * path: `A#foo().` is contained by `A#`, `A#foo().(p)` by `A#foo().`. Unlike
 * positional enclosure this needs no source ranges, so it works for indexers
 * (scip-dotnet) that emit name-token-only definition ranges. Returns the
 * enclosing definition present in `byFullPath`, else null.
 */
function structuralParent(
  def: DocDefinition,
  byFullPath: Map<string, DocDefinition>,
): DocDefinition | null {
  const { parsed } = def;
  if (parsed.isLocal || parsed.descriptors.length < 2) {
    return null;
  }
  const parent = byFullPath.get(
    descriptorPathKey(parsed, parsed.descriptors.length - 1),
  );
  return parent && parent !== def ? parent : null;
}

/**
 * Nearest scope definition whose name precedes `position` — the fallback that
 * attributes a reference to its enclosing method/type when definition ranges
 * are name-only and positional enclosure finds nothing. `sortedContainers`
 * must be ascending by start position.
 */
function nearestPrecedingContainer(
  position: Position,
  sortedContainers: DocDefinition[],
): DocDefinition | null {
  let best: DocDefinition | null = null;
  for (const container of sortedContainers) {
    const c = container.position;
    const precedes =
      c.startLine < position.startLine ||
      (c.startLine === position.startLine && c.startColumn <= position.startColumn);
    if (precedes) {
      best = container;
    } else {
      break;
    }
  }
  return best;
}

/**
 * Edge kind for an `isImplementation` SCIP relationship. A method/property
 * implementing or overriding another member is an `overrides` edge; a type
 * extending an interface-like base is `implements`; extending a class is
 * `extends`.
 */
function relationshipEdgeKind(
  sourceKind: string | undefined,
  targetKind: string | undefined,
): Edge['kind'] {
  if (
    sourceKind === 'method' ||
    sourceKind === 'function' ||
    sourceKind === 'property'
  ) {
    return 'overrides';
  }
  if (
    targetKind === 'interface' ||
    targetKind === 'protocol' ||
    targetKind === 'trait'
  ) {
    return 'implements';
  }
  return 'extends';
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Ingest one `.scip` index into the database. See the module header for the
 * stage breakdown. Returns ingestion statistics.
 */
export async function persistScipIndex(
  opts: ScipPersistOptions,
): Promise<IngestStats> {
  const scipPath = path.resolve(opts.scipPath);
  const { db, qb, projectRoot } = opts;
  const emptyThreshold = opts.emptyFallbackThresholdBytes ?? 200;

  const stats: IngestStats = {
    scipPath,
    documentCount: 0,
    nodeCount: 0,
    edgeCount: 0,
    externalNodeCount: 0,
    emptyFallbackCount: 0,
    unresolvedCount: 0,
  };

  // ---- STAGE A: validation pre-scan (no persistent writes) ----------------
  // Duplicate-document detection uses an in-process Set rather than a TEMP
  // table: the WASM SQLite backend will not DROP a TEMP table while prepared
  // statements reference it, and STAGE A must leave zero persistent residue.
  {
    const conflictStmt = db.prepare(
      `SELECT scip_index_path FROM scip_documents
       WHERE source_file_path = ? AND scip_index_path != ? LIMIT 1`,
    );
    const seen = new Set<string>();
    for await (const doc of iterateScipDocuments(opts.scipPath)) {
      const conflict = conflictStmt.get(doc.relativePath, scipPath) as
        | { scip_index_path: string }
        | undefined;
      if (conflict) {
        throw new MultiIndexConflictError(
          doc.relativePath,
          conflict.scip_index_path,
          scipPath,
        );
      }
      if (seen.has(doc.relativePath)) {
        throw new SameIndexDuplicateDocumentError(doc.relativePath, scipPath);
      }
      seen.add(doc.relativePath);
    }
  }

  // ---- STAGE B: destructive setup (single transaction) --------------------
  db.transaction(() => {
    qb.deleteScipIndexData(scipPath); // subsumes crash-recovery + re-ingest cleanup
    db.prepare(
      `INSERT INTO scip_ingestions (scip_index_path, started_at, completed_at, intended_files)
       VALUES (?, ?, NULL, NULL)
       ON CONFLICT(scip_index_path) DO UPDATE SET
         started_at = excluded.started_at,
         completed_at = NULL,
         intended_files = excluded.intended_files`,
    ).run(scipPath, Date.now());
    db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS scip_symbol_map (
        scip_symbol TEXT PRIMARY KEY, node_id TEXT NOT NULL
      );
      CREATE TEMP TABLE IF NOT EXISTS scip_external_symbols (
        scip_symbol TEXT PRIMARY KEY, info_blob TEXT NOT NULL
      );
      DELETE FROM scip_symbol_map;
      DELETE FROM scip_external_symbols;
    `);
  })();

  try {
    // ---- STAGE C: stream external symbols into the TEMP table -------------
    {
      const insertExternal = db.prepare(
        `INSERT OR IGNORE INTO scip_external_symbols (scip_symbol, info_blob) VALUES (?, ?)`,
      );
      let batch: ScipSymbolInformation[] = [];
      const flush = (): void => {
        if (batch.length === 0) return;
        const rows = batch;
        batch = [];
        db.transaction(() => {
          for (const sym of rows) {
            if (sym.symbol) {
              insertExternal.run(sym.symbol, JSON.stringify(sym));
            }
          }
        })();
      };
      for await (const sym of iterateScipExternalSymbols(opts.scipPath)) {
        batch.push(sym);
        if (batch.length >= EXTERNAL_BATCH_SIZE) flush();
      }
      flush();
    }

    // ---- STAGE D: Pass 1 — symbol map + internal nodes --------------------
    {
      const mapStmt = db.prepare(
        `INSERT OR IGNORE INTO scip_symbol_map (scip_symbol, node_id) VALUES (?, ?)`,
      );
      let batch: ScipDocument[] = [];
      const flush = (): void => {
        if (batch.length === 0) return;
        const docs = batch;
        batch = [];
        db.transaction(() => {
          for (const doc of docs) {
            stats.documentCount++;
            // Supersede prior tree-sitter rows for this now-SCIP-covered file.
            supersedeTreeSitter(db, doc.relativePath);
            const { fileNode, definitions } = deriveDocNodes(doc, scipPath);
            qb.insertScipNode(fileNode);
            stats.nodeCount++;
            for (const def of definitions) {
              qb.insertScipNode(def.node);
              stats.nodeCount++;
              if (!isLocalSymbol(def.symbol)) {
                mapStmt.run(def.symbol, def.nodeId);
              }
            }
          }
        })();
      };
      for await (const doc of iterateScipDocuments(opts.scipPath)) {
        batch.push(doc);
        if (batch.length >= DOC_BATCH_SIZE) flush();
      }
      flush();
    }

    // ---- STAGE E: Pass 2 — edges, external nodes, files, scip_documents ---
    {
      const lookupSymbol = db.prepare(
        `SELECT node_id FROM scip_symbol_map WHERE scip_symbol = ?`,
      );
      const lookupExternal = db.prepare(
        `SELECT info_blob FROM scip_external_symbols WHERE scip_symbol = ?`,
      );
      const lookupKind = db.prepare(`SELECT kind FROM nodes WHERE id = ?`);
      const insertScipDocument = db.prepare(
        `INSERT OR REPLACE INTO scip_documents
           (source_file_path, scip_index_path, source_hash, ingested_at)
         VALUES (?, ?, ?, ?)`,
      );
      const externalNodeIds = new Set<string>();

      let batch: ScipDocument[] = [];
      const flush = (): void => {
        if (batch.length === 0) return;
        const docs = batch;
        batch = [];
        db.transaction(() => {
          for (const doc of docs) {
            const meta = readSourceMeta(path.join(projectRoot, doc.relativePath));
            persistDocEdges(doc, scipPath, {
              db, qb, lookupSymbol, lookupExternal, lookupKind,
              externalNodeIds, stats,
            });

            const occurrenceCount = (doc.occurrences ?? []).length;
            if (occurrenceCount === 0) {
              maybeEmptyFallback(
                doc, meta, emptyThreshold, opts.extractFallback, projectRoot, qb, stats,
              );
            }

            qb.upsertFile({
              path: doc.relativePath,
              contentHash: meta.hash,
              language: languageForPath(doc.relativePath),
              size: meta.size,
              modifiedAt: meta.mtime,
              indexedAt: Date.now(),
              nodeCount: 1 + deriveDocNodes(doc, scipPath).definitions.length,
            });
            insertScipDocument.run(
              doc.relativePath, scipPath, meta.hash, Date.now(),
            );
          }
        })();
      };
      for await (const doc of iterateScipDocuments(opts.scipPath)) {
        batch.push(doc);
        if (batch.length >= DOC_BATCH_SIZE) flush();
      }
      flush();
      stats.externalNodeCount = externalNodeIds.size;
    }

    // ---- STAGE F: completion ----------------------------------------------
    db.transaction(() => {
      db.prepare(
        `UPDATE scip_ingestions SET completed_at = ? WHERE scip_index_path = ?`,
      ).run(Date.now(), scipPath);
    })();
  } finally {
    // Empty (not DROP) the symbol-map TEMP tables: this frees their rows
    // immediately while leaving the schema intact, so the prepared statements
    // that reference them stay valid and the WASM backend does not report
    // "table is locked". The tables themselves vanish when the connection
    // closes, and STAGE B re-clears them on the next ingest.
    db.exec(`
      DELETE FROM scip_symbol_map;
      DELETE FROM scip_external_symbols;
    `);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// STAGE E helpers
// ---------------------------------------------------------------------------

interface EdgeContext {
  db: SqliteDatabase;
  qb: QueryBuilder;
  lookupSymbol: { get(symbol: string): unknown };
  lookupExternal: { get(symbol: string): unknown };
  lookupKind: { get(id: string): unknown };
  externalNodeIds: Set<string>;
  stats: IngestStats;
}

/** Emit one edge through the upsert path, guarded by the strict invariant. */
function emitEdge(ctx: EdgeContext, edge: Edge): void {
  try {
    validateEdgeLineColumn(edge);
  } catch (err) {
    console.warn(`[codegraph] skipping malformed SCIP edge: ${(err as Error).message}`);
    return;
  }
  ctx.qb.upsertGraphEdge(edge);
  ctx.stats.edgeCount++;
}

/** Resolve a referenced symbol to a node id, creating external nodes as needed. */
function resolveTarget(
  ctx: EdgeContext,
  symbol: string,
  scipPath: string,
  localDefs: Map<string, string>,
): string | null {
  if (isLocalSymbol(symbol)) {
    return localDefs.get(symbol) ?? null;
  }
  const internal = ctx.lookupSymbol.get(symbol) as { node_id: string } | undefined;
  if (internal) {
    return internal.node_id;
  }
  const external = ctx.lookupExternal.get(symbol) as { info_blob: string } | undefined;
  if (external) {
    const sym = JSON.parse(external.info_blob) as ScipSymbolInformation;
    const node = externalSymbolToNode(sym);
    if (!node) return null;
    ctx.qb.upsertExternalScipNode(node, scipPath);
    ctx.externalNodeIds.add(node.id);
    return node.id;
  }
  ctx.stats.unresolvedCount++;
  return null;
}

/** Build and persist every edge for one document. */
function persistDocEdges(
  doc: ScipDocument,
  scipPath: string,
  ctx: EdgeContext,
): void {
  const relativePath = doc.relativePath;
  const { fileNode, definitions } = deriveDocNodes(doc, scipPath);

  // Per-document local-symbol resolution table.
  const localDefs = new Map<string, string>();
  for (const def of definitions) {
    if (isLocalSymbol(def.symbol)) {
      localDefs.set(def.symbol, def.nodeId);
    }
  }

  // Containment & enclosure indexes for this document.
  //  - byFullPath maps a definition's full descriptor path to itself, so a
  //    child's parent is one map lookup (its path minus the last descriptor).
  //  - scopeContainers is the source-ordered list of scope-bearing definitions
  //    used to attribute a reference to its enclosing method/type when the
  //    indexer emits name-only ranges (positional enclosure finds nothing).
  const byFullPath = new Map<string, DocDefinition>();
  for (const def of definitions) {
    if (!def.parsed.isLocal) {
      byFullPath.set(
        descriptorPathKey(def.parsed, def.parsed.descriptors.length),
        def,
      );
    }
  }
  const scopeContainers = definitions
    .filter((d) => SCOPE_NODE_KINDS.has(d.node.kind))
    .sort(
      (a, b) =>
        a.position.startLine - b.position.startLine ||
        a.position.startColumn - b.position.startColumn,
    );

  // contains: each definition under its structural parent. Descriptor-path
  // nesting is exact and range-independent; positional enclosure is the
  // fallback for indexers that do emit body-spanning definition ranges.
  for (const def of definitions) {
    const parent =
      structuralParent(def, byFullPath) ??
      enclosingDefinition(def.position, definitions);
    emitEdge(ctx, {
      source: parent ? parent.nodeId : fileNode.id,
      target: def.nodeId,
      kind: 'contains',
      provenance: 'scip',
    });
  }

  // calls / references / imports: one edge per non-definition occurrence.
  for (const occ of doc.occurrences ?? []) {
    if (occurrenceIsDefinition(occ) || !occ.symbol) {
      continue;
    }
    const target = resolveTarget(ctx, occ.symbol, scipPath, localDefs);
    if (!target) {
      continue;
    }
    const position = scipRangeToPosition(occ.range ?? []);
    const enclosing =
      enclosingDefinition(position, definitions) ??
      nearestPrecedingContainer(position, scopeContainers);
    const source = enclosing ? enclosing.nodeId : fileNode.id;
    if (source === target) {
      continue; // a definition's own name occurrence — not a relationship
    }

    if (occurrenceIsImport(occ)) {
      emitEdge(ctx, { source, target, kind: 'imports', provenance: 'scip' });
      continue;
    }
    const kind = referenceEdgeKind(occ.symbol);
    emitEdge(ctx, {
      source,
      target,
      kind,
      line: position.startLine,
      column: position.startColumn,
      provenance: 'scip',
    });
  }

  // extends / implements / overrides: from SymbolInformation.relationships.
  // SCIP's `isImplementation` covers both type inheritance and member
  // override; the edge kind is decided from the source/target node kinds.
  for (const info of doc.symbols ?? []) {
    const sourceId = idForDocSymbol(info.symbol, relativePath, definitions);
    if (!sourceId) {
      continue;
    }
    for (const rel of info.relationships ?? []) {
      if (!rel.isImplementation || !rel.symbol) {
        continue;
      }
      const target = resolveTarget(ctx, rel.symbol, scipPath, localDefs);
      if (!target || target === sourceId) {
        continue;
      }
      const sourceKindRow = ctx.lookupKind.get(sourceId) as { kind: string } | undefined;
      const targetKindRow = ctx.lookupKind.get(target) as { kind: string } | undefined;
      const kind = relationshipEdgeKind(sourceKindRow?.kind, targetKindRow?.kind);
      emitEdge(ctx, { source: sourceId, target, kind, provenance: 'scip' });
    }
  }
}

/** Edge kind for a non-import reference, decided from the target's descriptor. */
function referenceEdgeKind(symbol: string): Edge['kind'] {
  if (isLocalSymbol(symbol)) {
    return 'references';
  }
  try {
    const parsed = parseScipSymbol(symbol);
    const last = parsed.descriptors[parsed.descriptors.length - 1];
    if (last && (last.suffix === 'method' || last.suffix === 'macro')) {
      return 'calls';
    }
  } catch {
    /* fall through */
  }
  return 'references';
}

/** Node id of a symbol defined in this document, or null. */
function idForDocSymbol(
  symbol: string,
  relativePath: string,
  definitions: DocDefinition[],
): string | null {
  for (const def of definitions) {
    if (def.symbol === symbol) {
      return def.nodeId;
    }
  }
  // Not a definition occurrence but still a doc-scoped symbol — derive its id.
  return symbol ? nodeIdForSymbol(symbol, relativePath) : null;
}

/** Tree-sitter the file when SCIP produced an empty document for a real file. */
function maybeEmptyFallback(
  doc: ScipDocument,
  meta: SourceMeta,
  thresholdBytes: number,
  fallback: EmptyDocumentFallback | undefined,
  projectRoot: string,
  qb: QueryBuilder,
  stats: IngestStats,
): void {
  if (!fallback || !meta.exists || meta.size <= thresholdBytes) {
    return;
  }
  // The fallback receives the resolved absolute path (to read the file) and
  // the repo-relative path (so the extracted node `filePath`s stay relative).
  const absPath = path.join(projectRoot, doc.relativePath);
  const extracted = fallback(absPath, doc.relativePath);
  if (!extracted) {
    return;
  }
  for (const node of extracted.nodes) {
    qb.insertScipNode({ ...node, provenance: 'tree-sitter (scip-empty-fallback)' });
  }
  for (const edge of extracted.edges) {
    qb.upsertGraphEdge({ ...edge, provenance: 'tree-sitter (scip-empty-fallback)' });
  }
  // Persist unresolved refs so file-local calls / imports / type refs reach
  // the resolver pass — without this an empty-fallback file would keep only
  // symbols + containment, unlike a normal tree-sitter file. Refs are
  // enriched with the document's path + language exactly the way
  // `ExtractionOrchestrator.storeExtractionResult` enriches normal
  // tree-sitter refs: extraction omits those fields, and an un-enriched ref
  // persists with language `'unknown'`, which the resolver does NOT backfill
  // (it fills only a falsy value) — silently disabling language-sensitive
  // resolution. Single-row inserts (not the batched helper) avoid a nested
  // transaction inside the STAGE E transaction this runs within.
  const fallbackLanguage = languageForPath(doc.relativePath);
  for (const ref of extracted.unresolvedReferences ?? []) {
    qb.insertUnresolvedRef({
      ...ref,
      filePath: ref.filePath ?? doc.relativePath,
      language: ref.language ?? fallbackLanguage,
    });
  }
  stats.emptyFallbackCount++;
}

/**
 * Delete prior tree-sitter rows for a file now SCIP-covered.
 *
 * P2.3.1: predicate widened from exact `provenance = 'tree-sitter'` to
 * `provenance LIKE 'tree-sitter%'` so the same per-doc sweep also clears
 * any previously-created `'tree-sitter (scip-empty-fallback)'` rows from
 * an earlier ingest generation. STAGE E re-creates fresh fallback rows
 * AFTER this function runs (at line 914 via `maybeEmptyFallback`), so
 * empty SCIP documents still get their fallback — just freshly minted.
 *
 * The broader predicate is also what P2.2's `deleteFileTreeSitterRows`
 * uses for sync-side shadow cleanup; the two paths now have consistent
 * semantics for "what counts as a tree-sitter row for this file".
 */
function supersedeTreeSitter(db: SqliteDatabase, relativePath: string): void {
  const treeSitterIds = `SELECT id FROM nodes WHERE file_path = @p AND provenance LIKE 'tree-sitter%'`;
  db.prepare(
    `DELETE FROM edges WHERE source IN (${treeSitterIds}) OR target IN (${treeSitterIds})`,
  ).run({ p: relativePath });
  db.prepare(
    `DELETE FROM nodes WHERE file_path = @p AND provenance LIKE 'tree-sitter%'`,
  ).run({ p: relativePath });
}
