# Skills over MCP 与 MCP Hub 可行性

核查日期：2026-10-11。外部事实来自官方文档与官方源码；实现建议明确标为推断。目标是让 MCP Hub 获取仓库中的技能，经选择与整合后通过统一 MCP 端点分发；研究不包含上游 Skills 代理。

## Cloudflare 做了什么

Cloudflare 在 2026-10-10 宣布，其 API MCP 服务 `https://mcp.cloudflare.com/mcp` 开始通过 Skills over MCP 扩展提供 Cloudflare Skills；支持扩展的客户端用 `skills/list` 发现技能，再读取 `skill://<name>/<path>` 文件。[更新公告](https://developers.cloudflare.com/changelog/post/2026-10-10-cloudflare-mcp-skills/)

官方仓库说明技能来自 `cloudflare/skills`，每六小时从 GitHub 同步一次；服务源码在创建服务器时调用 `registerSkills(server)`，Code Mode 开关的两种模式都提供技能。Skills 仓库仍支持插件、复制目录等安装方式，因此这是新增的远端交付渠道。[MCP 仓库](https://github.com/cloudflare/mcp#skills)、[服务器源码](https://github.com/cloudflare/mcp/blob/main/src/server.ts)、[Skills 仓库](https://github.com/cloudflare/skills)

## 当前协议要点

这是官方扩展 `io.modelcontextprotocol/skills`，SEP-2640 已 Final；规范基于 MCP `2026-07-28` 或更新版本。[官方扩展概述](https://modelcontextprotocol.io/extensions/skills/overview)、[规范仓库](https://github.com/modelcontextprotocol/ext-skills)

- 服务在 `server/discover` 的 capabilities 中同时声明 `resources` 和 `extensions["io.modelcontextprotocol/skills"]`；必须实现 `skills/list`、`skills/get`，文件复用 `resources/read`。声明 `directoryRead: true` 后才必须实现可选的 `resources/directory/read`。[能力与方法](https://modelcontextprotocol.io/extensions/skills/overview#capabilities)
- 客户端每次请求通过 `_meta["io.modelcontextprotocol/clientCapabilities"]` 声明相关能力，并读取服务的扩展声明；支持普通 MCP 或本地 Agent Skills 并不自动表示支持这个扩展。[扩展支持矩阵](https://modelcontextprotocol.io/extensions/client-matrix)
- 技能条目含 `uri`、原样保留的完整 `frontmatter`、文件清单 `resources`；每个文件记录 URI、SHA-256 和字节数，动态内容则声明 `resources: "dynamic"`。列表条目必须完整，客户端不必再次调用 `skills/get` 补齐元数据。[条目规范](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx#skill-entries)
- `skills/list` 使用 `cursor` / `nextCursor` 分页，同一技能的文件清单不能跨页；list/get 响应含 `resultType: "complete"`、`ttlMs`、`cacheScope`。现行扩展没有定义 `notifications/skills/list_changed` 或 `listChanged` 能力，不能照搬工具列表通知作为规范要求。[列表与获取规范](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx#listing-skills)
- URI 可以带组织前缀，例如 `skill://source-a/refunds/SKILL.md`；技能根目录末段必须等于 frontmatter 的 `name`。前缀可用于命名空间，但规范没有单独的 package 对象，也没有整包下载形式。技能身份是「来源服务器身份 + URI」，名字只是标签。[URI 与身份规范](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx#resource-mapping)
- 规范要求 Host 至少支持每个技能 512 个文件、16 MiB 总字节数，服务器不宜超过这些范围；未知技能或文件返回 JSON-RPC `-32602`。[限制与错误](https://modelcontextprotocol.io/extensions/skills/overview#implementation-requirements)

Host 还负责按需加载、校验文件摘要/大小/frontmatter，以及技能所需的授权；普通 `resources/read` 读取 `SKILL.md` 不等于激活技能。官方概述明确 SDK 和 Host 支持仍在实现中；支持矩阵的空白不能视为完整支持证明。[加载与校验](https://modelcontextprotocol.io/extensions/skills/overview#integrity-and-verification)、[当前支持状态](https://modelcontextprotocol.io/extensions/client-matrix)

## SDK v2 接入证据

官方 `McpServer` 源码公开底层 `server: Server`，注释明确自定义请求处理使用该对象；底层 `registerCapabilities(capabilities)` 必须在连接 transport 前调用。SDK 更新记录提供三参数 `setRequestHandler(method, schemas, handler)` 以接入非核心方法。[McpServer 源码](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/mcp.ts)、[Server 源码](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/server/src/server/server.ts)、[SDK 更新记录](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/packages/core-internal/CHANGELOG.md)

官方 Inspector 测试服务文档特别说明：`skills/list`、`skills/get` 是使用方负责的扩展方法，SDK 不自动填充它们的 `resultType`、`ttlMs`、`cacheScope`，处理函数应自行返回这些字段。Skills 专用 SDK API 的官方工作项仍在推进，因此本研究不假定存在可用的 `registerSkill` API。[Inspector 测试说明](https://github.com/modelcontextprotocol/inspector/blob/main/docs/test-servers.md#skills-sep-2640)、[SDK 工作项](https://github.com/modelcontextprotocol/typescript-sdk/issues/2798)

## 实施前的本仓库状态

主线程源码核查显示，目前 Hub 主要聚合 Tools，并未实现 Skills 扩展：

- 出站客户端 capabilities 未声明 extensions，连接后只调用 `client.listTools()`，变化通知只处理工具发现。[server_manager.ts](../../backend/src/services/server_manager.ts#L150)
- HTTP MCP 创建的资源是 Hub 自身元数据；工具对外名称采用 `serverId_toolName`。[group-service.ts](../../backend/src/api/mcp/group-service.ts#L165)
- Group 配置主要包含 servers/tools 与 toolFilter，没有 skills 配置。[group.schema.ts](../../packages/share/src/config/schemas/group.schema.ts)
- CLI 服务器能力声明只有 tools。[cli-mcp-server.ts](../../packages/cli/src/server/cli-mcp-server.ts#L120)

这些基础能力可以复用，但实施前并不存在技能目录托管和 Skills 协议接口。

## 设计推断与建议

Hub 可以从 Git 等仓库获取标准 Agent Skills 目录，经选择后形成托管目录快照，在现有 MCP 端点上发布技能；实现应包含来源与版本管理、技能目录扫描、完整 frontmatter 与文件清单、扩展能力声明、list/get、文件读取，以及选择规则和分组访问控制。仓库拉取、更新与选择属于 Hub 的管理层；协议交付仍按文件进行。

有多个本地来源时，可用 `skill://<source-id>/<skill-name>/...` 区分同名技能，保持 frontmatter 的 `name` 不变。文件清单和实际读取应来自同一目录快照；读取限定在已托管根目录中，避免通过相对路径或符号链接读取目录外文件。不同分组的列表、单项查询和内容读取应采用一致的权限规则。

本地技能可以编写适合 Hub 的工作流，并引用其实际公开的工具名称。目录内容变化时，应重新生成清单摘要并使列表缓存及时过期；现行规范没有技能列表变化通知，不能以通知替代文件一致性。

结论：统一通过 MCP 交付技能目录及支持文件在协议上成立，Hub 也适合承载这个能力；需要新增本地 Skills 服务并接入现有端点，最终加载效果取决于客户端对扩展的实际支持。
