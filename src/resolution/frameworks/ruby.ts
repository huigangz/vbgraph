/**
 * Ruby on Rails Framework Resolver — Phase 3 shape.
 *
 * `extract` → `synthesize`: routes from `routes.rb` DSL.
 * `resolve` → dropped. The suffix-based by-name lookups (`*Controller`,
 * `*Service`, `*Helper`, ActiveRecord models) were heuristic best-effort
 * that the Ruby file resolver and scope index cover more precisely now.
 * Augment is omitted; route→handler `references/convention` edges follow
 * the same deferred pattern as the Python resolvers.
 */

import { Node } from '../../types';
import {
  FrameworkResolver,
  ResolutionContext,
  SynthesizeResult,
} from '../types';
import { GraphView } from '../graph-view';

export const railsResolver: FrameworkResolver = {
  name: 'rails',
  languages: ['ruby'],

  detect(context: ResolutionContext): boolean {
    const gemfile = context.readFile('Gemfile');
    if (gemfile && gemfile.includes("'rails'")) return true;
    if (context.fileExists('config/application.rb')) return true;
    return (
      context.fileExists('app/controllers/application_controller.rb') ||
      context.fileExists('config/routes.rb')
    );
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.rb')) continue;
      const safe = graph.readFileStripped(file, 'ruby');
      if (!safe) continue;

      // get/post/put/patch/delete/match '/path', to: 'controller#action'
      // Also: get '/path' => 'controller#action'
      const routeRegex =
        /\b(get|post|put|patch|delete|match)\s+['"]([^'"]+)['"]\s*(?:,\s*to:\s*|=>\s*)['"]([^#'"]+)#([^'"]+)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = routeRegex.exec(safe)) !== null) {
        const [, method, routePath] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const upper = method!.toUpperCase();
        nodes.push({
          id: `framework:rails:route:${file}:${line}:${upper}:${routePath}`,
          kind: 'route',
          name: `${upper} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'ruby',
          provenance: 'framework:rails',
          updatedAt: now,
        });
      }
    }

    return { nodes };
  },
};
