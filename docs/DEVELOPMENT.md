# MCP Knot 开发指南

本指南介绍如何设置开发环境并参与 MCP Knot 的开发。完整的架构说明参见 [CLAUDE.md](../CLAUDE.md)，本文只覆盖开发相关的内容。

## 目录

- [开发环境设置](#开发环境设置)
- [项目结构](#项目结构)
- [开发工作流](#开发工作流)
- [测试](#测试)
- [配置文件](#配置文件)
- [贡献流程](#贡献流程)
- [发布流程](#发布流程)
- [相关文档](#相关文档)

## 开发环境设置

### 前置要求

- **Node.js**: 20.19 或更高版本（推荐 Node 22/24）（`package.json` 中 `engines.node` 要求 `>=20.19.0`）
- **pnpm**: 10.x（仓库指定 `packageManager: pnpm@10.6.4`，启用 corepack 即可自动切换）
- **Git**: 2.x

### 安装步骤

```bash
# 克隆仓库
git clone https://github.com/your-org/mcp-knot.git
cd mcp-knot

# 启用 corepack 以使用仓库指定的 pnpm 版本（可选但推荐）
corepack enable

# 安装依赖
pnpm install

# 首次构建所有包（内部包之间有依赖顺序）
pnpm build
```

### 代码规范工具

项目使用 [oxlint](https://oxc.rs/) + [oxfmt](https://oxc.rs/) 进行 lint 和格式化，无需额外配置 Prettier/ESLint。推荐的编辑器扩展：`oxc.oxc-vscode`、`vue.volar`（前端开发时）。

## 项目结构

MCP Knot 是一个 pnpm monorepo，包之间有明确的依赖边界：

```
mcp-knot/
├── packages/
│   ├── core/     # @mcp-core/mcp-knot-core  核心 MCP 逻辑（服务管理、连接、工具执行）
│   ├── cli/      # @mcp-core/mcp-knot-cli    通过 stdin/stdout 通信的独立 MCP 服务器
│   ├── protocol/ # @mcp-core/mcp-knot-protocol 协议兼容层
│   └── share/    # @mcp-core/mcp-knot-share  共享类型和工具
├── backend/      # @mcp-core/mcp-knot-api    基于 Hono 的 API 服务器（HTTP/SSE）
├── frontend/     # @mcp-core/mcp-knot-web    Vue.js + Rsbuild 管理界面
├── config/       # 运行时配置文件（见「配置文件」）
├── docs/         # 文档
└── scripts/      # 构建、覆盖率等辅助脚本
```

**包依赖关系**（避免循环依赖）：

- `core` 依赖 `share`
- `protocol` 依赖 `share`
- `cli` 依赖 `core`、`protocol`、`share`
- `backend`（api）依赖 `core`、`protocol`、`share`
- `frontend`（web）依赖 `share`

## 开发工作流

### 命令速查

所有命令均从仓库根目录执行（实际通过 `pnpm --filter` 转发到对应包）。

| 场景                                    | 命令                                                       |
| --------------------------------------- | ---------------------------------------------------------- |
| 启动后端开发（热重载）                  | `pnpm dev:api`                                             |
| 启动前端开发                            | `pnpm dev:fe`                                              |
| 启动 CLI 开发                           | `pnpm dev:cli`                                             |
| 构建所有包                              | `pnpm build`                                               |
| 生产构建（按依赖顺序）                  | `pnpm build:production`                                    |
| 单包构建                                | `pnpm build:core` / `build:api` / `build:cli` / `build:fe` |
| Lint + 格式化（含 `--fix`，会改写文件） | `pnpm check`                                               |
| CI 门禁（readonly，仅检查不改写）       | `pnpm check:ci`                                            |
| 全量 lint + 格式化（`--fix`）           | `pnpm check:all`                                           |
| 运行所有测试                            | `pnpm test`                                                |
| 生产启动后端                            | `pnpm start:api`                                           |
| 生产启动 CLI                            | `pnpm start:cli`                                           |
| 清理所有包的 dist/coverage              | `pnpm clean`                                               |
| 连带清理所有 node_modules               | `pnpm clean:all`                                           |
| MCP Inspector                           | `pnpm inspector`                                           |

### 开发端口

- 后端默认监听 **8181**（由 `config/system.json` 的 `server.port` 控制；该字段缺省时回退到 8181）。
- 前端开发服务器监听 **8180**（`frontend/rsbuild.config.ts`），并把 `/api` 代理到 `http://localhost:8181`。

如需同时调试前后端，开两个终端分别跑 `pnpm dev:api` 和 `pnpm dev:fe`。要改后端端口请编辑 `config/system.json` 的 `server.port`（代码不读 `process.env.PORT`）。

### 开发核心 / CLI 包

核心包和 CLI 包没有独立的 `pnpm dev`（在根目录用 filter 调用）：

```bash
# 核心包监视模式编译
pnpm --filter @mcp-core/mcp-knot-core dev

# CLI 包测试
pnpm --filter @mcp-core/mcp-knot-cli test:e2e
```

### 代码检查注意事项

`pnpm check` 会自动修复 lint 和格式问题（改写文件）；`pnpm check:ci` 是只读的 CI 门禁，**提交/合并前务必再跑一次 `pnpm check:ci`** 复验，确保没有遗漏问题进入主干。

## 测试

项目使用 Vitest 4.x，采用集中的 projects 配置（`vitest.config.ts`），按粒度划分多个 project：

- `share` / `protocol` / `core` / `cli`：包内单元测试
- `api-unit` / `api-integration`：后端单元与集成测试
- `api-e2e`：完整 MCP 协议端到端测试（使用 mock server，位于 `backend/src/e2e/`）
- `frontend`：前端组件测试

测试文件按后缀区分：`.unit.test.ts` 为单元测试。

### 测试命令

| 场景                            | 命令                             |
| ------------------------------- | -------------------------------- |
| 运行所有测试                    | `pnpm test`                      |
| 监视模式                        | `pnpm test:watch`                |
| 仅 E2E                          | `pnpm test:e2e`                  |
| 带覆盖率                        | `pnpm test:coverage`             |
| 调试模式（`VITEST_DEBUG=true`） | `pnpm test:debug`                |
| 运行单个文件                    | `pnpm test path/to/file.test.ts` |

### 测试约定

摘自 [CLAUDE.md](../CLAUDE.md)，编写测试时必须遵循：

- 为 `vi.fn().mockImplementation()` 使用 `function` 关键字（非箭头函数），以支持 `new` 调用
- 使用 `useTestContext()`（`test/context/test-context.ts`）管理需要清理的测试资源
- 不要写 `expect(true).toBe(true)` 这类空断言，必须断言真实行为
- 测试文件中禁止使用 `any` 类型

## 配置文件

代码运行时从配置目录读取 JSON 配置，默认为 `<cwd>/config`，可用 `CONFIG_PATH` 环境变量覆盖：

```typescript
// backend/src/utils/config.ts
return process.env.CONFIG_PATH || path.resolve(process.cwd(), 'config');
```

从仓库根目录启动时读取 `./config/`，包含以下文件：

| 文件              | 作用                                           |
| ----------------- | ---------------------------------------------- |
| `mcp_server.json` | MCP 服务器定义（命令、参数、环境变量等）       |
| `group.json`      | 服务器分组与访问规则（allow/deny、验证密钥等） |
| `system.json`     | 系统设置（如 `server.port`，缺省回退 8181）    |
| `api-tools.json`  | 可选，将外部 HTTP API 转为 MCP 工具的集成配置  |

首次启动若配置缺失，核心包的 `DefaultConfigGenerator` 会生成初始模板。

## 贡献流程

### 基本流程

```bash
# 1. Fork 并克隆
git clone https://github.com/<your-username>/mcp-knot.git
cd mcp-knot

# 2. 创建功能分支
git checkout -b feature/your-feature

# 3. 开发、写测试、更新文档

# 4. 本地验证（按顺序）
pnpm check            # 修复 lint/格式
pnpm check:ci         # readonly 复验，必须通过
pnpm test             # 所有测试通过
pnpm build            # 构建通过

# 5. 重要变更更新 docs/RELEASE_NOTES.md

# 6. 提交并推送，使用 Conventional Commits 格式
git add .
git commit -m "feat(api): 添加服务器健康检查端点"
git push origin feature/your-feature

# 7. 在 GitHub 上向 main 分支发起 Pull Request
```

### 提交信息格式

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：`<type>(<scope>): <subject>`，常用 type 包括 `feat`、`fix`、`docs`、`refactor`、`perf`、`test`、`chore`。

### PR 检查清单

- [ ] `pnpm check:ci` 通过（CI 实际门禁）
- [ ] `pnpm test` 全部通过
- [ ] `pnpm build` 构建成功
- [ ] 新代码有对应测试，且未破坏原有测试
- [ ] 相关文档已同步更新
- [ ] 重要面向用户的变更已记录
- [ ] 提交信息遵循 Conventional Commits
- [ ] 无合并冲突

## 发布流程

四个公开包统一版本，不再要求开发者添加 changeset。重要变更记录在 RELEASE_NOTES.md。
功能合入并通过 main CI 后，维护者在干净且已同步的 main 上执行：

```bash
pnpm run release:prepare patch  # minor / major / X.Y.Z
# 审核版本提交与本地 tag
pnpm run release:push
```

prepare 先验证、提交四包版本，再打本地 tag；push 精确推送 main 与该 tag。
Tag 工作流测试构建、检查 tarball、通过 OIDC 发包，全部成功后创建 GitHub Release。
`pnpm run release:validate` 和 `pnpm run release:dry-run` 可安全本地验证而不发版。
首次设置、版本选择及重试详见 [RELEASING.md](RELEASING.md)。

## 相关文档

- [CLAUDE.md](../CLAUDE.md) — 架构总览、包结构与开发约定（必读）
- [README](../README.md) — 项目介绍、快速上手与发布流程
- [API 参考](API_REFERENCE.md)
- [分组路由](GROUP_ROUTING.md)
- [Web 界面使用指南](WEB_UI_GUIDE.md)
- [部署指南](DEPLOYMENT.md)
- [故障排除](TROUBLESHOOTING.md)
- [CLI 用法](CLI_USAGE.md)
- [发布日志](RELEASE_NOTES.md)
