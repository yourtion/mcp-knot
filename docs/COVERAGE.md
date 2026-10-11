# 测试覆盖率监控指南

本文档介绍了 MCP Knot 项目的测试覆盖率监控系统的使用方法和配置。

## 概述

我们的测试覆盖率监控系统包括：

- 自动化覆盖率报告生成
- 覆盖率阈值检查
- CI/CD 集成
- 多包覆盖率聚合

## 覆盖率阈值

### 各包的覆盖率要求

| 包名    | 分支覆盖率 | 函数覆盖率 | 行覆盖率 | 语句覆盖率 |
| ------- | ---------- | ---------- | -------- | ---------- |
| backend | 80%        | 80%        | 80%      | 80%        |
| core    | 85%        | 85%        | 85%      | 85%        |
| cli     | 85%        | 85%        | 85%      | 85%        |

### 阈值说明

- **backend**: 作为 API 层，包含较多的集成代码，设置为 80% 的基础阈值
- **core**: 作为核心逻辑包，要求更高的测试覆盖率，设置为 85%
- **cli**: 作为命令行工具，逻辑相对简单但需要高质量，设置为 85%

## 使用方法

### 运行单个包的覆盖率测试

```bash
# 后端 API 包
pnpm --filter @mcp-core/mcp-knot-api test:coverage

# 核心包
pnpm --filter @mcp-core/mcp-knot-core test:coverage

# CLI 包
pnpm --filter @mcp-core/mcp-knot-cli test:coverage
```

### 运行所有包的覆盖率测试

```bash
# 在根目录运行
pnpm test:coverage
```

### 调试模式测试

当需要查看测试过程中的日志输出时，可以使用调试模式：

```bash
# 运行所有包的调试模式测试
pnpm test:debug

# 运行所有包的调试模式覆盖率测试
pnpm test:coverage:debug

# 运行单个包的调试模式测试
pnpm --filter @mcp-core/mcp-knot-cli test:debug
pnpm --filter @mcp-core/mcp-knot-core test:debug
pnpm --filter @mcp-core/mcp-knot-api test:debug

# 运行单个包的调试模式覆盖率测试
pnpm --filter @mcp-core/mcp-knot-cli test:coverage:debug
```

**调试模式说明**：

- 调试模式会显示所有 console 输出，包括 `console.log`、`console.info`、`console.debug`、`console.warn`、`console.error` 等
- 正常模式下所有这些输出都会被静默，以保持测试输出的清洁（包括预期的错误信息）
- 使用环境变量 `VITEST_DEBUG=true` 或 `DEBUG=true` 启用调试模式

### 生成完整的覆盖率报告

```bash
# 运行测试并生成覆盖率报告
pnpm coverage:full

# 或者分步执行
pnpm test:coverage        # 运行所有包的覆盖率测试
pnpm coverage:merge       # 合并覆盖率报告
pnpm coverage:report      # 显示覆盖率汇总
```

### 查看覆盖率报告

```bash
# 打开 core 包的 HTML 报告（仅 core 包提供此脚本）
pnpm --filter @mcp-core/mcp-knot-core coverage:open

# 其他包可直接打开各自 coverage 目录下的 HTML 报告
```

### CI/CD 测试

```bash
# 运行 CI 测试流程
pnpm ci:test
```

## 报告文件

### 各包的报告文件

每个包会在其 `coverage/` 目录下生成以下文件：

- `index.html` - HTML 格式的详细报告
- `coverage-final.json` - 原始覆盖率数据
- `coverage-summary.json` - 汇总数据
- `lcov.info` - LCOV 格式报告（用于 CI/CD）

### 聚合报告

根目录的 `coverage/` 目录包含：

- `coverage-final.json` - 合并后的覆盖率数据
- `coverage-summary.json` - 项目总体覆盖率汇总

## CI/CD 集成

### GitHub Actions

我们的 CI/CD 流程会自动：

1. 运行所有测试并生成覆盖率报告
2. 检查覆盖率是否达到设定阈值
3. 上传报告到 Codecov
4. 在 PR 中添加覆盖率评论
5. 保存报告作为构建产物

### 覆盖率检查失败

如果覆盖率不达标，CI 构建会失败。你需要：

1. 查看具体哪些文件/函数缺少测试
2. 添加相应的测试用例
3. 重新提交代码

## 配置文件

### vitest.config.ts

每个包都有自己的 vitest 配置文件，包含：

- 覆盖率提供者配置 (v8)
- 报告格式设置
- 排除文件配置
- 阈值设置

### coverage.config.js

项目根目录的覆盖率配置文件，统一管理：

- 各包的阈值设置
- 报告格式配置
- CI/CD 集成设置

## 最佳实践

### 编写测试时

1. **优先测试核心逻辑**: 确保业务逻辑有完整的测试覆盖
2. **测试边界条件**: 包括错误处理、边界值等场景
3. **避免测试实现细节**: 专注于测试行为而非实现

### 提高覆盖率

1. **查看 HTML 报告**: 找出未覆盖的代码行
2. **分析未覆盖原因**: 区分是缺少测试还是死代码
3. **添加针对性测试**: 为未覆盖的分支添加测试用例

### 维护覆盖率

1. **定期检查**: 在开发过程中定期运行覆盖率检查
2. **代码审查**: 在 PR 中关注覆盖率变化
3. **持续改进**: 逐步提高覆盖率阈值

## 故障排除

### 常见问题

1. **覆盖率文件不存在**

   ```bash
   # 确保先运行测试
   pnpm test:coverage
   ```

2. **阈值检查失败**

   ```bash
   # 查看详细的覆盖率报告
   pnpm coverage:report
   ```

3. **合并报告失败**
   ```bash
   # 确保所有包都生成了覆盖率报告
   pnpm --filter "@mcp-core/*" test:coverage
   ```

### 调试技巧

1. 使用 `--verbose` 选项查看详细输出
2. 检查 `coverage/` 目录中的文件是否正确生成
3. 查看 CI 日志中的覆盖率输出

## 测试调试

如果在测试过程中需要查看详细的日志输出，请参考 [测试调试模式使用指南](./TEST_DEBUG.md)。

## 相关命令参考

```bash
# 测试相关
pnpm test                    # 运行所有测试
pnpm test:coverage          # 运行测试并生成覆盖率
pnpm coverage:report        # 检查覆盖率阈值
pnpm coverage:merge         # 合并覆盖率报告
pnpm coverage:full          # 完整覆盖率流程（test:coverage + merge + report）
pnpm ci:test               # CI 测试流程

# 开发相关
pnpm dev:api               # 启动后端开发服务器
pnpm dev:fe                # 启动前端开发服务器
pnpm build                 # 构建所有包
pnpm check                 # 代码检查和格式化
```
