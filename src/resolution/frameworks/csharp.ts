/**
 * C# Framework Resolver — ASP.NET Core / ASP.NET MVC.
 *
 * Phase 3 (synthesize/augment) shape. The legacy per-file `extract` and
 * per-ref `resolve` hooks were removed in this resolver's PR-3 migration:
 *   - `extract` → `synthesize`: same attribute / minimal-API regex over
 *     the file's stripped content, now driven by the whole-project pass.
 *   - `resolve` → `augment`: the by-name suffix / conventional-directory
 *     resolution is fully covered by P0.5b's scope resolver for csharp.
 *     Augment retains route→handler `references/convention` edges plus
 *     the `aspnet:controller` / `route-handler` inherent + derived tag
 *     pair.
 */

import { Edge, Node } from '../../types';
import {
  AugmentResult,
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

const CONTROLLER_DIRS = ['/Controllers/', '/Controller/'];

export const aspnetResolver: FrameworkResolver = {
  name: 'aspnet',
  languages: ['csharp'],

  detect(context: ResolutionContext): boolean {
    // Check for .csproj files with ASP.NET references
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.csproj')) {
        const content = context.readFile(file);
        if (content && (
          content.includes('Microsoft.AspNetCore') ||
          content.includes('Microsoft.NET.Sdk.Web') ||
          content.includes('System.Web.Mvc')
        )) {
          return true;
        }
      }
    }

    // Check for Program.cs with WebApplication
    const programCs = context.readFile('Program.cs');
    if (programCs && (
      programCs.includes('WebApplication') ||
      programCs.includes('CreateHostBuilder') ||
      programCs.includes('UseStartup')
    )) {
      return true;
    }

    // Check for Startup.cs (ASP.NET Core signature)
    if (context.fileExists('Startup.cs')) {
      return true;
    }

    // Check for Controllers directory
    return allFiles.some((f) => f.includes('/Controllers/') && f.endsWith('Controller.cs'));
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.cs')) continue;
      const safe = graph.readFileStripped(file, 'csharp');
      if (!safe) continue;

      // [HttpGet("path")], [HttpPost("path")], etc.
      const attrRegex = /\[(HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete)\s*\(\s*"([^"]+)"\s*\)\]/g;
      let match: RegExpExecArray | null;
      while ((match = attrRegex.exec(safe)) !== null) {
        const [, verb, routePath] = match;
        const method = verb!.replace(/^Http/, '').toUpperCase();
        const line = safe.slice(0, match.index).split('\n').length;
        nodes.push({
          id: `framework:aspnet:route:${method}:${routePath}:${file}:${line}`,
          kind: 'route',
          name: `${method} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'csharp',
          provenance: 'framework:aspnet',
          updatedAt: now,
        });
      }

      // Minimal APIs: app.MapGet("/path", handler)
      const minimalRegex = /\.Map(Get|Post|Put|Patch|Delete)\s*\(\s*"([^"]+)"\s*,\s*([^,)]+)/g;
      while ((match = minimalRegex.exec(safe)) !== null) {
        const [, verb, routePath] = match;
        const method = verb!.toUpperCase();
        const line = safe.slice(0, match.index).split('\n').length;
        nodes.push({
          id: `framework:aspnet:route:${method}:${routePath}:${file}:${line}`,
          kind: 'route',
          name: `${method} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'csharp',
          provenance: 'framework:aspnet',
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
      if (route.provenance !== 'framework:aspnet') continue;
      const handlerName = findHandlerName(graph, route);
      if (!handlerName) continue;

      // Attribute routes: look for a method declared after the [HttpVerb] line
      // in the same file. Minimal-API routes: the handlerName comes from the
      // `, handler)` slot at the end of MapXxx.
      const candidates = graph
        .getNodesByName(handlerName)
        .filter((n) => n.kind === 'method' || n.kind === 'function');
      if (candidates.length === 0) continue;

      // Prefer methods in a Controllers/ directory.
      let preferred = candidates.filter((n) =>
        CONTROLLER_DIRS.some((d) => n.filePath.includes(d)),
      );
      if (preferred.length === 0) preferred = candidates;

      // Only emit the edge if we've narrowed to a single target — avoids
      // wrong-target false positives. Falls back to file-collocated method
      // when the route's own file has a unique match.
      let target = preferred.length === 1 ? preferred[0] : undefined;
      if (!target) {
        const sameFile = preferred.filter((n) => n.filePath === route.filePath);
        if (sameFile.length === 1) target = sameFile[0];
      }
      if (!target) continue;

      edges.push({
        source: route.id,
        target: target.id,
        kind: 'references',
        subkind: 'convention',
        line: undefined,
        column: undefined,
        provenance: 'framework:aspnet',
        confidence: 0.85,
      });
      tags.push({ nodeId: target.id, tags: ['aspnet:controller', 'route-handler'] });
    }

    return { edges, tags };
  },
};

/**
 * For an aspnet route node, infer the handler method name.
 *
 * Attribute style ([HttpGet("/x")]): scan the file's stripped content
 * starting at the route's line for the next method declaration.
 *
 * Minimal-API style (app.MapGet("/x", handler)): the handler expression
 * sits on the same line as the route. Pull the trailing identifier.
 */
function findHandlerName(graph: GraphView, route: Node): string | null {
  const safe = graph.readFileStripped(route.filePath, 'csharp');
  if (!safe) return null;
  const lines = safe.split('\n');
  const startLine = Math.max(0, route.startLine - 1);
  const startLineText = lines[startLine] ?? '';

  // Minimal API on the same line: `.MapGet("/x", handler)` — pull trailing ident.
  const minimal = startLineText.match(
    /\.Map(?:Get|Post|Put|Patch|Delete)\s*\(\s*"[^"]+"\s*,\s*([^,)]+)/,
  );
  if (minimal) {
    return extractCSharpTailIdent(minimal[1]!);
  }

  // Attribute style: walk forward up to 10 lines for `(public|private|...) RetType Name(`.
  for (let i = startLine + 1; i < Math.min(lines.length, startLine + 10); i += 1) {
    const m = lines[i]!.match(
      /(?:public|private|protected|internal)\s+[\w<>,\s\[\]]+?\s+(\w+)\s*\(/,
    );
    if (m) return m[1]!;
  }
  return null;
}

/** Extract last identifier from an expression like `MyService.Handler` or `Handler`. */
function extractCSharpTailIdent(expr: string): string | null {
  const cleaned = expr.trim().replace(/\s+/g, '');
  const m = cleaned.match(/(?:\.|^)([A-Za-z_][A-Za-z0-9_]*)$/);
  return m ? m[1]! : null;
}
