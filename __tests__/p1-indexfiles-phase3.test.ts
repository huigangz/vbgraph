/**
 * P1.5 PR-16 — `CodeGraph.indexFiles()` runs Phase 3.
 *
 * Regression for Finding #4: `indexFiles()` previously delegated straight
 * to `ExtractionOrchestrator.indexFiles` and never invoked
 * `Phase3Orchestrator`. After the legacy per-file `extract` hook was
 * removed in PR-16, direct callers of `indexFiles()` lost every Phase 3
 * contribution (routes / components / tags / DI bindings) on the touched
 * files. This test pins the wiring.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  registerFrameworkResolver,
  unregisterFrameworkResolver,
} from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let tmpDir: string;
let cg: any;
let registeredFakeNames: string[] = [];

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function registerFake(r: FrameworkResolver): FrameworkResolver {
  registerFrameworkResolver(r);
  registeredFakeNames.push(r.name);
  return r;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-indexfiles-p3-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');

  const CodeGraph = (await import('../src/index')).default;
  cg = CodeGraph.initSync(tmpDir, {
    config: { include: ['**/*.ts'], exclude: [] },
  });
});

afterEach(() => {
  for (const n of registeredFakeNames) unregisterFrameworkResolver(n);
  registeredFakeNames = [];
  cg?.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CodeGraph.indexFiles runs Phase 3', () => {
  it('emits framework-synthesized nodes for files indexed via indexFiles()', async () => {
    registerFake({
      name: 'fake-indexfiles',
      detect: () => true,
      synthesize: () => ({
        nodes: [
          {
            id: 'framework:fake-indexfiles:route:demo',
            kind: 'route',
            name: 'GET /demo',
            qualifiedName: 'demo::route:/demo',
            filePath: 'app.ts',
            language: 'typescript',
            startLine: 1,
            endLine: 1,
            startColumn: 0,
            endColumn: 0,
            provenance: 'framework:fake-indexfiles',
            updatedAt: Date.now(),
          },
        ],
      }),
    });

    const result = await cg.indexFiles(['app.ts']);
    expect(result.success).toBe(true);
    const routes = cg.getNodesByKind('route');
    expect(routes.map((n: { id: string }) => n.id)).toContain(
      'framework:fake-indexfiles:route:demo',
    );
  });
});
