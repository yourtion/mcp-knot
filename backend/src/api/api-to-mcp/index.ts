/**
 * API到MCP配置管理API端点
 * 提供API配置的CRUD操作和测试功能
 */

import { Hono } from 'hono';

import { errorResponse, successResponse } from '../../utils/api-response.js';
import { logger } from '../../utils/logger.js';

import type { ApiToMcpWebService } from '../../services/api-to-mcp-web-service.js';
import type {
  ApiToolConfig,
  CreateApiConfigRequest,
  TestApiConfigRequest,
  TestApiConfigResponse,
} from '../../types/web-api.js';

// 扩展Hono的Context类型以包含API到MCP服务
declare module 'hono' {
  interface ContextVariableMap {
    apiToMcpWebService: ApiToMcpWebService;
  }
}

/**
 * 重新加载Hub服务的API工具配置
 * 确保McpKnotService中的工具列表与ApiToMcpWebService同步
 */
async function reloadHubApiTools(): Promise<void> {
  try {
    const { getHubServiceSafe } = await import('../../services/service-registry.js');
    const hubService = getHubServiceSafe();
    if (!hubService) {
      logger.debug('Hub服务尚未初始化，跳过API工具同步');
      return;
    }
    await hubService.reloadApiToolConfig();
    logger.info('Hub服务API工具配置同步完成');
  } catch (error) {
    logger.warn('Hub服务API工具配置同步失败，不影响配置管理操作', {
      error: (error as Error).message,
    });
  }
}

// 创建API路由
const apiToMcpRoutes = new Hono();

// 服务可用性检查中间件
apiToMcpRoutes.use('*', async (c, next) => {
  const service = c.get('apiToMcpWebService');
  if (!service) {
    return c.json(
      {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'API到MCP服务不可用',
        },
        requestId: c.get('requestId'),
      },
      503,
    );
  }
  await next();
});

/**
 * 获取API配置列表
 * GET /api/api-to-mcp/configs
 */
apiToMcpRoutes.get('/configs', async (c) => {
  try {
    logger.info('获取API配置列表');

    // 获取API到MCP Web服务实例
    const apiToMcpService = c.get('apiToMcpWebService') as ApiToMcpWebService;

    // 获取API配置列表
    const configs = await apiToMcpService.getConfigs();

    return successResponse(c, configs);
  } catch (error) {
    logger.error('获取API配置列表失败', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});

/**
 * 创建新的API配置
 * POST /api/api-to-mcp/configs
 */
apiToMcpRoutes.post('/configs', async (c) => {
  try {
    const body = (await c.req.json()) as CreateApiConfigRequest;

    logger.info('创建新的API配置', { context: { config: body.config } });

    // 获取API到MCP Web服务实例
    const apiToMcpService = c.get('apiToMcpWebService') as ApiToMcpWebService;

    // 创建配置
    const result = await apiToMcpService.createConfig(body.config);

    if (!result.success) {
      const response = {
        success: false,
        error: {
          code: 'CREATE_API_CONFIG_FAILED',
          message: result.message,
        },
        requestId: c.get('requestId'),
      };

      return c.json(response, 400);
    }

    logger.info('API配置创建成功', { context: { configId: body.config.id } });

    // 同步Hub服务的API工具配置
    await reloadHubApiTools();

    return successResponse(
      c,
      {
        id: body.config.id,
        message: result.message,
        config: result.config,
      },
      201,
    );
  } catch (error) {
    logger.error('创建API配置失败', error as Error);

    // Check if it's a JSON parsing error
    if (error instanceof SyntaxError && (error as Error).message?.includes('JSON')) {
      const response = {
        success: false,
        error: {
          code: 'INVALID_JSON',
          message: '请求体包含无效的JSON格式',
        },
        requestId: c.get('requestId'),
      };

      return c.json(response, 400);
    }

    return errorResponse(c, error as Error, 500);
  }
});

/**
 * 更新API配置
 * PUT /api/api-to-mcp/configs/:id
 */
apiToMcpRoutes.put('/configs/:id', async (c) => {
  try {
    const configId = c.req.param('id');
    const body = (await c.req.json()) as { config: ApiToolConfig };

    logger.info('更新API配置', { context: { configId, config: body.config } });

    // 验证配置数据
    if (!body.config || !body.config.name) {
      const response = {
        success: false,
        error: {
          code: 'INVALID_CONFIG',
          message: '配置数据无效：缺少必要字段',
        },
        requestId: c.get('requestId'),
      };

      return c.json(response, 400);
    }

    // 验证配置ID匹配
    if (body.config.id !== configId) {
      const response = {
        success: false,
        error: {
          code: 'UPDATE_API_CONFIG_FAILED',
          message: '配置ID不匹配',
        },
        requestId: c.get('requestId'),
      };

      return c.json(response, 400);
    }

    // 获取API到MCP Web服务实例
    const apiToMcpService = c.get('apiToMcpWebService') as ApiToMcpWebService;

    // 更新配置
    const result = await apiToMcpService.updateConfig(configId, body.config);

    if (!result.success) {
      const response = {
        success: false,
        error: {
          code: 'UPDATE_API_CONFIG_FAILED',
          message: result.message,
        },
        requestId: c.get('requestId'),
      };

      return c.json(response, 400);
    }

    logger.info('API配置更新成功', { context: { configId } });

    // 同步Hub服务的API工具配置
    await reloadHubApiTools();

    return successResponse(c, {
      id: configId,
      message: result.message,
      config: result.config,
    });
  } catch (error) {
    logger.error('更新API配置失败', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});

/**
 * 删除API配置
 * DELETE /api/api-to-mcp/configs/:id
 */
apiToMcpRoutes.delete('/configs/:id', async (c) => {
  try {
    const configId = c.req.param('id');

    logger.info('删除API配置', { context: { configId } });

    // 获取API到MCP Web服务实例
    const apiToMcpService = c.get('apiToMcpWebService') as ApiToMcpWebService;

    // 删除配置
    const result = await apiToMcpService.deleteConfig(configId);

    if (!result.success) {
      const response = {
        success: false,
        error: {
          code: 'DELETE_API_CONFIG_FAILED',
          message: result.message,
        },
        requestId: c.get('requestId'),
      };

      return c.json(response, 400);
    }

    logger.info('API配置删除成功', { context: { configId } });

    // 同步Hub服务的API工具配置
    await reloadHubApiTools();

    return successResponse(c, {
      id: configId,
      message: result.message,
    });
  } catch (error) {
    logger.error('删除API配置失败', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});

/**
 * 测试API配置
 * POST /api/api-to-mcp/configs/:id/test
 */
apiToMcpRoutes.post('/configs/:id/test', async (c) => {
  try {
    const configId = c.req.param('id');
    const body = (await c.req.json()) as TestApiConfigRequest;

    logger.info('测试API配置', {
      context: { configId, parameters: body.parameters },
    });

    // 获取API到MCP Web服务实例
    const apiToMcpService = c.get('apiToMcpWebService') as ApiToMcpWebService;

    // 执行API配置测试
    const testResponse = await apiToMcpService.testConfig(configId, body.parameters);

    return c.json(testResponse);
  } catch (error) {
    logger.error('测试API配置失败', error as Error);

    const response: TestApiConfigResponse = {
      success: false,
      error: 'Test failed',
      executionTime: 0,
    };

    return c.json(response, 200);
  }
});

/**
 * 获取API配置统计（必须在动态配置ID路由之前注册）
 * GET /api/api-to-mcp/configs/stats
 */
apiToMcpRoutes.get('/configs/stats', async (c) => {
  try {
    const service = c.get('apiToMcpWebService') as ApiToMcpWebService;
    const { configs } = await service.getConfigs();
    return successResponse(c, {
      totalConfigs: configs.length,
      activeConfigs: configs.filter((config) => config.status === 'active').length,
      totalTools: configs.reduce((total, config) => total + config.toolsGenerated, 0),
      lastUpdated: configs.reduce(
        (latest, config) => (config.lastUpdated > latest ? config.lastUpdated : latest),
        '',
      ),
    });
  } catch (error) {
    return errorResponse(c, error as Error, 500);
  }
});

apiToMcpRoutes.get('/configs/:id', async (c) => {
  try {
    const configId = c.req.param('id');

    logger.info('获取API配置详情', { context: { configId } });

    // 获取API到MCP Web服务实例
    const apiToMcpService = c.get('apiToMcpWebService') as ApiToMcpWebService;

    // 获取API配置详情
    const config = await apiToMcpService.getConfigDetails(configId);

    if (!config) {
      const response = {
        success: false,
        error: {
          code: 'API_CONFIG_NOT_FOUND',
          message: `API配置 ${configId} 不存在`,
        },
        requestId: c.get('requestId'),
      };

      return c.json(response, 404);
    }

    return successResponse(c, config);
  } catch (error) {
    logger.error('获取API配置详情失败', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});

export { apiToMcpRoutes };
