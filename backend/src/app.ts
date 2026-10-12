import { Hono } from 'hono';

import { apiToMcpRoutes } from './api/api-to-mcp/index.js';
import { createAuthApi } from './api/auth/index.js';
import { configApi } from './api/config/index.js';
import { dashboardApi } from './api/dashboard/index.js';
import { debugApi } from './api/debug/index.js';
import { groupsApi } from './api/groups/index.js';
import { hubApi } from './api/hub.js';
import { groupMcpRouter } from './api/mcp/group-router.js';
import { oauthApi, registerWellKnownRoutes } from './api/oauth/index.js';
import { performanceApi } from './api/performance/index.js';
import { serversApi } from './api/servers/index.js';
import { skillsApi } from './api/skills/index.js';
import { toolsAdminApi } from './api/tools-admin/index.js';
import { toolsApi } from './api/tools/index.js';
import { createAuthMiddleware } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { secureHeadersMiddleware } from './middleware/security.js';
import { ApiToMcpWebService } from './services/api-to-mcp-web-service.js';
import { AuthService } from './services/auth.js';
import { logger } from './utils/logger.js';
import { createPerformanceMiddleware } from './utils/performance-monitor.js';

// 创建认证服务实例
const authService = new AuthService();

// 创建 API 到 MCP Web 服务实例
const apiToMcpWebService = new ApiToMcpWebService();

export const app = new Hono();

// 安全头中间件（在所有路由之前）
app.use('*', secureHeadersMiddleware());

// Request ID 中间件（在安全头之后）
app.use('*', requestIdMiddleware);

// 性能监控中间件（在所有路由之前）
app.use('*', createPerformanceMiddleware());

// 认证服务初始化（服务在 index.ts 启动时已初始化，此处仅确保就绪）
app.use('*', async (_c, next) => {
  try {
    await authService.initialize();
  } catch (error) {
    logger.warn('认证服务初始化失败，某些功能可能不可用', {
      error: error instanceof Error ? error.message : String(error),
    } as Record<string, unknown>);
  }
  await next();
});

// 注入 API 到 MCP Web 服务到请求上下文（初始化在 index.ts 启动时完成）
app.use('*', async (c, next) => {
  c.set('apiToMcpWebService', apiToMcpWebService);
  await next();
});

// 创建认证中间件
const authMiddleware = createAuthMiddleware(authService);

// 应用认证中间件到受保护的API路由
configApi.use('*', authMiddleware);
serversApi.use('*', authMiddleware);
toolsApi.use('*', authMiddleware);
groupsApi.use('*', authMiddleware);
dashboardApi.use('*', authMiddleware);
apiToMcpRoutes.use('*', authMiddleware);

// 也在app级别应用认证中间件到受保护的API路径（确保生效）
app.use('/api/servers/*', authMiddleware);
app.use('/api/tools/*', authMiddleware);
app.use('/api/groups/*', authMiddleware);
app.use('/api/skills/*', authMiddleware);
app.use('/api/config/*', authMiddleware);
app.use('/api/dashboard/*', authMiddleware);
app.use('/api/api-to-mcp/*', authMiddleware);

// 具体的 API 路由放在通配符路由之前，避免被拦截
app.route('/api', hubApi);
app.route('/api/auth', createAuthApi(authService));
app.route('/api/config', configApi);
app.route('/api/dashboard', dashboardApi);
app.route('/api/debug', debugApi);
app.route('/api/servers', serversApi);
app.route('/api/tools', toolsApi);
app.route('/api/tools-admin', toolsAdminApi);
app.route('/api/groups', groupsApi);
app.route('/api/skills', skillsApi);
app.route('/api/performance', performanceApi);
app.route('/api/api-to-mcp', apiToMcpRoutes);

// OAuth 端点（内置 AS：token / jwks）
app.route('/api/oauth', oauthApi);

// /.well-known 路由（RFC9728 Protected Resource metadata / RFC8414 AS metadata）
// 挂载在根路径：/.well-known/oauth-protected-resource 等
const wellKnownApp = new Hono();
registerWellKnownRoutes(wellKnownApp);
app.route('/', wellKnownApp);

// 通配符路由放在最后
app.route('/', groupMcpRouter); // 组特定MCP路由

// 导出认证服务供其他模块使用
export { authService };

// 导出 api-to-mcp web 服务单例：e2e outbound profile 在 setup 里调
// `apiToMcpWebService.initialize(configPath)` 加载 oauth 工具，再经
// `/api/api-to-mcp/configs/:id/test` 触发出站 OAuth 取 token 全链路。
// app.ts 模块级 new 该单例（line 28），但生产启动（index.ts）不调 initialize——
// index.ts 只 init McpKnotService（其内部另建一个 ApiToolIntegrationService，不经此单例）。
// 故此单例默认未 initialize；e2e 显式 initialize 是激活 /api/api-to-mcp/* 测试路径的唯一方式。
export { apiToMcpWebService };
