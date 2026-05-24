/**
 * Spring Temporal Framework Resolver — Phase 3 augment-only.
 *
 * Re-routes `WorkflowStub.method()` and `ActivityStub.method()` invocations
 * to the concrete `@WorkflowImpl` / `@ActivityImpl` method via
 * `implements` edges. Tree-sitter sees the call against the stub method
 * (because resolution can't see the generic parameter); we add a
 * `calls/temporal_dispatch` edge from the same call site to the
 * concrete impl.
 *
 * Strict matching: the full `newWorkflowStub(X.class).method()` (or
 * `newActivityStub(X.class).method()`) chain must be visible at the call
 * site, exactly one interface candidate must exist, and exactly one
 * implementing class must exist. Recall traded for precision — wrong
 * cross-service control-flow edges are confusing.
 *
 * `detect` reuses `detectSpring` from `./spring-core.ts` — Temporal is
 * always wrapped in Spring/Java apps in this resolver's scope.
 */

import { Edge } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';
import { detectSpring } from './spring-core';

const STUB_FACTORY_RE =
  /(newWorkflowStub|newActivityStub)\s*\(\s*(\w+)\.class/g;

export const springTemporalResolver: FrameworkResolver = {
  name: 'spring-temporal',
  languages: ['java'],

  detect: detectSpring,

  synthesize(): SynthesizeResult {
    return { nodes: [] };
  },

  augment(graph: GraphView): AugmentResult {
    const edges: Edge[] = [];

    // For every `calls` edge in the graph, check if the source-line context
    // includes a `newWorkflowStub(X.class)` / `newActivityStub(X.class)`
    // chain. If so, find the implementing class and re-route the call to
    // its same-named method.
    //
    // Iterating all `calls` edges is potentially expensive; we filter early
    // by walking only edges in java files that have a `newWorkflowStub` /
    // `newActivityStub` substring.
    const seenSources = new Set<string>();
    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.java')) continue;
      const safe = graph.readFileStripped(file, 'java');
      if (!safe) continue;
      if (!safe.includes('newWorkflowStub') && !safe.includes('newActivityStub')) continue;
      const lines = safe.split('\n');

      // Walk each occurrence of the factory + look at the same line for
      // .method() chain.
      STUB_FACTORY_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = STUB_FACTORY_RE.exec(safe)) !== null) {
        const interfaceName = match[2]!;
        const lineIdx = safe.slice(0, match.index).split('\n').length - 1;
        const lineText = lines[lineIdx] ?? '';
        // Same-line `.method(...)` invocation after the stub factory.
        const chain = lineText
          .slice(lineText.indexOf(match[0]) + match[0].length)
          .match(/\)\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
        if (!chain) continue;
        const calledMethod = chain[1]!;

        // Find the unique interface.
        const ifaces = graph
          .getNodesByName(interfaceName)
          .filter((n) => n.kind === 'interface');
        if (ifaces.length !== 1) continue;
        const iface = ifaces[0]!;

        // Find unique implementor via `implements` edges.
        const impls = graph.getIncomingEdges(iface.id, ['implements']);
        if (impls.length !== 1) continue;
        const implClassId = impls[0]!.source;
        const implClass = graph.getNode(implClassId);
        if (!implClass) continue;

        // Find the impl's method with the matching name in the same file.
        const implMethods = graph
          .getNodesByFile(implClass.filePath)
          .filter((n) => n.kind === 'method' && n.name === calledMethod);
        if (implMethods.length !== 1) continue;
        const implMethod = implMethods[0]!;

        // Source is the enclosing function/method/constructor of the call
        // site. We find it by looking up the file's nodes and picking the
        // one whose [startLine, endLine] range includes `lineIdx + 1`.
        const enclosing = graph
          .getNodesByFile(file)
          .filter((n) => ['function', 'method', 'constructor'].includes(n.kind))
          .filter((n) => n.startLine <= lineIdx + 1 && (n.endLine ?? n.startLine) >= lineIdx + 1)
          .sort((a, b) => (b.startLine - a.startLine))[0];
        if (!enclosing) continue;

        const callCol = lineText.indexOf(match[0]) + match[0].length;
        const key = `${enclosing.id}\x00${implMethod.id}\x00${lineIdx + 1}\x00${callCol}`;
        if (seenSources.has(key)) continue;
        seenSources.add(key);

        edges.push({
          source: enclosing.id,
          target: implMethod.id,
          kind: 'calls',
          subkind: 'temporal_dispatch',
          line: lineIdx + 1,
          column: callCol,
          provenance: 'framework:spring-temporal',
          confidence: 0.85,
        });
      }
    }

    return { edges };
  },
};
