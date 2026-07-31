# CLI 使用指南

MCP Knot CLI（包名 `@mcp-core/mcp-knot-cli`，命令 `mcp-knot`）是一个独立的命令行 MCP 服务器，可聚合多个 MCP 服务，并通过标准 MCP 协议（stdio 传输）对外提供访问。

## 安装

### 从工作区构建

```bash
cd packages/cli
pnpm build

# 直接运行
node dist/cli.js
```

### 全局安装

```bash
# 从 npm 安装（发布后）
npm install -g @mcp-core/mcp-knot-cli

# 或从本地构建产物安装
cd packages/cli
npm pack
npm install -g mcp-core-mcp-knot-cli-1.0.0.tgz
```

## 命令行选项

```bash
mcp-knot [选项] [配置文件路径]
```

| 选项 | 说明 |
| --- | --- |
| `-h, --help` | 显示帮助信息 |
| `-v, --verbose` | 启用详细日志输出（注意：`-v` 是 verbose，不是 version） |
| `--version` | 显示版本信息（无短写） |
| `-c, --config <path>` | 指定配置文件路径（默认：`./mcp_server.json`） |
| `--generate-config` | 生成配置文件模板（输出到 stdout） |
| `--template <type>` | 指定模板类型：`basic` / `advanced` / `development` / `production` |
| `--validate` | 验证配置文件 |
| `--list-templates` | 列出所有可用的配置模板 |
| `--list-presets` | 列出所有可用的服务器预设 |
| `--init` | 快速初始化配置文件（包含 fetch / time / sequential-thinking） |
| `--init-all` | 初始化所有配置文件（包含组配置） |
| `--overwrite` | 覆盖已存在的配置文件（与 `--init` / `--init-all` / `--generate-config` 配合使用） |

> 说明：CLI **没有** `--debug` / `-d` 或 `--log-level` / `-l` 选项。需要更详细的日志请使用 `-v` / `--verbose`。如果不带任何子命令式选项（如 `--validate`），则进入服务器启动流程。

## 快速上手

### 初始化配置

```bash
# 快速初始化默认配置（包含 fetch / time / sequential-thinking）
mcp-knot --init

# 初始化所有配置文件（包含组配置），并覆盖已存在文件
mcp-knot --init-all --overwrite

# 查看可用的配置模板和服务器预设
mcp-knot --list-templates
mcp-knot --list-presets

# 生成高级模板并保存
mcp-knot --generate-config --template advanced > mcp_server.json
```

### 验证与启动

```bash
# 验证配置文件
mcp-knot --validate -c mcp_server.json

# 使用默认配置（./mcp_server.json）启动
mcp-knot

# 指定配置文件并启用详细日志
mcp-knot -c /path/to/mcp_server.json -v
```

## 配置文件格式

CLI 使用 `mcp_server.json` 配置文件，顶层结构为 `{"servers": {...}}`。每个 server 项支持标准的 `command` / `args` / `env` 等字段。

> 说明：transport 固定为 stdio，**没有**独立的顶层 `transport` 字段；日志配置不在该文件中，由 `system.json` 管理，因此也**没有**顶层 `logging` 字段。

```json
{
  "servers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": {}
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": "your-brave-api-key"
      }
    }
  }
}
```

### 配置文件查找顺序

1. 命令行指定的路径（`-c` / `--config`，或直接位置参数）
2. 当前目录下的 `mcp_server.json`

## MCP 客户端集成

### Claude Desktop

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mcp-knot": {
      "command": "mcp-knot",
      "args": ["--config", "/path/to/your/mcp_server.json"]
    }
  }
}
```

### 直接通过 stdin/stdout 交互

CLI 服务器通过 stdin/stdout 实现标准 MCP 协议，可与任何支持 MCP 的客户端集成：

```bash
# 列出所有工具
echo '{"jsonrpc": "2.0", "id": 1, "method": "tools/list"}' | mcp-knot -c mcp_server.json

# 调用工具
echo '{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": { "path": "/path/to/file.txt" }
  }
}' | mcp-knot -c mcp_server.json
```

## 故障排除

### 配置文件未找到

```text
错误: 配置文件未找到: mcp_server.json
```

解决：确保配置文件存在于当前目录，或使用 `-c` / `--config` 指定正确路径。若尚无配置文件，可使用 `mcp-knot --init` 生成。

### MCP 服务器连接失败

```text
错误: 无法连接到 MCP 服务器 'filesystem'
```

解决：检查该 server 的 `command` 和 `args` 是否正确、所需 npm 包是否已安装、`env` 中的环境变量（如 API Key）是否设置；使用 `-v` 查看更详细的信息。

### 验证配置文件

```bash
# 启动前先验证配置
mcp-knot --validate -c mcp_server.json
```

`--validate` 会输出详细的校验结果，并在配置非法时以非 0 退出码退出。

## 本地开发

```bash
# 克隆仓库后
pnpm install

# 构建 CLI 包
cd packages/cli
pnpm build

# 运行测试
pnpm test
pnpm test:e2e
```

## 参考资料

- [MCP 协议规范](https://modelcontextprotocol.io/docs)
- [MCP SDK 文档](https://github.com/modelcontextprotocol/typescript-sdk)
- [Claude Desktop MCP 配置](https://docs.anthropic.com/claude/docs/mcp)
