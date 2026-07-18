# vbgraph 功能与技术要点

## 1. 项目定位

vbgraph 是一个面向 AI 编程助手的本地代码知识图谱工具。项目的软件包名和命令行名称仍为 `vbgraph` 与 `vbgraph`；“vbgraph”可理解为当前仓库在 VBGraph 基础上强化了 VB.NET 与 SCIP 支持的版本。

它预先把代码库中的符号、结构和依赖关系提取到本地数据库，再通过命令行、TypeScript API 和 MCP（Model Context Protocol）工具提供给 ChatGPT、Codex、Claude Code、Cursor、OpenCode 等 AI 客户端。它解决的核心问题是：让 AI 不必反复依赖文件遍历、全文 grep 和逐文件读取，也能快速定位实现、理解调用链并评估改动影响。

vbgraph 是静态分析和上下文检索工具，不是编译器、IDE、运行时调试器或代码生成模型。它提供的是代码事实与相关上下文，最终结论仍应结合源码、测试和运行结果验证。

## 2. 核心功能

### 2.1 代码结构建模

vbgraph 把代码表示为“节点 + 边”的有向图。

节点可表示文件、命名空间、模块、类、结构、接口、特征、协议、函数、方法、构造函数、属性、字段、变量、常量、事件、枚举、类型别名、导入、导出、路由和前端组件等代码实体。

边可表示以下关系：

- `contains`：文件、类型或作用域包含某个符号；
- `calls`：函数或方法调用另一个函数或方法；
- `imports` / `exports`：模块导入与导出；
- `extends` / `implements`：继承与接口实现；
- `references`：一般符号引用或框架约定关系；
- `type_of` / `returns`：变量类型与返回类型；
- `instantiates`：对象实例化；
- `overrides`：方法重写；
- `decorates`：装饰器或注解关系。

节点同时保留文件位置、限定名、签名、文档注释、可见性、修饰符和语言等元数据；调用边可以保留调用点的行列位置。

### 2.2 语义搜索与上下文构建

符号名称通过 SQLite FTS5 建立全文索引。检索不只返回文本命中，还会结合精确名称、限定名、文件位置、图关系和路径相关性进行排序。

`vbgraph_explore` 面向“某个系统如何工作”“从入口到落地的流程是什么”等理解型问题。它会选择入口符号、沿图遍历相关节点，并按文件返回连续且带行号的源码区段及关系图。`vbgraph_context` 提供更轻量的任务上下文。二者的目标都是在一次调用中形成可供 AI 推理的多文件上下文。

### 2.3 调用链与影响分析

vbgraph 可以查询一个符号的调用者、被调用者和指定深度内的影响半径。典型用途包括：

- 查找功能入口和主要调用链；
- 追踪跨文件、跨语言的控制流；
- 在修改接口、函数或类型前评估潜在影响；
- 根据变更文件反向寻找受影响的测试文件；
- 辅助代码审查、重构规划和故障定位。

### 2.4 框架语义补全

普通 AST 无法完整表达依赖注入、配置绑定、约定式路由和组件关系。vbgraph 在基础抽取与符号解析之后运行框架解析阶段，合成路由等节点，补充框架关系，并给节点添加可检索标签。

当前解析器覆盖 Laravel、Express、React、Svelte、Vue、Django、Flask、FastAPI、Rails、Spring、Temporal、Go Web 框架、Rust Web 框架、ASP.NET、SwiftUI、UIKit 和 Vapor 等场景。可通过 `tag` 过滤框架角色，例如 `spring:service`、`react:hook` 或 `route-handler`。

### 2.5 本地增量同步

索引保存在项目的 `.vbgraph/vbgraph.db` 中。MCP 服务启动后可监听源文件变化，经过防抖后只重新处理受影响文件，并重新运行必要的引用和框架解析。全量索引用于首次建图或强制重建，`sync` 用于增量更新。

对于由 SCIP 建立的高精度索引，源码变化后旧数据会被标记为陈旧。若该语言具备 tree-sitter 解析器，系统会生成一个及时但精度较低的“影子”结果，并隐藏旧 SCIP 结果；若无法生成影子结果，则保留带陈旧标记的 SCIP 数据。`scip-refresh` 可重新生成并导入 SCIP 索引，恢复编译器级精度。查询层会过滤隐藏的陈旧节点及指向它们的悬空边，避免把不一致图数据暴露给 AI。

## 3. 双层索引体系

### 3.1 Tier 0：tree-sitter 语法索引

基础索引使用 tree-sitter 的 WASM 语法解析器读取 AST，不要求目标语言的编译环境。它速度快、部署简单，适合提取声明、包含关系、导入、调用语法和部分继承关系。

当前代码支持 TypeScript、JavaScript、Python、Go、Rust、Java、C、C++、C#、PHP、Ruby、Swift、Kotlin、Dart、Scala、Svelte、Vue、Liquid、Pascal/Delphi 和 VB.NET 等语言；TSX、JSX 作为相应语言变体处理。

Tier 0 的局限是缺少编译器的类型信息。重载解析、动态派发、跨项目符号、复杂泛型和部分框架约定可能只能得到启发式结果。

### 3.2 Tier 1：SCIP 编译器语义索引

SCIP（Source Code Intelligence Protocol）提供由语言工具链生成的精确符号、定义、引用和关系。vbgraph 可以导入已有 `.scip` 文件，也可以通过 `--scip-auto` 检测并运行已安装的索引器。

可自动检测的索引器包括：

- `scip-dotnet`：C#、VB.NET；
- `scip-java`：Java、Kotlin、Scala；
- `scip-typescript`：TypeScript、JavaScript；
- `scip-python`：Python；
- `scip-go`：Go；
- `scip-rust`：Rust；
- `scip-ruby`：Ruby。

SCIP 数据采用流式 Protobuf 解码和分阶段持久化，避免先把整个索引文件物化为大型对象。内部符号、外部依赖符号、定义、引用和关系会被映射到统一图模型。

### 3.3 来源与置信度

每个节点或边都记录来源（provenance），例如 `scip`、`tree-sitter`、`scope-resolved`、`heuristic` 或 `framework:<name>`。同一条边可保留多个独立观察来源，并选择优先级最高的来源作为主来源。

对 AI 展示时，来源可归纳为五档：

| 置信度档位 | 含义 |
|---|---|
| `compiler` | 来自 SCIP，通常最精确 |
| `scope-resolved` | 根据词法作用域补充解析 |
| `syntactic` | 来自 tree-sitter AST |
| `inferred` | 来自启发式或框架约定 |
| `ambiguous` | 来源不足或无法明确分类 |

这些档位代表证据来源，而不是对业务正确性的绝对保证。尤其是 `inferred` 和 `ambiguous` 结果，应回到源码或运行时证据复核。

## 4. VB.NET 专项能力

vbgraph 内置 VB.NET tree-sitter WASM 语法文件，因此即使机器上没有 .NET SDK 或 `scip-dotnet`，也能建立基础索引。Tier 0 可识别常见的 Namespace、Module、Class、Structure、Interface、Enum、Sub、Function、Property、构造函数和 Imports 等结构。

安装 `scip-dotnet` 后，可以获得更准确的跨文件符号解析、实现关系、引用和调用信息。系统会优先采用 SCIP 证据，并在 SCIP 缺失或暂时过期时回退到 tree-sitter。

需要注意：仓库验证时使用的 `scip-dotnet 0.2.14` 会把部分 VB.NET 符号类型输出为未知值，因此 Module、Interface 或 Property 可能被降级映射为较通用的节点类型。这个限制来自索引器输出，不是数据库模型本身的限制。VB.NET 的复杂 `Inherits` / `Implements` 关系也更适合依赖 SCIP；Tier 0 的社区语法对这些结构并非始终可靠。

## 5. 技术架构

一次完整索引大致经过以下流水线：

1. 扫描项目文件，应用语言识别、包含/排除规则和文件大小限制；
2. 使用 tree-sitter 抽取 AST，或读取/自动生成 SCIP 索引；
3. 把符号写成节点，把结构和引用写成边；
4. 解析未绑定的名称、导入、继承与跨文件引用；
5. 运行框架解析器，合成框架节点、关系和标签；
6. 将结果存入 SQLite，并建立 FTS5 与图查询所需索引；
7. 通过 CLI、TypeScript API 或 MCP 暴露搜索、遍历和上下文构建能力。

主要技术组件如下：

- TypeScript 与 Node.js 18–24；
- web-tree-sitter 与 WASM 语法包；
- SCIP Protobuf 流式解码；
- SQLite 图存储与 FTS5 搜索；
- `better-sqlite3` 原生后端，以及无原生模块时的 WASM SQLite 回退；
- MCP stdio 服务；
- 文件系统事件监听和防抖增量同步；
- Vitest 测试体系。

原生 SQLite 是推荐路径。WASM 回退能够提高可安装性，但索引速度较慢，写入时也更容易阻塞读取；`vbgraph status` 会显示当前数据库后端。

## 6. 对外接口

### 6.1 MCP 工具

| 工具 | 适用问题 |
|---|---|
| `vbgraph_explore` | 理解一个系统、架构或端到端流程 |
| `vbgraph_search` | 按名称快速定位符号 |
| `vbgraph_context` | 为一个任务构建轻量上下文 |
| `vbgraph_callers` | 查询谁调用了某符号 |
| `vbgraph_callees` | 查询某符号调用了什么 |
| `vbgraph_impact` | 评估修改的影响范围 |
| `vbgraph_node` | 获取单个符号的源码、签名和详情 |
| `vbgraph_files` | 查询已索引的文件结构 |
| `vbgraph_status` | 查询索引状态、规模、后端和陈旧数据 |

### 6.2 CLI

常用命令包括 `init`、`index`、`sync`、`scip-refresh`、`status`、`query`、`files`、`context`、`affected`、`serve --mcp` 和 `parity`。其中 `affected` 用导入依赖反向查找受变更影响的测试，`parity` 用于比较 SCIP 与 tree-sitter 图的解析差异。

### 6.3 TypeScript API

库 API 可初始化或打开项目图、执行全量/增量索引、搜索节点、查询调用者和影响范围、构建任务上下文、启动文件监听，以及注册自定义框架解析器。

## 7. 配置、隐私与部署

项目配置位于 `.vbgraph/config.json`，可控制语言、包含与排除模式、框架提示、最大文件大小、文档注释提取、调用点记录和 SCIP 来源等选项。

索引、源码分析和查询均在本机执行，不要求云端 API，也不会主动上传代码。需要保护 `.vbgraph/vbgraph.db`：它虽然是派生数据，但包含符号名、文件路径、签名、文档注释和可用于返回源码的位置信息，不应当作无敏感信息的缓存随意公开。

## 8. 使用边界

- 这是静态图，不包含运行时值、实际分支覆盖、反射后的动态绑定或生产环境调用轨迹。
- 图的准确度受语言语法、SCIP 索引器版本、框架解析器和源码是否可完整编译影响。
- 动态语言中的元编程、猴子补丁、运行时注册和字符串拼接路由可能无法完整解析。
- `vbgraph_impact` 表示静态可达影响范围，不等于一定会发生的业务影响。
- 索引可能落后于工作区；回答前应查看 `vbgraph_status`，必要时运行 `sync` 或 `scip-refresh`。
- 搜索结果用于发现候选符号；涉及精确实现、修改或安全判断时，应继续读取对应源码并运行测试。

## 9. 给 ChatGPT 的使用建议

当本参考文档与 vbgraph MCP 工具同时可用时，ChatGPT 应遵循以下原则：

1. 对“在哪里定义”这类精确定位问题，优先使用 `vbgraph_search`；
2. 对“如何工作”“端到端流程”“架构是什么”这类理解问题，优先使用 `vbgraph_explore`；
3. 对修改前评估，组合使用 `vbgraph_search`、`vbgraph_callers` 和 `vbgraph_impact`；
4. 不把 `inferred` 或 `ambiguous` 关系描述成编译器确认的事实；
5. 引用结果时尽量给出符号名、文件路径和行号；
6. 若索引陈旧、目标文件未被索引或查询无结果，应明确说明证据不足，再回退到源码搜索；
7. 不因图中没有某条边就断言关系不存在，尤其是在动态语言、反射、依赖注入和运行时路由场景中；
8. 代码修改完成后仍应运行相关测试，知识图谱不能替代构建、测试和运行时验证。

## 10. 简短总结

vbgraph 的关键价值，是把“代码库探索”从反复扫描文件转化为对本地语义图的查询。tree-sitter 提供低门槛、跨语言的基础覆盖，SCIP 提供编译器级符号精度，框架解析器补足约定式关系，SQLite/FTS5 与图遍历负责快速检索，MCP 则把这些能力交给 AI 编程助手。对 VB.NET 项目而言，它既能在无 .NET 工具链时提供基础结构索引，也能在 `scip-dotnet` 可用时升级为更精确的跨文件语义分析。
