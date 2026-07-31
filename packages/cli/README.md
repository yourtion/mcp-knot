# @mcp-core/mcp-knot-cli

MCP Knot CLI 包 - 提供命令行界面的 MCP 服务聚合器（命令名 `mcp-knot`）。

## 功能特性

- 通过命令行界面聚合多个 MCP 服务
- 支持标准 MCP 协议通信（stdio 传输）
- 支持配置文件的初始化、生成、验证
- 内置多种配置模板与服务器预设

## 安装

```bash
pnpm install @mcp-core/mcp-knot-cli
```

## 使用方法

### 基本使用

```bash
# 使用默认配置文件 (./mcp_server.json)
mcp-knot

# 指定配置文件路径并启用详细日志
mcp-knot -c /path/to/config.json -v

# 初始化默认配置（含 fetch / time / sequential-thinking）
mcp-knot --init

# 验证配置文件
mcp-knot --validate -c config.json
```

### 常用选项

| 选项 | 说明 |
| --- | --- |
| `-h, --help` | 显示帮助信息 |
| `-v, --verbose` | 启用详细日志输出（`-v` 是 verbose） |
| `--version` | 显示版本信息（无短写） |
| `-c, --config <path>` | 指定配置文件路径（默认：`./mcp_server.json`） |
| `--generate-config` | 生成配置文件模板（配合 `--template` 指定类型） |
| `--validate` | 验证配置文件 |
| `--list-templates` | 列出所有配置模板 |
| `--list-presets` | 列出所有服务器预设 |
| `--init` / `--init-all` | 初始化配置文件（`--init-all` 含组配置） |
| `--overwrite` | 覆盖已存在的配置文件 |

完整选项见 `mcp-knot --help`。

### 配置文件格式

顶层结构为 `{"servers": {...}}`，每个 server 项支持 `command` / `args` / `env` 等标准字段。

> transport 固定为 stdio，**没有**顶层 `transport` 字段；日志由 `system.json` 管理，**没有**顶层 `logging` 字段。

```json
{
  "servers": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-fetch"],
      "env": {}
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
      "env": {}
    }
  }
}
```

## 开发

```bash
pnpm build     # 构建
pnpm dev       # 开发模式
pnpm test      # 运行测试
pnpm check     # 代码检查
```

## 架构

CLI 包使用核心包 (`@mcp-core/mcp-knot-core`) 提供的 MCP 服务管理功能，通过 stdio 传输实现 MCP 协议通信。

## 许可证

ISC
