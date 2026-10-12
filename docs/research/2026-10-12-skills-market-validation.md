# Skills 市场搜索接入与验证

Hub 已提供独立的技能市场搜索管理 API。它从 skills.sh 获取候选元数据，附加当前 Hub 的导入与 Group 发布状态，并提供可提交到现有来源接口的 Git/CLI 配置。搜索不会获取技能文件、更新快照或改变 Group 发布选择。

- 日期：2026-10-12
- 分支：`codex/skills-protocol-validation`
- 环境：Node.js 24.19.0，MCP SDK 2.0.0
- 真实公开搜索、状态关联和自动回归验证通过

## API 与使用流程

```http
GET /api/skills/market/search?q=grill-me&owner=mattpocock&limit=20
Authorization: Bearer <Hub 管理员 JWT>
```

沿用 `/api/skills` 的 JWT 认证与管理员权限。`q` 必须为 2–200 个字符；`owner` 可选，限定 GitHub owner；`limit` 为 1–200，默认 20。未知字段不用于控制来源地址。

响应使用 `{ success: true, data: ... }`，其中 data 包含 `provider`、`query`、可选 `searchType`、`cached` 和 `items`。每个结果包含以下信息：

| 字段                                       | 含义                                                |
| ------------------------------------------ | --------------------------------------------------- |
| id、slug、name、source                     | 市场稳定标识、技能 slug、展示名称与仓库/来源        |
| installs、url、installUrl                  | 安装量、技能详情页和安装来源链接                    |
| sourceType、importable                     | 来源类别，以及当前 Git/CLI adapter 是否可接入       |
| local.imported、local.imports              | 是否已导入；匹配来源的最新有效候选引用              |
| local.published、local.publishedIn         | 是否已配置 Group 发布；对应 groupId 与固定 revision |
| importOptions.git、importOptions.skillsCli | GitHub 结果可直接复用的两种来源配置，需另补 id      |

本地状态以来源身份及技能 slug 关联，不把同名的其他仓库或没有来源证明的本地副本视为同一个市场技能。发布状态表示 Group 配置中的选择，不表示运行时服务健康。来源有新候选但 Group 仍发布旧 revision 时，两种 revision 分别出现在 imports 和 publishedIn。

使用搜索结果的 `importOptions.git` 或 `importOptions.skillsCli`，补充来源 id，然后提交到 `POST /api/skills/sources`。例如：

```json
{
  "id": "market-grill",
  "type": "git",
  "repository": "https://github.com/mattpocock/skills.git",
  "ref": "HEAD",
  "skills": ["grill-me"]
}
```

之后调用 `POST /api/skills/sources/market-grill/sync`，将响应的 selections 明确保存到 Group。如果结果已有本地 imports，可复用现有来源与 revision。原子 Skill 分发规则保持不变：市场结果是候选目录，`skills/list` 仍只列出 Group 已发布技能。

本轮实现搜索 API，详情通过返回的技能页面链接查看。尚未新增市场 Web 页面、排行榜/审计管理 API 或 MCP 搜索工具。well-known 等来源可展示，当前标记为不可通过现有 Git/CLI adapter 导入，不生成 Git 配置。

## Provider 与部署

核心接口为 `SkillMarketProvider.search()`，skills.sh adapter 位于 `packages/core/src/skills/market.ts`。backend 的 `SkillMarketService` 负责将市场结果与持久化来源、Group 配置关联。

市场搜索调用公开的 `/api/search`，无需上游凭据，Hub 可独立部署。管理入口仍使用 Hub 自身的 JWT 与管理员权限。

| 环境变量              | 默认值            | 作用                                                |
| --------------------- | ----------------- | --------------------------------------------------- |
| SKILLS_MARKET_API_URL | https://skills.sh | 服务端配置的 HTTPS origin，供兼容代理或部署调整使用 |

公开接口来源见[官方 CLI find.ts](https://github.com/vercel-labs/skills/blob/main/src/find.ts)。Provider 将上游 `skills` 数组转换为 Hub 结果。

## CLI 与 HTTP 的取舍

官方 `skills find` 当前同样请求 `/api/search`，因此增加 CLI 搜索入口不会提供独立的上游故障兜底。其搜索实现将非成功 HTTP 响应及异常转为空数组，命令输出为带 ANSI 颜色的展示文本；当前实现未提供结构化 JSON 搜索输出。这些行为见[官方 CLI 源码](https://github.com/vercel-labs/skills/blob/main/src/find.ts)。

本轮保留直接 HTTP 搜索，以便校验结构、区分空结果与请求失败、处理超时和限流。获取与更新继续支持已有的 `skills-cli` 来源 adapter，在隔离目录执行已解析并固定版本的命令，之后保存 Hub 快照。`latest` 是同步时的版本选择策略，实际执行版本记录在来源快照中。

未来若 CLI 提供稳定的 JSON 输出及明确的错误退出状态，可通过现有 `SkillMarketProvider` 增加 CLI 搜索实现；使用它仍需明确 CLI 升级策略，不能因共享上游而假定其能解决搜索服务故障。

## 缓存与错误行为

市场元数据在内存缓存最多 100 个查询，默认最多 30 秒，遵守上游 `s-maxage` / `max-age` 和 `no-store` / `no-cache`。缓存按 Provider 实例和查询参数区分，同一查询的并发请求合并。导入及发布状态不进入该缓存，每次管理请求重新计算；完整管理响应发送 `Cache-Control: private, no-store`。

请求默认 10 秒超时，响应按结构校验，读取上限为 2 MiB。上游失败明确返回错误，不伪装成没有搜索结果。

| 情况                      | HTTP 状态与错误码                         |
| ------------------------- | ----------------------------------------- |
| 查询参数不合法            | 400 / INVALID_MARKET_QUERY                |
| 上游限流                  | 429 / MARKET_RATE_LIMITED，附 Retry-After |
| 配置不合法                | 503 / MARKET_CONFIGURATION_ERROR          |
| 网络或上游暂不可用        | 503 / MARKET_UNAVAILABLE                  |
| 上游响应格式不合法        | 502 / INVALID_MARKET_RESPONSE             |
| 请求或响应超时            | 504 / MARKET_TIMEOUT                      |
| 本地导入/发布状态读取失败 | 503 / MARKET_LOCAL_STATE_UNAVAILABLE      |

429 时按 Retry-After 暂停该 Provider 实例的后续网络请求；没有提示时默认 60 秒。仍有效的已缓存结果可继续使用。错误响应不直接返回原始上游错误正文。

## 验证结果

真实公开搜索使用现有临时验证配置与 `owner=mattpocock`，通过管理 API 得到：

| 结果                             | 已导入            | 已配置发布             |
| -------------------------------- | ----------------- | ---------------------- |
| mattpocock/skills/grill-me       | 是，来源 matt-git | 是，Group verification |
| mattpocock/skills/batch-grill-me | 否                | 否                     |
| mattpocock/skills/grilling       | 否                | 否                     |

来源登记与 Group 配置在搜索前后保持一致。验证脚本使用管理员测试上下文调用 Hono 路由，不宣称经过完整生产 JWT 登录入口。

市场测试 **16 项**，覆盖公开响应归一化、参数校验、缓存过期及容量、并发合并、429 冷却与缓存可用性、网络/格式错误、超时、非 GitHub 来源、管理员权限、实时本地状态及既有来源导入配置复用。

- Skills 全部验证：8 个测试文件，**70 项通过**。
- Share、Core、backend 全量回归：107 个测试文件，**1,734 项通过**。
- Core/backend 构建、脚本及市场集成测试严格类型检查、oxlint 与格式检查通过。

自动测试：

```bash
pnpm test:skills
```

复现真实公开搜索，指定已有验证配置或独立临时目录：

```bash
pnpm exec tsx backend/scripts/skills-market-validation.ts \
  --directory /tmp/mcp-hub-skills-validation/git \
  --q grill-me --owner mattpocock
```

该目录已有来源和 Group 时可验证本地状态；新目录返回未导入/未发布状态。Git/CLI 获取与 Group 发布流程见[来源接入报告](2026-10-12-skills-source-validation.md)。
