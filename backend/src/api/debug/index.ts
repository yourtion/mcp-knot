import { Hono } from 'hono';

import { getHubService } from '../../services/service-registry.js';
import { errorResponse, successResponse } from '../../utils/api-response.js';
import { logger } from '../../utils/logger.js';

export const debugApi = new Hono();

// GET /api/debug/mcp-messages - Get MCP protocol messages
debugApi.get('/mcp-messages', async (c) => {
  try {
    const service = getHubService();

    // Get query parameters for filtering
    const limit = parseInt(c.req.query('limit') || '50', 10);
    const serverId = c.req.query('serverId');
    const type = (c.req.query('type') as 'request' | 'response' | 'notification') || undefined;

    // Get MCP messages from the service
    const messages = service.getMcpMessages(limit, serverId, type);

    return successResponse(c, { messages });
  } catch (error) {
    logger.error('Failed to get MCP messages', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});

// POST /api/debug/tool-test - Test tool execution
debugApi.post('/tool-test', async (c) => {
  try {
    const service = getHubService();
    const body = await c.req.json();

    const { toolName, serverId, groupId, arguments: args } = body;

    const validationError = !toolName
      ? 'toolName is required'
      : serverId !== undefined && (typeof serverId !== 'string' || !serverId.trim())
        ? 'serverId must be a non-empty string'
        : undefined;
    if (validationError) {
      return c.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: validationError,
          },
          timestamp: new Date().toISOString(),
          requestId: c.get('requestId'),
          path: c.req.path,
        },
        { status: 400 },
      );
    }

    // Execute the tool
    const startTime = Date.now();
    const result = await service.callTool(toolName, args || {}, groupId, serverId);
    const executionTime = Date.now() - startTime;

    return successResponse(c, {
      toolName,
      serverId,
      groupId,
      arguments: args,
      result,
      executionTime,
    });
  } catch (error) {
    logger.error('Failed to test tool', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});

// GET /api/debug/performance-stats - Get performance statistics
debugApi.get('/performance-stats', async (c) => {
  try {
    const service = getHubService();

    // Get performance stats from the service
    const stats = service.getPerformanceStats();

    return successResponse(c, { stats });
  } catch (error) {
    logger.error('Failed to get performance stats', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});

// GET /api/debug/error-analysis - Get error analysis
debugApi.get('/error-analysis', async (c) => {
  try {
    const service = getHubService();

    // Get error messages from the tracked messages
    const allMessages = service.getMcpMessages(1000);
    const errorMessages = allMessages.filter(
      (msg) =>
        msg.type === 'response' &&
        typeof msg.content === 'object' &&
        msg.content !== null &&
        (msg.content as { isError?: boolean }).isError === true,
    );

    // Simple error analysis
    const errorAnalysis = {
      totalErrors: errorMessages.length,
      errorRate: allMessages.length > 0 ? (errorMessages.length / allMessages.length) * 100 : 0,
      mostCommonErrors: errorMessages
        .map((msg) => {
          const content = msg.content as { error?: string };
          return content.error || 'Unknown error';
        })
        .reduce((acc: Record<string, number>, error: string) => {
          acc[error] = (acc[error] || 0) + 1;
          return acc;
        }, {}),
      recentErrors: errorMessages.slice(0, 10),
    };

    return successResponse(c, {
      errors: errorMessages,
      analysis: errorAnalysis,
    });
  } catch (error) {
    logger.error('Failed to analyze errors', error as Error);
    return errorResponse(c, error as Error, 500);
  }
});
