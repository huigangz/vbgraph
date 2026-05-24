/**
 * Express / Node.js Framework Resolver — Phase 3 shape.
 *
 * `extract` → `synthesize`: routes from `(app|router).METHOD('/path', …, handler)`.
 * `resolve` → `augment`: route→handler `references/convention` edges plus
 * `express:middleware` / `route-handler` tags. The legacy by-name suffix
 * resolution paths (controller method matching, service helpers, generic
 * middleware) are dropped — P0.5b's scope resolver covers file-local
 * refs in ts/js, and Phase 3 only needs to attach the routing convention.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

function extractTailIdent(expr: string): string | null {
  const cleaned = expr.replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}

function detectLanguage(filePath: string): 'typescript' | 'javascript' {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
    return 'typescript';
  }
  return 'javascript';
}

const ROUTE_REGEX =
  /\b(app|router)\.(get|post|put|patch|delete|all|use)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;

export const expressResolver: FrameworkResolver = {
  name: 'express',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // Check for Express in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.express || deps.fastify || deps.koa || deps.hapi) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for common Express patterns
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (
        file.includes('routes') ||
        file.includes('controllers') ||
        file.includes('middleware')
      ) {
        const content = context.readFile(file);
        if (content && (content.includes('express') || content.includes('app.get') || content.includes('router.get'))) {
          return true;
        }
      }
    }

    return false;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!/\.(m?js|tsx?|cjs)$/.test(file)) continue;
      const language = detectLanguage(file);
      const safe = graph.readFileStripped(file, language);
      if (!safe) continue;

      let match: RegExpExecArray | null;
      ROUTE_REGEX.lastIndex = 0;
      while ((match = ROUTE_REGEX.exec(safe)) !== null) {
        const [, _obj, method, routePath, _handlers] = match;
        if (method === 'use' && !routePath!.startsWith('/')) continue;
        const line = safe.slice(0, match.index).split('\n').length;
        nodes.push({
          id: `framework:express:route:${method!.toUpperCase()}:${routePath}:${file}:${line}`,
          kind: 'route',
          name: `${method!.toUpperCase()} ${routePath}`,
          qualifiedName: `${file}::${method!.toUpperCase()}:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language,
          provenance: 'framework:express',
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
      if (route.provenance !== 'framework:express') continue;
      const linked = linkRoute(graph, route);
      if (!linked) continue;
      const { handlerId, middlewareIds } = linked;

      edges.push({
        source: route.id,
        target: handlerId,
        kind: 'references',
        subkind: 'convention',
        line: undefined,
        column: undefined,
        provenance: 'framework:express',
        confidence: 0.85,
      });
      tags.push({ nodeId: handlerId, tags: ['route-handler'] });
      for (const mwId of middlewareIds) {
        edges.push({
          source: route.id,
          target: mwId,
          kind: 'references',
          subkind: 'convention',
          line: undefined,
          column: undefined,
          provenance: 'framework:express',
          confidence: 0.85,
        });
        tags.push({ nodeId: mwId, tags: ['express:middleware'] });
      }
    }

    return { edges, tags };
  },
};

interface RouteLink {
  handlerId: string;
  middlewareIds: string[];
}

/**
 * For an express route node, reconstruct the matching source line and
 * recover the handler ident (last comma-separated arg) plus any middleware
 * idents (earlier args). Returns nulls if the file can't be read or the
 * route line no longer matches.
 */
function linkRoute(graph: GraphView, route: Node): RouteLink | null {
  const language = detectLanguage(route.filePath);
  const safe = graph.readFileStripped(route.filePath, language);
  if (!safe) return null;
  const lines = safe.split('\n');
  const lineText = lines[route.startLine - 1];
  if (!lineText) return null;

  const m = lineText.match(
    /\b(?:app|router)\.(?:get|post|put|patch|delete|all|use)\s*\(\s*['"][^'"]+['"]\s*,\s*([^)]+)\)/,
  );
  if (!m) return null;

  const parts = m[1]!.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const handlerExpr = parts[parts.length - 1]!;
  const handlerName = extractTailIdent(handlerExpr);
  if (!handlerName) return null;

  const handlerId = resolveIdentToNodeId(graph, route.filePath, handlerName);
  if (!handlerId) return null;

  const middlewareIds: string[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const mwName = extractTailIdent(parts[i]!);
    if (!mwName) continue;
    const mwId = resolveIdentToNodeId(graph, route.filePath, mwName);
    if (mwId) middlewareIds.push(mwId);
  }

  return { handlerId, middlewareIds };
}

/**
 * Strict resolution: same-file unique match first, then unique global match.
 * Returns null on ambiguity to keep precision high (per the plan's
 * conservative-edge-emission convention).
 */
function resolveIdentToNodeId(
  graph: GraphView,
  routeFile: string,
  name: string,
): string | null {
  const candidates = graph
    .getNodesByName(name)
    .filter((n) => n.kind === 'method' || n.kind === 'function');
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!.id;
  const sameFile = candidates.filter((n) => n.filePath === routeFile);
  if (sameFile.length === 1) return sameFile[0]!.id;
  return null;
}
