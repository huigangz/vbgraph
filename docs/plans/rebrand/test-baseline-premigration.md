# 迁移前测试基线（Phase 0 固化）

- **日期**: 2026-07-17
- **源仓库 commit**: `1062cfb` (docs: record green baseline publication)
- **命令**: `npm test`（vitest run，全量）
- **环境**: Windows 11, Node v24.15.0, **wasm 后端**（better-sqlite3 未安装，
  `Native load error: Cannot find module 'better-sqlite3'` 属预期日志，非错误）

## 结果

| 指标 | 数值 |
|---|---|
| Test Files | **47 passed**, 1 skipped (49) |
| Tests | **818 passed**, 29 skipped (892) |
| Failed | **0** |
| Unhandled Errors | 1（见下） |
| Duration | 44.37s |
| 进程退出码 | 1（由 unhandled error 导致，非测试失败） |

## 已知噪音（基线的一部分，对照时同样预期出现）

```
Error: Worker exited unexpectedly
 ❯ ChildProcess.onUnexpectedExit node_modules/tinypool/dist/index.js:118:30
```

tinypool 子进程在全部测试通过后的收尾阶段异常退出（Windows 特有的 teardown
噪音）。它使 `npm test` 退出码为 1，但 0 个测试失败。

## Phase 3 对照标准

rename 完成后的全量测试结果不得劣于：**818 passed / 29 skipped / 0 failed**。
（skip 数与 unhandled error 允许持平；任何新增 fail 都定位到所在批次修复。）

## 更新（2026-07-17，批 b–e 完成后）

新仓库 fresh `npm install` 成功编译了 better-sqlite3（旧仓库没有原生模块），
26 个 `skipIf(!HAS_SQLITE)` 测试被唤醒：25 个直接通过，1 个暴露**预先存在的
过期断言**（`pr19-improvements` 断言 schema version 4，实际已是 7——多年被
skip 掩盖），已修复（断言改 7 + 注释说明）。

**新的有效基线：844 passed / 3 skipped / 0 failed**（48/49 文件，1 个已知
tinypool teardown 噪音 error，退出码 1 属预期）。后续批次以此对照。
