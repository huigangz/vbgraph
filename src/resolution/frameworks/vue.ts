/**
 * Vue / Nuxt Framework Resolver — Phase 3 shape.
 *
 * `extract` → `synthesize`: Nuxt page/api routes + middleware nodes.
 * `resolve` is RETAINED (not removed) for framework-built-in name patterns
 * that the scope resolver and import resolver cannot cover:
 *   - Vue 3 compiler macros (`defineProps`, `defineEmits`, etc. are
 *     compiler-provided, not declared anywhere in user code).
 *   - Nuxt auto-imported composables (`useFetch`, `useRouter`, etc.).
 *   - Nuxt virtual modules (`#imports`, `#components`, etc.).
 *
 * Removing those would leak phantom unresolved refs. The previous
 * by-name component lookup AND the `@/` / `~/` alias paths ARE dropped
 * — those are subsumed by `loadProjectAliases` in the import resolver
 * and P0.5b scope resolution.
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

const VUE_COMPILER_MACROS = new Set([
  'defineProps',
  'defineEmits',
  'defineExpose',
  'defineOptions',
  'defineSlots',
  'defineModel',
  'withDefaults',
]);

const NUXT_AUTO_IMPORTS = new Set([
  'useRoute',
  'useRouter',
  'navigateTo',
  'abortNavigation',
  'useFetch',
  'useAsyncData',
  'useLazyFetch',
  'useLazyAsyncData',
  'refreshNuxtData',
  'useState',
  'clearNuxtState',
  'useHead',
  'useSeoMeta',
  'useServerSeoMeta',
  'useRuntimeConfig',
  'useAppConfig',
  'useNuxtApp',
  'useCookie',
  'useError',
  'createError',
  'showError',
  'clearError',
  'definePageMeta',
  'defineNuxtConfig',
  'defineNuxtPlugin',
  'defineNuxtRouteMiddleware',
  'useRequestHeaders',
  'useRequestEvent',
  'useRequestFetch',
  'useRequestURL',
]);

const NUXT_VIRTUAL_MODULES = [
  '#imports',
  '#components',
  '#app',
  '#build',
  '#head',
];

export const vueResolver: FrameworkResolver = {
  name: 'vue',

  detect(context: ResolutionContext): boolean {
    // Check for vue or nuxt in package.json
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.vue || deps.nuxt || deps['@nuxt/kit']) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // Check for .vue files in project
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.vue'));
  },

  /**
   * Retained for framework-built-in symbol resolution. See module comment.
   * Will go away in P3 cleanup once a global "framework-provided names"
   * registry lands.
   */
  resolve(ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    if (VUE_COMPILER_MACROS.has(ref.referenceName)) {
      return { original: ref, targetNodeId: ref.fromNodeId, confidence: 1.0, resolvedBy: 'framework' };
    }
    if (NUXT_AUTO_IMPORTS.has(ref.referenceName)) {
      return { original: ref, targetNodeId: ref.fromNodeId, confidence: 1.0, resolvedBy: 'framework' };
    }
    if (ref.referenceKind === 'imports' && ref.referenceName.startsWith('#')) {
      if (NUXT_VIRTUAL_MODULES.some((prefix) => ref.referenceName.startsWith(prefix))) {
        return { original: ref, targetNodeId: ref.fromNodeId, confidence: 1.0, resolvedBy: 'framework' };
      }
    }
    return null;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      const normalized = file.replace(/\\/g, '/');

      // Nuxt page routes (pages/ directory, .vue files)
      const pagesIndex = normalized.indexOf('/pages/');
      if (pagesIndex !== -1 && normalized.endsWith('.vue')) {
        const routePath = filePathToNuxtRoute(normalized, pagesIndex + '/pages/'.length);
        if (routePath !== null) {
          nodes.push({
            id: `framework:vue:route:${file}:${routePath}:1`,
            kind: 'route',
            name: routePath,
            qualifiedName: `${file}::route:${routePath}`,
            filePath: file,
            startLine: 1,
            endLine: 1,
            startColumn: 0,
            endColumn: 0,
            language: 'vue',
            provenance: 'framework:vue',
            updatedAt: now,
          });
        }
      }

      // Nuxt API routes (server/api/ directory)
      const apiIndex = normalized.indexOf('/server/api/');
      if (apiIndex !== -1) {
        const afterApi = normalized.substring(apiIndex + '/server/api/'.length);
        const routeName = afterApi.replace(/\.[^/.]+$/, '').replace(/\/index$/, '');
        const apiRoute = '/api/' + routeName;
        nodes.push({
          id: `framework:vue:apiroute:${file}:${apiRoute}:1`,
          kind: 'route',
          name: apiRoute,
          qualifiedName: `${file}::route:${apiRoute}`,
          filePath: file,
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          language: normalized.endsWith('.vue') ? 'vue' : 'typescript',
          provenance: 'framework:vue',
          updatedAt: now,
        });
      }
    }

    return { nodes };
  },
};

/**
 * Convert a file path to a Nuxt route path
 */
function filePathToNuxtRoute(normalized: string, afterPagesStart: number): string | null {
  const afterPages = normalized.substring(afterPagesStart);
  const withoutExt = afterPages.replace(/\.vue$/, '');
  const withoutIndex = withoutExt.replace(/\/index$/, '');
  let route = '/' + withoutIndex
    .replace(/\[\.\.\.([^\]]+)\]/g, '*$1')
    .replace(/\[{2}([^\]]+)\]{2}/g, ':$1?')
    .replace(/\[([^\]]+)\]/g, ':$1');
  if (route === '/') return '/';
  return route.replace(/\/$/, '');
}
