/**
 * Generic Temporal Framework Resolver — Phase 3 augment-only.
 *
 * Cross-language. Detects Go / TypeScript / Python / Java (without
 * Spring) Temporal clients and re-routes workflow / activity dispatch
 * calls to the concrete implementation.
 *
 * Language-specific patterns:
 *   - Go:         `client.ExecuteWorkflow(ctx, opts, MyWorkflow)`
 *                 or `workflow.ExecuteActivity(ctx, MyActivity, args)`
 *   - TypeScript: `await client.workflow.start(MyWorkflow, { args })`
 *                 or `await client.workflow.execute(MyWorkflow, { args })`
 *   - Python:     `await client.start_workflow(MyWorkflow.run, args)`
 *                 or `await client.execute_workflow(MyWorkflow.run, args)`
 *   - Java (no Spring): same as spring-temporal's
 *                 `newWorkflowStub(X.class).method()` — but only fires
 *                 when spring is NOT detected.
 *
 * Graph-level dispatch (interface → implementation → method) is shared.
 * Same strict matching as spring-temporal: exactly one interface candidate,
 * exactly one implementor, exactly one method name match. Edge kind is
 * `calls`, subkind `temporal_dispatch`, line/col filled from the call site.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';
import type { CommentLang } from '../strip-comments';
import { detectSpring } from './spring-core';

export const temporalResolver: FrameworkResolver = {
  name: 'temporal',

  detect(context: ResolutionContext): boolean {
    // Generic Temporal detection: look for temporal-client SDK imports
    // across languages. Only positive if we DON'T also detect spring —
    // spring-temporal is the more specific resolver and avoids duplicate
    // edge contributions.
    if (detectSpring(context)) return false;

    // package.json — TS/JS clients
    const pkg = context.readFile('package.json');
    if (pkg) {
      try {
        const parsed = JSON.parse(pkg);
        const deps = { ...parsed.dependencies, ...parsed.devDependencies };
        if (
          deps['@temporalio/client'] ||
          deps['@temporalio/workflow'] ||
          deps['@temporalio/worker']
        ) {
          return true;
        }
      } catch {
        // Invalid JSON
      }
    }

    // go.mod — Go client
    const goMod = context.readFile('go.mod');
    if (goMod && /\bgo\.temporal\.io\/sdk\b/.test(goMod)) return true;

    // requirements.txt / pyproject.toml — Python client
    const req = context.readFile('requirements.txt');
    if (req && /\btemporalio\b/i.test(req)) return true;
    const pyproject = context.readFile('pyproject.toml');
    if (pyproject && /\btemporalio\b/i.test(pyproject)) return true;

    return false;
  },

  synthesize(): SynthesizeResult {
    return { nodes: [] };
  },

  augment(graph: GraphView): AugmentResult {
    const edges: Edge[] = [];
    const seen = new Set<string>();

    for (const file of graph.getAllFiles()) {
      const lang = languageOfFile(file);
      if (!lang) continue;
      const commentLang = COMMENT_LANG[lang];
      if (!commentLang) continue;
      const safe = graph.readFileStripped(file, commentLang);
      if (!safe) continue;

      const dispatches = scanLanguage(safe, lang);
      for (const d of dispatches) {
        addEdgeFor(graph, edges, seen, file, d);
      }
    }

    return { edges };
  },
};

// ────────────────────────────────────────────────────────────────────────
// Language detection & scanning
// ────────────────────────────────────────────────────────────────────────

type TLang = 'go' | 'typescript' | 'javascript' | 'python' | 'java';

const COMMENT_LANG: Record<TLang, CommentLang | null> = {
  go: 'go',
  typescript: 'typescript',
  javascript: 'javascript',
  python: 'python',
  java: 'java',
};

function languageOfFile(file: string): TLang | null {
  if (file.endsWith('.go')) return 'go';
  if (file.endsWith('.ts') || file.endsWith('.tsx')) return 'typescript';
  if (file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.mjs') || file.endsWith('.cjs')) return 'javascript';
  if (file.endsWith('.py')) return 'python';
  if (file.endsWith('.java')) return 'java';
  return null;
}

interface Dispatch {
  /** Interface / type name passed to the dispatch (e.g. `MyWorkflow`). */
  workflowName: string;
  /** Method name on the implementor (for `.run` style); null for "any matching". */
  methodName: string | null;
  /** Line in the source (1-based). */
  line: number;
  /** Column in the source (0-based). */
  col: number;
}

/**
 * Scan a stripped source file for temporal dispatch invocations specific to
 * the given language. Returns one Dispatch per call site.
 */
function scanLanguage(safe: string, lang: TLang): Dispatch[] {
  switch (lang) {
    case 'go':
      return scanGo(safe);
    case 'typescript':
    case 'javascript':
      return scanTypeScript(safe);
    case 'python':
      return scanPython(safe);
    case 'java':
      return scanJava(safe);
  }
}

// Go: client.ExecuteWorkflow(ctx, opts, MyWorkflow)
//     workflow.ExecuteActivity(ctx, MyActivity, args)
function scanGo(safe: string): Dispatch[] {
  const out: Dispatch[] = [];
  const re =
    /\b(?:\w+)\.Execute(?:Workflow|Activity)\s*\(\s*[^,]+,\s*(?:[^,]+,\s*)?([A-Za-z_][A-Za-z0-9_.]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(safe)) !== null) {
    const { line, col } = lineColAt(safe, match.index);
    // Last segment of dotted path is the workflow/activity name.
    const parts = match[1]!.split('.');
    out.push({
      workflowName: parts[parts.length - 1]!,
      methodName: null,
      line,
      col,
    });
  }
  return out;
}

// TypeScript/JavaScript: client.workflow.start(MyWorkflow, {...})
//                      : client.workflow.execute(MyWorkflow, {...})
function scanTypeScript(safe: string): Dispatch[] {
  const out: Dispatch[] = [];
  const re =
    /\bworkflow\.(?:start|execute)\s*\(\s*([A-Za-z_][A-Za-z0-9_.]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(safe)) !== null) {
    const { line, col } = lineColAt(safe, match.index);
    const parts = match[1]!.split('.');
    out.push({
      workflowName: parts[parts.length - 1]!,
      methodName: null,
      line,
      col,
    });
  }
  return out;
}

// Python: client.start_workflow(MyWorkflow.run, args)
//       : client.execute_workflow(MyWorkflow.run, args)
function scanPython(safe: string): Dispatch[] {
  const out: Dispatch[] = [];
  const re =
    /\b(?:start_workflow|execute_workflow)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(safe)) !== null) {
    const { line, col } = lineColAt(safe, match.index);
    out.push({
      workflowName: match[1]!,
      methodName: match[2]!,
      line,
      col,
    });
  }
  return out;
}

// Java (no Spring): newWorkflowStub(X.class).method() — same as spring-temporal
function scanJava(safe: string): Dispatch[] {
  const out: Dispatch[] = [];
  if (!safe.includes('newWorkflowStub') && !safe.includes('newActivityStub')) return out;
  const lines = safe.split('\n');
  const re = /(newWorkflowStub|newActivityStub)\s*\(\s*(\w+)\.class/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(safe)) !== null) {
    const interfaceName = match[2]!;
    const { line } = lineColAt(safe, match.index);
    const lineText = lines[line - 1] ?? '';
    const afterIdx = lineText.indexOf(match[0]) + match[0].length;
    const chain = lineText.slice(afterIdx).match(/\)\s*\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
    if (!chain) continue;
    out.push({
      workflowName: interfaceName,
      methodName: chain[1]!,
      line,
      col: afterIdx,
    });
  }
  return out;
}

function lineColAt(safe: string, idx: number): { line: number; col: number } {
  const before = safe.slice(0, idx);
  const lastNl = before.lastIndexOf('\n');
  return {
    line: before.split('\n').length,
    col: lastNl === -1 ? idx : idx - lastNl - 1,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Edge construction
// ────────────────────────────────────────────────────────────────────────

function addEdgeFor(
  graph: GraphView,
  edges: Edge[],
  seen: Set<string>,
  file: string,
  d: Dispatch,
): void {
  // Find unique workflow interface / class.
  const ifaceCandidates = graph
    .getNodesByName(d.workflowName)
    .filter((n) => n.kind === 'interface' || n.kind === 'class' || n.kind === 'struct');
  if (ifaceCandidates.length !== 1) return;
  const iface = ifaceCandidates[0]!;

  // Find unique implementor via `implements` edges. For class/struct
  // dispatch (Go/Python where the workflow IS the type, no separate
  // interface) the iface == impl shortcut applies when no implements
  // edges exist.
  let implClass: Node;
  const impls = graph.getIncomingEdges(iface.id, ['implements']);
  if (impls.length === 0) {
    // Workflow IS its own class — direct dispatch.
    implClass = iface;
  } else if (impls.length === 1) {
    const node = graph.getNode(impls[0]!.source);
    if (!node) return;
    implClass = node;
  } else {
    return;
  }

  // Resolve target method name.
  const methodName = d.methodName ?? guessMethodNameForGoTs(graph, implClass);
  if (!methodName) return;

  const implMethods = graph
    .getNodesByFile(implClass.filePath)
    .filter((n) => (n.kind === 'method' || n.kind === 'function') && n.name === methodName);
  if (implMethods.length !== 1) return;
  const implMethod = implMethods[0]!;

  // Source is the enclosing function/method of the call site.
  const enclosing = enclosingCallable(graph, file, d.line);
  if (!enclosing) return;

  const key = `${enclosing.id}\x00${implMethod.id}\x00${d.line}\x00${d.col}`;
  if (seen.has(key)) return;
  seen.add(key);

  edges.push({
    source: enclosing.id,
    target: implMethod.id,
    kind: 'calls',
    subkind: 'temporal_dispatch',
    line: d.line,
    column: d.col,
    provenance: 'framework:temporal',
    confidence: 0.85,
  });
}

/**
 * For Go/TS where the dispatch call doesn't name the method (the worker
 * convention names a single entry function), look for the implementor's
 * "Run" or "execute" method. Returns the method name or null.
 */
function guessMethodNameForGoTs(graph: GraphView, impl: Node): string | null {
  const methods = graph
    .getNodesByFile(impl.filePath)
    .filter((n) => n.kind === 'method' || n.kind === 'function');
  // Common conventions: Go uses "Run" (exported); TS/Python uses "run" or "execute".
  for (const candidate of ['Run', 'run', 'execute', 'Execute']) {
    if (methods.some((m) => m.name === candidate)) return candidate;
  }
  return null;
}

function enclosingCallable(graph: GraphView, file: string, line: number): Node | null {
  const candidates = graph
    .getNodesByFile(file)
    .filter((n) => ['function', 'method', 'constructor'].includes(n.kind))
    .filter((n) => n.startLine <= line && (n.endLine ?? n.startLine) >= line)
    .sort((a, b) => b.startLine - a.startLine);
  return candidates[0] ?? null;
}
