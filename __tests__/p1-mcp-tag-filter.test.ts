/**
 * P1.5 PR-16 — MCP codegraph_search tag filter.
 *
 * Regression for the tag-filter false-negative bug. The earlier fix
 * over-fetched candidates up to a 500-row cap and post-filtered. That
 * still false-negatived on large repos with >500 high-ranking untagged
 * matches. The current implementation pushes the tag filter into the
 * SQL candidate query (`INNER JOIN node_tags`), so the DB returns at
 * most `limit` already-tagged rows.
 *
 * Tests seed *real* untagged FTS noise to exercise the bug — the
 * earlier test didn't, despite the comment.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolHandler } from '../src/mcp/tools';
import { QueryBuilder } from '../src/db/queries';
import type { Node } from '../src/types';

let tmpDir: string;
let cg: any;
let handler: ToolHandler;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-tag-'));
  fs.mkdirSync(path.join(tmpDir, '.codegraph'));
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');

  const CodeGraph = (await import('../src/index')).default;
  cg = CodeGraph.initSync(tmpDir, {
    config: { include: ['**/*.ts'], exclude: [] },
  });
  await cg.indexAll();
  handler = new ToolHandler(cg);
});

afterEach(() => {
  handler?.closeAll();
  cg?.destroy();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkNode(id: string, name: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: 'class',
    name,
    qualifiedName: name,
    filePath: '/app.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function seedNodes(opts: {
  taggedCount: number;
  taggedNamePrefix: string;
  tag?: string;
  untaggedCount: number;
  untaggedNamePrefix: string;
}): void {
  const q = (cg as unknown as { queries: QueryBuilder }).queries;
  // Untagged nodes are inserted FIRST so their auto-increment edges /
  // FTS rowids put them ahead of the tagged set in score ties.
  for (let i = 0; i < opts.untaggedCount; i += 1) {
    const id = `untagged:${i.toString().padStart(4, '0')}`;
    q.insertNode(mkNode(id, `${opts.untaggedNamePrefix}${i}`));
  }
  for (let i = 0; i < opts.taggedCount; i += 1) {
    const id = `tagged:${i.toString().padStart(4, '0')}`;
    q.insertNode(mkNode(id, `${opts.taggedNamePrefix}${i}`));
    if (opts.tag) q.insertNodeTag(id, opts.tag, 'framework:fake');
  }
}

describe('MCP codegraph_search — DB-side tag filter', () => {
  it('finds tagged matches even when 1000+ untagged matches rank higher', async () => {
    // Seed 1000 untagged classes all named "ServiceFoo<N>" (perfect
    // FTS hits for "ServiceFoo"), plus 5 tagged classes also matching.
    // The untagged set is 2× the post-fix DB candidate-set theoretical
    // ceiling and 5× the earlier 500-row over-fetch cap — without the
    // DB-side INNER JOIN, the tag filter would never see the tagged
    // matches.
    seedNodes({
      untaggedCount: 1000,
      untaggedNamePrefix: 'ServiceFooUntagged',
      taggedCount: 5,
      taggedNamePrefix: 'ServiceFooTagged',
      tag: 'spring:service',
    });

    const result = await handler.execute('codegraph_search', {
      query: 'ServiceFoo',
      tag: 'spring:service',
      limit: 10,
    });

    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/^No results found/);
    // Every result line must be a tagged match — confirms the filter
    // didn't leak untagged rows.
    const taggedNameMatches = text.match(/ServiceFooTagged\d+/g) ?? [];
    const untaggedNameMatches = text.match(/ServiceFooUntagged\d+/g) ?? [];
    expect(taggedNameMatches.length).toBeGreaterThan(0);
    expect(untaggedNameMatches.length).toBe(0);
  });

  it('returns "No results" when the tag has zero matches for the query', async () => {
    seedNodes({
      untaggedCount: 50,
      untaggedNamePrefix: 'Foo',
      taggedCount: 3,
      taggedNamePrefix: 'Bar',
      tag: 'spring:service',
    });

    // Query matches untagged "Foo*" but tag matches "Bar*" — intersection empty.
    const result = await handler.execute('codegraph_search', {
      query: 'Foo',
      tag: 'spring:service',
      limit: 10,
    });
    expect(result.content[0]?.text ?? '').toMatch(/No results found/);
  });

  it('without tag, returns the normal mix of nodes (no filter)', async () => {
    seedNodes({
      untaggedCount: 5,
      untaggedNamePrefix: 'PlainNode',
      taggedCount: 5,
      taggedNamePrefix: 'TaggedNode',
      tag: 'spring:service',
    });
    const result = await handler.execute('codegraph_search', {
      query: 'Node',
      limit: 20,
    });
    expect(result.content[0]?.text ?? '').not.toMatch(/^No results found/);
  });
});
