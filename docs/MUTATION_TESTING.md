# 变异测试

项目通过 StrykerJS 10.0.0 和同版本的 Vitest runner 检查测试能否发现业务源码中的错误。
项目使用 Node >=22.20（推荐 Node 24）和 Vitest 4.1.12；Vitest UI 与 V8 覆盖率插件保持同版本。

当前采用 Vitest 4.1 维护线：Stryker 10 在本项目的 Vitest 5 多 project 场景下存在测试名筛选兼容问题。
后续升级主版本前，应先确认变异关联测试确实执行，并能检测已知错误。

`patches/@stryker-mutator__vitest-runner@10.0.0.patch` 修复该 runner 漏报测试文件加载失败、
以及格式化 Vitest 序列化错误时崩溃的问题。无法收集测试的变异记为 `RuntimeError`，
保留错误原因；这类变异不计作已检测，也不误报为存活。原始测试加载失败仍会中止变异作业。
`pnpm test:mutation-runner` 使用真实 Vitest 验证这些行为，常规 CI 和变异 CI 都执行该检查。
升级 runner 时应重新核对补丁和回归结果。

## 本地执行

先使用仓库固定的 pnpm 10.6.4 安装依赖并构建，再运行测试：

```bash
pnpm install --frozen-lockfile
pnpm build:production
pnpm test
pnpm mutation
pnpm mutation:full
```

`mutation` 显式启用增量模式，没有兼容的基线时自动全量执行；`mutation:full` 使用 `--force`
忽略已有结果并重建基线。两种模式都会先运行原始测试，收集测试和覆盖关系。

默认处理全部六个包，也可单独选择一个包：

```bash
MUTATION_PROJECT=protocol pnpm mutation
MUTATION_PROJECT=protocol pnpm mutation:full
```

可选值为 `share`、`protocol`、`core`、`cli`、`backend`、`frontend` 和 `all`（默认）。
配置在根目录 `stryker.config.mjs`、`vitest.mutation.config.ts`，始终从仓库根目录执行命令。

本地逐包运行可以建立与 CI 相同范围的基线；`all` 使用独立基线，不读取各包的增量文件。
大包建议使用 `MUTATION_PROJECT=backend`、`MUTATION_PROJECT=core` 分别执行。
这两个包启用 Vitest `related`，按源码导入关系选择关联测试。
启用前已比较全部测试与关联测试模式的静态覆盖集合、非静态变异覆盖集合，
并用登录 schema 的静态变异验证检测结果一致。普通 `pnpm test` 继续执行完整测试套件。

变异范围覆盖所选包的 `src/**/*.ts`、`src/**/*.tsx` 业务源码，排除声明、测试、fixture、
测试辅助代码和生成产物。Stryker 不对 Vue 单文件组件的 `.vue` 文件注入变异；前端 TS 源码参与变异，
前端现有组件测试仍会执行。

测试复用各包现有 Vitest 配置，包括 setup、别名和环境。独立的协议 E2E projects 使用固定服务端口，
由常规 `pnpm test` 和既有 E2E CI 执行，不加入并行变异测试。常规构建 CI 另执行 `pnpm typecheck`
检查整个工作区的 TypeScript 编译。

## 报告与评分

每个执行范围使用独立目录 `reports/mutation/<包名或 all>/`：

- `mutation.html`：可在浏览器打开的变异报告。
- `mutation.json`：机器可读的完整报告。
- `stryker-incremental.json`：供下次运行复用的增量基线。

报告和 `.stryker-tmp/` 不提交到 Git。初次接入没有设置 `thresholds.break`；作业成功表示测试流程完成，
并不表示所有变异都被检测到。应根据首次完整报告评估 surviving mutants 后再决定评分门槛。
CI 工作流不会自动修改分支保护或 required status checks。

## CI 与共享基线

`.github/workflows/mutation.yml` 对面向 `main` 的 PR、`main` 推送和手动触发执行，
使用 Node 24、仓库固定的 pnpm，以及六个包各自独立的缓存 namespace 和报告路径。
同一 PR 的新提交可取消旧运行，主分支运行不会主动互相取消。

- 首次接入、缓存缺失或不兼容：完整运行当前包的变异范围。
- PR：仅恢复主分支的兼容基线，不保存共享基线。
- 主分支：运行成功后保存新基线，失败不会覆盖基线。
- 手动触发：选中 `full` 可强制重建；只有在 `main` 上成功后才保存共享基线。

缓存键包含包名、系统、Node 版本标识、输入摘要、唯一 run ID 和 attempt。
恢复只匹配同一兼容性前缀，不回退到跨依赖或跨配置缓存。失败时仍尝试上传已有报告。
首次合并前没有主分支基线，PR 可能全量执行；首次成功的主分支作业负责建立全部包的共享基线。

## 缓存输入策略

`.github/scripts/baseline-inputs.mjs` 使用 Node >=22.20 的内置 API 和 Git，不依赖第三方模块。
它从 Git 根目录读取 `.github/mutation-cache-inputs.json`，可预览输入清单：

```bash
node .github/scripts/baseline-inputs.mjs .github/mutation-cache-inputs.json --list
node .github/scripts/baseline-inputs.mjs .github/mutation-cache-inputs.json
```

初次接入采用保守策略：`trackedByStryker: []`，哈希所有 Git 跟踪文件。
源码、测试、setup/helper、fixture、快照、跨包依赖、配置、锁文件乃至文档变化都会使共享缓存失效。
策略和缓存键脚本本身也始终参与摘要；新目录中的文件加入 Git 后自动纳入。
这会减少跨提交复用，但避免把未由当前包跟踪的输入误当作可安全复用的输入。
后续只有核对每个包的 mutate 范围和 runner 跟踪能力后，才应增加排除策略。

本地 Stryker 增量命令本身不执行 CI 输入摘要检查。修改依赖、配置、辅助文件、静态初始化逻辑或运行环境后，
请运行 `mutation:full`；未跟踪或忽略的生成文件、外部服务状态和环境变量不在 Git 摘要中。
CI 使用浮动 Node 24，若运行时变化影响行为，应手动 full 或更换缓存版本标识。

## 验证范围

可以用已有测试覆盖的小文件执行三次冒烟，使用独立临时基线，避免将局部结果当作完整基线：

```bash
MUTATION_PROJECT=protocol pnpm mutation --mutate packages/protocol/src/inbound/adapter.ts --incrementalFile /tmp/mcp-knot-mutation-smoke.json
MUTATION_PROJECT=protocol pnpm mutation --mutate packages/protocol/src/inbound/adapter.ts --incrementalFile /tmp/mcp-knot-mutation-smoke.json
MUTATION_PROJECT=protocol pnpm mutation:full --mutate packages/protocol/src/inbound/adapter.ts --incrementalFile /tmp/mcp-knot-mutation-smoke.json
```

第二次必须确认日志记录 `result(s) are reused`，第三次确认不复用。单文件冒烟只能验证接入和增量行为，
不能作为全项目变异测试通过的证据，也不会建立 CI 的完整共享基线。

首轮和强制轮还应检查报告中的 `testsCompleted` 与已知变异的检测结果，避免将运行器空执行视为验证成功。

## 接入验证记录

2026-10-21，在 Node 24.19.0、pnpm 10.6.4 下完成：

| 检查                              | 结果                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `pnpm check`、`pnpm check:ci`     | 通过；保留原有 subscriptions E2E 的一条 lint warning                                     |
| `pnpm build`、`pnpm typecheck`    | 通过                                                                                     |
| `pnpm test --coverage`            | 149 个文件、2058 个测试通过                                                              |
| `pnpm test:release`               | 16 个测试通过                                                                            |
| `pnpm test:mutation-runner`       | 7 项检查通过；原版 runner 无法通过同一回归                                               |
| 全范围 Stryker `--dryRunOnly`     | 224 个源码文件、25298 个变异成功插桩；2006 个基础测试通过，未执行变异                    |
| protocol adapter 三次真实变异冒烟 | 首轮检测出 18/18 个变异；再次复用 18/18；强制轮复用 0/18 并重新检测出全部变异            |
| 缓存失效与工作流                  | 临时 Git 检出验证 14 类输入变化（含补丁与运行器回归）；actionlint 验证两个 CI 工作流通过 |

健康检查集成用例改为受控 Date 时钟，准确断言初始化时间、检查时间与 1000ms uptime，
替代依赖真实 1ms 延迟的偶发失败断言。没有修改业务实现。

本地全量运行还修复了三处测试隔离问题：CLI 导入增加“不启动服务”的断言并阻止意外启动；
后端单元测试清理不再导入 E2E 测试服务器；分组路由数量断言只统计 16 个 API 端点，排除宿主中间件。
完整常规测试在这些修改后通过。生产构建、TypeScript 检查和发布测试也已重新通过。

配置生成和 CLI 配置测试的临时目录改用 `mkdtemp`，避免并行 worker 使用同一路径；
两处缓存断言使用受控 Date，避免 LRU 行为取决于真实时钟是否跨过一毫秒。
修改后重跑了 core 的 320 个和 CLI 的 86 个相关变异，并再次通过完整常规测试、类型检查与代码检查。

本地结果不会发布为共享缓存；首次成功的 `main` CI 完整运行负责建立共享基线。

## 测试优化前的首次全量结果（2026-10-21）

以下是首次全量和运行器修正后的历史快照。本次随后调整了业务测试并修复 LRU 容量问题，
最新分数以对应提交的 CI 变异报告为准。

按 CI 的六个包分别使用 `mutation:full` 强制执行，共 25,298 个变异。随后使用补丁版 runner
重跑全部 6,050 个原判存活或报错的变异，复用其余已检出、无覆盖和超时结果。
随后修复测试临时目录和时钟隔离，使用 Stryker 重新执行受影响测试覆盖的变异，并显式复核此前出现不一致的结果。
复核比较了全部变异的源码、位置和替换内容；完整结果无待运行项，也没有已覆盖却执行零测试的存活项。

| 包       | 变异数 | Killed | Survived | NoCoverage | Timeout | RuntimeError |   得分 |
| -------- | -----: | -----: | -------: | ---------: | ------: | -----------: | -----: |
| share    |  1,026 |    205 |      334 |        481 |       0 |            6 | 20.10% |
| protocol |    153 |    132 |       17 |          4 |       0 |            0 | 86.27% |
| core     |  8,818 |  4,672 |    2,674 |      1,458 |       9 |            5 | 53.11% |
| cli      |  1,398 |    689 |      259 |        449 |       0 |            1 | 49.32% |
| backend  | 12,291 |  3,177 |    2,662 |      6,435 |      16 |            1 | 25.98% |
| frontend |  1,612 |    163 |       95 |      1,354 |       0 |            0 | 10.11% |
| 合计     | 25,298 |  9,038 |    6,041 |     10,181 |      25 |           13 | 35.84% |

得分沿用 Stryker 规则：`(Killed + Timeout) / (Killed + Timeout + Survived + NoCoverage)`。
`RuntimeError` 不计分；应结合 JSON 报告中的错误原因复核，不能将其计为测试已检测。
本轮无业务实现改动，没有排除业务分支、忽略静态变异或调整评分门槛。

已复现的业务问题：`packages/core/src/api-to-mcp/services/cache-manager.ts` 的 LRU 驱逐只选择
时间戳严格小于当前时间的条目。同一毫秒写入时可能找不到候选项，导致缓存超过容量上限。
`maxSize=1`、固定 Date、连续写入两个键的实际结果为 `currentSize=2`，两个键都仍可读取。
复现脚本和结果保存在 `reports/mutation/cache-capacity-repro.mts`、`cache-capacity-repro.json`；
当时可从仓库根目录执行 `pnpm exec tsx reports/mutation/cache-capacity-repro.mts` 复现。
后续修复已纳入缓存回归测试，包含同毫秒写入和空字符串键两个边界。

优先补测的缺口：

- 前端 `stores/tool.ts` 和 `services/sse.ts` 的变异全部未覆盖；dashboard store 也有大量未覆盖逻辑。
- 后端 `api/tools-admin/index.ts`、`api/servers/index.ts` 和 `api/groups/group-service.ts` 未覆盖变异较多。
  一些已有测试自建 Hono 路由或重复定义 schema，没有验证对应的真实业务模块。
- `frontend/src/stores/auth.ts:17` 的登录状态判断从 `&&` 变为 `||` 仍能通过测试，缺少只有 token 或只有 user 的状态用例。
- 共享配置的引用校验、日志行为和 skills ID 的正则边界，以及 core 的模板生成和安全日志，需要加强错误分支和输出断言。

存活变异需逐项判断；日志文案、无影响的默认值等可能包含等价变异，不能将存活数量直接当作业务缺陷数量。

各包的 `mutation.html`、`mutation.json` 和 `stryker-incremental.json` 已写入对应报告目录。
汇总和验证记录位于 `reports/mutation/local-full-run-summary.json`、`reports/mutation/local-full-validation.json`。
原始报告保留在 `reports/mutation/before-runner-fix/`，复核日志为各包的 `runner-revalidation.log`。
首次全量已在本地生成六份完整基线；报告和基线未提交，也未写入 CI 的共享缓存。

## 测试清理与回归

| 调整                                            | 原因与结果                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| 删除配置 API 的自建假路由测试，改测 `configApi` | 验证真实请求校验、配置委派、操作者、分页和错误响应                            |
| 删除后端测试内复制的服务器 schema               | 在共享 schema 的测试中验证 stdio/SSE/streaming，消除与生产默认值不一致的副本  |
| 合并重复的分组路由存在性检查                    | 保留一个完整的路由兼容性契约，增加真实 HTTP 响应、降级健康状态和业务错误测试  |
| 调整缓存容量与访问顺序测试                      | 使用较小容量和受控时钟真正触发淘汰，并验证更新已有键不会误删其他条目          |
| 修复 LRU 同毫秒淘汰、空键及并发容量问题         | 回归在旧实现上失败；淘汰和写入同步完成，并发写入也必须遵守 `maxSize`          |
| 替换重复的缓存清空测试                          | 验证 `destroy()` 后不再触发定期清理，并在测试后释放缓存定时器                 |
| 补齐登录状态与持久化异常边界                    | 单独有 token 或 user 时仍未登录；损坏存储和登录失败不会留下错误会话或加载状态 |
| 加强 skills source ID 校验                      | 验证正则首尾边界、字符约束和 64 字符上限                                      |

常规 CI 在 Node 22 和 24 执行回归，构建作业执行 TypeScript 检查；变异 CI 按六个包执行，
PR 不保存共享基线。首次成功的 `main` 作业仍负责建立共享缓存。

本次优化后，本地 Node 24 验证通过：148 个文件、2,081 个常规测试（含覆盖率）、16 个发布测试、
7 项运行器回归，以及生产构建、TypeScript、lint、格式和 actionlint 检查。
