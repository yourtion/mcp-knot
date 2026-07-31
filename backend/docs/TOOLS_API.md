# 工具管理API文档

本文档描述了MCP Knot的工具管理API端点，提供了完整的工具查询、执行、测试和监控功能。

## 基础端点

### GET /api/tools

获取所有工具列表

**查询参数:**

- `serverId` (可选): 按服务器ID过滤工具
- `groupId` (可选): 指定组ID，默认为 'default'

**响应示例:**

```json
{
  "success": true,
  "data": {
    "tools": [
      {
        "name": "example-tool",
        "description": "示例工具",
        "serverId": "server-1",
        "inputSchema": { ... }
      }
    ],
    "toolsByServer": {
      "server-1": [ ... ]
    },
    "total": 1,
    "groupId": "default",
    "serverId": null
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### GET /api/tools/server/:serverId

获取指定服务器的工具

**路径参数:**

- `serverId`: 服务器ID

**查询参数:**

- `groupId` (可选): 指定组ID，默认为 'default'

### GET /api/tools/:toolName

获取工具详细信息

**路径参数:**

- `toolName`: 工具名称

**查询参数:**

- `groupId` (可选): 指定组ID，默认为 'default'

## 工具执行

### POST /api/tools/:toolName/execute

执行工具

**路径参数:**

- `toolName`: 工具名称

**请求体:**

```json
{
  "arguments": {
    "param1": "value1",
    "param2": "value2"
  },
  "groupId": "default",
  "serverId": "server-1"
}
```

**响应示例:**

```json
{
  "success": true,
  "data": {
    "executionId": "default-example-tool-1640995200000",
    "toolName": "example-tool",
    "serverId": "server-1",
    "groupId": "default",
    "result": [
      {
        "type": "text",
        "text": "执行结果"
      }
    ],
    "isError": false,
    "executionTime": 150,
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

### POST /api/tools/:toolName/test

测试工具参数（验证但不执行）

**路径参数:**

- `toolName`: 工具名称

**请求体:**

```json
{
  "arguments": {
    "param1": "value1"
  },
  "groupId": "default"
}
```

**响应示例:**

```json
{
  "success": true,
  "data": {
    "toolName": "example-tool",
    "serverId": "server-1",
    "groupId": "default",
    "serverStatus": "connected",
    "isAvailable": true,
    "validation": {
      "isValid": true,
      "errors": [],
      "warnings": []
    },
    "canExecute": true
  }
}
```

## 历史记录和统计

> 以下管理与监控端点挂在 `/api/tools-admin` 路由组下（区别于上方的 `/api/tools` 基础端点）。

### GET /api/tools-admin/history

获取工具执行历史记录

**查询参数:**

- `limit` (可选): 限制返回数量，默认50
- `offset` (可选): 偏移量，默认0
- `toolName` (可选): 按工具名称过滤
- `serverId` (可选): 按服务器ID过滤
- `groupId` (可选): 按组ID过滤

### GET /api/tools-admin/history/:executionId

获取特定执行记录的详细信息

**路径参数:**

- `executionId`: 执行记录ID

### GET /api/tools-admin/stats

获取工具执行统计信息

**查询参数:**

- `groupId` (可选): 按组ID过滤
- `serverId` (可选): 按服务器ID过滤

**响应示例:**

```json
{
  "success": true,
  "data": {
    "overview": {
      "totalExecutions": 100,
      "successfulExecutions": 95,
      "failedExecutions": 5,
      "successRate": 95.0,
      "averageExecutionTime": 200
    },
    "topTools": [
      {
        "toolName": "example-tool",
        "executions": 50,
        "successes": 48,
        "failures": 2,
        "totalTime": 10000,
        "averageTime": 200
      }
    ]
  }
}
```

## 监控和健康检查

### GET /api/tools-admin/monitoring

获取工具状态监控信息

**查询参数:**

- `groupId` (可选): 指定组ID，默认为 'default'

**响应示例:**

```json
{
  "success": true,
  "data": {
    "overview": {
      "totalTools": 10,
      "availableTools": 8,
      "unavailableTools": 2,
      "totalServers": 3,
      "connectedServers": 2,
      "disconnectedServers": 1,
      "availabilityRate": 80.0
    },
    "toolsByServer": {
      "server-1": {
        "serverId": "server-1",
        "serverStatus": "connected",
        "tools": [ ... ]
      }
    }
  }
}
```

### GET /api/tools-admin/health

获取工具健康检查信息

**查询参数:**

- `groupId` (可选): 指定组ID，默认为 'default'

### GET /api/tools-admin/performance

获取工具性能分析信息

**查询参数:**

- `timeRange` (可选): 时间范围，可选值: '1h', '6h', '24h', '7d'，默认 '1h'
- `groupId` (可选): 按组ID过滤
- `serverId` (可选): 按服务器ID过滤

**响应示例:**

```json
{
  "success": true,
  "data": {
    "timeRange": "1h",
    "period": {
      "startTime": "2024-01-01T00:00:00.000Z",
      "endTime": "2024-01-01T01:00:00.000Z"
    },
    "overview": {
      "totalExecutions": 50,
      "successfulExecutions": 48,
      "failedExecutions": 2,
      "successRate": 96.0,
      "averageExecutionTime": 180
    },
    "percentiles": {
      "p50": 150,
      "p95": 300,
      "p99": 500
    },
    "timeSeries": [
      {
        "timestamp": "2024-01-01T00:00:00.000Z",
        "executions": 10,
        "errors": 1,
        "averageTime": 200,
        "errorRate": 10.0
      }
    ]
  }
}
```

### GET /api/tools-admin/errors

获取工具错误日志和调试信息

**查询参数:**

- `limit` (可选): 限制返回数量，默认50
- `offset` (可选): 偏移量，默认0
- `toolName` (可选): 按工具名称过滤
- `serverId` (可选): 按服务器ID过滤
- `groupId` (可选): 按组ID过滤
- `severity` (可选): 错误严重程度过滤

**响应示例:**

```json
{
  "success": true,
  "data": {
    "errors": [
      {
        "executionId": "error-execution-id",
        "toolName": "example-tool",
        "serverId": "server-1",
        "groupId": "default",
        "timestamp": "2024-01-01T00:00:00.000Z",
        "executionTime": 100,
        "arguments": { ... },
        "result": [ ... ]
      }
    ],
    "errorSummary": [
      {
        "errorMessage": "连接超时",
        "count": 5,
        "affectedTools": ["tool1", "tool2"],
        "affectedServers": ["server-1"],
        "lastOccurrence": "2024-01-01T00:00:00.000Z",
        "examples": [ ... ]
      }
    ],
    "pagination": {
      "total": 10,
      "limit": 50,
      "offset": 0,
      "hasMore": false
    }
  }
}
```

## 错误响应

所有API端点在出错时都会返回标准化的错误响应：

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误描述"
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## 常见错误代码

- `TOOL_NOT_FOUND`: 工具未找到
- `SERVER_NOT_FOUND`: 服务器未找到
- `SERVER_UNAVAILABLE`: 服务器不可用
- `TOOL_SERVER_MISMATCH`: 工具与服务器不匹配
- `EXECUTION_NOT_FOUND`: 执行记录未找到
- `VALIDATION_ERROR`: 参数验证错误

## 功能特性

1. **完整的工具管理**: 支持工具查询、执行、测试和监控
2. **参数验证**: 基于工具schema的参数验证
3. **执行历史**: 完整的执行历史记录和统计
4. **实时监控**: 工具状态、性能和健康监控
5. **错误分析**: 详细的错误日志和分析
6. **多维度过滤**: 支持按组、服务器、工具等多维度过滤
7. **性能分析**: 提供执行时间百分位数和时间序列分析
8. **类型安全**: 完整的TypeScript类型定义和验证
