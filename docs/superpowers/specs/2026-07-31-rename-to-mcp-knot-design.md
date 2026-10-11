# 改名 + 差异化定位设计：MCP Hub → MCP Knot

- **状态**: Approved（设计已确认，待写实现计划）
- **日期**: 2026-07-31
- **作者**: yourtion
- **关联**:
  - `docs/superpowers/specs/2026-07-11-project-audit-report.md`（§2.2 命名冲突、§2.4 差异化机会）
  - `docs/superpowers/specs/2026-07-25-mcp-2026-07-28-adoption-overview.md`（P1–P6 协议演进已实现完成）

## 背景

审计报告（2026-07-11）已诊断三个核心矛盾：

1. **命名冲突**：`samanhappy/mcphub`（2.2k stars，域名 mcphub.app）功能高度重叠；npm `mcp-hub` 也被 `ravitemer/mcp-hub`（v4.2.1）占用。
2. **市场红海**：ContextForge / MetaMCP / MCPHub(竞品) / ToolHive / supergateway 等已成事实标准。
3. **差异化未落地**：P1–P6（2026-07-28 无状态网关 + OAuth 2.1 + ttlMs/cacheScope + OTel）已实现完成，但项目名仍撞车、README 未体现协议领先卖点。

本设计通过**改名 + 差异化定位一起做**，用一个能承载差异化卖点的新名字一次性解决品牌 + 定位，趁 0.0.1 未发布窗口零成本切换。

## 决策汇总

| 维度        | 决策                                                     | 理由                                                          |
| ----------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| 处理方式    | 改名 + 差异化定位一起做                                  | npm 未发布，迁移成本最低；名字和定位强绑定，一次性解决        |
| 差异化主线  | C（轻量开发者工具），A（协议领先）作支撑卖点             | C 受众广、与 0.0.1 现状契合；A 是时间窗口资产，作支撑而非主轴 |
| 目标用户    | 开发者为主 + 团队可扩展                                  | 默认零配置本地用，需要时能开分组/鉴权扩展                     |
| 命名词族    | 枢纽/聚合型（避开 hub/nexus）                            | 与"团队可扩展"最契合；避开被竞品占住的语义领地                |
| 新名字      | **`mcp-knot`**                                           | npm 自由 / GitHub 无热门同名 / 词形最短最独特                 |
| npm scope   | 保留 `@mcp-core`，只改包名                               | scope 本身不撞竞品，迁移最小                                  |
| 迁移策略    | 一刀切，无兼容垫片                                       | npm 从未发布，零外部用户依赖旧名                              |
| GitHub 仓库 | `yourtion/mcp-hub` → `yourtion/mcp-knot`（最后手动改名） | 自动 301 redirect，stars/issues 全保留                        |
| 域名        | 不纳入考虑                                               | 用户明确不需要                                                |

## 命名调研结论

**npm 已占用（排除）**：`mcp-proxy`、`mcp-relay`、`mcp-lite`、`mcp-node`、`mcp-base`、`mcp-forge`、`mcp-harbor`、`mcp-hive`

**npm 自由但有 GitHub 强同名（排除）**：`mcphost`（mark3labs/mcphost 1.6k stars）

**最终选择 `mcp-knot`**：npm 自由、GitHub `yardmcp` 系列无热门同名、词形短（4 字母 + knot）、品牌化空间大。

**语义风险与化解**：knot 有"打结→卡住"的潜在负面联想。通过 tagline **"Tie your MCP servers together"** 和 README 语义阐释转向"纽带/交织/连接"的正向含义。

## 第 1 节：品牌定位与叙事

### 一句话定位

> MCP Knot —— 把分散的 MCP server 打成一个结，一个轻量的枢纽，让开发者本地或团队一键聚合所有工具。

### 名字语义阐释（写进 README 开头）

> _Knot_ —— 纽带、交织点。多个 MCP server 像散落的线，MCP Knot 把它们打成一个结，成为所有工具交汇的轻量枢纽。

### 差异化叙事结构（C 主轴 + A 支撑）

| 层           | 内容                                                                                       | 作用                   |
| ------------ | ------------------------------------------------------------------------------------------ | ---------------------- |
| 主轴（拉新） | "轻量枢纽"：比 mcphub 更轻、比 MetaMCP 更简，零配置启动                                    | 吸引个人开发者/小团队  |
| 支撑（留客） | "全协议领先"：已抢先实现 2026-07-28 无状态 + ttlMs/cacheScope + OAuth 2.1 + OTel           | 留住懂行的，建技术壁垒 |
| 化解风险     | "knot" 正向语义：纽带/交织/连接（不是"打结卡住"）。tagline "Tie your MCP servers together" | 覆盖负面联想           |

### 差异化站位

- vs `samanhappy/mcphub`（2.2k）：协议领先一整个版本（2026-07-28 vs 旧有状态）、更轻、开源更新
- vs `MetaMCP`（2.5k）：零配置、本地优先，不做重编排
- vs `ToolHive`（1.9k）：面向开发者/小团队，不做企业级容器隔离

## 第 2 节：改名映射表 + 改动清单

### 包名映射（一刀切，无垫片）

| 旧名                      | 新名                       |
| ------------------------- | -------------------------- |
| `@mcp-core/mcp-hub`       | `@mcp-core/mcp-knot`       |
| `@mcp-core/mcp-hub-core`  | `@mcp-core/mcp-knot-core`  |
| `@mcp-core/mcp-hub-cli`   | `@mcp-core/mcp-knot-cli`   |
| `@mcp-core/mcp-hub-api`   | `@mcp-core/mcp-knot-api`   |
| `@mcp-core/mcp-hub-share` | `@mcp-core/mcp-knot-share` |
| `@mcp-core/mcp-hub-web`   | `@mcp-core/mcp-knot-web`   |

### 仓库 / 外部标识

- GitHub 仓库：`yourtion/mcp-hub` → `yourtion/mcp-knot`（最后一步，手动改名，自动 301）
- CLI bin 名：`mcp-hub` → `mcp-knot`（`packages/cli/package.json` 的 `bin` 字段 + `bin/mcp-hub.js` 文件改名）

### 改动清单（按文件类别）

| 类别                       | 范围                                   | 数量                |
| -------------------------- | -------------------------------------- | ------------------- |
| package.json `name` 字段   | 6 个文件                               | 6 处                |
| package.json 内部依赖引用  | `workspace:*` / `workspace:^`          | 22 处               |
| 代码 import                | `*.ts` / `*.vue`                       | 144 处              |
| CLI bin 入口               | `packages/cli/package.json` + 文件改名 | 2 处                |
| CI slug                    | `.github/workflows/ci.yml:109`         | 1 处                |
| README / docs 品牌名       | README.md、README.zh.md、各 doc        | 待统计（grep 全扫） |
| changeset 配置 ignore 列表 | `.changeset/config.json`               | 2 处包名            |

## 第 3 节：执行顺序、风险与验证

### 执行顺序（代码先行，GitHub 最后）

```
Phase 1 — 代码改名（一个 PR，机械替换）
  ① 6 个 package.json 的 name 字段
  ② 22 处内部依赖引用（workspace:*）
  ③ 144 处代码 import
  ④ CLI bin 名 + bin/mcp-hub.js → bin/mcp-knot.js
  ⑤ .changeset/config.json ignore 列表
  ⑥ CI slug (.github/workflows/ci.yml:109)
  ⑦ README/README.zh 品牌名 + 差异化叙事改写
  → 跑 pnpm build + pnpm test 全绿 → 合并 main

Phase 2 — GitHub 仓库改名（手动操作，零代码）
  ⑧ Settings → Rename: yourtion/mcp-hub → yourtion/mcp-knot
     （旧 URL 自动 301 redirect，stars/issues/PR 全保留）
  ⑨ 更新本地 git remote origin 指向新 URL
```

### 风险与对策

| 风险                                         | 影响                         | 对策                                                                     |
| -------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| workspace 引用漏改                           | 部分包找不到依赖，build 失败 | 全局替换 `mcp-hub` → `mcp-knot`，靠 build 失败兜底（编译器报错所有遗漏） |
| 测试 fixture / e2e 配置里的包名硬编码        | 测试运行时找不到模块         | 跑 `pnpm test` 全量验证（含 e2e）                                        |
| CLI bin 改名后 `bin/mcp-hub.js` 文件未重命名 | bin 链接失效                 | 同步改文件名 + package.json `bin` 字段                                   |
| docs 里品牌名残留（中英文混用）              | 品牌不一致                   | grep 全仓扫描，逐一确认                                                  |

### 验证方案（evidence before assertions）

1. `pnpm install` —— workspace 重新解析依赖，无报错
2. `pnpm build:production` —— 全包编译通过
3. `pnpm test`（含 e2e）—— 全绿
4. `pnpm check:ci` —— lint/format 通过
5. **验收硬指标**：`grep -rn "mcp-hub" --include="*.ts" --include="*.json" --include="*.md" . | grep -v node_modules` —— **零残留**

第 5 步的 grep 零残留是核心验收标准。若仍有 `mcp-hub` 出现：要么是漏改，要么是需要保留的历史文档（如 audit report 记录旧名）——后者显式标注保留。

## 不在本次范围

- npm 实际发布（改名后何时发 0.1.0 是独立决策）
- 官方 Registry 集成（差异化机会 B，属后续迭代）
- 向量语义工具发现（竞品已有，后续评估是否跟进）
- 新品牌下的视觉标识 / Logo 设计（独立工作）
