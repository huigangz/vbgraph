/**
 * P1.5 PR-14 — Spring DI dispatch unit tests.
 *
 * Verifies the augment-emitted `references/di_binding` edges for:
 *   #7  field injection (`@Autowired Foo foo`)
 *   #7a explicit constructor injection (`@Autowired public UserService(Foo)`)
 *   #7b Spring 4.3+ implicit single-constructor injection on @Service
 *   #7c multi-constructor without @Autowired — NO edges expected
 *
 * Tests drive the resolver against an in-memory GraphView. The Spring
 * fixture files live in __tests__/fixtures/spring-di-{field,ctor-*}/
 * for future end-to-end integration testing.
 */

import { describe, it, expect } from 'vitest';
import { springCoreResolver } from '../src/resolution/frameworks/spring-core';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';
import type { CommentLang } from '../src/resolution/strip-comments';
import type { Edge, EdgeKind, Node, NodeKind } from '../src/types';
import type { GraphView } from '../src/resolution/graph-view';

function mkView(
  files: Record<string, string>,
  language: CommentLang,
  options: { nodes?: Node[]; edges?: Edge[]; tags?: Map<string, Set<string>> } = {},
): GraphView {
  const nodes = options.nodes ?? [];
  const edges = options.edges ?? [];
  const tags = options.tags ?? new Map();
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  return {
    getNode: (id) => nodesById.get(id) ?? null,
    hasNode: (id) => nodesById.has(id),
    getNodesByKind: (k: NodeKind) => nodes.filter((n) => n.kind === k),
    getNodesByQualifiedName: (qn) => nodes.filter((n) => n.qualifiedName === qn),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByLowerName: (lower) => nodes.filter((n) => n.name.toLowerCase() === lower),
    getNodesByFile: (p) => nodes.filter((n) => n.filePath === p),
    getNodesByTag: (tag) => nodes.filter((n) => tags.get(n.id)?.has(tag)),
    *getAllNodes() {
      yield* nodes;
    },
    getOutgoingEdges: (id, kinds?: readonly EdgeKind[]) =>
      edges.filter((e) => e.source === id && (!kinds || kinds.includes(e.kind))),
    getIncomingEdges: (id, kinds?: readonly EdgeKind[]) =>
      edges.filter((e) => e.target === id && (!kinds || kinds.includes(e.kind))),
    getAllFiles: () => Object.keys(files),
    fileExists: (p) => p in files,
    readFile: (p) => files[p] ?? null,
    readFileStripped: (p) => {
      const raw = files[p];
      return raw === undefined ? null : stripCommentsForRegex(raw, language);
    },
    getProjectRoot: () => '/',
  };
}

function makeNode(id: string, name: string, overrides: Partial<Node> = {}): Node {
  return {
    id,
    kind: 'class',
    name,
    qualifiedName: name,
    filePath: '/App.java',
    language: 'java',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('#7 Spring DI — field injection (@Autowired field)', () => {
  it('emits di_binding edges to every implementor of the field type', () => {
    const userServiceSrc = `package app;
public class UserService {
    @Autowired
    private Foo foo;
}
`;
    const fooIface = makeNode('iface:Foo', 'Foo', {
      kind: 'interface',
      filePath: '/Foo.java',
    });
    const barImpl = makeNode('class:Bar', 'Bar', {
      kind: 'class',
      filePath: '/Bar.java',
    });
    const fooField = makeNode('field:UserService.foo', 'foo', {
      kind: 'field',
      filePath: '/UserService.java',
      startLine: 4,
      endLine: 4,
    });
    const view = mkView(
      { '/UserService.java': userServiceSrc },
      'java',
      {
        nodes: [fooIface, barImpl, fooField],
        edges: [
          {
            source: 'class:Bar',
            target: 'iface:Foo',
            kind: 'implements',
            provenance: 'tree-sitter',
          },
        ],
      },
    );

    const { edges } = springCoreResolver.augment!(view);
    const diBindings = edges.filter((e) => e.subkind === 'di_binding');
    expect(diBindings).toHaveLength(1);
    expect(diBindings[0]!.source).toBe('field:UserService.foo');
    expect(diBindings[0]!.target).toBe('class:Bar');
    expect(diBindings[0]!.kind).toBe('references');
    expect(diBindings[0]!.provenance).toBe('framework:spring-core');
    expect(diBindings[0]!.line).toBeUndefined();
  });
});

describe('#7a Spring DI — explicit @Autowired constructor injection', () => {
  it('emits di_binding from constructor parameter to implementor', () => {
    const userServiceSrc = `package app;
public class UserService {
    private final Foo foo;

    @Autowired
    public UserService(Foo foo) {
        this.foo = foo;
    }
}
`;
    const fooIface = makeNode('iface:Foo', 'Foo', {
      kind: 'interface',
      filePath: '/Foo.java',
    });
    const barImpl = makeNode('class:Bar', 'Bar', {
      kind: 'class',
      filePath: '/Bar.java',
    });
    const userService = makeNode('class:UserService', 'UserService', {
      kind: 'class',
      filePath: '/UserService.java',
      startLine: 2,
      endLine: 9,
    });
    const ctor = makeNode('ctor:UserService', 'UserService', {
      kind: 'constructor',
      filePath: '/UserService.java',
      startLine: 6,
      endLine: 8,
    });
    const param = makeNode('param:UserService.ctor.foo', 'foo', {
      kind: 'parameter',
      filePath: '/UserService.java',
      startLine: 6,
      endLine: 6,
    });
    const view = mkView(
      { '/UserService.java': userServiceSrc },
      'java',
      {
        nodes: [fooIface, barImpl, userService, ctor, param],
        edges: [
          { source: 'class:Bar', target: 'iface:Foo', kind: 'implements', provenance: 'tree-sitter' },
          { source: 'class:UserService', target: 'ctor:UserService', kind: 'contains', provenance: 'tree-sitter' },
          { source: 'ctor:UserService', target: 'param:UserService.ctor.foo', kind: 'contains', provenance: 'tree-sitter' },
        ],
      },
    );

    const { edges } = springCoreResolver.augment!(view);
    const diBindings = edges.filter((e) => e.subkind === 'di_binding');
    expect(diBindings).toHaveLength(1);
    expect(diBindings[0]!.source).toBe('param:UserService.ctor.foo');
    expect(diBindings[0]!.target).toBe('class:Bar');
  });
});

describe('#7b Spring DI — implicit single-constructor injection (Spring 4.3+)', () => {
  it('emits di_binding when the lone constructor of a @Service has no @Autowired', () => {
    const userServiceSrc = `package app;
public class UserService {
    private final Foo foo;
    public UserService(Foo foo) {
        this.foo = foo;
    }
}
`;
    const fooIface = makeNode('iface:Foo', 'Foo', {
      kind: 'interface',
      filePath: '/Foo.java',
    });
    const barImpl = makeNode('class:Bar', 'Bar', {
      kind: 'class',
      filePath: '/Bar.java',
    });
    const userService = makeNode('class:UserService', 'UserService', {
      kind: 'class',
      filePath: '/UserService.java',
      startLine: 2,
      endLine: 7,
    });
    const ctor = makeNode('ctor:UserService', 'UserService', {
      kind: 'constructor',
      filePath: '/UserService.java',
      startLine: 4,
      endLine: 6,
    });
    const param = makeNode('param:UserService.ctor.foo', 'foo', {
      kind: 'parameter',
      filePath: '/UserService.java',
      startLine: 4,
      endLine: 4,
    });

    // Pre-tag UserService as spring:service (this is what synthesize would do).
    const tags = new Map<string, Set<string>>([
      ['class:UserService', new Set(['spring:service'])],
    ]);
    const view = mkView(
      { '/UserService.java': userServiceSrc },
      'java',
      {
        nodes: [fooIface, barImpl, userService, ctor, param],
        edges: [
          { source: 'class:Bar', target: 'iface:Foo', kind: 'implements', provenance: 'tree-sitter' },
          { source: 'class:UserService', target: 'ctor:UserService', kind: 'contains', provenance: 'tree-sitter' },
          { source: 'ctor:UserService', target: 'param:UserService.ctor.foo', kind: 'contains', provenance: 'tree-sitter' },
        ],
        tags,
      },
    );

    const { edges } = springCoreResolver.augment!(view);
    const diBindings = edges.filter((e) => e.subkind === 'di_binding');
    expect(diBindings).toHaveLength(1);
    expect(diBindings[0]!.source).toBe('param:UserService.ctor.foo');
    expect(diBindings[0]!.target).toBe('class:Bar');
  });
});

describe('#7c Spring DI — multi-constructor without @Autowired is NOT injected', () => {
  it('emits zero di_binding edges when there are two un-annotated constructors', () => {
    const userServiceSrc = `package app;
public class UserService {
    private final Foo foo;
    public UserService(Foo foo) { this.foo = foo; }
    public UserService() { this.foo = null; }
}
`;
    const fooIface = makeNode('iface:Foo', 'Foo', {
      kind: 'interface',
      filePath: '/Foo.java',
    });
    const barImpl = makeNode('class:Bar', 'Bar', {
      kind: 'class',
      filePath: '/Bar.java',
    });
    const userService = makeNode('class:UserService', 'UserService', {
      kind: 'class',
      filePath: '/UserService.java',
      startLine: 2,
      endLine: 6,
    });
    const ctor1 = makeNode('ctor1:UserService', 'UserService', {
      kind: 'constructor',
      filePath: '/UserService.java',
      startLine: 4,
      endLine: 4,
    });
    const ctor2 = makeNode('ctor2:UserService', 'UserService', {
      kind: 'constructor',
      filePath: '/UserService.java',
      startLine: 5,
      endLine: 5,
    });
    const param = makeNode('param:UserService.ctor1.foo', 'foo', {
      kind: 'parameter',
      filePath: '/UserService.java',
      startLine: 4,
      endLine: 4,
    });
    const tags = new Map<string, Set<string>>([
      ['class:UserService', new Set(['spring:service'])],
    ]);
    const view = mkView(
      { '/UserService.java': userServiceSrc },
      'java',
      {
        nodes: [fooIface, barImpl, userService, ctor1, ctor2, param],
        edges: [
          { source: 'class:Bar', target: 'iface:Foo', kind: 'implements', provenance: 'tree-sitter' },
          { source: 'class:UserService', target: 'ctor1:UserService', kind: 'contains', provenance: 'tree-sitter' },
          { source: 'class:UserService', target: 'ctor2:UserService', kind: 'contains', provenance: 'tree-sitter' },
          { source: 'ctor1:UserService', target: 'param:UserService.ctor1.foo', kind: 'contains', provenance: 'tree-sitter' },
        ],
        tags,
      },
    );

    const { edges } = springCoreResolver.augment!(view);
    const diBindings = edges.filter((e) => e.subkind === 'di_binding');
    expect(diBindings).toHaveLength(0);
  });
});

describe('springCoreResolver.synthesize — bean tag emission', () => {
  it('tags an existing class with @Service annotation as spring:service', () => {
    const src = `package app;

@Service
public class UserService {
    public String hello() { return "hi"; }
}
`;
    const cls = makeNode('class:UserService', 'UserService', {
      kind: 'class',
      filePath: '/UserService.java',
      startLine: 4,
      endLine: 6,
    });
    const view = mkView({ '/UserService.java': src }, 'java', { nodes: [cls] });
    const { tags = [] } = springCoreResolver.synthesize!(view);
    const t = tags.find((x) => x.nodeId === 'class:UserService');
    expect(t).toBeDefined();
    expect(t!.tags).toContain('spring:service');
  });

  it('tags @Controller / @RestController as spring:controller', () => {
    const src = `package app;
@RestController
public class UserController {}
`;
    const cls = makeNode('class:UserController', 'UserController', {
      kind: 'class',
      filePath: '/UserController.java',
      startLine: 3,
      endLine: 3,
    });
    const view = mkView({ '/UserController.java': src }, 'java', { nodes: [cls] });
    const { tags = [] } = springCoreResolver.synthesize!(view);
    const t = tags.find((x) => x.nodeId === 'class:UserController');
    expect(t!.tags).toContain('spring:controller');
  });
});

describe('Spring Temporal dispatch (smoke)', () => {
  it('does not crash when no temporal stubs are present', async () => {
    // Just verifies the resolver wires up and runs cleanly with no stub
    // factories. The real fixture-based dispatch tests come with the
    // first end-to-end Java fixture.
    const { springTemporalResolver } = await import('../src/resolution/frameworks/spring-temporal');
    const view = mkView({ '/X.java': 'class X {}' }, 'java');
    const result = springTemporalResolver.augment!(view);
    expect(result.edges).toHaveLength(0);
  });

  it('emits a calls/temporal_dispatch edge for newWorkflowStub chain', async () => {
    const { springTemporalResolver } = await import('../src/resolution/frameworks/spring-temporal');
    const src = `package app;
public class Caller {
    public void run() {
        client.newWorkflowStub(MyWorkflow.class).execute();
    }
}
`;
    const iface = makeNode('iface:MyWorkflow', 'MyWorkflow', { kind: 'interface', filePath: '/MyWorkflow.java' });
    const impl = makeNode('class:MyWorkflowImpl', 'MyWorkflowImpl', { kind: 'class', filePath: '/Impl.java' });
    const implRun = makeNode('method:Impl.execute', 'execute', { kind: 'method', filePath: '/Impl.java' });
    const callerClass = makeNode('class:Caller', 'Caller', {
      kind: 'class',
      filePath: '/Caller.java',
      startLine: 2,
      endLine: 6,
    });
    const callerMethod = makeNode('method:Caller.run', 'run', {
      kind: 'method',
      filePath: '/Caller.java',
      startLine: 3,
      endLine: 5,
    });
    const view = mkView(
      { '/Caller.java': src },
      'java',
      {
        nodes: [iface, impl, implRun, callerClass, callerMethod],
        edges: [
          { source: 'class:MyWorkflowImpl', target: 'iface:MyWorkflow', kind: 'implements', provenance: 'tree-sitter' },
        ],
      },
    );
    const { edges } = springTemporalResolver.augment!(view);
    const dispatch = edges.find((e) => e.subkind === 'temporal_dispatch');
    expect(dispatch).toBeDefined();
    expect(dispatch!.source).toBe('method:Caller.run');
    expect(dispatch!.target).toBe('method:Impl.execute');
    expect(dispatch!.kind).toBe('calls');
    expect(dispatch!.provenance).toBe('framework:spring-temporal');
    expect(dispatch!.line).toBe(4);
  });
});

describe('Generic temporal — TypeScript dispatch', () => {
  it('emits temporal_dispatch for client.workflow.start(MyWorkflow, ...)', async () => {
    const { temporalResolver } = await import('../src/resolution/frameworks/temporal');
    const src = `import { Client } from '@temporalio/client';
async function caller() {
    await client.workflow.start(MyWorkflow, { args: [] });
}
`;
    const iface = makeNode('class:MyWorkflow', 'MyWorkflow', {
      kind: 'class',
      filePath: '/MyWorkflow.ts',
      language: 'typescript',
    });
    const implRun = makeNode('method:MyWorkflow.run', 'run', {
      kind: 'method',
      filePath: '/MyWorkflow.ts',
      language: 'typescript',
    });
    const callerFn = makeNode('fn:caller', 'caller', {
      kind: 'function',
      filePath: '/caller.ts',
      language: 'typescript',
      startLine: 2,
      endLine: 4,
    });
    const view = mkView(
      { '/caller.ts': src },
      'typescript',
      { nodes: [iface, implRun, callerFn] },
    );
    const { edges } = temporalResolver.augment!(view);
    const dispatch = edges.find((e) => e.subkind === 'temporal_dispatch');
    expect(dispatch).toBeDefined();
    expect(dispatch!.source).toBe('fn:caller');
    expect(dispatch!.target).toBe('method:MyWorkflow.run');
    expect(dispatch!.provenance).toBe('framework:temporal');
  });
});

describe('Generic temporal — Go dispatch', () => {
  it('emits temporal_dispatch for client.ExecuteWorkflow(ctx, opts, MyWorkflow)', async () => {
    const { temporalResolver } = await import('../src/resolution/frameworks/temporal');
    const src = `package main
func caller() {
    client.ExecuteWorkflow(ctx, opts, MyWorkflow)
}
`;
    const workflowStruct = makeNode('struct:MyWorkflow', 'MyWorkflow', {
      kind: 'struct',
      filePath: '/workflow.go',
      language: 'go',
    });
    const runMethod = makeNode('method:MyWorkflow.Run', 'Run', {
      kind: 'method',
      filePath: '/workflow.go',
      language: 'go',
    });
    const callerFn = makeNode('fn:caller', 'caller', {
      kind: 'function',
      filePath: '/main.go',
      language: 'go',
      startLine: 2,
      endLine: 4,
    });
    const view = mkView(
      { '/main.go': src },
      'go',
      { nodes: [workflowStruct, runMethod, callerFn] },
    );
    const { edges } = temporalResolver.augment!(view);
    const dispatch = edges.find((e) => e.subkind === 'temporal_dispatch');
    expect(dispatch).toBeDefined();
    expect(dispatch!.source).toBe('fn:caller');
    expect(dispatch!.target).toBe('method:MyWorkflow.Run');
  });
});
