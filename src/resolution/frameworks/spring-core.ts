/**
 * Spring Core Framework Resolver — Phase 3 shape with DI dispatch.
 *
 * Replaces the monolithic `springResolver` (formerly in `./java.ts`).
 * Split per the plan's PR-14: spring-core handles routes + DI; the
 * Temporal pieces live in `./spring-temporal.ts`.
 *
 * Synthesize:
 *   - `route` nodes from `@GetMapping` / `@PostMapping` / etc.
 *   - **INHERENT** bean tags on existing class nodes:
 *     `spring:service` / `spring:component` / `spring:repository` /
 *     `spring:configuration` / `spring:controller`. Inherent — annotations
 *     are properties of the class, not edge-derived. Must come from
 *     synthesize so they're visible to every augment (specifically the
 *     `isInjectionConstructor` check below reads them via view2).
 *
 * Augment:
 *   - **DI dispatch**: emits `references/di_binding` edges from each
 *     `@Autowired`/`@Inject` field AND injection constructor's parameters
 *     to every implementing class of the declared interface type. Handles
 *     field injection, explicit `@Autowired` constructor injection, AND
 *     Spring 4.3+ implicit single-constructor injection for
 *     Spring-managed beans.
 *   - Route → handler `references/convention` edges for synthesized routes.
 *   - Drops the legacy suffix-based by-name lookups (`*Service`, `*Repository`,
 *     `*Controller`, `*Component`, `*Config`, entity PascalCase) — covered
 *     by P0.5b scope resolver for Java.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

const MAPPING_REGEX =
  /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\s*\(\s*(?:value\s*=\s*|path\s*=\s*)?["']([^"']+)["'][^)]*\)/g;

const BEAN_TAG_BY_ANNOTATION: Record<string, string> = {
  Service: 'spring:service',
  Component: 'spring:component',
  Repository: 'spring:repository',
  Configuration: 'spring:configuration',
  Controller: 'spring:controller',
  RestController: 'spring:controller',
};

const SPRING_MANAGED_TAGS: ReadonlyArray<string> = [
  'spring:service',
  'spring:component',
  'spring:repository',
  'spring:configuration',
  'spring:controller',
];

export const springCoreResolver: FrameworkResolver = {
  name: 'spring-core',
  languages: ['java'],

  detect(context: ResolutionContext): boolean {
    return detectSpring(context);
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const tags: Array<{ nodeId: string; tags: string[] }> = [];
    const now = Date.now();

    // 1. Bean inherent tags on existing classes.
    for (const cls of graph.getNodesByKind('class')) {
      if (!cls.filePath.endsWith('.java')) continue;
      const safe = graph.readFileStripped(cls.filePath, 'java');
      if (!safe) continue;
      const annotations = readClassAnnotations(safe, cls);
      const classTags: string[] = [];
      for (const ann of annotations) {
        const tag = BEAN_TAG_BY_ANNOTATION[ann];
        if (tag && !classTags.includes(tag)) classTags.push(tag);
      }
      if (classTags.length > 0) {
        tags.push({ nodeId: cls.id, tags: classTags });
      }
    }

    // 2. @RequestMapping-family routes.
    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.java')) continue;
      const safe = graph.readFileStripped(file, 'java');
      if (!safe) continue;

      MAPPING_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = MAPPING_REGEX.exec(safe)) !== null) {
        const [, mappingName, routePath] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const method =
          mappingName === 'RequestMapping'
            ? 'ANY'
            : mappingName!.replace(/Mapping$/, '').toUpperCase();
        nodes.push({
          id: `framework:spring-core:route:${file}:${line}:${method}:${routePath}`,
          kind: 'route',
          name: `${method} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'java',
          provenance: 'framework:spring-core',
          updatedAt: now,
        });
      }
    }

    return { nodes, tags };
  },

  augment(graph: GraphView): AugmentResult {
    const edges: Edge[] = [];
    const tags: Array<{ nodeId: string; tags: string[] }> = [];

    // STAGE B has already persisted bean tags emitted by synthesize above,
    // so view2 returns them via getNodesByTag. isInjectionConstructor relies
    // on this.

    // ── DI dispatch — field injection ─────────────────────────────────
    for (const field of graph.getNodesByKind('field')) {
      if (!field.filePath.endsWith('.java')) continue;
      if (!hasAutowiredOrInject(graph, field)) continue;
      const ifaceId = resolveFieldInterfaceType(graph, field);
      emitDiBindings(graph, edges, field, ifaceId);
    }

    // ── DI dispatch — constructor injection (explicit + implicit) ────
    for (const ctor of graph.getNodesByKind('constructor')) {
      if (!ctor.filePath.endsWith('.java')) continue;
      if (!isInjectionConstructor(graph, ctor)) continue;
      // Find this constructor's parameters via `contains` edges. If the
      // graph doesn't expose constructor parameters (some tier-0 extractors
      // omit them), fall back to nothing — there's no edge to emit.
      const paramEdges = graph.getOutgoingEdges(ctor.id, ['contains']);
      for (const e of paramEdges) {
        const param = graph.getNode(e.target);
        if (!param || param.kind !== 'parameter') continue;
        const ifaceId = resolveParameterInterfaceType(graph, param);
        emitDiBindings(graph, edges, param, ifaceId);
      }
    }

    // ── Route → handler convention edges ──────────────────────────────
    for (const route of graph.getNodesByKind('route')) {
      if (route.provenance !== 'framework:spring-core') continue;
      const safe = graph.readFileStripped(route.filePath, 'java');
      if (!safe) continue;
      const handlerName = findSpringHandlerName(safe, route.startLine - 1);
      if (!handlerName) continue;
      const candidates = graph
        .getNodesByName(handlerName)
        .filter((n) => n.kind === 'method');
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
        provenance: 'framework:spring-core',
        confidence: 0.85,
      });
      tags.push({ nodeId: preferred[0]!.id, tags: ['route-handler'] });
    }

    return { edges, tags };
  },
};

// ────────────────────────────────────────────────────────────────────────
// Detect helper (shared with spring-temporal via re-export below)
// ────────────────────────────────────────────────────────────────────────

export function detectSpring(context: ResolutionContext): boolean {
  const pomXml = context.readFile('pom.xml');
  if (pomXml && (pomXml.includes('spring-boot') || pomXml.includes('springframework'))) {
    return true;
  }
  const buildGradle = context.readFile('build.gradle');
  if (
    buildGradle &&
    (buildGradle.includes('spring-boot') || buildGradle.includes('springframework'))
  ) {
    return true;
  }
  const buildGradleKts = context.readFile('build.gradle.kts');
  if (
    buildGradleKts &&
    (buildGradleKts.includes('spring-boot') || buildGradleKts.includes('springframework'))
  ) {
    return true;
  }
  const allFiles = context.getAllFiles();
  for (const file of allFiles) {
    if (file.endsWith('.java')) {
      const content = context.readFile(file);
      if (
        content &&
        (content.includes('@SpringBootApplication') ||
          content.includes('@RestController') ||
          content.includes('@Service') ||
          content.includes('@Repository'))
      ) {
        return true;
      }
    }
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────
// Annotation reading
// ────────────────────────────────────────────────────────────────────────

/** Set of annotation names present on the class declaration line and any line above it up to the previous code statement. */
function readClassAnnotations(safe: string, cls: Node): Set<string> {
  const lines = safe.split('\n');
  const idx = Math.max(0, cls.startLine - 1);
  const found = new Set<string>();
  // Walk upward from the class declaration line, collecting `@X(...)` annotations
  // until we hit a non-annotation, non-blank line.
  let i = idx;
  // Include the class line itself in case the annotation sits on the same line.
  const classLine = lines[i] ?? '';
  for (const m of classLine.matchAll(/@(\w+)/g)) found.add(m[1]!);
  for (i = idx - 1; i >= 0; i -= 1) {
    const text = lines[i]!.trim();
    if (text === '') continue;
    if (text.startsWith('@')) {
      for (const m of text.matchAll(/@(\w+)/g)) found.add(m[1]!);
      continue;
    }
    break;
  }
  return found;
}

function hasAutowiredOrInject(graph: GraphView, node: Node): boolean {
  const safe = graph.readFileStripped(node.filePath, 'java');
  if (!safe) return false;
  const lines = safe.split('\n');
  const idx = Math.max(0, node.startLine - 1);
  // Annotation on same line OR up to two lines above.
  for (let i = Math.max(0, idx - 2); i <= idx; i += 1) {
    const text = lines[i] ?? '';
    if (/@(Autowired|Inject)\b/.test(text)) return true;
  }
  return false;
}

// ────────────────────────────────────────────────────────────────────────
// DI dispatch
// ────────────────────────────────────────────────────────────────────────

function emitDiBindings(
  graph: GraphView,
  edges: Edge[],
  source: Node,
  interfaceId: string | null,
): void {
  if (!interfaceId) return;
  for (const impl of graph.getIncomingEdges(interfaceId, ['implements'])) {
    edges.push({
      source: source.id,
      target: impl.source,
      kind: 'references',
      subkind: 'di_binding',
      line: undefined,
      column: undefined,
      provenance: 'framework:spring-core',
      confidence: 0.85,
    });
  }
}

function resolveFieldInterfaceType(graph: GraphView, field: Node): string | null {
  return resolveDeclaredInterface(
    graph,
    field,
    /@(?:Autowired|Inject)\s+(?:private\s+|public\s+|protected\s+|final\s+)*(\w+)\s+/,
    /(?:private\s+|public\s+|protected\s+|final\s+)+(\w+)\s+/,
  );
}

function resolveParameterInterfaceType(graph: GraphView, param: Node): string | null {
  // Parameter declaration: `(..., Foo foo, ...)` — find token immediately before
  // the param name on its declaration line.
  const re = new RegExp(`(\\w+)\\s+${escapeRegex(param.name)}(?:\\s*[,)])`);
  return resolveDeclaredInterface(graph, param, re);
}

function resolveDeclaredInterface(
  graph: GraphView,
  node: Node,
  ...regexes: RegExp[]
): string | null {
  // Prefer the static type_of edge when present.
  const typeOf = graph.getOutgoingEdges(node.id, ['type_of']);
  if (typeOf.length === 1) return typeOf[0]!.target;

  const safe = graph.readFileStripped(node.filePath, 'java');
  if (!safe) return null;
  const lineText = safe.split('\n')[node.startLine - 1];
  if (!lineText) return null;
  for (const re of regexes) {
    const m = lineText.match(re);
    if (!m) continue;
    const typeName = m[1]!;
    const candidates = graph.getNodesByName(typeName).filter((n) => n.kind === 'interface');
    if (candidates.length === 1) return candidates[0]!.id;
  }
  return null;
}

function isInjectionConstructor(graph: GraphView, ctor: Node): boolean {
  // Explicit @Autowired wins.
  if (hasAutowiredOrInject(graph, ctor)) return true;
  // Otherwise: Spring 4.3+ treats the lone constructor of a Spring-managed
  // class as implicitly @Autowired.
  const enclosing = enclosingClass(graph, ctor);
  if (!enclosing) return false;
  const enclosingIsSpringBean = SPRING_MANAGED_TAGS.some((tag) =>
    graph.getNodesByTag(tag).some((n) => n.id === enclosing.id),
  );
  if (!enclosingIsSpringBean) return false;
  const allCtors = graph
    .getNodesByFile(enclosing.filePath)
    .filter((n) => n.kind === 'constructor' && enclosingClass(graph, n)?.id === enclosing.id);
  return allCtors.length === 1;
}

function enclosingClass(graph: GraphView, node: Node): Node | null {
  // Walk the `contains` graph backwards from `node`.
  const parents = graph.getIncomingEdges(node.id, ['contains']);
  for (const e of parents) {
    const parent = graph.getNode(e.source);
    if (parent && parent.kind === 'class') return parent;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Route → handler
// ────────────────────────────────────────────────────────────────────────

function findSpringHandlerName(safe: string, startLine: number): string | null {
  const lines = safe.split('\n');
  for (let i = startLine + 1; i < Math.min(lines.length, startLine + 8); i += 1) {
    const m = lines[i]!.match(/\b(?:public|private|protected)\s+[^;{]*?\s+(\w+)\s*\(/);
    if (m) return m[1]!;
  }
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
