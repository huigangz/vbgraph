/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */

import { SqliteDatabase, SqliteStatement } from './sqlite-adapter';
import {
  Node,
  Edge,
  FileRecord,
  UnresolvedReference,
  NodeKind,
  EdgeKind,
  Language,
  GraphProvenance,
  GraphStats,
  SearchOptions,
  SearchResult,
  pickPrimaryProvenance,
  defaultConfidence,
  coerceEdgePosition,
} from '../types';
import { safeJsonParse } from '../utils';
import { kindBonus, nameMatchBonus, scorePathRelevance } from '../search/query-utils';
import { parseQuery, boundedEditDistance } from '../search/query-parser';

/**
 * Database row types (snake_case from SQLite)
 */
interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  provenance: string | null;
  scip_symbol: string | null;
  scip_index_path: string | null;
  updated_at: number;
}

interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
  provenances: string | null;
  confidence: number | null;
  subkind: string | null;
}

interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
}

interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
}

/**
 * Convert database row to Node object
 */
function rowToNode(row: NodeRow): Node {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: row.visibility as Node['visibility'],
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: row.decorators ? safeJsonParse(row.decorators, undefined) : undefined,
    typeParameters: row.type_parameters ? safeJsonParse(row.type_parameters, undefined) : undefined,
    provenance: row.provenance ? (row.provenance as GraphProvenance) : undefined,
    scipSymbol: row.scip_symbol ?? undefined,
    scipIndexPath: row.scip_index_path ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert database row to Edge object
 */
function rowToEdge(row: EdgeRow): Edge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: row.metadata ? safeJsonParse(row.metadata, undefined) : undefined,
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: row.provenance ? (row.provenance as GraphProvenance) : undefined,
    provenances: row.provenances
      ? safeJsonParse<GraphProvenance[]>(row.provenances, [])
      : undefined,
    confidence: row.confidence ?? undefined,
    subkind: row.subkind ?? undefined,
  };
}

/**
 * Convert database row to FileRecord object
 */
function rowToFileRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    contentHash: row.content_hash,
    language: row.language as Language,
    size: row.size,
    modifiedAt: row.modified_at,
    indexedAt: row.indexed_at,
    nodeCount: row.node_count,
    errors: row.errors ? safeJsonParse(row.errors, undefined) : undefined,
  };
}

/**
 * Query builder for the knowledge graph database
 */
export class QueryBuilder {
  private db: SqliteDatabase;

  // Node cache for frequently accessed nodes (LRU-style, max 1000 entries)
  private nodeCache: Map<string, Node> = new Map();
  private readonly maxCacheSize = 1000;

  // Prepared statements (lazily initialized)
  private stmts: {
    insertNode?: SqliteStatement;
    updateNode?: SqliteStatement;
    deleteNode?: SqliteStatement;
    deleteNodesByFile?: SqliteStatement;
    getNodeById?: SqliteStatement;
    getNodesByFile?: SqliteStatement;
    getNodesByKind?: SqliteStatement;
    insertEdge?: SqliteStatement;
    upsertEdgeSelect?: SqliteStatement;
    upsertEdgeUpdate?: SqliteStatement;
    upsertEdgeInsert?: SqliteStatement;
    insertNodeOrIgnore?: SqliteStatement;
    insertExternalRef?: SqliteStatement;
    upsertFile?: SqliteStatement;
    deleteEdgesBySource?: SqliteStatement;
    deleteEdgesByTarget?: SqliteStatement;
    getEdgesBySource?: SqliteStatement;
    getEdgesByTarget?: SqliteStatement;
    insertFile?: SqliteStatement;
    updateFile?: SqliteStatement;
    deleteFile?: SqliteStatement;
    getFileByPath?: SqliteStatement;
    getAllFiles?: SqliteStatement;
    insertUnresolved?: SqliteStatement;
    deleteUnresolvedByNode?: SqliteStatement;
    getUnresolvedByName?: SqliteStatement;
    getNodesByName?: SqliteStatement;
    getNodesByQualifiedNameExact?: SqliteStatement;
    getNodesByLowerName?: SqliteStatement;
    getUnresolvedCount?: SqliteStatement;
    getUnresolvedBatch?: SqliteStatement;
    getAllFilePaths?: SqliteStatement;
    getAllNodeNames?: SqliteStatement;
  } = {};

  constructor(db: SqliteDatabase) {
    this.db = db;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    if (!this.stmts.insertNode) {
      this.stmts.insertNode = this.db.prepare(`
        INSERT OR REPLACE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters,
          provenance, scip_symbol, scip_index_path, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters,
          @provenance, @scipSymbol, @scipIndexPath, @updatedAt
        )
      `);
    }

    // Validate required fields to prevent SQLite bind errors
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node with missing required fields:', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
      return;
    }

    try {
      this.stmts.insertNode.run({
        id: node.id,
        kind: node.kind,
        name: node.name,
        qualifiedName: node.qualifiedName ?? node.name,
        filePath: node.filePath,
        language: node.language,
        startLine: node.startLine ?? 0,
        endLine: node.endLine ?? 0,
        startColumn: node.startColumn ?? 0,
        endColumn: node.endColumn ?? 0,
        docstring: node.docstring ?? null,
        signature: node.signature ?? null,
        visibility: node.visibility ?? null,
        isExported: node.isExported ? 1 : 0,
        isAsync: node.isAsync ? 1 : 0,
        isStatic: node.isStatic ? 1 : 0,
        isAbstract: node.isAbstract ? 1 : 0,
        decorators: node.decorators ? JSON.stringify(node.decorators) : null,
        typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        provenance: node.provenance ?? 'tree-sitter',
        scipSymbol: node.scipSymbol ?? null,
        scipIndexPath: node.scipIndexPath ?? null,
        updatedAt: node.updatedAt ?? Date.now(),
      });
    } catch (error) {
      throw error;
    }
  }

  /**
   * Insert multiple nodes in a transaction
   */
  insertNodes(nodes: Node[]): void {
    this.db.transaction(() => {
      for (const node of nodes) {
        this.insertNode(node);
      }
    })();
  }

  /**
   * Update an existing node.
   *
   * Deliberately does NOT touch `provenance` / `scip_symbol` / `scip_index_path`:
   * those are set once at insert time. SCIP re-ingestion replaces ownership via
   * the persister's scoped delete + re-insert, never through `updateNode`.
   */
  updateNode(node: Node): void {
    if (!this.stmts.updateNode) {
      this.stmts.updateNode = this.db.prepare(`
        UPDATE nodes SET
          kind = @kind,
          name = @name,
          qualified_name = @qualifiedName,
          file_path = @filePath,
          language = @language,
          start_line = @startLine,
          end_line = @endLine,
          start_column = @startColumn,
          end_column = @endColumn,
          docstring = @docstring,
          signature = @signature,
          visibility = @visibility,
          is_exported = @isExported,
          is_async = @isAsync,
          is_static = @isStatic,
          is_abstract = @isAbstract,
          decorators = @decorators,
          type_parameters = @typeParameters,
          updated_at = @updatedAt
        WHERE id = @id
      `);
    }

    // Invalidate cache before update
    this.nodeCache.delete(node.id);

    // Validate required fields
    if (!node.id || !node.kind || !node.name || !node.filePath || !node.language) {
      console.error('[CodeGraph] Skipping node update with missing required fields:', node.id);
      return;
    }

    this.stmts.updateNode.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    if (!this.stmts.deleteNode) {
      this.stmts.deleteNode = this.db.prepare('DELETE FROM nodes WHERE id = ?');
    }
    // Invalidate cache
    this.nodeCache.delete(id);
    this.stmts.deleteNode.run(id);
  }

  /**
   * Delete all nodes for a file
   */
  deleteNodesByFile(filePath: string): void {
    if (!this.stmts.deleteNodesByFile) {
      this.stmts.deleteNodesByFile = this.db.prepare('DELETE FROM nodes WHERE file_path = ?');
    }
    // Invalidate cache for nodes in this file
    for (const [id, node] of this.nodeCache) {
      if (node.filePath === filePath) {
        this.nodeCache.delete(id);
      }
    }
    this.stmts.deleteNodesByFile.run(filePath);
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first
    if (this.nodeCache.has(id)) {
      const cached = this.nodeCache.get(id)!;
      // Move to end to implement LRU (delete and re-add)
      this.nodeCache.delete(id);
      this.nodeCache.set(id, cached);
      return cached;
    }

    if (!this.stmts.getNodeById) {
      this.stmts.getNodeById = this.db.prepare('SELECT * FROM nodes WHERE id = ?');
    }
    const row = this.stmts.getNodeById.get(id) as NodeRow | undefined;
    if (!row) {
      return null;
    }

    const node = rowToNode(row);
    this.cacheNode(node);
    return node;
  }

  /**
   * Add a node to the cache, evicting oldest if needed
   */
  private cacheNode(node: Node): void {
    if (this.nodeCache.size >= this.maxCacheSize) {
      // Evict oldest (first) entry
      const firstKey = this.nodeCache.keys().next().value;
      if (firstKey) {
        this.nodeCache.delete(firstKey);
      }
    }
    this.nodeCache.set(node.id, node);
  }

  /**
   * Clear the node cache
   */
  clearCache(): void {
    this.nodeCache.clear();
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    if (!this.stmts.getNodesByFile) {
      this.stmts.getNodesByFile = this.db.prepare(
        'SELECT * FROM nodes WHERE file_path = ? ORDER BY start_line'
      );
    }
    const rows = this.stmts.getNodesByFile.all(filePath) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes of a specific kind
   */
  getNodesByKind(kind: NodeKind): Node[] {
    if (!this.stmts.getNodesByKind) {
      this.stmts.getNodesByKind = this.db.prepare('SELECT * FROM nodes WHERE kind = ?');
    }
    const rows = this.stmts.getNodesByKind.all(kind) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get all nodes in the database
   */
  getAllNodes(): Node[] {
    const rows = this.db.prepare('SELECT * FROM nodes').all() as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact name match (uses idx_nodes_name index)
   */
  getNodesByName(name: string): Node[] {
    if (!this.stmts.getNodesByName) {
      this.stmts.getNodesByName = this.db.prepare('SELECT * FROM nodes WHERE name = ?');
    }
    const rows = this.stmts.getNodesByName.all(name) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by exact qualified name match (uses idx_nodes_qualified_name index)
   */
  getNodesByQualifiedNameExact(qualifiedName: string): Node[] {
    if (!this.stmts.getNodesByQualifiedNameExact) {
      this.stmts.getNodesByQualifiedNameExact = this.db.prepare(
        'SELECT * FROM nodes WHERE qualified_name = ?'
      );
    }
    const rows = this.stmts.getNodesByQualifiedNameExact.all(qualifiedName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Get nodes by lowercase name match (uses idx_nodes_lower_name expression index)
   */
  getNodesByLowerName(lowerName: string): Node[] {
    if (!this.stmts.getNodesByLowerName) {
      this.stmts.getNodesByLowerName = this.db.prepare(
        'SELECT * FROM nodes WHERE lower(name) = ?'
      );
    }
    const rows = this.stmts.getNodesByLowerName.all(lowerName) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Search nodes by name using FTS with fallback to LIKE for better matching
   *
   * Search strategy:
   * 1. Try FTS5 prefix match (query*) for word-start matching
   * 2. If no results, try LIKE for substring matching (e.g., "signIn" finds "signInWithGoogle")
   * 3. Score results based on match quality
   */
  searchNodes(query: string, options: SearchOptions = {}): SearchResult[] {
    const { limit = 100, offset = 0, tag } = options;

    // Parse field-qualified bits out of the raw query (kind:, lang:,
    // path:, name:). Anything not recognised stays in `text` and goes
    // to FTS unchanged. Filters compose with the SearchOptions arg —
    // both are applied (intersection-style).
    const parsed = parseQuery(query);
    const mergedKinds =
      parsed.kinds.length > 0
        ? Array.from(new Set([...(options.kinds ?? []), ...parsed.kinds]))
        : options.kinds;
    const mergedLanguages =
      parsed.languages.length > 0
        ? Array.from(new Set([...(options.languages ?? []), ...parsed.languages]))
        : options.languages;
    const pathFilters = parsed.pathFilters;
    const nameFilters = parsed.nameFilters;
    // The text portion drives FTS/LIKE; if all the user typed was
    // filters (`kind:function`), we still need *some* candidate set,
    // so synthesise an empty-text path that returns everything matching
    // the filters.
    const text = parsed.text;
    const kinds = mergedKinds;
    const languages = mergedLanguages;

    // First try FTS5 with prefix matching
    let results = text
      ? this.searchNodesFTS(text, { kinds, languages, limit, offset, tag })
      // Over-fetch by 5× when running filter-only (no text). The
      // post-scoring path: + name: filters can be very selective, so
      // a smaller multiplier risks returning fewer than `limit`
      // results despite the DB having plenty of matches.
      : this.searchAllByFilters({ kinds, languages, limit: limit * 5, tag });

    // If no FTS results, try LIKE-based substring search
    if (results.length === 0 && text.length >= 2) {
      results = this.searchNodesLike(text, { kinds, languages, limit, offset, tag });
    }

    // Final fuzzy fallback: scan all known names and keep those within
    // a tight Levenshtein distance. Only fires when both FTS and LIKE
    // returned nothing AND there's a text portion long enough to be
    // worth fuzzing (1-char queries would match too much).
    if (results.length === 0 && text.length >= 3) {
      results = this.searchNodesFuzzy(text, { kinds, languages, limit, tag });
    }

    // Supplement: ensure exact name matches are always candidates.
    // BM25 can bury short exact-match names (e.g. "getBean") under hundreds of
    // compound names (e.g. "getBeanDescriptor") in large codebases,
    // pushing them past the FTS fetch limit before post-hoc scoring can help.
    // Use the max BM25 score as the base so the nameMatchBonus (exact=30 vs
    // prefix=20) actually differentiates them after rescoring.
    if (results.length > 0 && query) {
      const existingIds = new Set(results.map(r => r.node.id));
      const maxFtsScore = Math.max(...results.map(r => r.score));
      const terms = query.split(/\s+/).filter(t => t.length >= 2);
      for (const term of terms) {
        let sql = 'SELECT nodes.* FROM nodes';
        const params: (string | number)[] = [];
        if (tag) {
          sql += ' INNER JOIN node_tags ON node_tags.node_id = nodes.id AND node_tags.tag = ?';
          params.push(tag);
        }
        sql += ' WHERE nodes.name = ? COLLATE NOCASE';
        params.push(term);
        if (kinds && kinds.length > 0) {
          sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
          params.push(...kinds);
        }
        if (languages && languages.length > 0) {
          sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
          params.push(...languages);
        }
        sql += ' LIMIT 20';
        const rows = this.db.prepare(sql).all(...params) as NodeRow[];
        for (const row of rows) {
          if (!existingIds.has(row.id)) {
            results.push({ node: rowToNode(row), score: maxFtsScore });
            existingIds.add(row.id);
          }
        }
      }
    }

    // Apply multi-signal scoring
    if (results.length > 0 && (text || query)) {
      const scoringQuery = text || query;
      results = results.map(r => ({
        ...r,
        score: r.score
          + kindBonus(r.node.kind)
          + scorePathRelevance(r.node.filePath, scoringQuery)
          + nameMatchBonus(r.node.name, scoringQuery),
      }));
      results.sort((a, b) => b.score - a.score);
      // Trim to requested limit after rescoring
      if (results.length > limit) {
        results = results.slice(0, limit);
      }
    }

    // Apply path: + name: filters AFTER scoring. Scoring already uses
    // path/name as a soft signal; the explicit filters here are a hard
    // gate. Done last so the FTS limit fetched plenty of candidates to
    // narrow from.
    if (pathFilters.length > 0) {
      const lowered = pathFilters.map((p) => p.toLowerCase());
      results = results.filter((r) => {
        const fp = r.node.filePath.toLowerCase();
        return lowered.some((p) => fp.includes(p));
      });
    }
    if (nameFilters.length > 0) {
      const lowered = nameFilters.map((n) => n.toLowerCase());
      results = results.filter((r) => {
        const nm = r.node.name.toLowerCase();
        return lowered.some((n) => nm.includes(n));
      });
    }

    return results;
  }

  /**
   * Match-everything path used when the user supplied only field
   * filters (`kind:function lang:typescript`) with no text. Returns
   * candidates ordered by name; the caller's filter pass narrows to
   * what was asked for.
   */
  private searchAllByFilters(options: {
    kinds?: NodeKind[];
    languages?: Language[];
    limit: number;
    tag?: string;
  }): SearchResult[] {
    const { kinds, languages, limit, tag } = options;
    let sql = 'SELECT nodes.* FROM nodes';
    const params: (string | number)[] = [];
    if (tag) {
      sql += ' INNER JOIN node_tags ON node_tags.node_id = nodes.id AND node_tags.tag = ?';
      params.push(tag);
    }
    sql += ' WHERE 1=1';
    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }
    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }
    sql += ' ORDER BY nodes.name LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as NodeRow[];
    return rows.map((row) => ({ node: rowToNode(row), score: 1 }));
  }

  /**
   * Fuzzy fallback: when zero FTS/LIKE hits, try an edit-distance
   * sweep over the distinct symbol-name set. Caps `maxDist` at 2 so
   * `getUssr` finds `getUser` but `process` doesn't match `prosody`.
   * Bounded edit distance keeps each comparison cheap; the per-query
   * scan is O(distinct-name-count) which is far smaller than total
   * node count on any real codebase.
   */
  private searchNodesFuzzy(
    text: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit: number; tag?: string }
  ): SearchResult[] {
    const { kinds, languages, limit, tag } = options;
    const lowered = text.toLowerCase();
    const maxDist = lowered.length <= 4 ? 1 : 2;

    // Pull the distinct name list once. The set is cached on QueryBuilder
    // by getAllNodeNames(); even on a 200k-node project the distinct
    // name set is typically O(10k) because most names repeat. The
    // candidate-cap below bounds memory regardless.
    const allNames = this.getAllNodeNames();
    const candidates: Array<{ name: string; dist: number }> = [];
    for (const name of allNames) {
      const dist = boundedEditDistance(name.toLowerCase(), lowered, maxDist);
      if (dist <= maxDist) candidates.push({ name, dist });
    }
    candidates.sort((a, b) => a.dist - b.dist);

    // Cap the per-name follow-up queries. Each survivor triggers a
    // separate `SELECT * FROM nodes WHERE name = ?`; without this cap
    // a project with many similar names (`getUser1`, `getUser2`...)
    // could fan out far beyond `limit` queries before the inner-loop
    // limit kicks in.
    const FUZZY_FOLLOWUP_CAP = Math.max(limit * 2, 50);
    const cappedCandidates = candidates.slice(0, FUZZY_FOLLOWUP_CAP);

    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const c of cappedCandidates) {
      if (results.length >= limit) break;
      let sql = 'SELECT nodes.* FROM nodes';
      const params: (string | number)[] = [];
      if (tag) {
        sql += ' INNER JOIN node_tags ON node_tags.node_id = nodes.id AND node_tags.tag = ?';
        params.push(tag);
      }
      sql += ' WHERE nodes.name = ?';
      params.push(c.name);
      if (kinds && kinds.length > 0) {
        sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      if (languages && languages.length > 0) {
        sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }
      sql += ' LIMIT 5';
      const rows = this.db.prepare(sql).all(...params) as NodeRow[];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        // Lower the score for each edit step away from the query so
        // exact-match fallbacks (dist 0) outrank dist-2 typos.
        results.push({ node: rowToNode(row), score: 1 / (1 + c.dist) });
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  /**
   * FTS5 search with prefix matching
   */
  private searchNodesFTS(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0, tag } = options;

    // Add prefix wildcard for better matching (e.g., "auth" matches "AuthService", "authenticate")
    // Escape special FTS5 characters and add prefix wildcard.
    //
    // `::` is a qualifier separator in Rust/C++/Ruby, not a token char,
    // so treat it as whitespace before the strip step. Otherwise queries
    // like `stage_apply::run` collapse to `stage_applyrun` (the colons
    // are stripped without splitting) and find nothing. See #173.
    const ftsQuery = query
      .replace(/::/g, ' ') // Rust/C++/Ruby qualifier separator
      .replace(/['"*():^]/g, '') // Remove FTS5 special chars
      .split(/\s+/)
      .filter(term => term.length > 0)
      // Strip FTS5 boolean operators to prevent query manipulation
      .filter(term => !/^(AND|OR|NOT|NEAR)$/i.test(term))
      .map(term => `"${term}"*`) // Prefix match each term
      .join(' OR ');

    if (!ftsQuery) {
      return [];
    }

    // BM25 column weights: id=0, name=20, qualified_name=5, docstring=1, signature=2
    // Heavy name weight ensures exact/prefix name matches rank above incidental
    // mentions in long docstrings or qualified names of nested symbols.
    // Fetch 5x requested limit so post-hoc rescoring (kindBonus, pathRelevance,
    // nameMatchBonus) can promote results that BM25 alone undervalues.
    const ftsLimit = Math.max(limit * 5, 100);

    let sql = `
      SELECT nodes.*, bm25(nodes_fts, 0, 20, 5, 1, 2) as score
      FROM nodes_fts
      JOIN nodes ON nodes_fts.id = nodes.id
    `;

    const params: (string | number)[] = [];

    // Pushing the tag filter into the candidate query (rather than
    // post-filtering after the FTS limit) ensures we don't silently drop
    // tagged matches ranked outside the FTS window. With a large repo and
    // a heavily ranked untagged query, those drops would manifest as
    // false-negative `tag: 'x'` results.
    if (tag) {
      sql += ' INNER JOIN node_tags ON node_tags.node_id = nodes.id AND node_tags.tag = ?';
      params.push(tag);
    }

    sql += ' WHERE nodes_fts MATCH ?';
    params.push(ftsQuery);

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score LIMIT ? OFFSET ?';
    params.push(ftsLimit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      return rows.map((row) => ({
        node: rowToNode(row),
        score: Math.abs(row.score), // bm25 returns negative scores
      }));
    } catch {
      // FTS query failed, return empty
      return [];
    }
  }

  /**
   * LIKE-based substring search for cases where FTS doesn't match
   * Useful for camelCase matching (e.g., "signIn" finds "signInWithGoogle")
   */
  private searchNodesLike(query: string, options: SearchOptions): SearchResult[] {
    const { kinds, languages, limit = 100, offset = 0, tag } = options;

    let sql = `
      SELECT nodes.*,
        CASE
          WHEN nodes.name = ? THEN 1.0
          WHEN nodes.name LIKE ? THEN 0.9
          WHEN nodes.name LIKE ? THEN 0.8
          WHEN nodes.qualified_name LIKE ? THEN 0.7
          ELSE 0.5
        END as score
      FROM nodes
    `;

    // Pattern variants for better matching
    const exactMatch = query;
    const startsWith = `${query}%`;
    const contains = `%${query}%`;

    const params: (string | number)[] = [
      exactMatch,     // Exact match score
      startsWith,     // Starts with score
      contains,       // Contains score
      contains,       // Qualified name score
    ];

    if (tag) {
      sql += ' INNER JOIN node_tags ON node_tags.node_id = nodes.id AND node_tags.tag = ?';
      params.push(tag);
    }

    sql += `
      WHERE (
        nodes.name LIKE ? OR
        nodes.qualified_name LIKE ? OR
        nodes.name LIKE ?
      )
    `;
    params.push(
      contains,       // WHERE: name contains
      contains,       // WHERE: qualified_name contains
      startsWith,     // WHERE: name starts with
    );

    if (kinds && kinds.length > 0) {
      sql += ` AND nodes.kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND nodes.language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY score DESC, length(nodes.name) ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];

    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  /**
   * Find nodes by exact name match
   *
   * Used for hybrid search - looks up symbols by exact name or case-insensitive match.
   * Returns high-confidence matches for known symbol names extracted from query.
   *
   * @param names - Array of symbol names to look up
   * @param options - Search options (kinds, languages, limit)
   * @returns SearchResult array with exact matches scored at 1.0
   */
  findNodesByExactName(names: string[], options: SearchOptions = {}): SearchResult[] {
    if (names.length === 0) return [];

    const { kinds, languages, limit = 50 } = options;

    // Two-pass approach to handle common names (e.g., "run" has 40+ matches):
    // Pass 1: Find which files contain distinctive (rare) symbols from the query.
    // Pass 2: Query each name, boosting results that co-locate with distinctive symbols.

    // Pass 1: Find files containing each queried name, identify distinctive names
    const nameToFiles = new Map<string, Set<string>>();
    for (const name of names) {
      let sql = 'SELECT DISTINCT file_path FROM nodes WHERE name COLLATE NOCASE = ?';
      const params: (string | number)[] = [name];
      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }
      sql += ' LIMIT 100';
      const rows = this.db.prepare(sql).all(...params) as { file_path: string }[];
      nameToFiles.set(name.toLowerCase(), new Set(rows.map(r => r.file_path)));
    }

    // Distinctive names are those with fewer than 10 file matches (e.g., "scrapeLoop" = 1 file)
    const distinctiveFiles = new Set<string>();
    for (const [, files] of nameToFiles) {
      if (files.size > 0 && files.size < 10) {
        for (const f of files) distinctiveFiles.add(f);
      }
    }

    // Pass 2: Query each name with per-name limit, scoring by co-location
    const perNameLimit = Math.max(8, Math.ceil(limit / names.length));
    const allResults: SearchResult[] = [];
    const seenIds = new Set<string>();

    for (const name of names) {
      let sql = `
        SELECT nodes.*, 1.0 as score
        FROM nodes
        WHERE name COLLATE NOCASE = ?
      `;
      const params: (string | number)[] = [name];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (languages && languages.length > 0) {
        sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
        params.push(...languages);
      }

      // Fetch enough to find co-located results among common names
      sql += ' LIMIT ?';
      params.push(Math.max(perNameLimit * 3, 50));

      const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
      const nameResults: SearchResult[] = [];
      for (const row of rows) {
        const node = rowToNode(row);
        if (seenIds.has(node.id)) continue;
        // Boost results in files that also contain distinctive symbols
        const coLocationBoost = distinctiveFiles.has(node.filePath) ? 20 : 0;
        nameResults.push({ node, score: row.score + coLocationBoost });
      }

      // Sort by score (co-located first), take per-name limit
      nameResults.sort((a, b) => b.score - a.score);
      for (const r of nameResults.slice(0, perNameLimit)) {
        seenIds.add(r.node.id);
        allResults.push(r);
      }
    }

    // Sort all results by score so co-located results bubble up
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, limit);
  }

  /**
   * Find nodes whose name contains a substring (LIKE-based).
   * Useful for CamelCase-part matching where FTS fails because
   * e.g. "TransportSearchAction" is one FTS token, not matchable by "Search"*.
   *
   * Results are ordered by name length (shorter = more likely to be the core type).
   */
  findNodesByNameSubstring(
    substring: string,
    options: SearchOptions & { excludePrefix?: boolean } = {}
  ): SearchResult[] {
    const { kinds, languages, limit = 30, excludePrefix } = options;

    let sql = `
      SELECT nodes.*, 1.0 as score
      FROM nodes
      WHERE name LIKE ?
    `;
    const params: (string | number)[] = [`%${substring}%`];

    // Exclude prefix matches (handled by FTS-based prefix search in Step 2b)
    if (excludePrefix) {
      sql += ` AND name NOT LIKE ?`;
      params.push(`${substring}%`);
    }

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    if (languages && languages.length > 0) {
      sql += ` AND language IN (${languages.map(() => '?').join(',')})`;
      params.push(...languages);
    }

    sql += ' ORDER BY length(name) ASC LIMIT ?';
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as (NodeRow & { score: number })[];
    return rows.map((row) => ({
      node: rowToNode(row),
      score: row.score,
    }));
  }

  // ===========================================================================
  // Edge Operations
  // ===========================================================================

  /**
   * Insert or merge an edge — the single edge-write path for every extractor
   * (tree-sitter, SCIP, scope-resolver, framework augmenters).
   *
   * Edges are keyed by the `idx_edges_dedup` fingerprint
   * `(source, target, kind, COALESCE(subkind,''), COALESCE(line,-1), COALESCE(col,-1))`.
   * When an edge with that fingerprint already exists, the new contribution is
   * merged: `provenances[]` gains the new extractor (append-only audit trail),
   * `provenance` becomes the highest-priority member, `confidence` takes the
   * max, `metadata` is shallow-merged (a NULL is written only when both sides
   * are empty), and the freshness flags are reset — the freshness invariant
   * that lets P2's stale-shadow loop terminate.
   */
  upsertGraphEdge(rawEdge: Edge): void {
    // Strip positions from pure-relation kinds so a stray legacy line/col
    // cannot violate the three-tier invariant or split a fingerprint.
    const edge = coerceEdgePosition(rawEdge);
    const prov: GraphProvenance = edge.provenance ?? 'tree-sitter';
    const conf = edge.confidence ?? defaultConfidence(prov);
    const subkind = edge.subkind ?? null;
    const line = edge.line ?? null;
    const col = edge.column ?? null;

    if (!this.stmts.upsertEdgeSelect) {
      this.stmts.upsertEdgeSelect = this.db.prepare(`
        SELECT provenance, provenances, confidence, metadata FROM edges
        WHERE source=? AND target=? AND kind=?
          AND COALESCE(subkind,'')=COALESCE(?,'')
          AND COALESCE(line,-1)=COALESCE(?,-1)
          AND COALESCE(col,-1)=COALESCE(?,-1)
      `);
    }
    const existing = this.stmts.upsertEdgeSelect.get(
      edge.source, edge.target, edge.kind, subkind, line, col,
    ) as
      | { provenance: string | null; provenances: string | null; confidence: number | null; metadata: string | null }
      | undefined;

    if (existing) {
      const seed: GraphProvenance[] = existing.provenances
        ? safeJsonParse<GraphProvenance[]>(existing.provenances, [])
        : existing.provenance
          ? [existing.provenance as GraphProvenance]
          : [];
      const provSet = new Set<GraphProvenance>(seed);
      provSet.add(prov);
      const provList = [...provSet];
      const primary = pickPrimaryProvenance(provList);

      const oldMeta = existing.metadata
        ? safeJsonParse<Record<string, unknown>>(existing.metadata, {})
        : {};
      const mergedMeta = { ...oldMeta, ...(edge.metadata ?? {}) };
      const metaJson =
        Object.keys(mergedMeta).length > 0 ? JSON.stringify(mergedMeta) : null;

      if (!this.stmts.upsertEdgeUpdate) {
        this.stmts.upsertEdgeUpdate = this.db.prepare(`
          UPDATE edges
          SET provenance=?, provenances=?, confidence=max(COALESCE(confidence,0),?),
              metadata=?, stale=0, staleness_visible=0
          WHERE source=? AND target=? AND kind=?
            AND COALESCE(subkind,'')=COALESCE(?,'')
            AND COALESCE(line,-1)=COALESCE(?,-1)
            AND COALESCE(col,-1)=COALESCE(?,-1)
        `);
      }
      this.stmts.upsertEdgeUpdate.run(
        primary, JSON.stringify(provList), conf, metaJson,
        edge.source, edge.target, edge.kind, subkind, line, col,
      );
    } else {
      if (!this.stmts.upsertEdgeInsert) {
        this.stmts.upsertEdgeInsert = this.db.prepare(`
          INSERT INTO edges
            (source, target, kind, subkind, line, col, metadata, provenance, provenances, confidence)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
      }
      this.stmts.upsertEdgeInsert.run(
        edge.source, edge.target, edge.kind, subkind, line, col,
        edge.metadata ? JSON.stringify(edge.metadata) : null,
        prov, JSON.stringify([prov]), conf,
      );
    }
  }

  /**
   * Insert a new edge. Retained as the historical name — delegates to
   * `upsertGraphEdge` so every legacy call site gets dedup + merge semantics.
   */
  insertEdge(edge: Edge): void {
    this.upsertGraphEdge(edge);
  }

  /**
   * Insert multiple edges in a transaction
   */
  insertEdges(edges: Edge[]): void {
    this.db.transaction(() => {
      for (const edge of edges) {
        this.insertEdge(edge);
      }
    })();
  }

  /**
   * Delete all edges from a source node
   */
  deleteEdgesBySource(sourceId: string): void {
    if (!this.stmts.deleteEdgesBySource) {
      this.stmts.deleteEdgesBySource = this.db.prepare('DELETE FROM edges WHERE source = ?');
    }
    this.stmts.deleteEdgesBySource.run(sourceId);
  }

  /**
   * Get outgoing edges from a node
   */
  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[], provenance?: string): Edge[] {
    if ((kinds && kinds.length > 0) || provenance) {
      let sql = 'SELECT * FROM edges WHERE source = ?';
      const params: (string | number)[] = [sourceId];

      if (kinds && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
        params.push(...kinds);
      }

      if (provenance) {
        sql += ' AND provenance = ?';
        params.push(provenance);
      }

      const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesBySource) {
      this.stmts.getEdgesBySource = this.db.prepare('SELECT * FROM edges WHERE source = ?');
    }
    const rows = this.stmts.getEdgesBySource.all(sourceId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Get incoming edges to a node
   */
  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): Edge[] {
    if (kinds && kinds.length > 0) {
      const sql = `SELECT * FROM edges WHERE target = ? AND kind IN (${kinds.map(() => '?').join(',')})`;
      const rows = this.db.prepare(sql).all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }

    if (!this.stmts.getEdgesByTarget) {
      this.stmts.getEdgesByTarget = this.db.prepare('SELECT * FROM edges WHERE target = ?');
    }
    const rows = this.stmts.getEdgesByTarget.all(targetId) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Find all edges where both source and target are in the given node set.
   * Useful for recovering inter-node connectivity after BFS.
   */
  findEdgesBetweenNodes(nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
    if (nodeIds.length === 0) return [];

    const idsJson = JSON.stringify(nodeIds);
    let sql = `SELECT * FROM edges WHERE source IN (SELECT value FROM json_each(?)) AND target IN (SELECT value FROM json_each(?))`;
    const params: string[] = [idsJson, idsJson];

    if (kinds && kinds.length > 0) {
      sql += ` AND kind IN (${kinds.map(() => '?').join(',')})`;
      params.push(...kinds);
    }

    const rows = this.db.prepare(sql).all(...params) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  /**
   * Edges whose audit trail (`provenances[]`) contains `p` — i.e. every edge
   * any run of extractor `p` has observed, regardless of which extractor is
   * currently primary. Contrast `getOutgoingEdges(_, _, provenance)` which
   * filters on the single-value primary column.
   */
  getEdgesByContributingProvenance(p: GraphProvenance): Edge[] {
    const rows = this.db
      .prepare(`SELECT * FROM edges WHERE provenances LIKE '%"' || ? || '"%'`)
      .all(p) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // ===========================================================================
  // Phase 3 — node_tags + framework purge + transaction wrapper
  // ===========================================================================

  /**
   * Attach a tag to a node. First-writer-wins on `added_by` (mirrors
   * `pickPrimaryProvenance` for equal-rank provenances). Duplicate
   * (node_id, tag) pairs are silently ignored.
   *
   * Caller is responsible for tag-format validation (see isValidTagFormat in
   * Phase3Orchestrator) and for ensuring the node exists. A FK violation here
   * surfaces as a thrown error.
   */
  insertNodeTag(nodeId: string, tag: string, addedBy: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO node_tags (node_id, tag, added_by) VALUES (?, ?, ?)`,
    ).run(nodeId, tag, addedBy);
  }

  /** All nodes carrying the given tag. */
  getNodesByTag(tag: string): Node[] {
    const rows = this.db.prepare(
      `SELECT n.* FROM nodes n
       INNER JOIN node_tags t ON t.node_id = n.id
       WHERE t.tag = ?`,
    ).all(tag) as NodeRow[];
    return rows.map(rowToNode);
  }

  /**
   * Run `fn` inside a single transaction and return its result. Thin delegate
   * to the underlying adapter (`better-sqlite3.transaction(fn)()` /
   * `WasmDatabaseAdapter.transaction`). Phase 3 uses this as its sole
   * transaction boundary; do NOT nest other transaction-opening helpers
   * inside `fn` — `node-sqlite3-wasm` uses raw `BEGIN`/`COMMIT` and nesting
   * fails.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * STAGE 0 SQL 0.1 — strip framework contributions from every edge.
   *
   * For each edge whose `provenances[]` contains any `framework:*` entry:
   *   - If at least one non-framework provenance survives → strip framework
   *     from `provenances[]`, recompute `provenance` to the highest-rank
   *     surviving provenance (via `pickPrimaryProvenance`), and recompute
   *     `confidence` to `max(defaultConfidence(p) for p in survivors)`.
   *   - If no non-framework provenance survives → delete the edge row.
   *
   * Done row-by-row in TypeScript because we need to compute the primary
   * survivor (which mirrors `pickPrimaryProvenance` priorities) and write
   * a JSON array — both awkward in pure SQL across the two adapters.
   * Real workloads have framework contributors on a small fraction of
   * edges, so this is O(framework-edge-count), not O(total-edges).
   *
   * Critically handles the merged-edge case where framework is the primary
   * provenance because it outranks a non-framework contributor — e.g.
   * `heuristic` (rank 50) + `framework:x` (rank 60) → primary is framework,
   * but `heuristic` is a load-bearing static contributor that must NOT be
   * dropped. The earlier sketch deleted these rows wholesale; this version
   * preserves the static contribution by demoting the row to a non-framework
   * primary.
   *
   * `metadata` is NOT touched here — framework augmenters are forbidden from
   * writing metadata (see plan "Edge metadata ownership"); Phase3Orchestrator's
   * edge pre-flight enforces that contract on the write side.
   */
  stripFrameworkContributionsFromEdges(): void {
    // First-pass: a LIKE pre-filter narrows the row scan; the precise JSON
    // parse happens in JS. Empty/NULL provenances[] rows can't match because
    // the LIKE requires a `framework:` substring.
    const candidates = this.db
      .prepare(
        `SELECT id, provenance, provenances FROM edges
         WHERE provenances LIKE '%framework:%'`,
      )
      .all() as Array<{ id: number; provenance: string | null; provenances: string | null }>;

    if (candidates.length === 0) return;

    const updateStmt = this.db.prepare(
      `UPDATE edges
          SET provenance = ?, provenances = ?, confidence = ?
        WHERE id = ?`,
    );
    const deleteStmt = this.db.prepare(`DELETE FROM edges WHERE id = ?`);

    for (const row of candidates) {
      if (!row.provenances) continue;
      let provs: GraphProvenance[];
      try {
        provs = JSON.parse(row.provenances) as GraphProvenance[];
      } catch {
        continue;
      }
      const survivors = provs.filter((p) => !p.startsWith('framework:'));
      if (survivors.length === 0) {
        deleteStmt.run(row.id);
        continue;
      }
      // If neither the primary nor any provenance changed, skip the write.
      if (survivors.length === provs.length) continue;
      const primary = pickPrimaryProvenance(survivors);
      const confidence = Math.max(...survivors.map((p) => defaultConfidence(p)));
      updateStmt.run(primary, JSON.stringify(survivors), confidence, row.id);
    }
  }

  /** STAGE 0 SQL 0.2 — delete every tag written by any framework resolver. */
  deleteAllFrameworkTags(): void {
    this.db.exec(`DELETE FROM node_tags WHERE added_by LIKE 'framework:%'`);
  }

  /**
   * STAGE 0 SQL 0.3 — safety net for edges whose primary is `framework:*`
   * but whose `provenances[]` is NULL or empty (shouldn't happen via the
   * upsert path, but possible from legacy migrations or direct writes).
   * `stripFrameworkContributionsFromEdges` handles the well-formed case
   * (deletes framework-only edges); this catches malformed rows.
   */
  deleteFrameworkPrimaryEdges(): void {
    this.db.exec(`DELETE FROM edges WHERE provenance LIKE 'framework:%'`);
  }

  /** STAGE 0 SQL 0.4 — delete nodes whose provenance is framework-owned. */
  deleteFrameworkNodes(): void {
    this.db.exec(`DELETE FROM nodes WHERE provenance LIKE 'framework:%'`);
  }

  /**
   * For each `framework:<name>` provenance ever observed on an edge,
   * return the count of distinct edges in which that provenance
   * contributes (counts membership in `provenances[]`, NOT primary
   * `provenance`). Used by `codegraph status` per ship gate 9 so
   * SCIP-primary edges merged with a framework contribution still
   * appear in the per-framework count.
   */
  getFrameworkEdgeContributionCounts(): Record<string, number> {
    // `json_each` exposes its own `id` column, so the unqualified `id` in
    // `COUNT(DISTINCT id)` is ambiguous and errors at runtime. Qualify
    // with `edges.id`.
    const rows = this.db
      .prepare(
        `SELECT value AS provenance, COUNT(DISTINCT edges.id) AS edge_count
         FROM edges, json_each(edges.provenances)
         WHERE value LIKE 'framework:%'
         GROUP BY value
         ORDER BY value`,
      )
      .all() as Array<{ provenance: string; edge_count: number }>;
    const out: Record<string, number> = {};
    for (const row of rows) {
      out[row.provenance.replace(/^framework:/, '')] = row.edge_count;
    }
    return out;
  }

  /**
   * Flush QueryBuilder-level caches that could hold framework-derived rows.
   * Called by Phase3Orchestrator after STAGE 0 purge and after STAGE B writes
   * so that subsequent reads (and view construction) observe the fresh state.
   *
   * Raw-SQL DELETE / UPDATE in the purge helpers bypasses the cache
   * invalidation that `insertNode` / `updateNode` / `deleteNode` perform
   * inline. This is the explicit flush.
   */
  invalidatePhase3Caches(): void {
    this.nodeCache.clear();
  }

  // ===========================================================================
  // SCIP Operations
  // ===========================================================================

  /**
   * Insert an internal SCIP-derived node. `INSERT OR IGNORE` — the node id is
   * a stable hash of the SCIP symbol, so a (bug-induced) duplicate definition
   * is a harmless no-op rather than a clobber.
   */
  insertScipNode(node: Node): void {
    this.insertNodeOrIgnore(node);
  }

  /**
   * Insert an external SCIP node (a symbol defined outside the index) and
   * record this index's reference to it. Both inserts are `INSERT OR IGNORE`:
   * external nodes are globally unique by symbol hash and shared many-to-many
   * across `.scip` indexes via `scip_external_refs`.
   */
  upsertExternalScipNode(node: Node, scipIndexPath: string): void {
    this.insertNodeOrIgnore(node);
    if (!this.stmts.insertExternalRef) {
      this.stmts.insertExternalRef = this.db.prepare(
        `INSERT OR IGNORE INTO scip_external_refs (scip_index_path, external_node_id)
         VALUES (?, ?)`,
      );
    }
    this.stmts.insertExternalRef.run(scipIndexPath, node.id);
  }

  /** `INSERT OR IGNORE` a node row. Shared by internal + external SCIP inserts. */
  private insertNodeOrIgnore(node: Node): void {
    if (!this.stmts.insertNodeOrIgnore) {
      this.stmts.insertNodeOrIgnore = this.db.prepare(`
        INSERT OR IGNORE INTO nodes (
          id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column,
          docstring, signature, visibility,
          is_exported, is_async, is_static, is_abstract,
          decorators, type_parameters,
          provenance, scip_symbol, scip_index_path, updated_at
        ) VALUES (
          @id, @kind, @name, @qualifiedName, @filePath, @language,
          @startLine, @endLine, @startColumn, @endColumn,
          @docstring, @signature, @visibility,
          @isExported, @isAsync, @isStatic, @isAbstract,
          @decorators, @typeParameters,
          @provenance, @scipSymbol, @scipIndexPath, @updatedAt
        )
      `);
    }
    this.stmts.insertNodeOrIgnore.run({
      id: node.id,
      kind: node.kind,
      name: node.name,
      qualifiedName: node.qualifiedName ?? node.name,
      filePath: node.filePath,
      language: node.language,
      startLine: node.startLine ?? 0,
      endLine: node.endLine ?? 0,
      startColumn: node.startColumn ?? 0,
      endColumn: node.endColumn ?? 0,
      docstring: node.docstring ?? null,
      signature: node.signature ?? null,
      visibility: node.visibility ?? null,
      isExported: node.isExported ? 1 : 0,
      isAsync: node.isAsync ? 1 : 0,
      isStatic: node.isStatic ? 1 : 0,
      isAbstract: node.isAbstract ? 1 : 0,
      decorators: node.decorators ? JSON.stringify(node.decorators) : null,
      typeParameters: node.typeParameters ? JSON.stringify(node.typeParameters) : null,
      provenance: node.provenance ?? 'tree-sitter',
      scipSymbol: node.scipSymbol ?? null,
      scipIndexPath: node.scipIndexPath ?? null,
      updatedAt: node.updatedAt ?? Date.now(),
    });
  }

  /**
   * Scoped delete of all data owned by one `.scip` index: its internal
   * nodes/edges, its external references (garbage-collecting external nodes
   * whose ref count drops to zero), its scip-empty-fallback nodes, and its
   * `scip_documents` rows. The caller is responsible for the transaction.
   */
  deleteScipIndexData(scipIndexPath: string): void {
    const p = { idx: scipIndexPath };

    // Owned (internal) SCIP nodes/edges.
    this.db
      .prepare(
        `DELETE FROM edges
         WHERE source IN (SELECT id FROM nodes WHERE scip_index_path=@idx)
            OR target IN (SELECT id FROM nodes WHERE scip_index_path=@idx)`,
      )
      .run(p);
    this.db.prepare(`DELETE FROM nodes WHERE scip_index_path=@idx`).run(p);

    // External refs owned by this index, then GC of now-orphaned external nodes.
    // The per-endpoint orphan test asks "is THIS endpoint an external node with
    // zero remaining refs" — internal endpoints never match the
    // provenance='scip:external' filter, so a still-referenced external on the
    // other end of an internal->external edge is never collateral-damaged.
    this.db.prepare(`DELETE FROM scip_external_refs WHERE scip_index_path=@idx`).run(p);
    const orphanExternal = `SELECT id FROM nodes
        WHERE provenance='scip:external'
          AND id NOT IN (SELECT external_node_id FROM scip_external_refs)`;
    this.db
      .prepare(
        `DELETE FROM edges
         WHERE source IN (${orphanExternal}) OR target IN (${orphanExternal})`,
      )
      .run();
    this.db
      .prepare(
        `DELETE FROM nodes
         WHERE provenance='scip:external'
           AND id NOT IN (SELECT external_node_id FROM scip_external_refs)`,
      )
      .run();

    // scip-empty-fallback nodes are file-path-associated, not scip_index_path-owned.
    const fallbackNodes = `SELECT id FROM nodes
        WHERE provenance='tree-sitter (scip-empty-fallback)'
          AND file_path IN (SELECT source_file_path FROM scip_documents WHERE scip_index_path=@idx)`;
    this.db
      .prepare(
        `DELETE FROM edges
         WHERE source IN (${fallbackNodes}) OR target IN (${fallbackNodes})`,
      )
      .run(p);
    this.db
      .prepare(
        `DELETE FROM nodes
         WHERE provenance='tree-sitter (scip-empty-fallback)'
           AND file_path IN (SELECT source_file_path FROM scip_documents WHERE scip_index_path=@idx)`,
      )
      .run(p);

    this.db.prepare(`DELETE FROM scip_documents WHERE scip_index_path=@idx`).run(p);
  }

  /**
   * Clean up a SCIP ingestion left incomplete by a crash: scoped-delete its
   * partial data and drop the `scip_ingestions` row. Destructive, not
   * restorative — the user must re-run the indexer to restore coverage.
   */
  cleanupIncompleteScipIngestion(scipIndexPath: string): void {
    this.db.transaction(() => {
      this.deleteScipIndexData(scipIndexPath);
      this.db
        .prepare(`DELETE FROM scip_ingestions WHERE scip_index_path=?`)
        .run(scipIndexPath);
    })();
  }

  /** `scip_index_path`s of ingestions that never completed (crash recovery). */
  getIncompleteScipIngestions(): string[] {
    const rows = this.db
      .prepare(`SELECT scip_index_path FROM scip_ingestions WHERE completed_at IS NULL`)
      .all() as Array<{ scip_index_path: string }>;
    return rows.map((r) => r.scip_index_path);
  }

  // ===========================================================================
  // File Operations
  // ===========================================================================

  /**
   * Insert or update a file record
   */
  upsertFile(file: FileRecord): void {
    if (!this.stmts.upsertFile) {
      this.stmts.upsertFile = this.db.prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
        VALUES (@path, @contentHash, @language, @size, @modifiedAt, @indexedAt, @nodeCount, @errors)
        ON CONFLICT(path) DO UPDATE SET
          content_hash = @contentHash,
          language = @language,
          size = @size,
          modified_at = @modifiedAt,
          indexed_at = @indexedAt,
          node_count = @nodeCount,
          errors = @errors
      `);
    }

    this.stmts.upsertFile.run({
      path: file.path,
      contentHash: file.contentHash,
      language: file.language,
      size: file.size,
      modifiedAt: file.modifiedAt,
      indexedAt: file.indexedAt,
      nodeCount: file.nodeCount,
      errors: file.errors ? JSON.stringify(file.errors) : null,
    });
  }

  /**
   * Delete a file record and its nodes
   */
  deleteFile(filePath: string): void {
    this.db.transaction(() => {
      this.deleteNodesByFile(filePath);
      if (!this.stmts.deleteFile) {
        this.stmts.deleteFile = this.db.prepare('DELETE FROM files WHERE path = ?');
      }
      this.stmts.deleteFile.run(filePath);
    })();
  }

  /**
   * Get a file record by path
   */
  getFileByPath(filePath: string): FileRecord | null {
    if (!this.stmts.getFileByPath) {
      this.stmts.getFileByPath = this.db.prepare('SELECT * FROM files WHERE path = ?');
    }
    const row = this.stmts.getFileByPath.get(filePath) as FileRow | undefined;
    return row ? rowToFileRecord(row) : null;
  }

  /**
   * Get all tracked files
   */
  getAllFiles(): FileRecord[] {
    if (!this.stmts.getAllFiles) {
      this.stmts.getAllFiles = this.db.prepare('SELECT * FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFiles.all() as FileRow[];
    return rows.map(rowToFileRecord);
  }

  /**
   * Get files that need re-indexing (hash changed)
   */
  getStaleFiles(currentHashes: Map<string, string>): FileRecord[] {
    const files = this.getAllFiles();
    return files.filter((f) => {
      const currentHash = currentHashes.get(f.path);
      return currentHash && currentHash !== f.contentHash;
    });
  }

  // ===========================================================================
  // Unresolved References
  // ===========================================================================

  /**
   * Insert an unresolved reference
   */
  insertUnresolvedRef(ref: UnresolvedReference): void {
    if (!this.stmts.insertUnresolved) {
      this.stmts.insertUnresolved = this.db.prepare(`
        INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language)
        VALUES (@fromNodeId, @referenceName, @referenceKind, @line, @col, @candidates, @filePath, @language)
      `);
    }

    this.stmts.insertUnresolved.run({
      fromNodeId: ref.fromNodeId,
      referenceName: ref.referenceName,
      referenceKind: ref.referenceKind,
      line: ref.line,
      col: ref.column,
      candidates: ref.candidates ? JSON.stringify(ref.candidates) : null,
      filePath: ref.filePath ?? '',
      language: ref.language ?? 'unknown',
    });
  }

  /**
   * Insert multiple unresolved references in a transaction
   */
  insertUnresolvedRefsBatch(refs: UnresolvedReference[]): void {
    if (refs.length === 0) return;
    const insert = this.db.transaction(() => {
      for (const ref of refs) {
        this.insertUnresolvedRef(ref);
      }
    });
    insert();
  }

  /**
   * Delete unresolved references from a node
   */
  deleteUnresolvedByNode(nodeId: string): void {
    if (!this.stmts.deleteUnresolvedByNode) {
      this.stmts.deleteUnresolvedByNode = this.db.prepare(
        'DELETE FROM unresolved_refs WHERE from_node_id = ?'
      );
    }
    this.stmts.deleteUnresolvedByNode.run(nodeId);
  }

  /**
   * Get unresolved references by name (for resolution)
   */
  getUnresolvedByName(name: string): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedByName) {
      this.stmts.getUnresolvedByName = this.db.prepare(
        'SELECT * FROM unresolved_refs WHERE reference_name = ?'
      );
    }
    const rows = this.stmts.getUnresolvedByName.all(name) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get all unresolved references
   */
  getUnresolvedReferences(): UnresolvedReference[] {
    const rows = this.db.prepare('SELECT * FROM unresolved_refs').all() as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get the count of unresolved references without loading them into memory
   */
  getUnresolvedReferencesCount(): number {
    if (!this.stmts.getUnresolvedCount) {
      this.stmts.getUnresolvedCount = this.db.prepare(
        'SELECT COUNT(*) as count FROM unresolved_refs'
      );
    }
    const row = this.stmts.getUnresolvedCount.get() as { count: number };
    return row.count;
  }

  /**
   * Get a batch of unresolved references using LIMIT/OFFSET pagination.
   * Used to process references in bounded memory chunks.
   */
  getUnresolvedReferencesBatch(offset: number, limit: number): UnresolvedReference[] {
    if (!this.stmts.getUnresolvedBatch) {
      this.stmts.getUnresolvedBatch = this.db.prepare(
        'SELECT * FROM unresolved_refs LIMIT ? OFFSET ?'
      );
    }
    const rows = this.stmts.getUnresolvedBatch.all(limit, offset) as UnresolvedRefRow[];
    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Get all tracked file paths (lightweight — no full FileRecord objects)
   */
  getAllFilePaths(): string[] {
    if (!this.stmts.getAllFilePaths) {
      this.stmts.getAllFilePaths = this.db.prepare('SELECT path FROM files ORDER BY path');
    }
    const rows = this.stmts.getAllFilePaths.all() as Array<{ path: string }>;
    return rows.map((r) => r.path);
  }

  /**
   * Get all distinct node names (lightweight — just name strings for pre-filtering)
   */
  getAllNodeNames(): string[] {
    if (!this.stmts.getAllNodeNames) {
      this.stmts.getAllNodeNames = this.db.prepare('SELECT DISTINCT name FROM nodes');
    }
    const rows = this.stmts.getAllNodeNames.all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  /**
   * Get unresolved references scoped to specific file paths.
   * Uses the idx_unresolved_file_path index for efficient lookup.
   */
  getUnresolvedReferencesByFiles(filePaths: string[]): UnresolvedReference[] {
    if (filePaths.length === 0) return [];

    const placeholders = filePaths.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT * FROM unresolved_refs WHERE file_path IN (${placeholders})`)
      .all(...filePaths) as UnresolvedRefRow[];

    return rows.map((row) => ({
      fromNodeId: row.from_node_id,
      referenceName: row.reference_name,
      referenceKind: row.reference_kind as EdgeKind,
      line: row.line,
      column: row.col,
      candidates: row.candidates ? safeJsonParse(row.candidates, undefined) : undefined,
      filePath: row.file_path,
      language: row.language as Language,
    }));
  }

  /**
   * Delete all unresolved references (after resolution)
   */
  clearUnresolvedReferences(): void {
    this.db.exec('DELETE FROM unresolved_refs');
  }

  /**
   * Delete resolved references by their IDs
   */
  deleteResolvedReferences(fromNodeIds: string[]): void {
    if (fromNodeIds.length === 0) return;
    const placeholders = fromNodeIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM unresolved_refs WHERE from_node_id IN (${placeholders})`).run(...fromNodeIds);
  }

  /**
   * Delete specific resolved references by (fromNodeId, referenceName, referenceKind) tuples.
   * More precise than deleteResolvedReferences — only removes refs that were actually resolved.
   */
  deleteSpecificResolvedReferences(refs: Array<{ fromNodeId: string; referenceName: string; referenceKind: string }>): void {
    if (refs.length === 0) return;
    const stmt = this.db.prepare(
      'DELETE FROM unresolved_refs WHERE from_node_id = ? AND reference_name = ? AND reference_kind = ?'
    );
    const deleteMany = this.db.transaction((items: typeof refs) => {
      for (const ref of items) {
        stmt.run(ref.fromNodeId, ref.referenceName, ref.referenceKind);
      }
    });
    deleteMany(refs);
  }

  // ===========================================================================
  // Statistics
  // ===========================================================================

  /**
   * Get graph statistics
   */
  getStats(): GraphStats {
    // Single query for all three aggregate counts
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM nodes) AS node_count,
        (SELECT COUNT(*) FROM edges) AS edge_count,
        (SELECT COUNT(*) FROM files) AS file_count
    `).get() as { node_count: number; edge_count: number; file_count: number };

    const nodesByKind = {} as Record<NodeKind, number>;
    const nodeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of nodeKindRows) {
      nodesByKind[row.kind as NodeKind] = row.count;
    }

    const edgesByKind = {} as Record<EdgeKind, number>;
    const edgeKindRows = this.db
      .prepare('SELECT kind, COUNT(*) as count FROM edges GROUP BY kind')
      .all() as Array<{ kind: string; count: number }>;
    for (const row of edgeKindRows) {
      edgesByKind[row.kind as EdgeKind] = row.count;
    }

    const filesByLanguage = {} as Record<Language, number>;
    const languageRows = this.db
      .prepare('SELECT language, COUNT(*) as count FROM files GROUP BY language')
      .all() as Array<{ language: string; count: number }>;
    for (const row of languageRows) {
      filesByLanguage[row.language as Language] = row.count;
    }

    return {
      nodeCount: counts.node_count,
      edgeCount: counts.edge_count,
      fileCount: counts.file_count,
      nodesByKind,
      edgesByKind,
      filesByLanguage,
      dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
      lastUpdated: Date.now(),
    };
  }

  // ===========================================================================
  // Project Metadata
  // ===========================================================================

  /**
   * Get a metadata value by key
   */
  getMetadata(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  /**
   * Set a metadata key-value pair (upsert)
   */
  setMetadata(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).run(key, value, Date.now());
  }

  /**
   * Get all metadata as a key-value record
   */
  getAllMetadata(): Record<string, string> {
    const rows = this.db.prepare('SELECT key, value FROM project_metadata').all() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  /**
   * Clear all graph data from the database.
   *
   * Wipes the SCIP bookkeeping tables (`scip_documents`, `scip_ingestions`,
   * `scip_external_refs`) alongside the graph tables: they describe coverage
   * that no longer exists once nodes/edges are gone. Leaving `scip_documents`
   * behind would make a subsequent index treat those paths as SCIP-covered and
   * skip them in the tree-sitter pass — silently un-indexing them.
   */
  clear(): void {
    this.nodeCache.clear();
    this.db.transaction(() => {
      this.db.exec('DELETE FROM unresolved_refs');
      this.db.exec('DELETE FROM edges');
      this.db.exec('DELETE FROM nodes');
      this.db.exec('DELETE FROM files');
      this.db.exec('DELETE FROM scip_external_refs');
      this.db.exec('DELETE FROM scip_documents');
      this.db.exec('DELETE FROM scip_ingestions');
    })();
  }
}
