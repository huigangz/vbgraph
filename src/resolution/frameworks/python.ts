/**
 * Python Framework Resolvers — Phase 3 shape.
 *
 * django/flask/fastapi share Python machinery. All three migrate together
 * (per the plan's PR-8). For each:
 *   - `detect` unchanged.
 *   - `extract` → `synthesize`: same route regexes, now whole-project pass.
 *   - `resolve` → dropped. P0.5b scope resolver covers file-local refs in
 *     Python; the by-name/suffix lookups were heuristic best-effort that
 *     scope resolution does more precisely.
 *
 * Augment is omitted for now: the legacy `extract` produced `UnresolvedRef`
 * entries that the strategy-2 resolver chain handled. Once these resolvers
 * stop emitting refs (they don't, in synthesize), the corresponding edges
 * are reconstructed by tree-sitter `calls` extraction on the urls.py /
 * decorator-target functions. A future augment can emit explicit
 * route→handler `references/convention` edges when there's appetite for
 * the recall gain.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

// ════════════════════════════════════════════════════════════════════
// django
// ════════════════════════════════════════════════════════════════════

const DJANGO_ROUTE_REGEX =
  /\b(path|re_path|url)\s*\(\s*r?['"]([^'"]+)['"]\s*,\s*([\w.]+(?:\s*\([^)]*\))?)/g;

export const djangoResolver: FrameworkResolver = {
  name: 'django',
  languages: ['python'],

  detect(context: ResolutionContext) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && requirements.toLowerCase().includes('django')) return true;
    const setup = context.readFile('setup.py');
    if (setup && setup.toLowerCase().includes('django')) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && pyproject.toLowerCase().includes('django')) return true;
    return context.fileExists('manage.py');
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.py')) continue;
      const safe = graph.readFileStripped(file, 'python');
      if (!safe) continue;

      DJANGO_ROUTE_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = DJANGO_ROUTE_REGEX.exec(safe)) !== null) {
        const [, _fn, urlPath] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        nodes.push({
          id: `framework:django:route:${file}:${line}:${urlPath}`,
          kind: 'route',
          name: urlPath!,
          qualifiedName: `${file}::route:${urlPath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'python',
          provenance: 'framework:django',
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
      if (route.provenance !== 'framework:django') continue;
      const safe = graph.readFileStripped(route.filePath, 'python');
      if (!safe) continue;
      const lineText = safe.split('\n')[route.startLine - 1];
      if (!lineText) continue;
      const m = lineText.match(
        /\b(?:path|re_path|url)\s*\(\s*r?['"][^'"]+['"]\s*,\s*([\w.]+(?:\s*\([^)]*\))?)/,
      );
      if (!m) continue;
      const handlerName = parseDjangoHandlerName(m[1]!);
      if (!handlerName) continue;

      const candidates = graph
        .getNodesByName(handlerName)
        .filter((n) => n.kind === 'class' || n.kind === 'function');
      if (candidates.length === 0) continue;
      // Prefer a candidate in a views/ directory.
      let preferred = candidates.filter((n) => n.filePath.includes('views'));
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
        provenance: 'framework:django',
        confidence: 0.85,
      });
      tags.push({ nodeId: target.id, tags: ['django:view', 'route-handler'] });
    }

    return { edges, tags };
  },
};

/**
 * Parse a Django URL handler expression to its bound name.
 *  - `include('module.path')` → null (we don't link to module-level names yet)
 *  - `UserView.as_view()` → 'UserView'
 *  - `views.UserView.as_view()` → 'UserView' (tail ident)
 *  - `home_view` → 'home_view'
 */
function parseDjangoHandlerName(expr: string): string | null {
  if (/^include\s*\(/.test(expr)) return null;
  // Strip trailing .as_view(...) or any trailing method call.
  let head = expr.replace(/\.as_view\s*\([^)]*\)\s*$/, '');
  head = head.replace(/\.\w+\s*\([^)]*\)\s*$/, '');
  const dotted = head.split('.').filter(Boolean);
  if (dotted.length === 0) return null;
  const last = dotted[dotted.length - 1]!;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(last) ? last : null;
}

// ════════════════════════════════════════════════════════════════════
// flask
// ════════════════════════════════════════════════════════════════════

export const flaskResolver: FrameworkResolver = {
  name: 'flask',
  languages: ['python'],

  detect(context: ResolutionContext) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bflask\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bflask\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'application.py', 'main.py', '__init__.py']) {
      const content = context.readFile(file);
      if (content && content.includes('Flask(__name__)')) return true;
    }
    return false;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.py')) continue;
      const safe = graph.readFileStripped(file, 'python');
      if (!safe) continue;

      // @x.route('/path', methods=[...])  \n  def handler(...)
      const decoratorRegex =
        /@(\w+)\.route\s*\(\s*['"]([^'"]+)['"](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?\s*\)\s*\n\s*(?:async\s+)?def\s+(\w+)/g;
      let match: RegExpExecArray | null;
      while ((match = decoratorRegex.exec(safe)) !== null) {
        const routePath = match[2]!;
        let method = 'GET';
        if (match[3]) {
          const m = match[3]!.match(/['"]([A-Z]+)['"]/i);
          if (m) method = m[1]!.toUpperCase();
        }
        const line = safe.slice(0, match.index).split('\n').length;
        nodes.push({
          id: `framework:flask:route:${file}:${line}:${method}:${routePath}`,
          kind: 'route',
          name: `${method} ${routePath}`,
          qualifiedName: `${file}::${method}:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'python',
          provenance: 'framework:flask',
          updatedAt: now,
        });
      }
    }

    return { nodes };
  },
};

// ════════════════════════════════════════════════════════════════════
// fastapi
// ════════════════════════════════════════════════════════════════════

export const fastapiResolver: FrameworkResolver = {
  name: 'fastapi',
  languages: ['python'],

  detect(context: ResolutionContext) {
    const requirements = context.readFile('requirements.txt');
    if (requirements && /\bfastapi\b/i.test(requirements)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\bfastapi\b/i.test(pyproject)) return true;
    for (const file of ['app.py', 'main.py', 'api.py']) {
      const content = context.readFile(file);
      if (content && content.includes('FastAPI(')) return true;
    }
    return false;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.py')) continue;
      const safe = graph.readFileStripped(file, 'python');
      if (!safe) continue;

      // @x.METHOD('/path') -> handler on the next def line
      const decoratorRegex =
        /@(\w+)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"]([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = decoratorRegex.exec(safe)) !== null) {
        const method = match[2]!.toUpperCase();
        const routePath = match[3]!;
        const line = safe.slice(0, match.index).split('\n').length;
        nodes.push({
          id: `framework:fastapi:route:${file}:${line}:${method}:${routePath}`,
          kind: 'route',
          name: `${method} ${routePath}`,
          qualifiedName: `${file}::${method}:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'python',
          provenance: 'framework:fastapi',
          updatedAt: now,
        });
      }
    }

    return { nodes };
  },
};
