/**
 * Go Framework Resolver — Phase 3 shape.
 *
 * `extract` → `synthesize`: gin/echo/chi/net-http style route registration.
 * `resolve` → `augment`: route→handler `references/convention` edges.
 * Legacy suffix-based by-name lookups (`*Handler`, `*Service`, `*Store`,
 * etc.) are dropped — they were heuristic best-effort against directory
 * conventions; augment now resolves via the graph's actual node set.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

const ROUTE_REGEX =
  /\b(?:router|r|mux|app|e)\.(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD|Get|Post|Put|Patch|Delete|Handle|HandleFunc)\s*\(\s*"([^"]+)"\s*,\s*([^)]+)\)/g;

export const goResolver: FrameworkResolver = {
  name: 'go',
  languages: ['go'],

  detect(context: ResolutionContext): boolean {
    const goMod = context.readFile('go.mod');
    if (goMod) return true;
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.go'));
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.go')) continue;
      const safe = graph.readFileStripped(file, 'go');
      if (!safe) continue;

      ROUTE_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ROUTE_REGEX.exec(safe)) !== null) {
        const [, rawMethod, routePath] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const method =
          rawMethod === 'Handle' || rawMethod === 'HandleFunc'
            ? 'ANY'
            : rawMethod!.toUpperCase();
        nodes.push({
          id: `framework:go:route:${file}:${line}:${method}:${routePath}`,
          kind: 'route',
          name: `${method} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'go',
          provenance: 'framework:go',
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
      if (route.provenance !== 'framework:go') continue;
      const safe = graph.readFileStripped(route.filePath, 'go');
      if (!safe) continue;
      const lineText = safe.split('\n')[route.startLine - 1];
      if (!lineText) continue;
      const m = lineText.match(
        /\b(?:router|r|mux|app|e)\.[A-Za-z]+\s*\(\s*"[^"]+"\s*,\s*([^)]+)\)/,
      );
      if (!m) continue;
      const handlerName = extractGoTailIdent(m[1]!);
      if (!handlerName) continue;

      const candidates = graph
        .getNodesByName(handlerName)
        .filter((n) => n.kind === 'function' || n.kind === 'method');
      if (candidates.length === 0) continue;
      let preferred = candidates.filter((n) => n.filePath === route.filePath);
      if (preferred.length === 0) preferred = candidates;
      if (preferred.length !== 1) continue;
      const target = preferred[0]!;

      edges.push({
        source: route.id,
        target: target.id,
        kind: 'references',
        subkind: 'convention',
        line: undefined,
        column: undefined,
        provenance: 'framework:go',
        confidence: 0.85,
      });
      tags.push({ nodeId: target.id, tags: ['route-handler'] });
    }

    return { edges, tags };
  },
};

function extractGoTailIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\s+/g, '').replace(/\(\)$/, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}
