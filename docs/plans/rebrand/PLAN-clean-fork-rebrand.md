# PLAN: vbgraph — 个人开源 fork + 公司 OSS 引入

> 写于 2026-07-16，2026-07-17 改为个人开源路线。目标：将本仓库迁移为**个人维护的
> 公开开源项目 vbgraph**（MIT，保留上游版权声明，保留完整 git 历史，全量迁移），
> 公司作为普通第三方开源工具引入使用（OSS intake + JFrog 缓存）。

## 0. 已定决策与待定项

| 决策点 | 状态 |
|---|---|
| 项目性质 | ✅ **个人开源项目**（个人 GitHub public repo，MIT）；公司作为第三方 OSS 引入。director 书面同意（非职务作品 + 数据边界 + 现有成果归属）**在切 public 前补入**，不阻塞前期工作；**兜底决策（2026-07-17）：若最终拿不到同意书，项目仍照常转开源**（职务作品灰色风险由本人知情自担——正因如此，切 public 前的 worklog 敏感内容审查更不可省） |
| 迁移方式 | ✅ fork + 改名，不重写 |
| 功能范围 | ✅ 先全量迁移，之后再单独裁剪；**一切改动（含裁剪）只在新仓库做，本仓库保持原样**（裁剪清单见 §2.5） |
| git 历史 | ✅ 保留完整历史（`pr19-improvements.test.ts` 等测试名锚定历史，squash 会使锚点失效） |
| LICENSE | ✅ 保留原 MIT 声明（Copyright (c) 2026 Colby Mchenry），上方追加**个人**版权行 |
| 新名字 | ✅ **`vbgraph`**（2026-07-16 定；公网 npm 查证未被占用，E404） |
| 分发方式 | ✅ 公网 npm 正式发布（`vbgraph`，unscoped）；公司侧经 JFrog npm remote 缓存安装。发布前的内部试点用 `npm pack` tarball（Phase 5a） |
| 数据边界 | ✅ 红线：公司源码/数据不进个人开发环境；开发测试只用合成 fixture 与公开开源项目；在公司环境发现的问题凭现象复现，不带代码回来 |

### 名字派生的全部标识（rename 时的对照表）

| 用途 | 旧 | 新 |
|---|---|---|
| npm 包名 | `@colbymchenry/codegraph` | `vbgraph`（个人发布，unscoped） |
| CLI 命令 / bin | `codegraph` | `vbgraph` |
| 数据目录 | `.codegraph/` | `.vbgraph/` |
| MCP server 名 | `codegraph` | `vbgraph` |
| MCP 工具前缀 | `codegraph_search` 等 9 个 | `vbgraph_search` 等 |
| 环境变量前缀 | `CODEGRAPH_*`（9 个） | `VBGRAPH_*` |
| Codex TOML 表 | `[mcp_servers.codegraph]` | `[mcp_servers.vbgraph]` |
| Cursor 规则文件 | `.cursor/rules/codegraph.mdc` | `.cursor/rules/vbgraph.mdc` |
| section 标记 | `CODEGRAPH_SECTION_START/END` | `VBGRAPH_SECTION_START/END` |
| bin 源文件 | `src/bin/codegraph.ts` | `src/bin/vbgraph.ts` |

名字风险已消解：公网 npm 就是正式发布渠道，`vbgraph` 由本人注册持有，
不再存在 dependency confusion 问题。拿到书面同意后**尽早**发一个占位版本锁定包名。

## 1. 现状盘点（2026-07-16 扫描）

`codegraph` 标识分布：**src/ 671 处 / 44 文件；__tests__/ 416 处 / 43 文件**；
`colbymchenry` 46 处 / 18 文件（含 package-lock.json、CHANGELOG、docs）。

按性质分类（决定各自的处理方式）：

| # | 类别 | 位置 | 备注 |
|---|---|---|---|
| A | npm 包名 `@colbymchenry/codegraph` | package.json、README、CHANGELOG、docs 模板 | package-lock 用 `npm install` 重新生成，不手改 |
| B | CLI bin 名 `codegraph` | package.json `bin`、`src/bin/codegraph.ts`（文件也要改名）、build 脚本里的 chmod 路径 | |
| C | 数据目录 `.codegraph/` | `src/directory.ts`、`src/config.ts` 等 | 派生数据，存量项目重新 index 即可，无需迁移数据 |
| D | MCP server 名 + 9 个工具名 `codegraph_*` | `src/mcp/index.ts:47`、`src/mcp/tools.ts` | **agent 可见 API**。改名必须同步三处指引文档（见 F） |
| E | 9 个环境变量 `CODEGRAPH_*` | `_DIR` `_GITIGNORE` `_DEBUG` `_DEV` `_ASCII` `_UNICODE` `_ALLOW_UNSAFE_NODE` `_EXPLORE_LINENUMS` `_IGNORE_MARKER` | 若同事已在 CI/shell 配置旧变量，需在迁移通告里列出对照表 |
| F | 三处同步的 agent 指引 | `src/mcp/server-instructions.ts`、`src/installer/instructions-template.ts`、`.cursor/rules/codegraph.mdc`（文件名也要改） | 仓库 house rule：三者内容必须一致 |
| G | installer 写入用户文件的 section 标记 `CODEGRAPH_SECTION_START/END` | `instructions-template.ts`、`claude-md-template.ts`、各 target | ⚠️ 存量坑：旧标记已写进同事机器上的 CLAUDE.md/AGENTS.md，新版 installer 认不出旧标记 → 见 Phase 4 |
| H | Codex TOML 表 `[mcp_servers.codegraph]` | `src/installer/targets/toml.ts`、`codex.ts` | |
| I | 用户代码注释标记（IGNORE_MARKER） | `src/extraction/index.ts` | 若公司项目里已有人写了旧 ignore 注释，考虑新旧标记双识别一个过渡期 |
| J | 纯文档/品牌 | README、CHANGELOG、CLAUDE.md、DELPHI-SUPPORT.md、docs/ | 重写而非替换 |

## 2. 阶段计划

### Phase 0 — 前置（迁移前，在旧仓库完成）

0. **director 书面同意**（邮件即可，明确三点：公司不主张 vbgraph 为职务作品；认可
   数据边界承诺；现有 VB.NET 工作成果的归属处理方式）——**推进但不阻塞**：本地
   准备、建 private 仓库、rename 全部照常做；同意书在**切 public 时**补入检查。
   兜底：拿不到同意书也照常转开源（见决策表）。
1. ~~定名~~（已定 `vbgraph`）；公网 npm 包名可随时占位注册（占位包只含 README，
   不含代码，无泄露面）。
2. 处理当前未提交改动（`.gitignore`、`__tests__/resolution.test.ts`、phase2 worklog）：该提交的提交，该丢弃的丢弃，工作区清零。
3. 跑全量测试，**记录迁移前基线**（pass/fail/skip 数字 + 失败清单），存为对照文件。
4. 确认根目录 PLAN-*.md 等本地计划文档是否随迁（已 gitignore，默认不迁；本文件
   届时随迁并纳入版本管理，见批 g）。

**验收**：工作区干净；基线文件在手（书面同意移至切 public 前检查）。

### Phase 1 — 建新仓库（个人 GitHub）

0. **个人 GitHub 账号下新建 `vbgraph` 仓库**。建议流程：先建 **private** 空仓库
   （不勾自动初始化 README/LICENSE，避免与 push 的完整历史冲突），完成 Phase 2
   的 rename/重写后再切 public——公开的第一眼就是干净的 vbgraph，而非满是
   codegraph 痕迹的中间态。⛔ 切 public 必须在 Phase 0 书面同意之后。
   仓库在 GitHub → `scripts/release.sh` 的 GitHub Release 逻辑**保留**，只改仓库地址。
   **切 public 前审一遍将公开的全部内容**：git 历史作者邮箱（已核验 2026-07-17：
   全部为个人邮箱，干净）、docs/plans 与 worklog 全文（确认无公司名/内部系统名/
   公司项目细节——这些文档会随历史一起公开）。若发现历史中有敏感内容，
   届时在"保留历史"与"squash 起点"之间重新取舍。
1. `git clone` 本仓库 → 新目录，`git remote set-url origin <个人仓库地址>`，push 全部历史
   （`--all` + `--tags`）。加 `git remote add upstream https://github.com/colbymchenry/codegraph`，
   便于日后 fetch 上游修复。
2. LICENSE：保留原 MIT 全文与 `Copyright (c) 2026 Colby Mchenry`，其上追加
   `Copyright (c) 2026 <你的名字>`（个人，不是公司）。
3. README 顶部加一句 attribution：本项目基于 [codegraph](https://github.com/colbymchenry/codegraph) 开发。

**验收**：新仓库可 clone，`git log` 完整，LICENSE 双版权行（原作者 + 个人）。

### Phase 2 — 标识 rename（每批独立提交，每批后跑相关测试）

> 原则：**不做一次性全局 sed**。1100+ 处替换里混着必须保留的（LICENSE、attribution、
> CHANGELOG 归档），按批替换 + 人工过 diff。

- **批 a｜包与构建**：package.json（name/bin/description/keywords）、`src/bin/codegraph.ts` → `src/bin/<name>.ts`、build 脚本 chmod 路径、`npm install` 重新生成 lock。跑 `npm run build` + `node-version-check` 相关测试。
- **批 b｜运行时标识**：`.codegraph/` 目录名、9 个环境变量、错误信息文案、`CODEGRAPH_IGNORE_MARKER`（决定是否双识别过渡）。跑 foundation/directory/extraction 测试。
- **批 c｜MCP**：server 名、9 个工具名、`server-instructions.ts` 全文。跑 `mcp-initialize`、`p1-mcp-tag-filter`、`explore-output-budget` 等 MCP 测试。
- **批 d｜installer**：4 个 target、TOML 表名、section 标记、`instructions-template.ts`、`claude-md-template.ts`、`.cursor/rules/codegraph.mdc` 改名、`uninstall.ts`。跑 `installer-targets.test.ts`（~47 契约测试）+ `installer.test.ts`。
- **批 e｜测试内引用**：43 个测试文件里的 416 处（多为断言字符串，随 a–d 已大部分同步改掉，此批收尾）。跑全量测试。
- **批 f｜README 与 agent 记忆文件重写**（不是替换，是重写）：
  - **README.md 整体重写**（英文，面向公开社区）：删除上游品牌全套内容——npm badge/链接
    （指向 `@colbymchenry/codegraph`）、"94% fewer tool calls" 等 benchmark 营销段落
    （数据是上游在 VS Code/Excalidraw 等仓库上测的，不代表 vbgraph，保留即失实）、
    GitHub user-attachments 图片。重写为：开源定位（VB.NET/Delphi 为核心的 code
    intelligence，多语言保留）、`npx vbgraph` 安装、快速上手、支持的语言与 agent、
    顶部 attribution（基于 codegraph 开发，MIT）。**公司内部的 JFrog 安装说明不进
    这个 README**——那是公司内部文档，写在公司 wiki/内部通告里（见 Phase 5b）。
  - **agent 记忆/指引文件重写**：
    - `CLAUDE.md`（仓库根，Claude Code 的项目记忆）：整体重写。当前内容大量描述上游现实
      （`@colbymchenry/codegraph` npm 发布流、release.sh 流程、上游 house rules），迁移后
      按 vbgraph 的构建/测试/发布现实重写；`pr19-improvements` 等测试名保留并注明
      "锚定上游历史，见 git log"。
    - `.cursor/rules/codegraph.mdc` → `.cursor/rules/vbgraph.mdc`：文件名 + 内容同步重写
      （与批 d 的 instructions-template / server-instructions 三处一致性要求联动）。
    - 视需要新增 `AGENTS.md`（仓库根，Codex/opencode 的项目记忆）：当前仓库没有，若团队
      有人用这两类 agent 开发本仓库则补一份，内容与 CLAUDE.md 同源。
- **批 g｜计划与日志文档统一归位**（目前散落在根目录和 docs/ 两层，用 `git mv` 保留历史）：
  - 目标结构：
    ```
    docs/
      plans/            # 唯一的计划文档目录（含各主题子目录）
        phase2/         # 现有 phase2 计划 + worklog/ 原样保留
        worklog 约定：每个主题的执行日志放该主题子目录的 worklog/ 下
      reference/        # VBCODEGRAPH_REFERENCE.md、DELPHI-SUPPORT.md、SEARCH_QUALITY_LOOP.md
      scheduling/       # 保持不动（操作性模板，不是计划文档）
    ```
  - 具体移动：根目录 `IMPLEMENTATION_PLAN.md`、`PLAN-clean-fork-rebrand.md`（本文件，届时纳入
    版本管理）、`run-interactive-test.md` → `docs/plans/`；根目录 `DELPHI-SUPPORT.md`、
    `docs/SEARCH_QUALITY_LOOP.md`、`docs/VBCODEGRAPH_REFERENCE.md` → `docs/reference/`。
  - 移动后全库 grep 修正指向这些文件的相对链接（CLAUDE.md、README、docs 内互引）。
  - 在 CLAUDE.md 写明约定："计划文档一律放 docs/plans/<主题>/，执行日志放其 worklog/ 子目录"，
    防止再次散落。
- **批 h｜CHANGELOG 重开**：从 `1.0.0` 重新开始；旧内容归档为 `CHANGELOG-upstream.md`
  或删除（历史在 git 里）。

**验收**：全库 `grep -ri codegraph`（含 `colbymchenry`）只剩允许清单：
LICENSE、README attribution 一句、CHANGELOG-upstream.md（若保留）、git 历史相关注释。

### Phase 3 — 验证

1. 全量 `npm test` 对照 Phase 0 基线，不得劣化。
2. `npm run build` 后真机 smoke：在一个 scratch 项目里走完整链路
   `install → init → index → status → query`，并用 Claude Code 实际连一次 MCP，
   确认 server 名/工具名以新名字出现、工具可调用。
3. `npm run eval` 跑一遍评估套件（可选但建议，验证抽取质量未被误伤）。

**验收**：基线持平；smoke 全链路通过。

### Phase 4 — 存量安装迁移（公司同事机器）

旧安装的三处残留必须用**旧版**工具清理（新版认不出旧的 section 标记和 MCP entry）：

1. 先跑旧版 `codegraph uninstall`（或 npm uninstall 触发的 preuninstall）——清掉旧 MCP
   entry 和各 agent 配置里的 `CODEGRAPH_SECTION_*` 段落。
2. 再安装新包、重新 install + init。
3. 各项目里的旧 `.codegraph/` 目录直接删除，新工具重新 index（纯派生数据，无迁移成本）。
4. 发迁移通告：新旧环境变量对照表、新工具名列表（同事的自定义 prompt/脚本里若写死了
   `codegraph_search` 等旧工具名需要自查）。

### Phase 5a — 试点（先于 1.0.0 正式发布）

1. 首选通道：`npm run build && npm pack` 产出 `vbgraph-1.0.0-rc.N.tgz`，直接发给试点
   同事（含公司同事——tarball 是公开 OSS 的预发布产物，不涉及公司代码，无合规问题）。
   tarball 与 npm 上的正式包完全同构，试点验证的即上线形态。
   备选：包名注册后也可 `npm publish --tag next` 发 rc 到公网（`npm i vbgraph@next`），
   适合试点者不便收文件的场景。
2. 版本号试点期用 `1.0.0-rc.N` 预发布段，正式发 `1.0.0`。
3. 公司同事试点者即 Phase 4 的第一批迁移对象：装过旧 codegraph 的机器先用**旧版**
   uninstall 清理，同时验证 Phase 4 迁移文档。
4. 试点期间并行推进公司侧 OSS 引入流程（见 5b），别串行等。
5. 试点验收：≥2 名同事完整走通 install → init → index → agent 实际使用一周，
   无阻断性问题。

### Phase 5b — 正式发布（两侧并行）

**个人侧（开源发布）**：
1. `npm publish` 发 `vbgraph@1.0.0` 到公网 npm。
2. `scripts/release.sh` 改仓库地址后照用（个人 GitHub：tag + GitHub Release +
   CHANGELOG 提取的流程原样成立）。
3. GitHub 仓库补齐开源标配：LICENSE（已有）、简短的 CONTRIBUTING 说明（可后补）。

**公司侧（OSS 引入，走公司流程）**：
1. 提交 OSS intake 审批，材料已备：MIT + 全宽松依赖链（已逐项核验）、100% 本地无
   网络调用（已核验）、公开仓库可溯源。身份是"引入第三方开源工具"，与引入任何
   npm 包同类。
2. JFrog 配置：`vbgraph` 走 npm **remote repository**（代理 npmjs）即可，无需 deploy
   权限——公司不发布这个包，只缓存。同事照常 `npm i -g vbgraph`，解析经 JFrog。
3. 公司内部安装/迁移通告（含 Phase 4 的旧版清理步骤、环境变量对照表、新工具名
   列表）发内部 wiki——这份文档属于公司，不进开源仓库。

## 2.5 迁移后的裁剪任务清单（在新仓库执行，不动本仓库）

> 决策（2026-07-16）：裁剪一律在新仓库做，本仓库保持与上游可对照的原样。
> 以下第一项已在本仓库预演并验证过全部牵连点（改动已回滚），照单执行即可。

### 裁剪 #1：移除 Scala 支持（tarball 解压体积 -4.7 MB，约减半）

`tree-sitter-scala.wasm` 是自带 wasm（`tree-sitter-wasms` 依赖里没有 scala/pascal/vbnet），
删除即整体移除 Scala 语言支持，无回退路径。已验证的完整改动清单：

| 文件 | 改动 |
|---|---|
| `src/extraction/wasm/tree-sitter-scala.wasm` | 删除文件 |
| `src/extraction/languages/scala.ts` | 删除文件 |
| `src/extraction/grammars.ts` | 移除 4 处：`WASM_GRAMMAR_FILES`、`SELF_HOSTED_WASM_LANGUAGES`、`EXTENSION_MAP`（`.scala`/`.sc`）、语言显示名 |
| `src/types.ts` | 移除 2 处：`LANGUAGES` 数组、默认 include glob（`**/*.scala`、`**/*.sc`） |
| `src/extraction/languages/index.ts` | 移除 import + `EXTRACTORS` 注册 |
| `src/extraction/scip/detect-indexers.ts` | `scip-java` 的 languages 改为 `['java', 'kotlin']` |
| `src/resolution/index.ts` | 注释里的 Scala 提及（1 处） |
| `__tests__/extraction.test.ts` | 删除整个 `Scala Extraction` describe 块（含前面的分节注释，原 3135–3403 行） |
| README / 参考文档 | 语言表删 Scala 行；`docs/VBCODEGRAPH_REFERENCE.md` 两处（语言列表、scip-java 行） |

注意：`p26-perf-edge-visibility.test.ts` 里 grep 会命中 "e**scala**te"，是误报，不改。
验证：`npm run clean && npm run build`（tsc 通过即证明无遗漏的类型引用）+ 全量测试 + `npm pack --dry-run`
确认体积（预期 unpacked 从 9.8 MB 降至约 5.1 MB）。

### 后续候选（未评估，按需展开）

- 其他不需要的语言 extractor / framework resolver（每项都要先像 Scala 一样查清牵连点）
- 不使用的 agent target（cursor/codex/opencode 若公司只用 Claude Code）——注意每项牵动
  installer 契约测试

## 3. 风险与对策

| 风险 | 对策 |
|---|---|
| 书面同意未到手即切 public | Phase 1 先建 private 仓库；切 public 是唯一检查点：同意书在手→照常公开；确认拿不到→按兜底决策公开（自担风险，且 worklog 审查必须完成） |
| ⛔ 公司代码/数据进入个人开发环境 | 数据边界红线（决策表）；测试只用合成 fixture + 公开项目；公司环境的问题凭现象复现 |
| 公网发布不可撤回（npm 72 小时后基本不可删） | 发布前过一遍 checklist：无公司信息残留（内部主机名/路径/邮箱/wiki 链接）、grep 验收通过 |
| 全局替换误伤必须保留的字符串 | 分批替换 + 每批过 diff；验收用"grep 零残留 + 允许清单" |
| MCP 工具名是 agent 可见 API，三处指引文档漏改导致 agent 调不存在的工具 | 批 c、d 完成后专项 diff 三个文件，确保内容一致（house rule） |
| 存量安装卸载失败（新版认不出旧标记） | Phase 4 强制"先旧版 uninstall 再装新版"的顺序 |
| package-lock 手改导致 install 异常 | 只改 package.json，lock 一律重新生成 |
| 测试劣化被改名 diff 淹没 | Phase 0 固化基线，每批提交后跑对应测试，问题定位在批内 |
| 公司重度依赖后个人项目停更 | MIT 本身即对策：公司可随时内部 fork；此点可主动写进给 director 的说明 |

## 4. 工作量估计

纯机械替换约 1100 处但高度模式化，加上文档重写与 smoke 验证，**约 1–2 个工作日**
（不含 Phase 4 在同事机器上的推广和 Phase 5 发布）。
