# 改名 MCP Hub → MCP Knot 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将项目包名/CLI/GitHub 仓库从 `mcp-hub` 一刀切改名为 `mcp-knot`，保留 `@mcp-core` scope，无兼容垫片。

**Architecture:** 纯机械性全局替换，无逻辑变更。包名前缀 `mcp-hub` → `mcp-knot`，保留所有 subpath exports（`/config`、`/api-to-mcp` 等）。分 4 个验证驱动的 task：包名基础设施 → 代码 import → CI/文档 → 全量验证。GitHub 仓库改名留作最后的手动步骤（自动 301）。

**Tech Stack:** pnpm workspace monorepo, TypeScript, vitest, oxlint/oxfmt, conventional commits。

**注意：** 本任务无新功能逻辑，不适用 TDD。每个 task 的验证步骤即其"测试"——用 `pnpm install` / `pnpm build` / `pnpm test` / grep 作为验收依据。

## Global Constraints

- npm scope 固定为 `@mcp-core`，只改包名后缀（`mcp-hub-*` → `mcp-knot-*`）。
- 保留所有 subpath export 路径不变（`./config`、`./api-to-mcp`、`./services`、`./types`、`./utils/logger`、`./errors`、`.`）。
- 一刀切，无兼容垫片（npm 从未发布，零外部用户依赖旧名）。
- 品牌名统一为 **MCP Knot**（英文）/ MCP Knot（中文文档保留英文品牌名）。
- Conventional commit 格式：`refactor(rename): ...` 或 `docs(rename): ...`。
- 终态验收硬指标：`grep -rn "mcp-hub" --include="*.ts" --include="*.json" --include="*.md" --include="*.js" --include="*.vue" . | grep -v node_modules` 零残留（历史审计文档显式保留的除外）。

**包名映射表（所有 task 共用）：**

| 旧名                      | 新名                       |
| ------------------------- | -------------------------- |
| `@mcp-core/mcp-hub`       | `@mcp-core/mcp-knot`       |
| `@mcp-core/mcp-hub-core`  | `@mcp-core/mcp-knot-core`  |
| `@mcp-core/mcp-hub-cli`   | `@mcp-core/mcp-knot-cli`   |
| `@mcp-core/mcp-hub-api`   | `@mcp-core/mcp-knot-api`   |
| `@mcp-core/mcp-hub-share` | `@mcp-core/mcp-knot-share` |
| `@mcp-core/mcp-hub-web`   | `@mcp-core/mcp-knot-web`   |

---

## File Structure

改动文件类别与范围：

- **package.json 层**（Task 1）：6 个 package.json 的 `name` 字段 + 22 处内部 `workspace:*` 依赖引用 + `.changeset/config.json` 的 ignore 列表。
- **CLI bin 层**（Task 1）：`packages/cli/package.json` 的 `bin` 字段 + `packages/cli/bin/mcp-hub.js` 文件重命名为 `mcp-knot.js`。
- **代码 import 层**（Task 2）：91 个 `.ts`/`.vue` 文件，144 处 import 语句。
- **CI 层**（Task 3）：`.github/workflows/ci.yml:109` 的 slug。
- **文档层**（Task 3）：`README.md`（24 处品牌名）、`README.zh.md`（22 处品牌名），含差异化叙事改写。
- **验证**（Task 4）：全量 build / test / lint / grep。

---

### Task 1: 包名基础设施 + CLI bin 改名

**Files:**

- Modify: `package.json`（根，name + 7 处 filter 脚本）
- Modify: `packages/share/package.json`（name）
- Modify: `packages/core/package.json`（name）
- Modify: `packages/cli/package.json`（name + bin 字段 + 2 处 deps）
- Modify: `backend/package.json`（name + 2 处 deps）
- Modify: `frontend/package.json`（name + 1 处 deps）
- Modify: `.changeset/config.json`（ignore 列表 2 处包名）
- Rename: `packages/cli/bin/mcp-hub.js` → `packages/cli/bin/mcp-knot.js`

**Interfaces:**

- Produces: 所有 workspace 包的新 `name`，供 Task 2 的 import 替换对齐。

- [ ] **Step 1: 改 6 个 package.json 的 name 字段**

逐个文件把 `"name": "@mcp-core/mcp-hub..."` 改为 `"name": "@mcp-core/mcp-knot..."`，按映射表：

```
package.json:                "@mcp-core/mcp-hub"       → "@mcp-core/mcp-knot"
packages/share/package.json:  "@mcp-core/mcp-hub-share" → "@mcp-core/mcp-knot-share"
packages/core/package.json:   "@mcp-core/mcp-hub-core"  → "@mcp-core/mcp-knot-core"
packages/cli/package.json:    "@mcp-core/mcp-hub-cli"   → "@mcp-core/mcp-knot-cli"
backend/package.json:         "@mcp-core/mcp-hub-api"   → "@mcp-core/mcp-knot-api"
frontend/package.json:        "@mcp-core/mcp-hub-web"   → "@mcp-core/mcp-knot-web"
```

- [ ] **Step 2: 改 22 处内部 workspace 依赖引用**

在每个 package.json 的 `dependencies`/`devDependencies` 里，把 `"@mcp-core/mcp-hub-*": "workspace:*"` 改为 `"@mcp-core/mcp-knot-*": "workspace:*"`。根 package.json 的 `scripts` 里有大量 `pnpm --filter @mcp-core/mcp-hub-*` 也要改。安全做法：对所有 package.json 执行字符串替换 `mcp-hub` → `mcp-knot`（这些文件里不含应保留的旧名）。

- [ ] **Step 3: 改 packages/cli/package.json 的 bin 字段**

```json
"bin": {
  "mcp-knot": "./bin/mcp-knot.js"
}
```

- [ ] **Step 4: 重命名 bin 文件并更新注释**

把 `packages/cli/bin/mcp-hub.js` 重命名为 `packages/cli/bin/mcp-knot.js`，并把文件头注释从 `MCP Hub CLI 可执行文件入口点` 改为 `MCP Knot CLI 可执行文件入口点`。`import('../dist/cli.js')` 路径不变。

```bash
git mv packages/cli/bin/mcp-hub.js packages/cli/bin/mcp-knot.js
```

文件内容改为：

```javascript
#!/usr/bin/env node

/**
 * MCP Knot CLI 可执行文件入口点
 */

// 使用 import 运行 ES Module
import('../dist/cli.js');
```

- [ ] **Step 5: 改 .changeset/config.json 的 ignore 列表**

```json
"ignore": ["@mcp-core/mcp-knot-api", "@mcp-core/mcp-knot-web"]
```

- [ ] **Step 6: 验证 workspace 重新解析**

Run: `pnpm install`
Expected: 成功，无 "unmet dependency" 或找不到 workspace 包的错误。pnpm 会重新 link 新包名。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(rename): 包名 mcp-hub→mcp-knot 基础设施（name/deps/bin/changeset）"
```

---

### Task 2: 代码 import 全局替换

**Files:**

- Modify: 91 个 `.ts`/`.vue` 文件中的 144 处 import 语句
- 典型样本：
  - `backend/src/middleware/mcp-auth.ts:11` — `from '@mcp-core/mcp-hub-core'`
  - `backend/src/types/web-api.ts:9` — `from '@mcp-core/mcp-hub-core/api-to-mcp'`
  - `backend/src/types/mcp-hub.ts:1` — `from '@mcp-core/mcp-hub-share'`
  - `backend/src/types/config-helpers.ts:7` — `from '@mcp-core/mcp-hub-share/config'`

**Interfaces:**

- Consumes: Task 1 产出的新包名。
- Produces: 全部代码引用新包名，build 可通过。

- [ ] **Step 1: 全局替换 import 包名前缀**

对所有 `*.ts` / `*.vue` / `*.tsx` 文件，把字符串 `@mcp-core/mcp-hub` 替换为 `@mcp-core/mcp-knot`。**关键：只替换 `@mcp-core/mcp-hub` 这个前缀，保留其后的 subpath**（如 `/api-to-mcp`、`/config`、`/services` 等）。

一条命令完成（前缀替换天然保留 subpath，因为只替换到 `mcp-hub` 这一段）：

```bash
find . -type f \( -name "*.ts" -o -name "*.vue" -o -name "*.tsx" \) \
  -not -path "*/node_modules/*" -not -path "*/dist/*" \
  -exec sed -i '' 's/@mcp-core\/mcp-hub/@mcp-core\/mcp-knot/g' {} +
```

> macOS 的 sed 需要 `-i ''`；Linux 环境改为 `-i`。

- [ ] **Step 2: 抽查替换正确性（保留 subpath）**

Run:

```bash
grep -rn "@mcp-core/mcp-knot" --include="*.ts" --include="*.vue" . | grep -v node_modules | grep -E "/(api-to-mcp|config|services|types|errors|utils/logger)"
```

Expected: 能看到 `@mcp-core/mcp-knot-core/api-to-mcp`、`@mcp-core/mcp-knot-share/config` 等，subpath 完整保留。

- [ ] **Step 3: 确认无旧包名残留（代码层）**

Run:

```bash
grep -rn "@mcp-core/mcp-hub" --include="*.ts" --include="*.vue" --include="*.tsx" . | grep -v node_modules
```

Expected: 空输出（零残留）。

- [ ] **Step 4: 验证全量编译**

Run: `pnpm build:production`
Expected: 全部 5 个包（share → core → api → cli → web）编译通过。若报 "Cannot find module '@mcp-core/mcp-hub-\*'"，说明有遗漏，回到 Step 1 补查。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(rename): 代码 import 全局替换 mcp-hub→mcp-knot（144 处）"
```

---

### Task 3: CI slug + README 品牌叙事改写

**Files:**

- Modify: `.github/workflows/ci.yml:109`（slug）
- Modify: `README.md`（24 处品牌名 + 头部叙事改写）
- Modify: `README.zh.md`（22 处品牌名 + 头部叙事改写）

**Interfaces:**

- Consumes: spec 第 1 节的品牌叙事（一句话定位、语义阐释、差异化站位）。

- [ ] **Step 1: 改 CI slug**

`.github/workflows/ci.yml:109` 的 `slug: yourtion/mcp-hub` 改为 `slug: yourtion/mcp-knot`。

- [ ] **Step 2: 改写 README.md 头部**

把 README.md 开头的标题与简介段替换为：

```markdown
# MCP Knot

English | [中文版](README.zh.md)

> _Knot_ —— 纽带、交织点。多个 MCP server 像散落的线，MCP Knot 把它们打成一个结，成为所有工具交汇的轻量枢纽。

**Tie your MCP servers together.**

A centralized hub server engineered to consolidate multiple MCP servers into dedicated Streamable HTTP or SSE endpoints, each tailored to specific use scenarios — lightweight, zero-config, and leading on the 2026-07-28 stateless MCP protocol.
```

- [ ] **Step 3: 改写 README.zh.md 头部**

把 README.zh.md 开头替换为：

```markdown
# MCP Knot

[English](README.md) | 中文版

> _Knot_ —— 纽带、交织点。多个 MCP server 像散落的线，MCP Knot 把它们打成一个结，成为所有工具交汇的轻量枢纽。

**把你的 MCP server 系在一起。**

一个轻量的集中式枢纽服务器，将多个 MCP server 整合为专属的 Streamable HTTP 或 SSE 端点，每个端点针对特定场景——零配置启动，并率先支持 2026-07-28 无状态 MCP 协议。
```

- [ ] **Step 4: 替换两份 README 中其余品牌名**

对 README.md 和 README.zh.md，把 `MCP Hub` / `MCPHub` / `mcp-hub` 统一替换为 `MCP Knot` / `mcp-knot`（包名/命令用 `mcp-knot`，品牌名用 `MCP Knot`）。注意区分品牌名与 npm 包名：命令 `pnpm --filter @mcp-core/mcp-knot-cli` 等保持包名形式。

```bash
# README.md / README.zh.md 中：品牌名 MCP Hub → MCP Knot
sed -i '' 's/MCP Hub/MCP Knot/g; s/MCPHub/MCP Knot/g' README.md README.zh.md
# 包名/命令 mcp-hub → mcp-knot（这两文件里的安装命令、npm 包名）
sed -i '' 's/mcp-hub/mcp-knot/g' README.md README.zh.md
```

> 替换后需人工通读 README，确认安装命令、CLI 用法示例中的包名与命令（`mcp-knot`、`@mcp-core/mcp-knot-*`）连贯一致。

- [ ] **Step 5: 验证 CI 配置语法**

Run: `pnpm check:ci`
Expected: oxlint + oxfmt 通过（README/CI 不影响 lint，但确认无格式破坏）。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(rename): CI slug + README/README.zh 品牌叙事改写为 MCP Knot"
```

---

### Task 4: 全量验证（验收硬指标）

**Files:** 无修改，仅验证。

**Interfaces:**

- Consumes: Task 1–3 的全部产出。

- [ ] **Step 1: 全量测试（含 e2e）**

Run: `pnpm test`
Expected: 全绿。重点关注 e2e 是否因包名/模块解析变化而失败。

- [ ] **Step 2: 生产构建复核**

Run: `pnpm build:production`
Expected: 全部包编译通过。

- [ ] **Step 3: lint + format 终检**

Run: `pnpm check:ci`
Expected: 0 warnings，格式无 diff。

- [ ] **Step 4: 验收硬指标——grep 零残留**

Run:

```bash
grep -rn "mcp-hub" --include="*.ts" --include="*.json" --include="*.md" --include="*.js" --include="*.vue" --include="*.yml" --include="*.yaml" . | grep -v node_modules | grep -v dist
```

Expected: **空输出**。

若仍有输出，分两种情况处理：

- **漏改**（如遗漏的 config、fixture）：补改并重跑本步。
- **历史文档显式保留**（如 `docs/superpowers/specs/2026-07-11-project-audit-report.md` 记录旧名、本改名计划文档本身）：在该处加注释说明保留理由，并在验收记录中列出豁免清单。

- [ ] **Step 5: 记录豁免清单（若有）**

若 Step 4 有显式保留的历史文档，在此 step 列出豁免文件路径与理由（例如："审计报告记录改名前的历史事实，保留旧名符合文档语义"）。

- [ ] **Step 6: Commit 验证记录（可选）**

若 Step 5 有内容：

```bash
git add -A
git commit -m "docs(rename): 记录 mcp-hub 旧名豁免清单（历史文档）"
```

---

## Phase 2：GitHub 仓库改名（手动，零代码）

> 本阶段由 yourtion 手动执行，不在 agentic worker 范围内。记录于此作为完整流程参考。

- [ ] **手动 Step 1: GitHub Settings 改名**

在 `https://github.com/yourtion/mcp-hub/settings` → Repository name 改为 `mcp-knot`。GitHub 自动对旧 URL 做 301 redirect，stars/issues/PR/forks 全保留。

- [ ] **手动 Step 2: 更新本地 remote**

```bash
git remote set-url origin git@github.com:yourtion/mcp-knot.git
git remote -v  # 确认 origin 指向 yourtion/mcp-knot
```

- [ ] **手动 Step 3: 验证 push**

```bash
git push  # 应通过新 URL，旧 URL 的 redirect 也能兜底
```

---

## Self-Review 记录

（写完 plan 后自查，结果记录于此。）

- **Spec 覆盖**：spec 决策汇总表每项都有对应 task —— 包名(Task1)、scope保留(Global)、一刀切(Global)、GitHub改名(Phase2)、品牌叙事(Task3)、命名调研(已在 spec 定稿)。✓
- **Placeholder 扫描**：无 TBD/TODO；每个 step 都有确切命令或内容。README 改写给了完整头部草稿。✓
- **类型一致性**：无新增类型/函数；包名字符串全文统一用映射表。subpath 在 Task 1 Global Constraint 与 Task 2 Step 2 均强调保留。✓
