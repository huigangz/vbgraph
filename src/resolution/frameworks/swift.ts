/**
 * Swift Framework Resolvers — Phase 3 shape.
 *
 * Three resolvers, one file (per the plan's PR-13: scheduled last for
 * the file-size reason):
 *   - swiftui: synthesizes `component` nodes for SwiftUI `View` structs;
 *     tags `swiftui:app` on existing `class`/`struct` nodes that match
 *     the `@main App` pattern (node-kind discipline: an App struct IS
 *     its source-code struct).
 *   - uikit: tags `uikit:viewcontroller` / `uikit:uiview` on existing
 *     class nodes whose declaration matches the convention (no
 *     synthesized phantom classes — Node-kind discipline).
 *   - vapor: synthesizes `route` nodes from `app.METHOD("/x", use: handler)`;
 *     augments with route→handler `references/convention` edges.
 *
 * All three drop their suffix-based `resolve` heuristics (the legacy
 * `*View` / `*ViewModel` / `*ViewController` / `*Cell` / `*Controller` /
 * `*Model` lookups). Swift doesn't have a scope resolver yet (P0.5b
 * covers csharp/vbnet/java/python/typescript), so some recall is lost.
 * Trade-off documented in the laravel/rails migration worklogs.
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
// swiftui
// ════════════════════════════════════════════════════════════════════

const SWIFTUI_VIEW_PATTERN = /struct\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*View/g;
const SWIFTUI_APP_PATTERN = /@main\s+struct\s+(\w+)\s*:\s*App/g;

export const swiftUIResolver: FrameworkResolver = {
  name: 'swiftui',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import SwiftUI')) return true;
      }
    }
    for (const file of allFiles) {
      if (file.endsWith('.xcodeproj') || file.endsWith('.xcworkspace')) return true;
    }
    return false;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const tags: Array<{ nodeId: string; tags: string[] }> = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.swift')) continue;
      const safe = graph.readFileStripped(file, 'swift');
      if (!safe) continue;

      // SwiftUI Views — synthesized as `component` nodes.
      SWIFTUI_VIEW_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = SWIFTUI_VIEW_PATTERN.exec(safe)) !== null) {
        const [, viewName] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const id = `framework:swiftui:view:${file}:${viewName}:${line}`;
        nodes.push({
          id,
          kind: 'component',
          name: viewName!,
          qualifiedName: `${file}::${viewName}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'swift',
          provenance: 'framework:swiftui',
          updatedAt: now,
        });
        tags.push({ nodeId: id, tags: ['swiftui:view'] });
      }

      // @main App entry point — tag the EXISTING struct node, don't synthesize.
      SWIFTUI_APP_PATTERN.lastIndex = 0;
      while ((match = SWIFTUI_APP_PATTERN.exec(safe)) !== null) {
        const [, appName] = match;
        const existing = graph
          .getNodesByName(appName!)
          .find((n) => n.filePath === file && (n.kind === 'struct' || n.kind === 'class'));
        if (existing) {
          tags.push({ nodeId: existing.id, tags: ['swiftui:app', 'entry-point'] });
        }
      }
    }

    return { nodes, tags };
  },
};

// ════════════════════════════════════════════════════════════════════
// uikit
// ════════════════════════════════════════════════════════════════════

const UIKIT_VC_PATTERN = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIViewController/g;
const UIKIT_VIEW_PATTERN = /class\s+(\w+)\s*:\s*(?:\w+\s*,\s*)*UIView[^C]/g;

export const uikitResolver: FrameworkResolver = {
  name: 'uikit',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (
          content &&
          (content.includes('import UIKit') ||
            content.includes('UIViewController') ||
            content.includes('UIView'))
        ) {
          return true;
        }
      }
    }
    return false;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const tags: Array<{ nodeId: string; tags: string[] }> = [];

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.swift')) continue;
      const safe = graph.readFileStripped(file, 'swift');
      if (!safe) continue;

      const tagExistingClass = (className: string, tagName: string) => {
        const existing = graph
          .getNodesByName(className)
          .find((n) => n.filePath === file && n.kind === 'class');
        if (existing) tags.push({ nodeId: existing.id, tags: [tagName] });
      };

      UIKIT_VC_PATTERN.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = UIKIT_VC_PATTERN.exec(safe)) !== null) {
        tagExistingClass(match[1]!, 'uikit:viewcontroller');
      }

      UIKIT_VIEW_PATTERN.lastIndex = 0;
      while ((match = UIKIT_VIEW_PATTERN.exec(safe)) !== null) {
        tagExistingClass(match[1]!, 'uikit:uiview');
      }
    }

    return { nodes: [], tags };
  },
};

// ════════════════════════════════════════════════════════════════════
// vapor
// ════════════════════════════════════════════════════════════════════

const VAPOR_ROUTE_REGEX =
  /\b(?:app|router|routes)\.(get|post|put|patch|delete)\s*\(\s*"([^"]+)"\s*,\s*use:\s*([A-Za-z_][A-Za-z0-9_.]*)/g;

export const vaporResolver: FrameworkResolver = {
  name: 'vapor',
  languages: ['swift'],

  detect(context: ResolutionContext): boolean {
    const packageSwift = context.readFile('Package.swift');
    if (packageSwift && packageSwift.includes('vapor')) return true;
    const allFiles = context.getAllFiles();
    for (const file of allFiles) {
      if (file.endsWith('.swift')) {
        const content = context.readFile(file);
        if (content && content.includes('import Vapor')) return true;
      }
    }
    return false;
  },

  synthesize(graph: GraphView): SynthesizeResult {
    const nodes: Node[] = [];
    const now = Date.now();

    for (const file of graph.getAllFiles()) {
      if (!file.endsWith('.swift')) continue;
      const safe = graph.readFileStripped(file, 'swift');
      if (!safe) continue;

      VAPOR_ROUTE_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = VAPOR_ROUTE_REGEX.exec(safe)) !== null) {
        const [, method, routePath] = match;
        const line = safe.slice(0, match.index).split('\n').length;
        const upper = method!.toUpperCase();
        nodes.push({
          id: `framework:vapor:route:${file}:${line}:${upper}:${routePath}`,
          kind: 'route',
          name: `${upper} ${routePath}`,
          qualifiedName: `${file}::route:${routePath}`,
          filePath: file,
          startLine: line,
          endLine: line,
          startColumn: 0,
          endColumn: match[0].length,
          language: 'swift',
          provenance: 'framework:vapor',
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
      if (route.provenance !== 'framework:vapor') continue;
      const safe = graph.readFileStripped(route.filePath, 'swift');
      if (!safe) continue;
      const lineText = safe.split('\n')[route.startLine - 1];
      if (!lineText) continue;
      const m = lineText.match(
        /\b(?:app|router|routes)\.(?:get|post|put|patch|delete)\s*\(\s*"[^"]+"\s*,\s*use:\s*([A-Za-z_][A-Za-z0-9_.]*)/,
      );
      if (!m) continue;
      const parts = m[1]!.split('.');
      const handlerName = parts[parts.length - 1]!;
      const candidates = graph
        .getNodesByName(handlerName)
        .filter((n) => n.kind === 'function' || n.kind === 'method');
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
        provenance: 'framework:vapor',
        confidence: 0.85,
      });
      tags.push({ nodeId: preferred[0]!.id, tags: ['vapor:controller', 'route-handler'] });
    }

    return { edges, tags };
  },
};
