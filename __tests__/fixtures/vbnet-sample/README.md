# VB.NET validation fixture (P0.10)

A minimal VB.NET class library plus a **committed `index.scip`** — the output of
Sourcegraph's `scip-dotnet` indexer over this project. The committed `.scip`
lets the SCIP-path tests run against a *real* indexer's output without a .NET
SDK installed on the test machine.

## Files

| File | Purpose |
|---|---|
| `VbnetSample.vbproj` | net8.0 class library; `GenerateAssemblyInfo`/`GenerateTargetFrameworkAttribute` disabled so `obj/**` build files do not leak into the index. |
| `Shapes.vb` | `Namespace`, `Interface`, `MustInherit` base class, `Inherits`, `Implements`, `Sub New`, `Overrides`. |
| `Geometry.vb` | `Module` (→ implicit `Shared`), `Function`, `Sub`, `Imports`. |
| `Catalog.vb` | `Class`, `Property`, `Friend`, `Shared`, overloaded `Sub New`, and a cross-file call repeated on two lines (edge-dedup regression). |
| `index.scip` | Committed `scip-dotnet` output. **Consumed by the tests; not rebuilt by them.** |

## Regenerating `index.scip`

Requires the .NET SDK and the `scip-dotnet` global tool:

```sh
dotnet tool install -g scip-dotnet
cd __tests__/fixtures/vbnet-sample
scip-dotnet index VbnetSample.vbproj --output index.scip
```

If the .NET SDK is installed in a non-default location, `scip-dotnet` needs
`DOTNET_ROOT` pointed at it (e.g. `DOTNET_ROOT=$LOCALAPPDATA/Microsoft/dotnet`).

Delete the generated `bin/` and `obj/` directories afterwards — only
`index.scip` is committed.

## Tests that consume this fixture

- `__tests__/scip-ingester.test.ts` — `describe('persistScipIndex — real scip-dotnet VB.NET fixture')`
- `__tests__/p05b-parity.test.ts` — `describe('parity — real scip-dotnet VB.NET fixture vs tree-sitter Tier 0')`
