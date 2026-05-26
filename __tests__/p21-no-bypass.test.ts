/**
 * P2.1.8 — CI bypass guard.
 *
 * Asserts every prepared statement that reads `nodes` or `edges` in
 * `src/db/queries.ts` either composes `freshPredicate(` (plus
 * `visibleNodeIdPredicate(` for edge SQL) OR appears on the explicit
 * INTERNAL allowlist below.
 *
 * If a future contributor adds a raw `SELECT … FROM nodes` or
 * `SELECT … FROM edges` outside `freshPredicate`, this test fails and
 * points them at:
 *   docs/plans/phase2/worklog/P2.1-query-inventory.md
 *
 * The guard is intentionally string-based, not AST-based: the surface
 * area is small (one file) and the SQL templates are stable. AST
 * parsing would add weight without catching anything string-matching
 * misses.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Allowlist: INTERNAL prepared statements that legitimately bypass the
// freshness filter. Each entry is matched as a substring against the SQL
// surrounding the offending line. The reason field is documentary; it has
// no effect on the assertion.
//
// Adding to this list = "I've thought about it, this read should see ALL
// rows including stale." See [P2.1-query-inventory.md](docs/plans/phase2/worklog/P2.1-query-inventory.md)
// for the rationale of each entry.
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  /** Substring expected near the offending SQL line; uniquely identifies the call site. */
  sqlMarker: string;
  /** Why this site bypasses the filter. */
  reason: string;
}

const NODE_ALLOWLIST: AllowlistEntry[] = [
  {
    sqlMarker: 'WHERE source IN (SELECT id FROM nodes WHERE scip_index_path=@idx)',
    reason: 'STAGE B scoped delete (deleteScipIndexData) — must see all SCIP rows including stale',
  },
  {
    sqlMarker: 'orphanExternal',
    reason: "STAGE B external-node orphan SELECT — variable name; matches `const orphanExternal = `SELECT id FROM nodes …`",
  },
  {
    sqlMarker: 'fallbackNodes',
    reason: "STAGE B scip-empty-fallback cleanup SELECT — variable name; matches `const fallbackNodes = `SELECT id FROM nodes …`",
  },
  {
    sqlMarker: '(SELECT COUNT(*) FROM nodes${nodeWhere})',
    reason: 'getStats / getStatsIncludingStale composite — when applyFreshFilter=false the nodeWhere is empty by design',
  },
  {
    sqlMarker: 'FROM nodes${nodeWhere} GROUP BY kind',
    reason: 'getStats / getStatsIncludingStale node-kind aggregate — same opt-in mechanism',
  },
  {
    sqlMarker: 'SUM(CASE WHEN stale=1 AND staleness_visible=0',
    reason: 'getStaleSummary — by definition reads raw stale columns',
  },
  {
    sqlMarker: 'COUNT(DISTINCT file_path) FROM nodes',
    reason: 'getStaleSummary file-count subquery — raw column read',
  },
  {
    sqlMarker: 'NOT IN (SELECT id FROM nodes WHERE stale = 1 AND staleness_visible = 0)',
    reason: 'visibleNodeIdPredicate helper itself — the subquery that powers Decision 7 endpoint visibility',
  },
  {
    sqlMarker: "SELECT COUNT(*) AS n FROM nodes WHERE file_path = ? AND provenance = 'tree-sitter'",
    reason: 'countShadowRowsForFile (P2.3.2) — narrow exact-match read for scip-refresh post-ingest assertion; by definition must read raw, the assertion is checking for stale leakage',
  },
  {
    sqlMarker: 'SELECT language, provenance, COUNT(*) AS count',
    reason: 'getNodeCountsByLanguageAndProvenance (P2.4.3) — status command groups by language+provenance to derive per-language tier; must read raw because hidden-stale SCIP rows still indicate Tier 1 coverage exists',
  },
  {
    sqlMarker: 'SELECT source_file_path FROM scip_documents WHERE scip_index_path',
    reason: 'getScipDocumentsForIndex (P2.3.2) — reads scip_documents (not nodes/edges), but text pattern is generic; included for safety',
  },
];

const EDGE_ALLOWLIST: AllowlistEntry[] = [
  {
    sqlMarker: 'SELECT provenance, provenances, confidence, metadata FROM edges',
    reason: 'upsertGraphEdge select (upsertEdgeSelect prepared statement) — internal upsert lookup, must see all rows',
  },
  {
    sqlMarker: "SELECT id, provenance, provenances FROM edges",
    reason: 'stripFrameworkContributionsFromEdges STAGE 0 audit — reads all rows for purge work',
  },
  {
    sqlMarker: '(SELECT COUNT(*) FROM edges${edgeWhere})',
    reason: 'getStats / getStatsIncludingStale composite — opt-in via applyFreshFilter',
  },
  {
    sqlMarker: 'FROM edges${edgeWhere} GROUP BY kind',
    reason: 'getStats / getStatsIncludingStale edge-kind aggregate',
  },
  {
    sqlMarker: 'SUM(CASE WHEN stale=1 AND staleness_visible=0 THEN 1 ELSE 0 END) AS hidden_edges',
    reason: 'getStaleSummary edge category breakdown — raw read by design',
  },
  {
    sqlMarker: 'SELECT * FROM edges WHERE source = ? AND',
    reason: '*IncludingDanglingEndpoints siblings (review fix #4) — bypass visibleNodeIdPredicate by design (the whole point of the sibling); the inline-context check would also match the default getOutgoingEdges, but THAT line already includes visibleNodeIdPredicate so it passes its own predicate check independently',
  },
  {
    sqlMarker: 'SELECT * FROM edges WHERE target = ? AND',
    reason: 'Counterpart to the source-side variant above (getIncomingEdgesIncludingDanglingEndpoints)',
  },
  {
    sqlMarker: 'AND source IN (SELECT value FROM json_each(?))',
    reason: 'findEdgesBetweenNodesIncludingDanglingEndpoints — same rationale',
  },
  {
    sqlMarker: 'SELECT COUNT(*) AS n FROM edges',
    reason: 'countDanglingEdgesAgainstHiddenStale (review fix #4) — by definition counts what the visibility filter hides; status diagnostic',
  },
];

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

const QUERIES_TS_PATH = path.join(__dirname, '..', 'src', 'db', 'queries.ts');

/**
 * Extract lines that READ from `nodes` (SELECT or JOIN). Filters out writes
 * (DELETE / UPDATE / INSERT) — those don't need freshness filtering; they're
 * the source of staleness state.
 */
/**
 * Returns true if the line is part of a write statement (DELETE/INSERT/UPDATE).
 * Looks at the line itself AND a few lines back (multi-line DELETE statements
 * like `\`DELETE FROM edges\\n  WHERE …`).
 */
function isPartOfWrite(allLines: string[], lineIdx: number, table: 'nodes' | 'edges'): boolean {
  // Pattern A: DELETE FROM <table> on this exact line.
  if (new RegExp(`\\bDELETE\\s+FROM\\s+${table}\\b`, 'i').test(allLines[lineIdx])) return true;
  // Pattern B: INSERT (OR ?) INTO <table>.
  if (new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}\\b`, 'i').test(allLines[lineIdx])) return true;
  // Pattern C: UPDATE <table> SET.
  if (new RegExp(`\\bUPDATE\\s+${table}\\b`, 'i').test(allLines[lineIdx])) return true;
  // Pattern D: a DELETE/INSERT/UPDATE within 3 lines BEFORE, where the FROM/INTO
  // didn't fit on the same line as the verb. These are multi-line writes like:
  //   `DELETE FROM edges
  //    WHERE source IN (SELECT id FROM nodes …)`
  // The inner `SELECT id FROM nodes` is part of the DELETE's subquery — not a public read.
  // But we ONLY want to skip the OUTER table's FROM line, not all nested SELECTs.
  // Actually the simpler rule: if the FROM <table> appears in a backtick template that
  // started with DELETE/INSERT/UPDATE, skip it.
  // Lookback distance: 12 lines covers multi-line WHERE source IN (…) OR
  // target IN (…) patterns where the outer DELETE is up to a dozen lines
  // before the inner SELECT. Wider than the "compose predicate ahead" pattern
  // of public read queries, so this should not cause false negatives.
  for (let i = Math.max(0, lineIdx - 12); i < lineIdx; i++) {
    if (/\b(?:DELETE|INSERT|UPDATE)\s+(?:FROM\s+|OR\s+\w+\s+INTO\s+|INTO\s+|)?(?:nodes|edges)?\s*$/i.test(allLines[i].trimEnd())) {
      // The verb was on a prior line and FROM/INTO is on the current line.
      return true;
    }
    // Backtick-opened DELETE statement: ` `DELETE FROM table\n  WHERE …`
    if (/`\s*DELETE\s+FROM\s+\w+\s*$/i.test(allLines[i].trimEnd())) return true;
  }
  return false;
}

function findNodeReadLines(source: string): Array<{ lineNo: number; text: string }> {
  const lines = source.split('\n');
  const out: Array<{ lineNo: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    // Skip pure comments and JSDoc lines.
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    // Skip ALTER TABLE / CREATE INDEX (schema / migration).
    if (/\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX)/.test(text)) continue;
    // Must reference nodes as a SELECT target / JOIN.
    if (!(/\bFROM\s+nodes\b/.test(text) || /\bJOIN\s+nodes\b/.test(text))) continue;
    // Skip write statements (DELETE/INSERT/UPDATE — including multi-line).
    if (isPartOfWrite(lines, i, 'nodes')) continue;
    // Skip the helper's OWN subquery (visibleNodeIdPredicate body) — it's the
    // canonical hidden-set fetch; flagging it would be self-referential.
    if (/NOT IN \(SELECT id FROM nodes WHERE stale = 1/.test(text)) continue;
    out.push({ lineNo: i + 1, text });
  }
  return out;
}

function findEdgeReadLines(source: string): Array<{ lineNo: number; text: string }> {
  const lines = source.split('\n');
  const out: Array<{ lineNo: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (/\b(?:ALTER\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX)/.test(text)) continue;
    if (!(/\bFROM\s+edges\b/.test(text) || /\bJOIN\s+edges\b/.test(text))) continue;
    if (isPartOfWrite(lines, i, 'edges')) continue;
    out.push({ lineNo: i + 1, text });
  }
  return out;
}

/**
 * Return the substring of `source` around `lineNo` (±contextLines on each side).
 * Expanded to 15 lines on each side because some prepared statements use
 * dynamic SQL builders that compose the predicate several lines after the
 * `FROM nodes`/`FROM edges` literal.
 */
function contextWindow(source: string, lineNo: number, contextLines: number = 15): string {
  const lines = source.split('\n');
  const start = Math.max(0, lineNo - 1 - contextLines);
  const end = Math.min(lines.length, lineNo + contextLines);
  return lines.slice(start, end).join('\n');
}

function isAllowlisted(window: string, allowlist: AllowlistEntry[]): boolean {
  return allowlist.some((entry) => window.includes(entry.sqlMarker));
}

function hasFreshPredicate(window: string): boolean {
  return window.includes('freshPredicate(');
}

function hasVisibleNodeIdPredicate(window: string): boolean {
  return window.includes('visibleNodeIdPredicate(');
}

describe('P2.1.8 — CI bypass guard', () => {
  const source = fs.readFileSync(QUERIES_TS_PATH, 'utf8');

  it('every node read in src/db/queries.ts uses freshPredicate() or is allowlisted', () => {
    const matches = findNodeReadLines(source);
    expect(matches.length).toBeGreaterThan(0); // sanity: grep should find something

    const violations: Array<{ lineNo: number; text: string; context: string }> = [];
    for (const match of matches) {
      // Skip the doc comments in freshPredicate's JSDoc.
      if (
        /SELECT.*FROM nodes\$\{freshPredicate\(/.test(match.text) ||  // template string in doc
        /freshPredicate\b.*nodes\b/.test(match.text) ||
        /visibleNodeIdPredicate/.test(match.text)
      ) {
        // It's the helper itself (line ~222) or example doc. Skip.
        if (match.text.includes('visibleNodeIdPredicate') || match.text.includes('return `(')) continue;
      }

      const window = contextWindow(source, match.lineNo, 25);

      if (hasFreshPredicate(window) || isAllowlisted(window, NODE_ALLOWLIST)) {
        continue;
      }
      // Doc-comment example lines inside the helper's JSDoc — skip them.
      // These start with ` *` (markdown-style asterisks in JSDoc) and aren't real SQL.
      if (/^\s*\*\s/.test(match.text)) continue;

      violations.push({ lineNo: match.lineNo, text: match.text.trim(), context: window });
    }

    if (violations.length > 0) {
      const report = violations
        .map(
          (v) =>
            `\n  src/db/queries.ts:${v.lineNo}\n    SQL: ${v.text}\n    Context:\n${v.context
              .split('\n')
              .map((l) => '      ' + l)
              .join('\n')}`,
        )
        .join('\n');
      throw new Error(
        `${violations.length} node SQL site(s) bypass freshPredicate without allowlist entry. ` +
          `Add freshPredicate() to the query OR add an entry to NODE_ALLOWLIST in ` +
          `__tests__/p21-no-bypass.test.ts with rationale. See ` +
          `docs/plans/phase2/worklog/P2.1-query-inventory.md.${report}`,
      );
    }
  });

  it('every edge read in src/db/queries.ts uses freshPredicate() + visibleNodeIdPredicate() or is allowlisted', () => {
    const matches = findEdgeReadLines(source);
    expect(matches.length).toBeGreaterThan(0);

    const violations: Array<{ lineNo: number; text: string; context: string; missing: string }> = [];
    for (const match of matches) {
      // Skip doc-comment example lines (markdown-style * prefix).
      if (/^\s*\*\s/.test(match.text)) continue;

      const window = contextWindow(source, match.lineNo, 25);

      if (isAllowlisted(window, EDGE_ALLOWLIST)) continue;

      // Public edge reads need BOTH predicates.
      const hasFresh = hasFreshPredicate(window);
      const hasVisible = hasVisibleNodeIdPredicate(window);

      if (hasFresh && hasVisible) continue;

      const missing = !hasFresh && !hasVisible
        ? 'freshPredicate + visibleNodeIdPredicate'
        : !hasFresh
          ? 'freshPredicate'
          : 'visibleNodeIdPredicate';

      violations.push({
        lineNo: match.lineNo,
        text: match.text.trim(),
        context: window,
        missing,
      });
    }

    if (violations.length > 0) {
      const report = violations
        .map(
          (v) =>
            `\n  src/db/queries.ts:${v.lineNo}\n    Missing: ${v.missing}\n    SQL: ${v.text}\n    Context:\n${v.context
              .split('\n')
              .map((l) => '      ' + l)
              .join('\n')}`,
        )
        .join('\n');
      throw new Error(
        `${violations.length} edge SQL site(s) bypass the visibility-coherent default. ` +
          `Add freshPredicate() + visibleNodeIdPredicate() to source AND target columns, OR ` +
          `add an entry to EDGE_ALLOWLIST with rationale. See ` +
          `docs/plans/phase2/worklog/P2.1-query-inventory.md.${report}`,
      );
    }
  });

  it('the helper functions themselves are exported (smoke)', async () => {
    const queries = await import('../src/db/queries');
    expect(typeof queries.freshPredicate).toBe('function');
    expect(typeof queries.visibleNodeIdPredicate).toBe('function');
    expect(queries.freshPredicate()).toBe('(stale = 0 OR staleness_visible = 1)');
    expect(queries.freshPredicate('n')).toBe('(n.stale = 0 OR n.staleness_visible = 1)');
    expect(queries.freshPredicate('n.')).toBe('(n.stale = 0 OR n.staleness_visible = 1)');
    expect(queries.visibleNodeIdPredicate()).toBe(
      'NOT IN (SELECT id FROM nodes WHERE stale = 1 AND staleness_visible = 0)',
    );
  });
});
