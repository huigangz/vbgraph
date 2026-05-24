/**
 * Svelte / SvelteKit Framework Resolver — Phase 3 shape.
 *
 * Same pattern as vue: `extract` → `synthesize` (SvelteKit routes),
 * `resolve` RETAINED for framework-provided symbols (Svelte 5 runes,
 * `$store` auto-subscribe, `$app/*` / `$env/*` virtual modules) that
 * scope/import resolvers cannot find. Component PascalCase lookup and
 * `$lib/*` alias resolution are dropped — covered by import resolution.
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  SynthesizeResult,
  UnresolvedRef,
} from '../types';
import { GraphView } from '../graph-view';

const SVELTE_RUNES = new Set([
  '$state',
  '$state.raw',
  '$state.snapshot',
  '$derived',
  '$derived.by',
  '$effect',
  '$effect.pre',
  '$effect.root',
  '$effect.tracking',
  '$props',
  '$bindable',
  '$inspect',
  '$host',
]);

const SVELTEKIT_MODULE_PREFIXES = [
  '$app/navigation',
  '$app/stores',
  '$app/environment',
  '$app/forms',
  '$app/paths',
  '$env/static/private',
  '$env/static/public',
  '$env/dynamic/private',
  '$env/dynamic/public',
];

const SVELTEKIT_ROUTE_FILES = new Set<string>([
  '+page.svelte',
  '+page.ts',
  '+page.js',
  '+page.server.ts',
  '+page.server.js',
  '+layout.svelte',
  '+layout.ts',
  '+layout.js',
  '+layout.server.ts',
  '+layout.server.js',
  '+server.ts',
  '+server.js',
  '+error.svelte',
]);

export const svelteResolver: FrameworkResolver = {
  name: 'svelte',
  languages: ['svelte'],

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.svelte || deps['@sveltejs/kit']) return true;
      } catch {
        // Invalid JSON
      }
    }
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.svelte'));
  },

  /** Retained for runes / `$store` / framework virtual modules. */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (isRuneReference(ref.referenceName)) {
      return { original: ref, targetNodeId: ref.fromNodeId, confidence: 1.0, resolvedBy: 'framework' };
    }
    if (ref.referenceName.startsWith('$') && !ref.referenceName.startsWith('$$')) {
      const storeName = ref.referenceName.substring(1);
      const storeNode = context.getNodesByName(storeName).find(
        (n) => n.kind === 'variable' || n.kind === 'constant',
      );
      if (storeNode) {
        return { original: ref, targetNodeId: storeNode.id, confidence: 0.85, resolvedBy: 'framework' };
      }
    }
    if (
      ref.referenceKind === 'imports' &&
      ref.referenceName.startsWith('$') &&
      SVELTEKIT_MODULE_PREFIXES.some((p) => ref.referenceName.startsWith(p))
    ) {
      return { original: ref, targetNodeId: ref.fromNodeId, confidence: 1.0, resolvedBy: 'framework' };
    }
    return null;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      const fileName = file.split(/[/\\]/).pop() || '';
      if (!SVELTEKIT_ROUTE_FILES.has(fileName)) continue;
      const routePath = filePathToSvelteKitRoute(file);
      if (!routePath) continue;

      nodes.push({
        id: `framework:svelte:route:${file}:${routePath}:1`,
        kind: 'route',
        name: routePath,
        qualifiedName: `${file}::route:${routePath}`,
        filePath: file,
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        language: file.endsWith('.svelte') ? 'svelte' : 'typescript',
        provenance: 'framework:svelte',
        updatedAt: now,
      });
    }

    return { nodes };
  },
};

function isRuneReference(name: string): boolean {
  if (SVELTE_RUNES.has(name)) return true;
  if (name === '$state' || name === '$derived' || name === '$effect') return true;
  return false;
}

function filePathToSvelteKitRoute(filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/');
  const routesIndex = normalized.indexOf('/routes/');
  if (routesIndex === -1) return null;
  const afterRoutes = normalized.substring(routesIndex + '/routes/'.length);
  const lastSlash = afterRoutes.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : afterRoutes.substring(0, lastSlash);
  let route = '/' + dirPath
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?')
    .replace(/\[([^\]]+)\]/g, ':$1');
  if (route === '/') return '/';
  return route.replace(/\/$/, '');
}
