# OIDC 自动发布

公开发布四个包：`@mcp-core/mcp-knot-share`、`@mcp-core/mcp-knot-protocol`、
`@mcp-core/mcp-knot-core`、`@mcp-core/mcp-knot-cli`。根目录、API、Web 不发布到 npm。

## 发布链路

1. 功能 PR 附带 changeset，合入 main。
2. CI 检查格式、Node 20/22/24 测试、生产构建、所有协议 E2E、conformance 基线及 Docker 构建。
3. `publish.yml` 只接受 main push 的成功 CI；确认 CI 的 SHA 仍是当前 main，跳过旧提交。
4. 有 changeset 时创建/更新 `chore: version packages` PR。使用 GitHub 默认 token 创建的 PR，可能需要在合并框点击 **Approve workflows to run** 才能开始 CI。
5. 版本 PR 合入后，main CI 成功；先构建公开包，使用 pnpm pack 转换 workspace 依赖，再由 npm 11 使用 OIDC 发布 tarball。
6. 已发布版本自动跳过；成功发布的包生成 Git 标签与 GitHub Release。失败不会继续发布后面的包。

CI 的 pnpm 固定使用 package.json 中的 10.6.4；该版本的发布认证不用于 OIDC，实际发包使用 npm 11。

## npm 一次性设置（维护者操作）

先确认拥有 npm `@mcp-core` scope 的包创建和维护权限。npm 的 Trusted Publisher 在**已创建包的 Settings** 中配置；公开 registry 当前查不到上述 CLI/protocol 包，首次创建需要交互式登录发布一次。

```bash
# 使用 Node 24/npm 11；只需首次建包时交互式登录
npm login
pnpm release:dry-run
# dry-run 只检查构建和 tarball，不会发布任何版本

# 依赖顺序：share → protocol → core → cli
# 在各 packages/<name> 目录执行：
pnpm pack --pack-destination /tmp/mcp-knot-bootstrap
# 然后在仓库根目录将刚生成的对应 .tgz 发到 npm：
npm publish /tmp/mcp-knot-bootstrap/<对应包名和版本>.tgz --access public --registry=https://registry.npmjs.org/
```

首次创建使用当前 0.0.1；自动版本 PR 会发布 changeset 提升后的版本。不要手动消费本分支的 changeset 来初始化包。

逐包在 npm → Package → Settings → Trusted publishing 添加 GitHub Actions：

| 字段                 | 值                                 |
| -------------------- | ---------------------------------- |
| Organization or user | `yourtion`                         |
| Repository           | `mcp-knot`                         |
| Workflow filename    | `publish.yml`                      |
| Environment          | 留空（工作流没有声明 environment） |
| Allowed actions      | 允许 `npm publish`                 |

仅允许 `npm stage publish` 无法运行本仓库的直接发布流程。CI 已设置 `id-token: write`，不需要添加 npm Secret。包的 `repository.url` 已对齐 GitHub 仓库。

设置来源：[npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)。OIDC 要求 npm ≥11.5.1、Node ≥22.14；新绑定需在两天内完成首次成功发布，超时需重新创建绑定。

仓库已允许 GitHub Actions 创建 PR。如果该设置被关闭，在 Settings → Actions → General 打开 **Allow GitHub Actions to create and approve pull requests**。

## 重试和本地验证

```bash
pnpm check:ci
pnpm test
pnpm build:production
pnpm release:dry-run
pnpm changeset:check
```

`pnpm release:dry-run` 检查四个 tarball 的 JS/类型/bin 入口、测试文件泄漏及 workspace 依赖转换，不会访问发布接口。

发布认证失败时，检查包的 Trusted Publisher 字段与 `npm publish` 权限，再重跑对应 main push 的 CI（需要整个 CI run 成功以触发 workflow_run）。如果 main 已更新，应验证新 main；旧 CI 的发布请求会被跳过。无需创建另一版本来重试未发布的版本。

OIDC `npm whoami` 不能验证发布权限；最终认证只能在 GitHub runner 的实际发布中确认。

## Docker（可选）

默认只验证镜像构建。若要发布 Docker Hub 镜像，设置仓库变量 `DOCKER_PUBLISH=true`，以及 Secret `DOCKER_USERNAME`、`DOCKER_PASSWORD`。发布成功后推送 `<username>/mcp-knot-api` 和 `<username>/mcp-knot-web`，使用 `latest` 与 CI 提交 SHA 标签。

## 已知协议限制

backend 已接通 `compatibility.outbound.modernOnly` 和 `outbound.enabled`，拒绝 legacy 上游；CLI 核心服务仍使用模拟上游，CLI 的 modern-only flag 明确标为预留。

legacy MRTR shim 尚未实现（返回 -32601）；官方 TCK 0.1.16 尚无现代 era server 场景。现有 SDK 原生错误和上游错误没有全部经过统一 normalizer，但动态工具异常已标记 `isError: true`，避免报成成功。完整限制见协议设计文档和 README。
