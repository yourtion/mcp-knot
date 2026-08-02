/**
 * P5 MRTR e2e：上游测试 MCP server，提供 `confirm_action` 工具。
 *
 * 被 hub 作为 stdio 子进程拉起（见 mrtr.test.ts 的配置注入）。
 *
 * 设计（对齐 SDK MRTR 作者模式 + spec 主线二图示）：
 *   - `confirm_action`：首次调用返回 `input_required`，带
 *     - `inputRequests.confirm` = `inputRequired.elicit({ message, requestedSchema })`
 *       （客户端据此向用户呈现确认 UI）
 *     - `requestState` = 本上游 mint 的上游级 state（HMAC，关联重试轮次）
 *       重试时（`ctx.mcpReq.inputResponses.confirm` 已接受）读出 `confirm`，
 *       返回最终文本结果。
 *
 *   - 上游用 `createRequestStateCodec` 自管 requestState（关联首次与重试），
 *     匹配 Hub MrtrRelayService 的「上游有自己 state」假设（Hub 把它映射进 HubState）。
 *
 *   - 额外注册一个 `static_tool`，保证连接后 tools/list 非空（与 dynamic-upstream 一致，
 *     避免某些路径把空工具集视为未连上）。
 *
 * 上游不配 `requestState.verify`：上游只在重试时通过 inputResponses 判定，不依赖
 * 解码 state（state 仅作为 opaque 句柄回传给 Hub）。这是合法的——上游对 state 的
 * 用法是"会话关联"，Hub 才是真正做 HMAC verify 的那一层。
 *
 * ── 关键：用 serveStdio 而非裸 McpServer.connect(StdioServerTransport) ────────────
 * MRTR（input_required）是 2026-07-28 wire 词汇：服务端只有 `_servedModernEra()` 为真
 * （即 `_negotiatedProtocolVersion` 为 modern）时，才会把 `resultType: 'input_required'`
 * 直接写回 wire；否则（2025-era 连接）SDK 跑 LegacyInputRequiredShim——它不发 input_required，
 * 而是向客户端发真正的 `elicitation/create` JSON-RPC 请求、就地驱动多轮，这要求客户端声明
 * elicitation 能力并提供 handler。Hub 的上游客户端（capabilities: {}）无法满足，shim 失败。
 *
 * 裸 `new McpServer(...).connect(new StdioServerTransport())` 只做 legacy `initialize` 握手，
 * **不响应 `server/discover`、从不 setNegotiatedProtocolVersion 到 modern**——故任何裸连的上游
 * 对 MRTR 都是 2025-era，触发 shim 失败。
 *
 * `serveStdio(factory, { legacy: 'reject' })`（来自 @modelcontextprotocol/server/stdio）才是
 * modern stdio serving 入口：它处理 `server/discover` probe、按连接 era pin 一份 factory 实例，
 * modern 连接上 `_servedModernEra()` 为真、input_required 正确回 wire。legacy: 'reject' 让 Hub 的
 * auto 协商只能落在 modern（与 Hub 入站 legacy: 'reject' 对称），避免误入 shim。
 */
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  McpServer,
  type McpRequestContext,
} from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod/v4';

// 上游级 requestState codec（32 字节 key；本上游是单进程，无需多实例共享）
const upstreamCodec = createRequestStateCodec<{ round: number }>({
  key: 'mrtr-upstream-e2e-key-0123456789abcdef',
  ttlSeconds: 600,
});

/**
 * 构造一份上游 McpServer（注册 static_tool + confirm_action）。
 * serveStdio 会按连接 era 调用本 factory：modern 连接 pin 一份；legacy 连接（被
 * `legacy: 'reject'` 拒绝）不构造。同一份注册逻辑对两个 era 一致。
 */
function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'mrtr-upstream', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  // 静态工具：保证 tools/list 非空
  server.registerTool(
    'static_tool',
    { inputSchema: z.object({}), description: 'MRTR 上游静态测试工具' },
    async () => ({
      content: [{ type: 'text' as const, text: 'mrtr-upstream static_tool ok' }],
    }),
  );

  // confirm_action：首次 input_required，重试返回结果
  server.registerTool(
    'confirm_action',
    {
      inputSchema: z.object({ action: z.string().default('deploy') }),
      description: '需用户确认的动作；首次返回 input_required，确认后返回结果',
    },
    async (args, extra) => {
      const action = (args?.action as string | undefined) ?? 'deploy';
      const ctx = extra as { mcpReq?: { inputResponses?: unknown; requestState?: () => unknown } };

      // 重试路径：客户端已带回 inputResponses（经 Hub 中转透传）
      const confirmView = acceptedContent<{ confirm: boolean }>(
        ctx?.mcpReq?.inputResponses,
        'confirm',
      );
      if (confirmView === undefined) {
        // 首次调用：mint 上游 state（关联重试），返回 input_required + elicit 请求
        const requestState = await upstreamCodec.mint({ round: 1 });
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: `确认执行 ${action}？`,
              requestedSchema: {
                type: 'object',
                properties: { confirm: { type: 'boolean' } },
                required: ['confirm'],
              },
            }),
          },
          requestState,
        });
      }

      // 重试路径：已拿到用户确认
      if (confirmView.confirm === true) {
        return {
          content: [{ type: 'text' as const, text: `${action} 已确认并执行成功` }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: `${action} 被用户拒绝` }],
        isError: true,
      };
    },
  );

  return server;
}

// modern stdio serving：处理 server/discover probe + era pin。
// legacy: 'reject' 保证 Hub（versionNegotiation: auto）的 probe 只能落在 modern era。
serveStdio((_ctx: McpRequestContext) => buildServer(), { legacy: 'reject' });
