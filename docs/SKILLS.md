# Skills 使用指南

MCP Knot 可以从本地目录、公共 HTTPS Git 仓库和 `skills` CLI 导入选定的 Agent Skills，将完整文件保存为不可变快照，再通过现有 `/:group/mcp` 端点分发。来源同步生成候选版本，Group 明确选择要发布的版本；更新来源不会自动改变组输出。

## 当前范围

已实现来源登记、同步/更新、快照恢复、Group 固定版本选择和市场搜索管理 API。MCP 使用 `io.modelcontextprotocol/skills` 扩展，提供 `skills/list`、`skills/get` 以及文件的 `resources/read`，保留原 frontmatter、完整文件清单、SHA-256 和字节数。

Hub 分发单个 Skill 及其附件。技能正文引用其他技能时，由模型判断需求、宿主读取已授权内容；Hub 不递归导入、不合并技能正文，也不执行附带脚本。

当前通过 API 或配置操作，Web 界面尚未新增技能编辑入口。没有后台任务、定时同步、私有仓库凭据管理、Bundle 或自动 GC。生产 CLI/stdin 服务尚未接入 Skills；stdio 验证脚本仅用于协议测试。客户端需要支持 Skills 扩展，普通 MCP 资源读取不代表客户端会激活技能。

## 运行与存储

项目要求 Node.js 20.19+。Git/CLI 来源需要运行环境中的 `git`，CLI 来源还需要 `npx` 与 npm 网络访问。backend Docker 镜像包含 Git 和 Node/npm。同步请求当前同步执行，单个外部命令超时为 120 秒，部署代理的超时应覆盖整个导入过程。

数据位于 `CONFIG_PATH/.skills/`；未指定 CONFIG_PATH 时为当前工作目录下的 `config/.skills/`。容器部署应将配置目录挂载到持久存储，并保证运行用户可写。

```text
.skills/
  sources.json                            # 来源登记
  revisions/<sourceId>/<revision>.json     # 原始文件字节及来源记录
  revisions/<sourceId>/latest.json         # 最新有效候选
  workspaces/<sourceId>/<revision>/        # CLI 项目目录与 skills-lock.json
  staging/                                # 导入时的临时工作目录
```

读取已发布技能不访问来源网络。失败同步保留原有有效候选；Group 选择继续指向原版本。备份必须包含 `group.json` 和整个 `.skills/`，现有配置备份 API 不包含技能快照。不要删除仍被 Group 引用的 revision 或 CLI 更新需要的 workspace。

写操作由文件系统锁互斥保护。异常退出可能留下 `.skills/.write-lock`；确认所有相关写进程已停止后才能手动清理。当前部署契约为单实例，尚未提供分布式任务调度和锁恢复。

## 管理 API

所有 `/api/skills/*` 请求需要 Hub 管理员 JWT，即 `Authorization: Bearer <Hub 管理员 accessToken>`。该凭据与 MCP 入站 OAuth token 不同。

| 请求                                                                 | 用途                                          |
| -------------------------------------------------------------------- | --------------------------------------------- |
| `GET /api/skills/market/search?q=grill-me&owner=mattpocock&limit=20` | 搜索市场候选，返回本地导入/发布状态与来源配置 |
| `GET /api/skills/sources`                                            | 查看登记来源、最新候选、技能清单与来源记录    |
| `POST /api/skills/sources`                                           | 登记来源；已有来源 ID 的配置不能改变          |
| `POST /api/skills/sources/:sourceId/sync`                            | 获取、校验并保存候选快照                      |
| `POST /api/skills/sources/:sourceId/update`                          | 更新并保存候选快照                            |

来源与市场请求使用 `{ "success": true, "data": ... }` 响应。同步成功的 `data.selections` 包含 `{sourceId, revision, skill}`，可直接作为 Group 的 `skills.include`。来源同步错误返回 `400 / SKILLS_ERROR`；市场查询会区分参数、限流、网络、格式及超时错误，详见[市场验证报告](research/2026-10-12-skills-market-validation.md)。

### 1. 登记来源

公共 Git 来源：

```json
{
  "id": "matt-git",
  "type": "git",
  "repository": "https://github.com/mattpocock/skills.git",
  "ref": "HEAD",
  "skills": ["grill-me"]
}
```

`ref` 可为 HEAD、分支、标签或完整 commit。Hub 先解析 commit，再检出该提交，不运行仓库 hooks，也不自动获取 submodule/LFS。根据目录名选择技能，目录名须与 SKILL.md 的 name 在 NFKC 规范化后相同；同一来源发现同名候选会拒绝导入。

CLI 来源可以使用结构化配置：

```json
{
  "id": "matt-cli",
  "type": "skills-cli",
  "repository": "mattpocock/skills",
  "cliVersion": "latest",
  "skills": ["grill-me"]
}
```

也可使用受限的命令形式：

```json
{
  "id": "matt-cli",
  "command": "npx skills@latest add mattpocock/skills --skill=grill-me"
}
```

命令仅用于解析配置，不作为 shell 执行。Hub 解析实际 CLI 版本后以固定版本获取，安装到独立项目目录，保留 `skills-lock.json` 供更新使用。可将 `cliVersion` 指定为确切版本；`latest` 每次同步重新解析版本，实际执行版本记录在快照 provenance 中。CLI 更新沿用已保存的项目目录与 lock。

本地来源使用 `{ "id": "team", "type": "local", "directory": "/srv/team-skills", "skills": ["review"] }`。建议使用绝对路径；当前相对路径按 Hub 进程的工作目录解析。技能根目录或附件中的符号链接、硬链接和非普通文件不能导入。每个 Skill 上限为 512 个文件、16 MiB。

### 2. 同步并选择发布

调用 `POST /api/skills/sources/matt-git/sync`，复制响应的 `data.selections`。通过 `POST /api/groups` 新建组，或 `PUT /api/groups/:groupId` 更新组：

```json
{
  "id": "design",
  "name": "Design skills",
  "servers": [],
  "tools": [],
  "skills": {
    "include": [
      {
        "sourceId": "matt-git",
        "revision": "<复制同步响应中的 64 位 revision>",
        "skill": "grill-me"
      }
    ]
  }
}
```

示例 revision 是占位符，必须替换为当前 Hub 已保存的 revision。组保存会检查 revision 和技能是否存在，重复或冲突选择会报错；成功保存后后续请求重建组视图。纯 Skills Group 允许 `servers: []`，但 Hub 全局的 MCP 配置仍沿用至少一个 upstream server 的校验要求。

配置文件 `group.json` 使用组 ID 作为顶层 key，例如 `{ "design": { "name": "Design skills", "servers": [], "tools": [], "skills": { "include": [...] } } }`，与管理 API 请求中的 `id` 字段不同。配置文件修改需要按既有配置重载流程生效。

未配置 `skills` 的组不公开任何导入技能。读取沿用当前 Group 的入站认证与 `mcp:tools` scope；当前没有技能专用 scope。支持文件仅限所选快照清单，另一组或已撤销版本的 URI 无法访问。

### 3. 更新与回滚

调用来源的 `/update` 获得新候选，检查后将新的 selections 保存到 Group。保持现有 include 即继续分发旧版本。要回滚，将组选择恢复为以前保存的 selections；不会重新从 Git/CLI 获取旧文件。

来源登记与同步不会自动发布，市场搜索也不会登记、导入或发布来源。同名技能可来自不同来源，URI 按 sourceId 和内容摘要区分。

## 市场搜索

搜索使用公开 skills.sh `/api/search`，无需 Vercel 凭据。`q` 为 2–200 字符，`owner` 可选，`limit` 为 1–200、默认 20。服务端可用 `SKILLS_MARKET_API_URL` 配置兼容的 HTTPS origin。

每个结果返回元数据、详情链接、`local.imported` / `local.published` 状态，以及可复用的 `importOptions.git` / `importOptions.skillsCli`；提交来源配置前补上自己的来源 ID。已发布状态来自 Group 配置，不能代表服务健康。

市场元数据遵守上游缓存指令，并合并同查询的并发请求；本地状态每次重新计算。限流会返回 429 和 Retry-After；网络或响应错误与空结果区分。直接 HTTP 搜索和官方 CLI 当前使用同一个上游，CLI 不提供独立搜索服务兜底。非 GitHub 来源可展示，当前不生成可导入配置。

## 验证与开发

```bash
pnpm test:skills

# 公共 Git/CLI 获取、更新、磁盘恢复及 Group MCP 验证
pnpm exec tsx backend/scripts/skills-source-validation.ts \
  --directory /tmp/mcp-knot-skills/git --type git
pnpm exec tsx backend/scripts/skills-source-validation.ts \
  --directory /tmp/mcp-knot-skills/cli --type skills-cli

# 只读市场搜索；可关联已有验证目录中的来源和 Group
pnpm exec tsx backend/scripts/skills-market-validation.ts \
  --directory /tmp/mcp-knot-skills/git --q grill-me --owner mattpocock
```

验证脚本使用独立配置目录，不应指向生产配置。Core 的共享实现从 `@mcp-core/mcp-knot-core/skills` 导出，协议和来源验证记录见[协议报告](research/2026-10-11-skills-protocol-validation.md)、[来源报告](research/2026-10-12-skills-source-validation.md)和[市场报告](research/2026-10-12-skills-market-validation.md)。
