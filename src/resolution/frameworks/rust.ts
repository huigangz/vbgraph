/**
 * Rust Framework Resolver — Phase 3 shape (with retained module resolution).
 *
 * `extract` → `synthesize`: Actix/Rocket attribute routes + axum DSL.
 * `resolve` PARTIALLY RETAINED: cargo-workspace crate-name → crate-root
 * module resolution stays (load-bearing for cross-crate `imports`
 * edges; tested in `__tests__/frameworks.test.ts` 'rustResolver.resolve
 * cargo workspace crates'). The suffix-based by-name lookups
 * (`*_handler`, `*Service`, PascalCase struct) are dropped — heuristic
 * best-effort that import resolution covers better.
 * `augment`: route→handler `references/convention` edges + tags.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  SynthesizeResult,
  UnresolvedRef,
} from '../types';
import { GraphView } from '../graph-view';
import { getCargoWorkspaceCrateMap } from './cargo-workspace';

const cargoWorkspaceMapCache = new WeakMap<ResolutionContext, Map<string, string>>();

function getCachedCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const cached = cargoWorkspaceMapCache.get(context);
  if (cached) return cached;
  const map = getCargoWorkspaceCrateMap(context);
  cargoWorkspaceMapCache.set(context, map);
  return map;
}

const ATTR_REGEX =
  /#\[(get|post|put|patch|delete|head|options)\s*\(\s*["']([^"']+)["'][^\]]*\)\]/g;
const AXUM_REGEX =
  /\.route\s*\(\s*"([^"]+)"\s*,\s*(get|post|put|patch|delete)\s*\(\s*(\w+)/g;

export const rustResolver: FrameworkResolver = {
  name: 'rust',
  languages: ['rust'],

  detect(context: ResolutionContext): boolean {
    return context.fileExists('Cargo.toml');
  },

  /**
   * Retained for cargo-workspace module resolution. Module references
   * (lowercase identifiers) try local `src/<name>.rs` / `src/<name>/mod.rs`
   * and workspace member crate roots. Workspace hits are high-confidence
   * (0.95) to beat name-matcher self-file matches.
   */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (!/^[a-z_]+$/.test(ref.referenceName)) return null;
    const result = resolveModule(ref.referenceName, context);
    if (!result) return null;
    return {
      original: ref,
      targetNodeId: result.targetId,
      confidence: result.fromWorkspace ? 0.95 : 0.6,
      resolvedBy: 'framework',
    };
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.rs')) continue;
      const safe = graph.readFileStripped(file, 'rust');
      if (!safe) continue;

      // Actix-web / Rocket attribute: #[get("/path")] fn handler(..)
      ATTR_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ATTR_REGEX.exec(safe)) !== null) {
        const [, method, routePath] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const upper = method!.toUpperCase();
        nodes.push({
          id: `framework:rust:route-attr:${file}:${line}:${upper}:${routePath}`,
          kind: 'route',
          name: `${upper} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'rust',
          provenance: 'framework:rust',
          updatedAt: now,
        });
      }

      // Axum: .route("/path", get(handler))
      AXUM_REGEX.lastIndex = 0;
      while ((match = AXUM_REGEX.exec(safe)) !== null) {
        const [, routePath, method] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const upper = method!.toUpperCase();
        nodes.push({
          id: `framework:rust:route-axum:${file}:${line}:${upper}:${routePath}`,
          kind: 'route',
          name: `${upper} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'rust',
          provenance: 'framework:rust',
          updatedAt: now,
        });
      }
    }

    return { nodes };
  },

  augment(graph: GraphView): AugmentResult {
    const edges: Edge[] = [];
    const tags: Array<{ nodeId: string; tags: string[] }> = [];

    for (const route of graph.getNodesByKind('route')) {
      if (route.provenance !== 'framework:rust') continue;
      const safe = graph.readFileStripped(route.filePath, 'rust');
      if (!safe) continue;
      const lines = safe.split('\n');
      const handlerName = findRustHandlerName(lines, route.startLine - 1);
      if (!handlerName) continue;

      const candidates = graph
        .getNodesByName(handlerName)
        .filter((n) => n.kind === 'function');
      if (candidates.length === 0) continue;
      let preferred = candidates.filter((n) => n.filePath === route.filePath);
      if (preferred.length === 0) preferred = candidates;
      if (preferred.length !== 1) continue;

      edges.push({
        source: route.id,
        target: preferred[0]!.id,
        kind: 'references',
        subkind: 'convention',
        line: undefined,
        column: undefined,
        provenance: 'framework:rust',
        confidence: 0.85,
      });
      tags.push({ nodeId: preferred[0]!.id, tags: ['route-handler'] });
    }

    return { edges, tags };
  },
};

function findRustHandlerName(lines: string[], startLine: number): string | null {
  const startLineText = lines[startLine] ?? '';
  // Axum same-line: .route("/x", get(handler))
  const axum = startLineText.match(
    /\.route\s*\(\s*"[^"]+"\s*,\s*(?:get|post|put|patch|delete)\s*\(\s*(\w+)/,
  );
  if (axum) return axum[1]!;
  // Attribute: walk forward up to 5 lines for `(pub) (async) fn name(`
  for (let i = startLine + 1; i < Math.min(lines.length, startLine + 6); i += 1) {
    const m = lines[i]!.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/);
    if (m) return m[1]!;
  }
  return null;
}

interface ModuleResolution {
  targetId: string;
  fromWorkspace: boolean;
}

function resolveModule(name: string, context: ResolutionContext): ModuleResolution | null {
  const localPaths = [`src/${name}.rs`, `src/${name}/mod.rs`];
  const workspaceCrates = getCachedCargoWorkspaceCrateMap(context);
  const cratePath = workspaceCrates.get(name);
  const workspacePaths = cratePath
    ? [`${cratePath}/src/lib.rs`, `${cratePath}/src/main.rs`]
    : [];

  const candidates: Array<{ path: string; fromWorkspace: boolean }> = [
    ...localPaths.map((path) => ({ path, fromWorkspace: false })),
    ...workspacePaths.map((path) => ({ path, fromWorkspace: true })),
  ];

  for (const { path: modPath, fromWorkspace } of candidates) {
    if (!context.fileExists(modPath)) continue;
    const nodes = context.getNodesInFile(modPath);
    const modNode = nodes.find((n) => n.kind === 'module');
    if (modNode) return { targetId: modNode.id, fromWorkspace };
    if (nodes.length > 0) return { targetId: nodes[0]!.id, fromWorkspace };
  }

  return null;
}
