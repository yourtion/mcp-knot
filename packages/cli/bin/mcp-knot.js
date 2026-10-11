#!/usr/bin/env node

/**
 * MCP Knot CLI 可执行文件入口点
 */

// 标记本次进程应由 cli.ts 启动主入口。cli.ts 会在被 bin 动态导入或直接运行时
// 检查此标记；被测试 import 时（未设置）不会触发 main()，保证可单元测试。
process.env.MCP_KNOT_CLI_RUN = '1';

// 使用 import 运行 ES Module
import('../dist/cli.js');
