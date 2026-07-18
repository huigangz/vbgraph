/**
 * P0.5b — resolution-parity harness + runner.
 *
 * The borrowed *methodology*: an edge resolved by the SCIP backend and the same
 * edge resolved by the tree-sitter path must come out semantically equal. This
 * harness compares two edge sets by `(sourceQualifiedName, targetQualifiedName,
 * kind)` fingerprint, preserves per-fingerprint call-site counts (so a missed
 * call site is not hidden by fingerprint collapsing), and flags divergence —
 * accepting the compiler-magic categories SCIP legitimately resolves alone.
 *
 * `runParity` is the full-pipeline runner: it ingests a committed `.scip`,
 * tree-sitter-extracts the same files, and returns the comparison. It lives in
 * `src/` (not `__tests__/`) because the `vbgraph parity` CLI subcommand
 * drives it — the harness core moved here with it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { Edge, EdgeKind, Language, Node } from './types';

/** Identity of an edge for cross-backend comparison — ignores line/col. */
export interface EdgeFingerprint {
  sourceQualifiedName: string;
  targetQualifiedName: string;
  kind: EdgeKind;
}

/** Per-fingerprint call-site accounting. */
export interface ParityRow {
  fingerprint: EdgeFingerprint;
  /** Distinct SCIP rows (by line/col) for this fingerprint. */
  scipCallSites: number;
  /** Distinct tree-sitter rows for this fingerprint. */
  treeSitterCallSites: number;
  /** `max(0, scipCallSites - treeSitterCallSites)` — call sites tree-sitter missed. */
  missedSites: number;
}

export interface ParityReport {
  scipOnly: EdgeFingerprint[];
  treeSitterOnly: EdgeFingerprint[];
  shared: EdgeFingerprint[];
  rows: ParityRow[];
}

/** Divergence categories that are expected and accepted (compiler magic). */
export interface AllowedDivergence {
  /** Fingerprint-kind labels SCIP is allowed to resolve alone. */
  scipOnlyKinds: string[];
  /** tree-sitter should never resolve an edge SCIP lacks — normally empty. */
  treeSitterOnlyKinds: string[];
}

export interface ParityTolerance {
  /** Permitted absolute confidence delta (informational). */
  confidenceDelta: number;
}

/**
 * VB.NET compiler-magic features that legitimately appear only in the SCIP
 * graph — tree-sitter cannot see them, so they are accepted divergences.
 */
export const VBNET_ALLOWED_DIVERGENCE: AllowedDivergence = {
  scipOnlyKinds: [
    'calls (My.* synthesized member)',
    'references (project-level Imports)',
    'calls (WithEvents+Handles auto-binding)',
    'calls (late binding, Option Strict Off)',
  ],
  treeSitterOnlyKinds: [],
};

function fingerprintKey(fp: EdgeFingerprint): string {
  return `${fp.sourceQualifiedName} ${fp.targetQualifiedName} ${fp.kind}`;
}

/** `(line,col)` key — distinguishes call sites within one fingerprint. */
function callSiteKey(edge: Edge): string {
  return `${edge.line ?? -1}:${edge.column ?? -1}`;
}

interface FingerprintGroup {
  fingerprint: EdgeFingerprint;
  callSites: Set<string>;
}

/** Group edges by fingerprint, counting distinct call sites. */
function groupByFingerprint(
  edges: Edge[],
  qualifiedNameOf: (nodeId: string) => string | undefined,
): Map<string, FingerprintGroup> {
  const groups = new Map<string, FingerprintGroup>();
  for (const edge of edges) {
    const sourceQualifiedName = qualifiedNameOf(edge.source) ?? edge.source;
    const targetQualifiedName = qualifiedNameOf(edge.target) ?? edge.target;
    const fingerprint: EdgeFingerprint = {
      sourceQualifiedName,
      targetQualifiedName,
      kind: edge.kind,
    };
    const key = fingerprintKey(fingerprint);
    let group = groups.get(key);
    if (!group) {
      group = { fingerprint, callSites: new Set() };
      groups.set(key, group);
    }
    group.callSites.add(callSiteKey(edge));
  }
  return groups;
}

/**
 * Compare a SCIP-produced and a tree-sitter-produced edge set.
 *
 * @param qualifiedNameOf  resolves a node id to its qualified name (for
 *                         fingerprinting); falls back to the raw id when absent.
 */
export function buildParityReport(
  scipEdges: Edge[],
  treeSitterEdges: Edge[],
  qualifiedNameOf: (nodeId: string) => string | undefined,
): ParityReport {
  const scipGroups = groupByFingerprint(scipEdges, qualifiedNameOf);
  const tsGroups = groupByFingerprint(treeSitterEdges, qualifiedNameOf);

  const scipOnly: EdgeFingerprint[] = [];
  const treeSitterOnly: EdgeFingerprint[] = [];
  const shared: EdgeFingerprint[] = [];
  const rows: ParityRow[] = [];

  for (const [key, scipGroup] of scipGroups) {
    const tsGroup = tsGroups.get(key);
    const scipCallSites = scipGroup.callSites.size;
    const treeSitterCallSites = tsGroup ? tsGroup.callSites.size : 0;
    rows.push({
      fingerprint: scipGroup.fingerprint,
      scipCallSites,
      treeSitterCallSites,
      missedSites: Math.max(0, scipCallSites - treeSitterCallSites),
    });
    if (tsGroup) {
      shared.push(scipGroup.fingerprint);
    } else {
      scipOnly.push(scipGroup.fingerprint);
    }
  }
  for (const [key, tsGroup] of tsGroups) {
    if (!scipGroups.has(key)) {
      treeSitterOnly.push(tsGroup.fingerprint);
    }
  }

  return { scipOnly, treeSitterOnly, shared, rows };
}

/** Build a node-id -> qualifiedName resolver from a node list. */
export function qualifiedNameResolver(
  nodes: Node[],
): (nodeId: string) => string | undefined {
  const map = new Map(nodes.map((n) => [n.id, n.qualifiedName]));
  return (id) => map.get(id);
}

/**
 * Assert two edge sets are equivalent for non-compiler-magic features.
 *
 * Fails when tree-sitter missed a call site of a shared fingerprint
 * (`missedSites > 0`), when SCIP resolved a fingerprint tree-sitter did not
 * *and* its kind is not in `allowedDivergence.scipOnlyKinds`, or when
 * tree-sitter produced an edge SCIP lacks outside `treeSitterOnlyKinds`.
 *
 * @throws {Error} listing every unexpected divergence.
 */
export function assertEdgesEquivalent(
  scipEdges: Edge[],
  treeSitterEdges: Edge[],
  qualifiedNameOf: (nodeId: string) => string | undefined,
  opts: { allowedDivergence?: AllowedDivergence; tolerance?: ParityTolerance } = {},
): void {
  const report = buildParityReport(scipEdges, treeSitterEdges, qualifiedNameOf);
  const allowed = opts.allowedDivergence ?? { scipOnlyKinds: [], treeSitterOnlyKinds: [] };
  const problems: string[] = [];

  for (const row of report.rows) {
    // Only a *shared* fingerprint can have "missed" call sites; a fingerprint
    // tree-sitter resolved zero times is scip-only, handled by the loop below.
    if (row.missedSites > 0 && row.treeSitterCallSites > 0) {
      problems.push(
        `tree-sitter missed ${row.missedSites} call site(s) of ` +
          `${row.fingerprint.sourceQualifiedName} -> ` +
          `${row.fingerprint.targetQualifiedName} (${row.fingerprint.kind})`,
      );
    }
  }
  for (const fp of report.scipOnly) {
    if (!allowed.scipOnlyKinds.some((label) => label.startsWith(fp.kind))) {
      problems.push(
        `SCIP-only edge not in allowed divergence: ` +
          `${fp.sourceQualifiedName} -> ${fp.targetQualifiedName} (${fp.kind})`,
      );
    }
  }
  for (const fp of report.treeSitterOnly) {
    if (!allowed.treeSitterOnlyKinds.some((label) => label.startsWith(fp.kind))) {
      problems.push(
        `tree-sitter-only edge (SCIP lacks it): ` +
          `${fp.sourceQualifiedName} -> ${fp.targetQualifiedName} (${fp.kind})`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(`parity divergence:\n  - ${problems.join('\n  - ')}`);
  }
}

// ---------------------------------------------------------------------------
// runParity — full-pipeline runner
// ---------------------------------------------------------------------------

/** Result of `runParity` — the report plus the inputs it was built from. */
export interface ParityRunResult {
  /** The `.scip` index ingested (absolute path). */
  scipPath: string;
  /** Source files compared on both backends (relative to the fixture root). */
  files: string[];
  /** SCIP-backend edge-row count (pre-fingerprint). */
  scipEdgeCount: number;
  /** tree-sitter-backend edge-row count (pre-fingerprint). */
  treeSitterEdgeCount: number;
  /** The fingerprint-level comparison. */
  report: ParityReport;
}

/** Locate the `.scip` index inside a fixture directory. */
function findScipIndex(fixtureDir: string): string {
  const direct = path.join(fixtureDir, 'index.scip');
  if (fs.existsSync(direct)) {
    return direct;
  }
  const scip = fs
    .readdirSync(fixtureDir)
    .filter((f) => f.toLowerCase().endsWith('.scip'))
    .sort();
  if (scip.length === 0) {
    throw new Error(`no .scip index found in fixture directory: ${fixtureDir}`);
  }
  return path.join(fixtureDir, scip[0]!);
}

/**
 * Run the resolution-parity comparison over a committed fixture: ingest its
 * `.scip` index on the SCIP backend, tree-sitter-extract the same files, and
 * compare the two edge sets.
 *
 * Edges are fingerprinted by node **name** rather than qualified name — the
 * SCIP and tree-sitter backends mint different qualified-name shapes
 * (`Catalog.ShapeCatalog` vs `Catalog::ShapeCatalog`), so a qualified-name
 * fingerprint would report everything as divergent. Name fingerprints surface
 * the genuine shared backbone and the SCIP-only compiler-grade uplift.
 */
export async function runParity(fixturePath: string): Promise<ParityRunResult> {
  const fixtureDir = path.resolve(fixturePath);
  if (!fs.existsSync(fixtureDir) || !fs.statSync(fixtureDir).isDirectory()) {
    throw new Error(`fixture path is not a directory: ${fixtureDir}`);
  }
  const scipPath = findScipIndex(fixtureDir);

  // Heavy modules are imported lazily so importing the harness core (used by
  // tests) does not pull in the SQLite backend or the tree-sitter grammars.
  const { DatabaseConnection } = await import('./db');
  const { QueryBuilder } = await import('./db/queries');
  const { persistScipIndex } = await import('./extraction/scip/persister');
  const { extractFromSource } = await import('./extraction');
  const { initGrammars, loadGrammarsForLanguages, EXTENSION_MAP } = await import(
    './extraction/grammars'
  );

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vbgraph-parity-'));
  const conn = DatabaseConnection.initialize(path.join(tmpDir, 'parity.db'));
  try {
    const db = conn.getDb();
    const qb = new QueryBuilder(db);

    // --- SCIP backend ------------------------------------------------------
    await persistScipIndex({ scipPath, projectRoot: fixtureDir, db, qb });

    const scipNodes = db.prepare(`SELECT id, name FROM nodes`).all() as Array<{
      id: string;
      name: string;
    }>;
    const scipEdges = (
      db.prepare(`SELECT source, target, kind, line, col FROM edges`).all() as Array<{
        source: string;
        target: string;
        kind: string;
        line: number | null;
        col: number | null;
      }>
    ).map(
      (r) =>
        ({
          source: r.source,
          target: r.target,
          kind: r.kind,
          line: r.line ?? undefined,
          column: r.col ?? undefined,
        }) as Edge,
    );
    const files = (
      db
        .prepare(`SELECT source_file_path FROM scip_documents ORDER BY source_file_path`)
        .all() as Array<{ source_file_path: string }>
    ).map((d) => d.source_file_path);

    // --- tree-sitter backend ----------------------------------------------
    const languages = [
      ...new Set(
        files
          .map((f) => EXTENSION_MAP[path.extname(f).toLowerCase()])
          .filter((l): l is Language => !!l && l !== 'unknown' && l !== 'external'),
      ),
    ];
    await initGrammars();
    if (languages.length > 0) {
      await loadGrammarsForLanguages(languages);
    }

    const tsNodes: Node[] = [];
    const tsEdges: Edge[] = [];
    for (const file of files) {
      const abs = path.join(fixtureDir, file);
      if (!fs.existsSync(abs)) {
        continue;
      }
      const extracted = extractFromSource(file, fs.readFileSync(abs, 'utf8'));
      tsNodes.push(...extracted.nodes);
      tsEdges.push(...extracted.edges);
    }

    // --- compare -----------------------------------------------------------
    const nameById = new Map<string, string>();
    for (const n of scipNodes) nameById.set(n.id, n.name);
    for (const n of tsNodes) nameById.set(n.id, n.name);

    const report = buildParityReport(scipEdges, tsEdges, (id) => nameById.get(id));
    return {
      scipPath,
      files,
      scipEdgeCount: scipEdges.length,
      treeSitterEdgeCount: tsEdges.length,
      report,
    };
  } finally {
    conn.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
