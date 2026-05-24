/**
 * Laravel Framework Resolver — Phase 3 shape.
 *
 * `extract` → `synthesize`: routes from `routes/web.php` etc.
 * `resolve` → `augment`: route→handler `references/convention` edges
 * (handler is `Controller@method` or `[Controller::class, 'method']`)
 * PLUS facade-call edges via the Phase 3 graph — for each `calls` edge
 * whose target name is a Facade in `FACADE_MAPPINGS`, emit a
 * `references/convention` edge from the caller to the facade's
 * underlying-class node when present in the indexed code.
 *
 * The legacy by-name `Model::method` / `Controller@method` lookups
 * (`resolveModelCall`, `resolveControllerMethod`) are dropped — they
 * were heuristic file-path-convention lookups; augment's handler-name
 * resolution covers the same cases more precisely when the controller
 * exists in the graph.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

export const FACADE_MAPPINGS: Record<string, string> = {
  Auth: 'Illuminate\\Auth\\AuthManager',
  Cache: 'Illuminate\\Cache\\CacheManager',
  Config: 'Illuminate\\Config\\Repository',
  DB: 'Illuminate\\Database\\DatabaseManager',
  Event: 'Illuminate\\Events\\Dispatcher',
  File: 'Illuminate\\Filesystem\\Filesystem',
  Gate: 'Illuminate\\Auth\\Access\\Gate',
  Hash: 'Illuminate\\Hashing\\HashManager',
  Log: 'Illuminate\\Log\\LogManager',
  Mail: 'Illuminate\\Mail\\Mailer',
  Queue: 'Illuminate\\Queue\\QueueManager',
  Redis: 'Illuminate\\Redis\\RedisManager',
  Request: 'Illuminate\\Http\\Request',
  Response: 'Illuminate\\Http\\Response',
  Route: 'Illuminate\\Routing\\Router',
  Session: 'Illuminate\\Session\\SessionManager',
  Storage: 'Illuminate\\Filesystem\\FilesystemManager',
  URL: 'Illuminate\\Routing\\UrlGenerator',
  Validator: 'Illuminate\\Validation\\Factory',
  View: 'Illuminate\\View\\Factory',
};

const ROUTE_REGEX =
  /Route::(get|post|put|patch|delete|options|any)\s*\(\s*['"]([^'"]+)['"]\s*,\s*([^)]+)\)/g;
const RESOURCE_REGEX =
  /Route::(resource|apiResource)\s*\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\)/g;

export const laravelResolver: FrameworkResolver = {
  name: 'laravel',
  languages: ['php'],

  detect(context: ResolutionContext): boolean {
    return context.fileExists('artisan') || context.fileExists('app/Http/Kernel.php');
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.php')) continue;
      const safe = graph.readFileStripped(file, 'php');
      if (!safe) continue;

      ROUTE_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = ROUTE_REGEX.exec(safe)) !== null) {
        const [, method, routePath] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const upper = method!.toUpperCase();
        nodes.push({
          id: `framework:laravel:route:${file}:${line}:${upper}:${routePath}`,
          kind: 'route',
          name: `${upper} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'php',
          provenance: 'framework:laravel',
          updatedAt: now,
        });
      }

      RESOURCE_REGEX.lastIndex = 0;
      while ((match = RESOURCE_REGEX.exec(safe)) !== null) {
        const [, _fn, resourceName] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        nodes.push({
          id: `framework:laravel:resource:${file}:${line}:${resourceName}`,
          kind: 'route',
          name: `resource:${resourceName}`,
          qualifiedName: `${file}::route:${resourceName}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'php',
          provenance: 'framework:laravel',
          updatedAt: now,
        });
      }
    }

    return { nodes };
  },

  augment(graph: GraphView): AugmentResult {
    const edges: Edge[] = [];
    const tags: Array<{ nodeId: string; tags: string[] }> = [];

    // Route → handler convention edges.
    for (const route of graph.getNodesByKind('route')) {
      if (route.provenance !== 'framework:laravel') continue;
      const safe = graph.readFileStripped(route.filePath, 'php');
      if (!safe) continue;
      const lineText = safe.split('\n')[route.startLine - 1];
      if (!lineText) continue;

      const m =
        lineText.match(
          /Route::(?:get|post|put|patch|delete|options|any)\s*\(\s*['"][^'"]+['"]\s*,\s*([^)]+)\)/,
        ) ||
        lineText.match(
          /Route::(?:resource|apiResource)\s*\(\s*['"][^'"]+['"]\s*,\s*([^)]+)\)/,
        );
      if (!m) continue;
      const handler = extractLaravelHandler(m[1]!);
      if (!handler) continue;

      // Look up handler. For `Controller@method` and `[Class::class, 'method']`,
      // `extractLaravelHandler` returns the method name. For `Class::class`
      // (resource shape), it returns the class name.
      const handlerName = handler.name;
      const kindFilter: Array<'class' | 'method' | 'function'> = handler.isMethod
        ? ['method', 'function']
        : ['class'];
      const candidates = graph
        .getNodesByName(handlerName)
        .filter((n) => (kindFilter as string[]).includes(n.kind));
      if (candidates.length === 0) continue;

      let preferred = candidates.filter((n) => n.filePath.includes('Controllers'));
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
        provenance: 'framework:laravel',
        confidence: 0.85,
      });
      tags.push({ nodeId: target.id, tags: ['laravel:controller', 'route-handler'] });
    }

    // Facade resolution upgrade: a `calls` edge whose target node is a method
    // on a Laravel Facade (target's parent class name is in FACADE_MAPPINGS)
    // gets a `references/convention` edge from the caller to the facade's
    // underlying class IF the class is present in the indexed graph (i.e.
    // user-vendored Illuminate or a local stub).
    //
    // We deliberately don't try to walk container bindings; that's a runtime
    // concern. This is the static name-based upgrade.
    const facadeNames = new Set(Object.keys(FACADE_MAPPINGS));
    for (const facade of facadeNames) {
      const facadeClassNodes = graph
        .getNodesByName(facade)
        .filter((n) => n.kind === 'class');
      if (facadeClassNodes.length === 0) continue;
      // Look up the underlying class by last namespace segment.
      const underlyingFqn = FACADE_MAPPINGS[facade]!;
      const underlyingShortName = underlyingFqn.split('\\').pop()!;
      const underlying = graph
        .getNodesByName(underlyingShortName)
        .find((n) => n.kind === 'class');
      if (!underlying) continue;

      for (const facadeClass of facadeClassNodes) {
        // Every incoming `calls` edge to a method of this facade class gets
        // a matching convention edge to the underlying.
        const facadeMethods = graph
          .getNodesByFile(facadeClass.filePath)
          .filter((n) => n.kind === 'method');
        for (const method of facadeMethods) {
          for (const inEdge of graph.getIncomingEdges(method.id, ['calls'])) {
            edges.push({
              source: inEdge.source,
              target: underlying.id,
              kind: 'references',
              subkind: 'convention',
              line: undefined,
              column: undefined,
              provenance: 'framework:laravel',
              confidence: 0.85,
            });
          }
        }
        tags.push({ nodeId: facadeClass.id, tags: ['laravel:facade'] });
      }
    }

    return { edges, tags };
  },
};

interface ParsedHandler {
  name: string;
  /** `[Class::class, 'method']` and `'Controller@method'` produce method names;
   *  `Class::class` (resource shape) produces a class name. */
  isMethod: boolean;
}

function extractLaravelHandler(expr: string): ParsedHandler | null {
  const trimmed = expr.trim();

  const tupleMatch = trimmed.match(/^\[\s*[^,]+,\s*['"]([^'"]+)['"]\s*\]/);
  if (tupleMatch) return { name: tupleMatch[1]!, isMethod: true };

  const atMatch = trimmed.match(/^['"]([^'"@]+)@([^'"]+)['"]$/);
  if (atMatch) return { name: atMatch[2]!, isMethod: true };

  const classMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)::class/);
  if (classMatch) return { name: classMatch[1]!, isMethod: false };

  return null;
}
