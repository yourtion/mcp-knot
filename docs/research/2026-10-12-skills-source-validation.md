# Skills 来源获取与 Group 发布验证

Git、本地目录和 `skills` CLI 现在共用持久化快照，正式 Group MCP 服务可以分发明确选择的技能版本。来源同步产生候选 revision；Group 配置固定选择 revision，更新候选不会替换已发布内容。

- 日期：2026-10-12
- 分支：`codex/skills-protocol-validation`
- 环境：Node.js 24.19.0，MCP SDK 2.0.0，实际解析的 skills CLI 1.7.2
- 规范沿用第一轮的官方 `io.modelcontextprotocol/skills` / SEP-2640

## 来源获取与快照

`SkillRepository` 提供来源登记、同步/更新、查询最新候选和构造发布视图。`sources.ts` 负责获取文件树，快照验证与 MCP 分发沿用第一轮实现。

Git 来源接受不含凭据的 HTTPS 仓库 URL。支持 HEAD、分支、标签和完整 SHA-1 commit；获取后先解析 commit，再 detached checkout。禁用 Git hooks、submodule 自动获取及 LFS smudge。扫描选择的技能目录，记录 commit、目录路径和内容 revision。

CLI 来源接受 `owner/repo`、技能名称列表和 CLI 版本。也可提交用户给出的命令形式：

```text
npx skills@latest add mattpocock/skills --skill=grill-me
```

命令只用于解析配置，执行使用 `execFile` 的独立参数，不经过 shell。获取时先解析实际 CLI 版本，再运行固定版本的 `add`，附加 `--agent universal --copy --yes`；文件安装到 Hub staging 工作目录的 `.agents/skills/`，不指定全局安装。

更新使用上次保留的工作目录与 `skills-lock.json`，运行固定版本的 `update <skills...> --project --yes`。随后重新验证完整文件树、摘要和大小，再写入候选快照。Git 和本地来源的 `update` 重新捕获选定技能。

运行时文件位于 `CONFIG_PATH/.skills/`，未指定 CONFIG_PATH 时使用当前工作目录的 `config/.skills/`：

```text
.skills/
  sources.json
  revisions/<sourceId>/<revision>.json
  revisions/<sourceId>/latest.json
  workspaces/<sourceId>/<revision>/      # CLI 更新需要的文件及 lock
  staging/<job-directory>/              # 获取完成或失败后清理
```

快照包含原始文件字节，按内容固定 revision。同一 revision 保留第一次导入的来源记录；相同内容再次同步不会制造新版本。加载时重新解析 SKILL.md、计算文件摘要及 revision，损坏数据导致加载失败。已发布读取无网络依赖，源目录消失后仍可读取。失败同步不会改变最新有效候选指针或 Group 选择。

写操作使用原子 rename 和跨实例目录锁，阻止并发修改。当前为文件系统持久化；异常终止遗留的 `.write-lock` 需要在确认相关进程已停止后清理。备份应包含整个 `.skills/`，现有仅备份 system/mcp/group JSON 的配置备份不包含技能文件。

## 管理 API

沿用 `/api/*` 的 JWT 认证；来源管理另外要求管理员角色。MCP 读取沿用现有 Group 入站认证和 `mcp:tools` scope，尚未拆分技能专用 scope。

| 请求                                        | 行为                                       |
| ------------------------------------------- | ------------------------------------------ |
| `GET /api/skills/sources`                   | 来源配置、最新有效候选、技能清单与来源记录 |
| `POST /api/skills/sources`                  | 登记结构化来源或受限的 add 命令            |
| `POST /api/skills/sources/:sourceId/sync`   | 获取、验证并保存候选快照                   |
| `POST /api/skills/sources/:sourceId/update` | 更新来源并保存候选快照                     |

Git 来源登记请求示例：

```json
{
  "id": "matt-git",
  "type": "git",
  "repository": "https://github.com/mattpocock/skills.git",
  "ref": "main",
  "skills": ["grill-me"]
}
```

CLI 来源登记请求示例：

```json
{
  "id": "matt-cli",
  "command": "npx skills@latest add mattpocock/skills --skill=grill-me"
}
```

等价的结构化配置为 `type: "skills-cli"`、`repository: "mattpocock/skills"`、`skills: ["grill-me"]`、`cliVersion: "latest"`。部署可固定 `cliVersion: "1.7.2"`。来源 ID 的配置登记后不允许原地改变；需要改变仓库或选择集时使用新 ID，避免旧 revision 的来源含义变化。

同步响应的 `data.selections` 是可直接用于 Group 配置的完整引用。管理请求当前同步执行；后台 job、取消和定时同步属于后续扩展。

## 正式 Group 配置

通过现有 `POST /api/groups`、`PUT /api/groups/:groupId` 或 `group.json` 配置发布选择。例如实际 Git 验证产生的选择：

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
        "revision": "4b9e762d5f7a06b3bbefbc5c9054314b5a3f8e5dc54a22c0e1a63b784e3c06f2",
        "skill": "grill-me"
      }
    ]
  }
}
```

示例 revision 必须已存在于当前 Hub；实际使用时复制同步响应的 selections。选择结构是本轮落实的配置格式，以 sourceId、revision、skill 三元组代替方案中的未固定版本字符串，避免更新后悄悄改变 Group 输出。

Group CRUD 和批量配置验证检查 revision 是否存在、技能是否属于该 revision，并拒绝同一来源同一技能的重复/冲突版本。保存 Group 后复用既有缓存失效机制，后续请求重建视图；切换回旧引用即可回滚。列表、详情和保存响应保留 skills 字段。

正式 `/:groupId/mcp` 服务注册 `skills/list`、`skills/get` 与技能文件的 `resources/read`。未选择的技能和文件不进入视图，猜测另一组 URI 也不能读取。缺省 `skills` 不公开导入技能。原 Tools 和 Hub Resources 保留。

允许只有技能的 Group，但 Hub 全局 MCP 配置仍沿用“至少一个 upstream server”的现有校验规则；本轮没有放宽该全局启动要求。Web 界面尚未新增来源与技能编辑页面，可通过 API 或配置文件操作。

## 实际公共仓库结果

验证仓库为 [mattpocock/skills](https://github.com/mattpocock/skills)，选取 `skills/productivity/grill-me`，Git commit 为 `49dd158d1076134a641b33efb035946536778336`。

| 路径               | 结果                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| Git 获取与重复同步 | 成功，包含 SKILL.md 与 agents/openai.yaml 共 2 个文件                                                                      |
| CLI add            | 成功，实际 CLI 版本 1.7.2，保存 project lock                                                                               |
| CLI update         | 成功，远端内容未改变，revision 保持不变                                                                                    |
| 内容比较           | Git 和 CLI 的单技能内容 revision 均为 `a880b8006ba465db31d35884037f69de01f4b5ed4d2368037d41ff9424184687`；来源命名空间不同 |
| 磁盘恢复           | 新 Repository 实例在禁止来源命令的情况下恢复并读取旧 revision                                                              |
| 正式 Group 服务    | 使用 GroupMcpService 与 SDK HTTP handler 获取清单并读取全部文件，字节大小及 SHA-256 匹配                                   |

验证使用临时配置目录，不改生产配置。CLI 获取的是技能文件，技能说明及附件不会被 Hub 执行或激活。

## 自动测试与复现

Skills 测试共 **54 项**，覆盖第一轮协议测试以及新增持久化、来源 adapter、命令解析、Group Schema、管理 API、版本切换、旧 URI 拒绝及管理员权限测试。Share、Core、backend 全量回归 **105 个测试文件、1,718 项通过**。三者 TypeScript 构建、脚本/集成测试的严格类型检查、oxlint 和格式检查通过。

运行自动测试：

```bash
pnpm test:skills
```

部署环境需要可用的 git、Node.js 和 npx，Node 版本满足项目要求。实际公共仓库验证可复现为：

```bash
pnpm exec tsx backend/scripts/skills-source-validation.ts \
  --directory /tmp/mcp-hub-skills-validation/git --type git

pnpm exec tsx backend/scripts/skills-source-validation.ts \
  --directory /tmp/mcp-hub-skills-validation/cli --type skills-cli
```

脚本执行导入、更新、磁盘恢复与正式 Group MCP 输出检查。HTTP 使用真实 SDK Fetch 链路，自动测试另覆盖真实 loopback socket 与 stdio；公共仓库脚本不宣称经过完整生产认证入口或真实宿主技能激活。

CLI 参考：[官方 add 及 update 文档](https://github.com/vercel-labs/skills#other-commands)。官方格式与协议基线见[第一轮验证报告](2026-10-11-skills-protocol-validation.md)，产品范围见[总体方案](../superpowers/specs/2026-10-11-skills-hub-design.md)。

后续已接入独立市场搜索管理 API，返回导入/发布状态及可复用的来源配置，见[市场搜索接入与验证](2026-10-12-skills-market-validation.md)。
