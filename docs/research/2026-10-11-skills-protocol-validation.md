# Skills over MCP 第一轮协议验证

- 日期：2026-10-11
- 分支：`codex/skills-protocol-validation`
- 范围：总体方案的阶段 0，本地技能快照与独立协议验证入口
- 环境：Node.js 24.19.0、MCP TypeScript SDK 2.0.0
- 结论：当前 SDK 能承载官方 Skills 扩展，HTTP 与 stdio 链路已跑通。

## 规范基线

以官方扩展 `io.modelcontextprotocol/skills` / SEP-2640 的稳定规范为准，基于 MCP `2026-07-28`；格式校验参考 Agent Skills 规范及官方参考实现。

- [官方稳定 Skills 规范](https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx)
- [官方概述](https://modelcontextprotocol.io/extensions/skills/overview)
- [Agent Skills 格式](https://agentskills.io/specification)
- [Agent Skills 名称校验参考实现](https://github.com/agentskills/agentskills/blob/main/skills-ref/src/skills_ref/validator.py)
- [Inspector Skills 扩展方法说明](https://github.com/modelcontextprotocol/inspector/blob/main/docs/test-servers.md#skills-sep-2640)

本轮实现必需的 `skills/list`、`skills/get` 和标准 `resources/read`。服务声明 Resources 与 Skills 扩展。未声明可选的 `directoryRead`，因此本轮不实现 `resources/directory/read`。

## 实现

| 位置                                         | 功能                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `packages/core/src/skills/local-snapshot.ts` | 从标准技能目录捕获文件，解析完整 frontmatter，生成不可变内容 URI、SHA-256 和字节清单 |
| `packages/core/src/skills/catalog.ts`        | 固定发布视图、完整条目分页、直接查询、文件访问与视图绑定 cursor                      |
| `packages/core/src/skills/protocol.ts`       | 在既有 McpServer 上注册扩展方法及资源模板，保留原 Tools/Resources                    |
| `packages/core/src/skills/schemas.ts`        | 协议线上响应与 SDK 解码结果的独立校验 Schema                                         |
| `backend/scripts/skills-validation.ts`       | 独立 HTTP/stdio 验证入口，使用与 Hub 相同的 SDK serving API                          |

核心入口通过 `@mcp-core/mcp-knot-core/skills` 导出。HTTP 验证入口仅监听 `127.0.0.1`，端口 `0` 可选择空闲端口。演示工具为 `echo`，基础资源为 `hub://version`。

快照内容在内存中捕获，读取不再访问原目录。源文件变化或删除后，旧清单与旧读取保持一致；重新加载产生新的内容 revision。所有支持文件都进入 manifest，包括嵌套技能文件和二进制附件；分发过程不执行脚本。

## 自动验证结果

新增 3 个测试文件，共 **38 项全部通过**：

| 验证面   | 数量 | 覆盖                                                                                                                                                                                                          |
| -------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地快照 | 24   | 完整 frontmatter、未知及特殊字段、JSON 值合法性、原始字节摘要、编辑/删除后的快照、BOM/CRLF、二进制与非 UTF-8 文件、嵌套文件、URI 编码、Unicode 名称、非法 YAML/名称、符号链接、512 文件及 16 MiB 边界         |
| 发布视图 | 5    | 同名技能并存、完整条目分页、直接 get、视图隔离、cursor 失效、元数据不可变、空目录及重复 URI                                                                                                                   |
| SDK 链路 | 9    | HTTP 能力发现与完整线上响应、特殊 frontmatter 字段保留、全部文件校验、未知/越界 URI 和非法参数、空视图与普通资源客户端、二进制附件、真实 stdio 子进程、真实 loopback HTTP socket、legacy Tools/Resources shim |

另外通过：Core 全量回归 **41 个文件、908 项测试**，Core 与 backend TypeScript 构建、验证脚本及 SDK 链路测试的严格类型检查、变更代码的 oxlint 检查（0 warning / 0 error）。

全量回归曾出现既有健康检查测试的时间边界波动：初始化与检查落在同一毫秒，`uptime` 为 0，未满足测试的 `> 0` 断言。完整重跑后 908 项全部通过；本轮没有修改该测试或健康检查逻辑。

HTTP 测试同时覆盖 SDK HTTP 客户端通过 Fetch 调用 `createMcpHandler` 的确定性路径，以及启动独立 Hono/Node 服务后的真实本机 HTTP 连接。stdio 测试通过 SDK `StdioClientTransport` 启动真实子进程，不替换服务端或客户端 SDK。

## 确认的接入细节

### 线上响应与客户端解码结果

Skills 扩展方法需要在服务端自行返回 `resultType: "complete"`、`ttlMs` 与 `cacheScope`。实测 SDK v2 客户端会在校验自定义结果之前移除 wire-only 的 `resultType`，但保留缓存字段。

因此分开提供：

- `ListSkillsResultSchema` / `GetSkillResultSchema`：验证服务端线上响应，必需 `resultType`。
- `ListSkillsPayloadSchema` / `GetSkillPayloadSchema`：供 SDK 客户端 `request()` 使用，省去已被解码层移除的 discriminator。

HTTP 测试检查实际 JSON 响应，stdio 测试检查 transport 收到的实际消息，再检查 SDK 解码结果；没有为了让客户端测试通过而删去服务端必需字段。

### 资源和原始字节

使用 SDK ResourceTemplate 将 Skill 文件接入普通 Resources。UTF-8 文本保留 BOM、换行及内容；二进制/非 UTF-8 内容通过 base64 blob 分发。manifest 的摘要与大小对应客户端还原后的原始字节。

未知或视图外 Skill/File 返回 `-32602`。文件读取只匹配已捕获清单，不把请求 URI 拼成文件系统路径。

### 名称与元数据

官方格式参考实现支持 Unicode 名称和 NFKC 名称比较。本轮兼容这一行为，并保留原 frontmatter；URI 对名称和文件路径分段编码。同名技能通过命名空间与 URI 区分。

实测 Zod 对象解析会丢弃原始 `__proto__` 字段，因此 frontmatter 使用只验证、不重建对象的 Schema。原字段经快照、HTTP 线上响应与 SDK 解码后仍保留；额外校验所有 JSON 值和 metadata 字符串值，避免特殊字段绕过验证或改变对象原型。

## 复现

在仓库根目录，使用满足项目要求的 Node.js 版本（20.19+，本轮使用 24.19.0）：

```bash
pnpm test:skills
```

启动 HTTP 演示端点：

```bash
pnpm exec tsx backend/scripts/skills-validation.ts \
  --directory packages/core/src/skills/__fixtures__/review-code \
  --transport http --port 8182
```

端点为 `http://127.0.0.1:8182/mcp`。需要使用声明相应能力的 modern MCP 客户端；自动测试包含所需请求协商。

启动 stdio 演示服务：

```bash
pnpm exec tsx backend/scripts/skills-validation.ts \
  --directory packages/core/src/skills/__fixtures__/review-code \
  --transport stdio
```

可重复传入 `--directory` 验证多个目录与同名技能。stdout 保留给 MCP 消息。

## 后续接入范围

本轮是可重复运行的协议 PoC，已具备可复用核心模块。Git 获取、持久化快照、正式 Group 配置、发布/回滚管理与 method 级 scope 仍按总体方案的下一阶段落地。

真实宿主的技能审批、激活、缓存与脚本物化能力需针对具体客户端另做验证。本轮 SDK 客户端结果不能代表所有宿主已经支持自动技能加载。

总体方案：[Skills 获取、管理与统一 MCP 分发规划](../superpowers/specs/2026-10-11-skills-hub-design.md)。
