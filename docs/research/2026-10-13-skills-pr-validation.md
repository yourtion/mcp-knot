# Skills 首轮交付与提交前验证

- 日期：2026-10-13
- 分支：`codex/skills-protocol-validation`
- 同步主干：`origin/main`，`152adaf`（v0.1.1 发布和 Docker 部署迭代），合并无文本冲突
- 操作指南：[Skills 使用指南](../SKILLS.md)

## 本轮交付

完成本地/公共 HTTPS Git/skills CLI 来源登记与获取更新、原始字节持久化快照、Group 固定版本选择和回滚、标准 Skills MCP 扩展分发，以及独立的公开 skills.sh 市场搜索管理 API。默认 Group 不公开新导入技能；来源更新生成候选，已发布版本保持不变。

Hub 仅分发原子 Skill 和支持文件。技能引用其他技能时，由模型判断、宿主按权限加载；不自动递归导入、组合正文或执行脚本。市场 API 不需要 Vercel 凭据，正式 v1/OIDC 接入不在本轮范围。

总体方案中的 Web 管理、后台任务、定时同步、私有凭据、技能专用 scope、Bundle/Composite、GC 和独立 publication 记录仍是后续规划。生产 CLI/stdin Skills 接入也未实现；stdio 脚本用于协议验证。纯 Skills Group 已支持，全局 MCP 配置仍要求至少一个 upstream。

## Standards

依据 `CLAUDE.md` 与 `docs/DEVELOPMENT.md` 审查。发现 1 项标准问题：新测试手动串行清理资源，单个失败会跳过后续清理。已统一使用 `useTestContext()` 独立注册客户端、transport、子进程、临时目录和配置恢复，清理按 LIFO 执行，单个失败不阻止其他资源清理。

## Spec

依据总体方案、分轮验证报告及用户明确的范围决定审查，发现并修复 2 项问题：

1. **失败同步保留有效候选**：复用的持久化旧 revision 可能损坏；先完整加载并验证 revision，再替换 latest 指针。回归覆盖 A → B → 损坏 A → 来源恢复 A，失败后 B 仍可通过磁盘恢复和发布读取。
2. **批量配置重建技能视图**：Group 批量更新和备份恢复在写入前验证引用、成功写入后清除 handler/service 缓存。回归通过真实 SDK 验证版本切换、旧 URI 拒绝、备份回滚和无效引用不提前覆盖配置。其他配置类型保持既有行为。

Standards 1 项、Spec 2 项，均已修复，未保留阻塞项。

## 验证

环境为 Node.js 24.19.0、pnpm 10.6.4、MCP SDK 2.0.0。

| 检查                                                | 结果                                                                   |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                    | 通过，合并锁文件可复现                                                 |
| `pnpm build:production`                             | Share、Protocol、Core、backend、CLI、frontend 全部通过                 |
| `pnpm test`                                         | 149 个测试文件、2,057 项全部通过，含各 E2E/OAuth/CLI/前端 project      |
| `pnpm test:skills`                                  | 9 个测试文件、75 项全部通过                                            |
| `node --test scripts/release.test.cjs`              | 最新 main 的发布流程 16 项通过                                         |
| `CONFORMANCE_SKIP_BUILD=1 pnpm test:conformance`    | 基线门禁通过：5 个场景通过，25 个预期失败；无新增失败或 stale 基线条目 |
| 验证脚本及新增 backend 集成测试严格 TypeScript 检查 | 通过                                                                   |
| `pnpm check:ci`                                     | 通过；既有 subscriptions 测试保留 1 条非阻塞 lint 警告                 |

公开仓库真实 Git/CLI add/update 与市场搜索的执行证据沿用[来源报告](2026-10-12-skills-source-validation.md)和[市场报告](2026-10-12-skills-market-validation.md)。自动测试验证服务行为，不代表特定宿主已支持远端技能激活。

backend Docker 生产阶段补上 Git 运行依赖。当前本地 Docker daemon 未运行，未执行镜像构建与容器启动验证；交由仓库已有 Docker CI 检查。

快照和 CLI 工作目录在 `CONFIG_PATH/.skills/`，部署需持久挂载、可写权限及包含该目录的备份。配置备份 API 本身不打包技能文件；异常退出后的写锁恢复和自动 GC 仍需后续完善。
