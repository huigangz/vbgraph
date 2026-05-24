import { describe, it, expect } from 'vitest';
import type { FrameworkResolver, UnresolvedRef } from '../src/resolution/types';
import type { Edge, EdgeKind, Node, NodeKind } from '../src/types';
import type { GraphView } from '../src/resolution/graph-view';
import type { CommentLang } from '../src/resolution/strip-comments';
import { stripCommentsForRegex } from '../src/resolution/strip-comments';

/**
 * In-memory `GraphView` for testing migrated resolvers' synthesize/augment
 * hooks without standing up a SQLite DB. Pass a `{path: content}` map and
 * the language to use for `readFileStripped`. Optional `nodes` and `edges`
 * back the graph-side lookups.
 */
function makeStubGraphView(
  files: Record<string, string>,
  language: CommentLang,
  options: { nodes?: Node[]; edges?: Edge[] } = {},
): GraphView {
  const nodes = options.nodes ?? [];
  const edges = options.edges ?? [];
  const nodesById = new Map(nodes.map((n) => [n.id, n]));
  return {
    getNode: (id) => nodesById.get(id) ?? null,
    hasNode: (id) => nodesById.has(id),
    getNodesByKind: (k: NodeKind) => nodes.filter((n) => n.kind === k),
    getNodesByQualifiedName: (qn) => nodes.filter((n) => n.qualifiedName === qn),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByLowerName: (lower) => nodes.filter((n) => n.name.toLowerCase() === lower),
    getNodesByFile: (p) => nodes.filter((n) => n.filePath === p),
    getNodesByTag: () => [],
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

describe('FrameworkResolver.extract interface', () => {
  it('extract() returns { nodes, references }', () => {
    const resolver: FrameworkResolver = {
      name: 'fake',
      detect: () => true,
      resolve: () => null,
      languages: ['python'],
      extract: (_filePath: string, _content: string) => ({
        nodes: [] as Node[],
        references: [] as UnresolvedRef[],
      }),
    };
    const result = resolver.extract!('foo.py', '');
    expect(result).toEqual({ nodes: [], references: [] });
  });
});

import { getApplicableFrameworks } from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';

describe('getApplicableFrameworks', () => {
  const pyFw: FrameworkResolver = { name: 'py', languages: ['python'], detect: () => true, resolve: () => null };
  const jsFw: FrameworkResolver = { name: 'js', languages: ['javascript', 'typescript'], detect: () => true, resolve: () => null };
  const anyFw: FrameworkResolver = { name: 'any', detect: () => true, resolve: () => null };

  it('filters by language', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'python');
    expect(result.map(r => r.name)).toEqual(['py', 'any']);
  });

  it('returns anyFw-only when language has no matches', () => {
    const result = getApplicableFrameworks([pyFw, jsFw, anyFw], 'rust');
    expect(result.map(r => r.name)).toEqual(['any']);
  });
});

import { djangoResolver } from '../src/resolution/frameworks/python';

describe('djangoResolver.synthesize', () => {
  it('extracts route node for path() with CBV.as_view()', () => {
    const src = `
from django.urls import path
from users.views import UserListView

urlpatterns = [
    path('users/', UserListView.as_view(), name='user-list'),
]
`;
    const view = makeStubGraphView({ 'users/urls.py': src }, 'python');
    const { nodes } = djangoResolver.synthesize!(view);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('users/');
    expect(nodes[0]!.provenance).toBe('framework:django');
  });

  it('extracts route for path() with dotted module.Class.as_view()', () => {
    const src = `from django.urls import path\nfrom api.v1 import views as api_v1_views\nurlpatterns = [path('api/', api_v1_views.UserListView.as_view())]\n`;
    const view = makeStubGraphView({ 'api/urls.py': src }, 'python');
    const { nodes } = djangoResolver.synthesize!(view);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('api/');
  });

  it('extracts route for path() with bare function view', () => {
    const src = `from django.urls import path\nurlpatterns = [path('home/', home_view, name='home')]\n`;
    const view = makeStubGraphView({ 'home/urls.py': src }, 'python');
    const { nodes } = djangoResolver.synthesize!(view);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.name).toBe('home/');
  });

  it('extracts route for path() with include()', () => {
    const src = `from django.urls import path, include\nurlpatterns = [path('api/', include('api.urls'))]\n`;
    const view = makeStubGraphView({ 'root/urls.py': src }, 'python');
    const { nodes } = djangoResolver.synthesize!(view);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
  });

  it('extracts routes for re_path and url', () => {
    const src = `from django.urls import re_path, url\nurlpatterns = [re_path(r'^users/$', UserView), url(r'^old/$', OldView)]\n`;
    const view = makeStubGraphView({ 'legacy/urls.py': src }, 'python');
    const { nodes } = djangoResolver.synthesize!(view);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name)).toEqual(['^users/$', '^old/$']);
  });

  it('returns empty result for a non-urls.py python file', () => {
    const src = `def foo(): return 1\n`;
    const view = makeStubGraphView({ 'views.py': src }, 'python');
    const { nodes } = djangoResolver.synthesize!(view);
    expect(nodes).toEqual([]);
  });
});

import { flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python';

describe('flaskResolver.synthesize', () => {
  it('extracts route from @app.route', () => {
    const src = `
@app.route('/users')
def list_users():
    return []
`;
    const view = makeStubGraphView({ 'app.py': src }, 'python');
    const { nodes } = flaskResolver.synthesize!(view);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('GET /users');
  });

  it('extracts blueprint routes', () => {
    const src = `
@users_bp.route('/<id>', methods=['POST'])
def create_user(id):
    pass
`;
    const view = makeStubGraphView({ 'routes.py': src }, 'python');
    const { nodes } = flaskResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('POST /<id>');
  });
});

describe('fastapiResolver.synthesize', () => {
  it('extracts route from @app.get', () => {
    const src = `
@app.get('/users')
async def list_users():
    return []
`;
    const view = makeStubGraphView({ 'main.py': src }, 'python');
    const { nodes } = fastapiResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('GET /users');
  });

  it('extracts route from router.post', () => {
    const src = `
@router.post('/items')
def create_item(item: Item):
    pass
`;
    const view = makeStubGraphView({ 'items.py': src }, 'python');
    const { nodes } = fastapiResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('POST /items');
  });
});

import { expressResolver } from '../src/resolution/frameworks/express';

describe('expressResolver.synthesize', () => {
  it('extracts route with inline handler reference', () => {
    const src = `app.get('/users', listUsers);\n`;
    const view = makeStubGraphView({ 'routes.ts': src }, 'typescript');
    const result = expressResolver.synthesize!(view);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.name).toBe('GET /users');
    expect(result.nodes[0]!.provenance).toBe('framework:express');
  });

  it('extracts route with router.post and middleware chain', () => {
    const src = `router.post('/items', auth, createItem);\n`;
    const view = makeStubGraphView({ 'items.ts': src }, 'typescript');
    const result = expressResolver.synthesize!(view);
    expect(result.nodes[0]!.name).toBe('POST /items');
  });

  it('extracts route with controller method reference', () => {
    const src = `app.get('/x', userController.list);\n`;
    const view = makeStubGraphView({ 'routes.ts': src }, 'typescript');
    const result = expressResolver.synthesize!(view);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.name).toBe('GET /x');
  });
});

import { laravelResolver } from '../src/resolution/frameworks/laravel';

describe('laravelResolver.synthesize', () => {
  it('extracts route with controller tuple syntax', () => {
    const src = `Route::get('/users', [UserController::class, 'index']);\n`;
    const view = makeStubGraphView({ 'routes/web.php': src }, 'php');
    const { nodes } = laravelResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('GET /users');
    expect(nodes[0]!.provenance).toBe('framework:laravel');
  });

  it('extracts route with Controller@action syntax', () => {
    const src = `Route::post('/users', 'UserController@store');\n`;
    const view = makeStubGraphView({ 'routes/web.php': src }, 'php');
    const { nodes } = laravelResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('POST /users');
  });

  it('extracts resource route', () => {
    const src = `Route::resource('users', UserController::class);\n`;
    const view = makeStubGraphView({ 'routes/web.php': src }, 'php');
    const { nodes } = laravelResolver.synthesize!(view);
    expect(nodes[0]!.kind).toBe('route');
    expect(nodes[0]!.name).toBe('resource:users');
  });
});

import { railsResolver } from '../src/resolution/frameworks/ruby';

describe('railsResolver.synthesize', () => {
  it('extracts route with controller#action syntax', () => {
    const src = `get '/users', to: 'users#index'\n`;
    const view = makeStubGraphView({ 'config/routes.rb': src }, 'ruby');
    const { nodes } = railsResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('GET /users');
    expect(nodes[0]!.provenance).toBe('framework:rails');
  });

  it('extracts route without to: keyword', () => {
    const src = `post '/items' => 'items#create'\n`;
    const view = makeStubGraphView({ 'config/routes.rb': src }, 'ruby');
    const { nodes } = railsResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('POST /items');
  });
});

import { springCoreResolver } from '../src/resolution/frameworks/spring-core';

describe('springCoreResolver.synthesize', () => {
  it('extracts route with @GetMapping', () => {
    const src = `
@GetMapping("/users")
public List<User> listUsers() {
  return users;
}
`;
    const view = makeStubGraphView({ 'UserController.java': src }, 'java');
    const { nodes } = springCoreResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('GET /users');
    expect(nodes[0]!.provenance).toBe('framework:spring-core');
  });
});

import { goResolver } from '../src/resolution/frameworks/go';

describe('goResolver.synthesize', () => {
  it('extracts route from r.GET', () => {
    const src = `r.GET("/users", listUsers)\n`;
    const view = makeStubGraphView({ 'main.go': src }, 'go');
    const { nodes } = goResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('GET /users');
    expect(nodes[0]!.provenance).toBe('framework:go');
  });

  it('extracts route from router.HandleFunc', () => {
    const src = `router.HandleFunc("/items", createItem)\n`;
    const view = makeStubGraphView({ 'main.go': src }, 'go');
    const { nodes } = goResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('ANY /items');
  });
});

import { rustResolver } from '../src/resolution/frameworks/rust';

describe('rustResolver.synthesize', () => {
  it('extracts route from axum .route with get()', () => {
    const src = `let app = Router::new().route("/users", get(list_users));\n`;
    const view = makeStubGraphView({ 'main.rs': src }, 'rust');
    const { nodes } = rustResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('GET /users');
    expect(nodes[0]!.provenance).toBe('framework:rust');
  });
});

describe('rustResolver.resolve cargo workspace crates', () => {
  it('resolves crate name from workspace member lib.rs', () => {
    const workspaceCargo = `
[workspace]
members = ["crates/mytool-core", "crates/mytool-fetcher"]
`;
    const coreCargo = `
[package]
name = "mytool-core"
version = "0.1.0"
`;
    const libNode: Node = {
      id: 'module:crates/mytool-core/src/lib.rs:mytool_core:1',
      kind: 'module',
      name: 'mytool_core',
      qualifiedName: 'crates/mytool-core/src/lib.rs::mytool_core',
      filePath: 'crates/mytool-core/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const context = {
      getNodesInFile: (fp: string) => (fp === 'crates/mytool-core/src/lib.rs' ? [libNode] : []),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        p === 'Cargo.toml' ||
        p === 'crates/mytool-core/Cargo.toml' ||
        p === 'crates/mytool-core/src/lib.rs'
      ),
      readFile: (p: string) => {
        if (p === 'Cargo.toml') return workspaceCargo;
        if (p === 'crates/mytool-core/Cargo.toml') return coreCargo;
        return null;
      },
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        'crates/mytool-core/Cargo.toml',
        'crates/mytool-core/src/lib.rs',
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'fn:crates/mytool-fetcher/src/main.rs:main:1',
      referenceName: 'mytool_core',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-fetcher/src/main.rs',
      language: 'rust' as const,
    };

    const result = rustResolver.resolve(ref, context);
    expect(result?.targetNodeId).toBe(libNode.id);
    expect(result?.resolvedBy).toBe('framework');
    // Workspace-manifest hits are unambiguous and must beat name-matcher's
    // self-file matches (0.7) so cross-crate `imports` edges materialize.
    expect(result?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('resolves crate name from workspace member main.rs when lib.rs is absent', () => {
    const workspaceCargo = `
[workspace]
members = [
  "crates/mytool-runner",
]
`;
    const runnerCargo = `
[package]
name = "mytool-runner"
version = "0.1.0"
`;
    const mainNode: Node = {
      id: 'module:crates/mytool-runner/src/main.rs:mytool_runner:1',
      kind: 'module',
      name: 'mytool_runner',
      qualifiedName: 'crates/mytool-runner/src/main.rs::mytool_runner',
      filePath: 'crates/mytool-runner/src/main.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const context = {
      getNodesInFile: (fp: string) => (fp === 'crates/mytool-runner/src/main.rs' ? [mainNode] : []),
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        p === 'Cargo.toml' ||
        p === 'crates/mytool-runner/Cargo.toml' ||
        p === 'crates/mytool-runner/src/main.rs'
      ),
      readFile: (p: string) => {
        if (p === 'Cargo.toml') return workspaceCargo;
        if (p === 'crates/mytool-runner/Cargo.toml') return runnerCargo;
        return null;
      },
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        'crates/mytool-runner/Cargo.toml',
        'crates/mytool-runner/src/main.rs',
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
    };

    const ref = {
      fromNodeId: 'fn:crates/mytool-runner/src/main.rs:main:1',
      referenceName: 'mytool_runner',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-runner/src/main.rs',
      language: 'rust' as const,
    };

    const result = rustResolver.resolve(ref, context);
    expect(result?.targetNodeId).toBe(mainNode.id);
    expect(result?.resolvedBy).toBe('framework');
  });

  it('resolves crate name when members uses a glob (crates/*)', () => {
    const workspaceCargo = `
[workspace]
members = ["crates/*"]
`;
    const fooCargo = `
[package]
name = "mytool-foo"
version = "0.1.0"
`;
    const barCargo = `
[package]
name = "mytool-bar"
version = "0.1.0"
`;
    const fooLib: Node = {
      id: 'module:crates/mytool-foo/src/lib.rs:mytool_foo:1',
      kind: 'module',
      name: 'mytool_foo',
      qualifiedName: 'crates/mytool-foo/src/lib.rs::mytool_foo',
      filePath: 'crates/mytool-foo/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
    const barLib: Node = {
      id: 'module:crates/mytool-bar/src/lib.rs:mytool_bar:1',
      kind: 'module',
      name: 'mytool_bar',
      qualifiedName: 'crates/mytool-bar/src/lib.rs::mytool_bar',
      filePath: 'crates/mytool-bar/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const filesByPath: Record<string, string> = {
      'Cargo.toml': workspaceCargo,
      'crates/mytool-foo/Cargo.toml': fooCargo,
      'crates/mytool-bar/Cargo.toml': barCargo,
    };
    const nodesByFile: Record<string, Node[]> = {
      'crates/mytool-foo/src/lib.rs': [fooLib],
      'crates/mytool-bar/src/lib.rs': [barLib],
    };
    const dirsByPath: Record<string, string[]> = {
      '.': ['crates'],
      crates: ['mytool-foo', 'mytool-bar'],
      'crates/mytool-foo': ['src'],
      'crates/mytool-bar': ['src'],
    };

    const context = {
      getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        Object.prototype.hasOwnProperty.call(filesByPath, p) ||
        Object.prototype.hasOwnProperty.call(nodesByFile, p)
      ),
      readFile: (p: string) => filesByPath[p] ?? null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
        ...Object.keys(nodesByFile),
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      listDirectories: (rel: string) => dirsByPath[rel] ?? [],
    };

    const fooRef = {
      fromNodeId: 'fn:crates/mytool-bar/src/lib.rs:other:1',
      referenceName: 'mytool_foo',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-bar/src/lib.rs',
      language: 'rust' as const,
    };
    const barRef = {
      fromNodeId: 'fn:crates/mytool-foo/src/lib.rs:other:1',
      referenceName: 'mytool_bar',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'crates/mytool-foo/src/lib.rs',
      language: 'rust' as const,
    };

    expect(rustResolver.resolve(fooRef, context)?.targetNodeId).toBe(fooLib.id);
    expect(rustResolver.resolve(barRef, context)?.targetNodeId).toBe(barLib.id);
  });

  it('resolves crate name when members uses a name glob at root (helix-*)', () => {
    const workspaceCargo = `
[workspace]
members = ["helix-*"]
`;
    const coreCargo = `
[package]
name = "helix-core"
version = "0.1.0"
`;
    const coreLib: Node = {
      id: 'module:helix-core/src/lib.rs:helix_core:1',
      kind: 'module',
      name: 'helix_core',
      qualifiedName: 'helix-core/src/lib.rs::helix_core',
      filePath: 'helix-core/src/lib.rs',
      language: 'rust',
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };

    const filesByPath: Record<string, string> = {
      'Cargo.toml': workspaceCargo,
      'helix-core/Cargo.toml': coreCargo,
    };
    const nodesByFile: Record<string, Node[]> = {
      'helix-core/src/lib.rs': [coreLib],
    };
    const dirsByPath: Record<string, string[]> = {
      '.': ['helix-core', 'docs', 'target'],
      'helix-core': ['src'],
    };

    const context = {
      getNodesInFile: (fp: string) => nodesByFile[fp] ?? [],
      getNodesByName: () => [],
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      fileExists: (p: string) => (
        Object.prototype.hasOwnProperty.call(filesByPath, p) ||
        Object.prototype.hasOwnProperty.call(nodesByFile, p)
      ),
      readFile: (p: string) => filesByPath[p] ?? null,
      getProjectRoot: () => '/test',
      getAllFiles: () => [
        'Cargo.toml',
        ...Object.keys(filesByPath).filter((p) => p !== 'Cargo.toml'),
        ...Object.keys(nodesByFile),
      ],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      listDirectories: (rel: string) => dirsByPath[rel] ?? [],
    };

    const ref = {
      fromNodeId: 'fn:helix-core/src/lib.rs:other:1',
      referenceName: 'helix_core',
      referenceKind: 'references' as const,
      line: 1,
      column: 1,
      filePath: 'helix-core/src/lib.rs',
      language: 'rust' as const,
    };

    expect(rustResolver.resolve(ref, context)?.targetNodeId).toBe(coreLib.id);
  });
});

import { aspnetResolver } from '../src/resolution/frameworks/csharp';

describe('aspnetResolver.synthesize', () => {
  it('extracts route from [HttpGet] attribute', () => {
    const src = `
[HttpGet("/users")]
public IActionResult ListUsers()
{
  return Ok();
}
`;
    const view = makeStubGraphView({ 'UserController.cs': src }, 'csharp');
    const result = aspnetResolver.synthesize!(view);
    expect(result.nodes[0]!.name).toBe('GET /users');
    expect(result.nodes[0]!.provenance).toBe('framework:aspnet');
    expect(result.nodes[0]!.kind).toBe('route');
    expect(result.nodes[0]!.id.startsWith('framework:aspnet:')).toBe(true);
  });
});

import { vaporResolver } from '../src/resolution/frameworks/swift';

describe('vaporResolver.synthesize', () => {
  it('extracts route from app.get with use:', () => {
    const src = `app.get("users", use: listUsers)\n`;
    const view = makeStubGraphView({ 'routes.swift': src }, 'swift');
    const { nodes } = vaporResolver.synthesize!(view);
    expect(nodes[0]!.name).toBe('GET users');
    expect(nodes[0]!.provenance).toBe('framework:vapor');
  });
});

import { reactResolver } from '../src/resolution/frameworks/react';
import { svelteResolver } from '../src/resolution/frameworks/svelte';

describe('reactResolver.synthesize (smoke)', () => {
  it('returns SynthesizeResult shape', () => {
    const src = `<Route path="/users" element={<UsersPage/>}/>`;
    const view = makeStubGraphView({ 'App.tsx': src }, 'typescript');
    const result = reactResolver.synthesize!(view);
    expect(result).toHaveProperty('nodes');
    expect(Array.isArray(result.nodes)).toBe(true);
  });

  it('emits component node for function component returning JSX', () => {
    const src = `
function MyButton() {
  return <button>click</button>;
}
`;
    const view = makeStubGraphView({ 'components/MyButton.tsx': src }, 'typescript');
    const result = reactResolver.synthesize!(view);
    const components = result.nodes.filter((n) => n.kind === 'component');
    expect(components).toHaveLength(1);
    expect(components[0]!.name).toBe('MyButton');
    expect(components[0]!.provenance).toBe('framework:react');
  });

  it('emits react:hook tag on existing function named useFoo', () => {
    const hook = {
      id: 'fn:useFoo',
      kind: 'function' as const,
      name: 'useFoo',
      qualifiedName: 'useFoo',
      filePath: 'src/useFoo.ts',
      language: 'typescript' as const,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      updatedAt: 0,
    };
    const view = makeStubGraphView({}, 'typescript', { nodes: [hook] });
    const result = reactResolver.synthesize!(view);
    const tag = (result.tags ?? []).find((t) => t.nodeId === 'fn:useFoo');
    expect(tag?.tags).toContain('react:hook');
  });
});

describe('svelteResolver.synthesize (smoke)', () => {
  it('returns SynthesizeResult shape', () => {
    const view = makeStubGraphView({ '+page.svelte': '' }, 'javascript');
    const result = svelteResolver.synthesize!(view);
    expect(result).toHaveProperty('nodes');
    expect(Array.isArray(result.nodes)).toBe(true);
  });

  it('emits route node for src/routes/blog/[slug]/+page.svelte', () => {
    const view = makeStubGraphView(
      { 'src/routes/blog/[slug]/+page.svelte': '' },
      'javascript',
    );
    const result = svelteResolver.synthesize!(view);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.kind).toBe('route');
    expect(result.nodes[0]!.name).toBe('/blog/:slug');
    expect(result.nodes[0]!.provenance).toBe('framework:svelte');
  });
});

// Regression tests: commented-out and docstring route examples must NOT
// surface as phantom route nodes. These would have failed before the
// strip-comments wiring (the regex would happily scan comments/docstrings).
describe('framework extractors ignore commented-out routes', () => {
  it('django: skips line-comment and docstring routes', () => {
    const src = `
# urls.py example:
# path('/admin/', AdminPanel.as_view())
"""
Other routing example:
    path('/users/', UserListView.as_view())
"""
urlpatterns = [path('/real/', RealView.as_view())]
`;
    const view = makeStubGraphView({ 'app/urls.py': src }, 'python');
    const { nodes } = djangoResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['/real/']);
  });

  it('flask: skips commented-out @app.route', () => {
    const src = `
# @app.route('/fake')
# def fake_view():
#     return ''

@app.route('/real')
def real_view():
    return ''
`;
    const view = makeStubGraphView({ 'app.py': src }, 'python');
    const { nodes } = flaskResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('fastapi: skips docstring example routes', () => {
    const src = `
"""
Example:
    @app.get('/in-docstring')
    async def doc():
        pass
"""
@app.get('/real')
async def real_handler():
    return {}
`;
    const view = makeStubGraphView({ 'main.py': src }, 'python');
    const { nodes } = fastapiResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('express: skips // and /* */ commented routes', () => {
    const src = `
// app.get('/fake', fakeHandler);
/* router.post('/also-fake', otherHandler); */
app.get('/real', realHandler);
`;
    const view = makeStubGraphView({ 'routes.ts': src }, 'typescript');
    const result = expressResolver.synthesize!(view);
    expect(result.nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('laravel: skips // # and /* */ commented Route::* calls', () => {
    const src = `<?php
// Route::get('/fake', [FakeController::class, 'index']);
# Route::get('/also-fake', 'FakeController@show');
/* Route::post('/another-fake', [X::class, 'y']); */
Route::get('/real', [RealController::class, 'index']);
`;
    const view = makeStubGraphView({ 'routes/web.php': src }, 'php');
    const { nodes } = laravelResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('rails: skips =begin/=end and # commented routes', () => {
    const src = `
# get '/fake', to: 'fake#index'
=begin
get '/also-fake', to: 'fake#show'
=end
get '/real', to: 'real#index'
`;
    const view = makeStubGraphView({ 'config/routes.rb': src }, 'ruby');
    const { nodes } = railsResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('spring: skips // and /* */ commented @GetMapping', () => {
    const src = `
// @GetMapping("/fake")
// public List<X> fake() { return null; }

/* @PostMapping("/also-fake")
   public void alsoFake() {} */

@GetMapping("/real")
public List<User> listUsers() { return users; }
`;
    const view = makeStubGraphView({ 'UserController.java': src }, 'java');
    const { nodes } = springCoreResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('go: skips // and /* */ commented router.METHOD calls', () => {
    const src = `
// r.GET("/fake", fakeHandler)
/* r.POST("/also-fake", anotherHandler) */
r.GET("/real", listUsers)
`;
    const view = makeStubGraphView({ 'main.go': src }, 'go');
    const { nodes } = goResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('rust: skips // and nested /* */ commented .route() calls', () => {
    const src = `
// .route("/fake", get(fake_handler))
/* outer /* inner .route("/inner-fake", get(x)) */ still .route("/outer-fake", get(y)) */
let app = Router::new().route("/real", get(list_users));
`;
    const view = makeStubGraphView({ 'main.rs': src }, 'rust');
    const { nodes } = rustResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('aspnet: skips // and /* */ commented [HttpGet] attributes', () => {
    const src = `
// [HttpGet("/fake")]
// public IActionResult Fake() { return Ok(); }

/* [HttpPost("/also-fake")]
   public IActionResult AlsoFake() { return Ok(); } */

[HttpGet("/real")]
public IActionResult ListUsers() { return Ok(); }
`;
    const view = makeStubGraphView({ 'UserController.cs': src }, 'csharp');
    const result = aspnetResolver.synthesize!(view);
    expect(result.nodes.map((n) => n.name)).toEqual(['GET /real']);
  });

  it('vapor: skips // and /* */ commented app.METHOD calls', () => {
    const src = `
// app.get("fake", use: fakeHandler)
/* app.post("also-fake", use: anotherHandler) */
app.get("real", use: listUsers)
`;
    const view = makeStubGraphView({ 'routes.swift': src }, 'swift');
    const { nodes } = vaporResolver.synthesize!(view);
    expect(nodes.map((n) => n.name)).toEqual(['GET real']);
  });
});
