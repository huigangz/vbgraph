/**
 * React / Next.js Framework Resolver — Phase 3 shape.
 *
 * Node-kind discipline:
 *   - `component` synthesized for function/arrow/forwardRef/memo definitions
 *     that return JSX. Component is a first-class concept here because it
 *     has identity (file + name) distinct from the underlying function in
 *     a way that matters to caller queries — pre-existing kind.
 *   - Hooks are NOT a synthesized kind. A "hook" IS its source-code
 *     function. We emit `react:hook` tags on existing `function` nodes
 *     whose name matches `^use[A-Z]`.
 *   - Next.js page routes synthesized as `route` nodes (existing kind).
 *
 * The legacy by-name resolution (`resolveComponent` / `resolveHook` /
 * `resolveContext`) is dropped — P0.5b's scope resolver covers ts/js
 * file-local refs.
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

export const reactResolver: FrameworkResolver = {
  name: 'react',
  languages: ['javascript', 'typescript'],

  detect(context: ResolutionContext): boolean {
    // Check for React in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.react || deps.next || deps['react-native']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .jsx/.tsx files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const tags: Array<{ nodeId: string; tags: string[] }> = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!/\.(jsx|tsx)$/.test(file) && !file.includes('pages/') && !file.includes('app/')) {
        continue;
      }
      // Components live in .jsx / .tsx; Next.js pages can be any extension.
      const language: 'jsx' | 'tsx' | 'javascript' | 'typescript' =
        file.endsWith('.tsx')
          ? 'tsx'
          : file.endsWith('.jsx')
            ? 'jsx'
            : file.endsWith('.ts')
              ? 'typescript'
              : 'javascript';
      const stripLang: 'typescript' | 'javascript' =
        language === 'tsx' || language === 'typescript' ? 'typescript' : 'javascript';
      const safe = graph.readFileStripped(file, stripLang);
      if (!safe) continue;

      // ── Components ───────────────────────────────────────────────────
      const componentPatterns = [
        /(?:export\s+)?function\s+([A-Z][a-zA-Z0-9]*)\s*\(/g,
        /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:\([^)]*\)|[a-zA-Z_][a-zA-Z0-9_]*)\s*=>/g,
        /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?forwardRef/g,
        /(?:export\s+)?(?:const|let)\s+([A-Z][a-zA-Z0-9]*)\s*=\s*(?:React\.)?memo/g,
      ];
      for (const pattern of componentPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(safe)) !== null) {
          const [fullMatch, name] = match;
          const line = safe.slice(0, match.index).split('\n').length;
          const afterMatch = safe.slice(
            match.index + fullMatch.length,
            match.index + fullMatch.length + 500,
          );
          const hasJSX =
            afterMatch.includes('<') &&
            (afterMatch.includes('/>') || afterMatch.includes('</'));
          if (!hasJSX) continue;
          const id = `framework:react:component:${file}:${name}:${line}`;
          nodes.push({
            id,
            kind: 'component',
            name: name!,
            qualifiedName: `${file}::${name}`,
            filePath: file,
            startLine: line,
            endLine: line,
            startColumn: 0,
            endColumn: fullMatch.length,
            language,
            isExported: fullMatch.includes('export'),
            provenance: 'framework:react',
            updatedAt: now,
          });
          tags.push({ nodeId: id, tags: ['react:component'] });
        }
      }

      // ── Next.js routes (synthesized as `route` nodes) ──
      if (file.includes('pages/') || file.includes('app/')) {
        if (safe.includes('export default')) {
          const routePath = filePathToRoute(file);
          if (routePath) {
            const idx = safe.indexOf('export default');
            const lineNum = safe.slice(0, idx).split('\n').length;
            nodes.push({
              id: `framework:react:route:${file}:${routePath}:${lineNum}`,
              kind: 'route',
              name: routePath,
              qualifiedName: `${file}::route:${routePath}`,
              filePath: file,
              startLine: lineNum,
              endLine: lineNum,
              startColumn: 0,
              endColumn: 0,
              language,
              provenance: 'framework:react',
              updatedAt: now,
            });
          }
        }
      }
    }

    // ── react:hook tags on existing `function` nodes matching /^use[A-Z]/.
    // Node-kind discipline: a hook IS its source-code function; we tag the
    // existing node rather than synthesizing a phantom `hook` kind.
    for (const fn of graph.getNodesByKind('function')) {
      if (/^use[A-Z]/.test(fn.name)) {
        tags.push({ nodeId: fn.id, tags: ['react:hook'] });
      }
    }

    return { nodes, tags };
  },

  // No augment yet — the legacy `resolve` paths (PascalCase component
  // resolution, `useX` hook resolution, `*Context`/`*Provider` resolution)
  // are all covered by P0.5b's scope + import resolvers. Component→hook
  // call edges remain in the tree-sitter `calls` graph; they don't need a
  // framework-derived convention edge to be discoverable.
};

/**
 * Convert file path to Next.js route.
 */
function filePathToRoute(filePath: string): string | null {
  if (filePath.includes('pages/')) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  if (filePath.includes('app/')) {
    if (!filePath.includes('page.')) {
      return null;
    }

    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replace(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  return null;
}
