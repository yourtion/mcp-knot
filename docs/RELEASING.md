# 统一版本与 tag 发布

四个公开包按依赖顺序发布：`@mcp-core/mcp-knot-share` →
`@mcp-core/mcp-knot-protocol` → `@mcp-core/mcp-knot-core` →
`@mcp-core/mcp-knot-cli`。它们始终使用同一个稳定版本。根目录、API、Web 是私有包，
不参与版本联动；内部依赖保留 `workspace:*`，由 pnpm pack 转换为准确版本。

## 本地入口

先将功能改动合入并同步 `main`，确认常规 CI 成功。在干净工作区执行：

```bash
pnpm install --frozen-lockfile
pnpm run release:prepare patch   # 也可用 minor、major 或明确版本（例如 0.1.0）
# 审核刚生成的 chore: release vX.Y.Z 提交及本地 vX.Y.Z tag
pnpm run release:push
```

`prepare` 只接受 main，拒绝已修改、已暂存或未跟踪文件。检查四包版本一致、
目标为严格递增的 X.Y.Z（不支持预发布或 v 前缀参数），并检查本地和 origin 的重复 tag。
远程不可访问时中止。只修改并提交四个 `packages/*/package.json`，之后生成 annotated tag。
当前 lockfile 的工作区依赖是相对链接，单纯更新这些包的 version 不需要修改 lockfile。
CLI 从自己的 package.json 读取显示版本，无额外手写版本文件。

提交前运行 `release:validate`：完整 lint/format、发布脚本隔离测试、生产构建、
工作区 TypeScript 检查、全量 Vitest 和四包 tarball 检查。验证失败会恢复版本文件，
不会提交或打 tag；若验证意外生成其他文件，保留供检查且拒绝提交。
Git hook/commit/tag 失败时不自动 reset，请检查 `git status`、HEAD 和 tag 后处理；
若只有 tag 创建失败，可审核版本提交后手动创建相应 annotated tag，再运行 push。

`push` 重新检查干净的 main、版本、release 提交信息、父提交、仅版本字段变更、
准确的四文件列表，以及 tag 指向 HEAD。使用原子推送，仅发送 `refs/heads/main` 与
当前版本 tag，不使用 `--tags`，不强推。不支持 atomic push 的远端会拒绝整个操作。
重复 push 相同 refs 是安全的；远端 main 已前进时，应先解决分支分歧，不移动已发布 tag。

日常开发不再提交 changeset 或生成版本 PR。重要面向用户的变更写入
[RELEASE_NOTES.md](RELEASE_NOTES.md)，GitHub Release 使用自动生成的提交说明。
尚未发布的协议兼容层说明已保留在那里；首次采用新流程时由维护者选择版本级别。

## Tag CI

保留 `.github/workflows/publish.yml` 文件名。仅 `v*.*.*` tag push 触发，checkout 对应 tag，
安装依赖前严格核验 tag、四包版本及版本提交，并确认提交属于 origin/main。
随后重新运行完整验证，使用 pnpm 10.6.4 打包，再由 Node 24/npm 11 发布 tarball。
所有包发布成功或确认准确版本已存在后，才创建/完成一个 GitHub Release。
可选 Docker job 依赖此 job 成功，checkout 同一 tag，使用版本 tag 和 latest。

每包先查询 `npm view <name>@<version> version --json`，仅准确版本匹配才跳过。
只有结构化 `E404` 表示缺失（包括首次发布），允许继续调用 npm publish；
认证、超时、网络、服务端错误和异常响应均中止，不伪装成未发布。
某个包失败会停止后续发布。修复原因后重跑同一 tag 的失败工作流即可，已完成包自动跳过；
不要为了部分失败另升版本，也不要移动已经推送的 tag。GitHub API 查询失败同样直接中止。

## npm 认证与首次发布边界

CI 使用 npm Trusted Publishing（OIDC），权限为 `id-token: write`，无需 npm token。
四包各自的 Trusted Publisher 应绑定 `yourtion/mcp-knot`、工作流 **publish.yml**，
Environment 留空，并允许直接 `npm publish`。工作流无自动 PR，不再需要 PR 写权限。
[npm 官方说明](https://docs.npmjs.com/trusted-publishers/)要求支持 OIDC 的 npm/Node 版本；
本工作流使用 Node 24/npm 11。不得把 dry-run 或 npm whoami 当成 OIDC 发包权限证明。

E404 放行只是去掉脚本对首次发包的硬性阻挡，**不会创建权限或绕过认证**。
若包尚不存在、无法配置 Trusted Publisher，维护者需先确认 scope 创建权限，
用自己获准的交互登录完成首次发布，再配置每包绑定。可先执行完整验证，然后在仓库根目录
运行 `node scripts/publish-packages.cjs`，沿用打包检查和依赖顺序；该命令会真实发布，
仅在维护者明确准备好凭据和版本时执行。也可逐包 pnpm pack 后 npm publish 对应 tarball。
不要直接用 npm 打包含 workspace 依赖的源目录。最终 OIDC 授权只能由真实 GitHub runner
发布确认，本地测试不创建或变更凭据、包权限及 Trusted Publisher。

## 首次本地发布与后续 OIDC 的衔接

首次建包可直接发布当前统一的 `0.0.1`，无需先创建发布 tag。在仓库根目录：

```bash
# 使用 Node 24、npm 11；pnpm 版本由 packageManager 固定为 10.6.4
# 已有 corepack 时可执行 corepack pnpm；也可使用本机已安装的 pnpm 10.6.4
git switch main
git pull --ff-only origin main
pnpm install --frozen-lockfile
pnpm run release:validate
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
# 确认当前四包版本及 scope 创建权限后，才执行下面的真实发布命令：
node scripts/publish-packages.cjs
```

此脚本会先打包并验证全部四包，再按 share → protocol → core → cli 顺序发布，
自动传入 `--access public` 和 npm registry。已有准确版本会跳过；npm 不允许覆盖已发布版本。
本地无需项目专用环境变量、GitHub token 或 OIDC 环境变量，认证来自 npm login。
若 npm 要求 2FA，按终端提示授权；必要时可在当次命令前传入
`npm_config_otp=<本次验证码>`，不要把验证码或 token 写入仓库。
`npm whoami` 只能确认登录账户，还需该账户具备 `@mcp-core` scope 的建包/维护权限。

全部包建好后，在 npm 网页逐包进入 Settings → Trusted Publisher，选择 GitHub Actions，
填写 Organization or user=`yourtion`、Repository=`mcp-knot`、Workflow filename=`publish.yml`，
Environment 留空，并允许直接 npm publish。这四条绑定必须由维护者自行设置。
首次本地发布成功前，不要选择仅允许 Trusted Publisher 发包的设置来阻断登录发布。
无需在 GitHub 添加 NPM_TOKEN，也无需为本地脚本伪造 ACTIONS_ID_TOKEN 环境变量。

绑定完成后，下一次版本发布走：

```bash
git switch main
git pull --ff-only origin main
pnpm run release:prepare patch  # 或 minor / major / 明确版本
# 审核版本提交及 tag
pnpm run release:push
```

首次本地发布的 `0.0.1` 用于创建包及建立绑定；随后递增版本的 tag 才触发 OIDC 发布。
不要为了首次建包推送 tag，否则会在绑定完成前启动 CI 发包。

旧名称包若已改名并停止维护，建议在新包可正常安装后标记 deprecated，说明替代包名。
保留已有版本供旧用户安装；普通的旧版本不必逐一废弃。通常不建议 unpublish，
以免破坏依赖方及 lockfile，且 npm 的删除政策另有限制。此流程不会自动废弃或删除任何包。

## 安全的本地检查

```bash
pnpm run test:release       # 临时 Git 仓库与模拟 registry，不触碰真实 refs/npm
pnpm run release:validate  # 全量验证，不提交、不打 tag、不发布
pnpm run release:dry-run   # 构建四包、pnpm pack 并检查解包产物，不发包
```

tarball 检查包含 main/types/bin/全部 exports 的文件存在性、测试文件泄漏、
workspace 协议转换及内部精确版本，再从解包产物导入 JS 入口、运行 CLI --help/--version。
四个内部包只从解包目录解析；外部依赖复用 lockfile 安装结果，不访问发布接口。
这验证了打包与运行入口，不等于在全新机器从 registry 安装后的完整集成测试。

## Docker（可选）

仓库变量 `DOCKER_PUBLISH=true` 才启用 Docker Hub 发布，并需要已有
`DOCKER_USERNAME`、`DOCKER_PASSWORD`。npm/GitHub Release 完成后发布
`<username>/mcp-knot-api` 和 `<username>/mcp-knot-web` 的 `latest` 与 `vX.Y.Z` 标签。
Docker 失败可独立重跑失败 job，不影响已完成的 npm 发布。

## 已知协议限制

backend 已接通 `compatibility.outbound.modernOnly` 和 `outbound.enabled`，拒绝 legacy 上游；
CLI 核心服务仍使用模拟上游，CLI 的 modern-only flag 为预留。
legacy MRTR shim 尚未实现（返回 -32601）；官方 TCK 0.1.16 尚无现代 era server 场景。
完整限制见协议设计文档和 README。
