/**
 * 模板生成器测试
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { TemplateGeneratorImpl, TemplateType } from './template-generator.js';

describe('TemplateGeneratorImpl', () => {
  let templateGenerator: TemplateGeneratorImpl;

  beforeEach(() => {
    templateGenerator = new TemplateGeneratorImpl();
  });

  describe('getAvailableTemplates', () => {
    it('应该返回全部 6 个模板，且每个模板信息完整', () => {
      const templates = templateGenerator.getAvailableTemplates();

      expect(templates).toHaveLength(6);
      expect(templates.map((t) => t.type)).toEqual([
        TemplateType.BASIC_REST,
        TemplateType.AUTHENTICATED_API,
        TemplateType.COMPLEX_DATA_API,
        TemplateType.WEATHER_API,
        TemplateType.TRANSLATION_API,
        TemplateType.DATABASE_API,
      ]);
    });

    it('每个模板的元信息（名称/描述/场景/环境变量）应与预期一致', () => {
      const templates = templateGenerator.getAvailableTemplates();
      const byType = new Map(templates.map((t) => [t.type, t]));

      expect(byType.get(TemplateType.BASIC_REST)).toEqual({
        type: TemplateType.BASIC_REST,
        name: '基础REST API',
        description: '简单的GET请求API配置',
        useCase: '适用于无需认证的公开API',
        requiredEnvVars: [],
      });

      expect(byType.get(TemplateType.AUTHENTICATED_API)).toEqual({
        type: TemplateType.AUTHENTICATED_API,
        name: '认证API',
        description: '需要API密钥或Token认证的API',
        useCase: '适用于需要认证的第三方API服务',
        requiredEnvVars: ['API_KEY', 'API_TOKEN'],
      });

      expect(byType.get(TemplateType.COMPLEX_DATA_API)).toEqual({
        type: TemplateType.COMPLEX_DATA_API,
        name: '复杂数据处理API',
        description: '使用JSONata进行复杂数据转换的API',
        useCase: '适用于需要复杂数据处理和转换的API',
        requiredEnvVars: ['API_ENDPOINT'],
      });

      expect(byType.get(TemplateType.WEATHER_API)).toEqual({
        type: TemplateType.WEATHER_API,
        name: '天气API示例',
        description: '获取天气信息的API配置示例',
        useCase: '演示如何配置天气查询API',
        requiredEnvVars: ['WEATHER_API_KEY'],
      });

      expect(byType.get(TemplateType.TRANSLATION_API)).toEqual({
        type: TemplateType.TRANSLATION_API,
        name: '翻译API示例',
        description: '文本翻译API配置示例',
        useCase: '演示如何配置翻译服务API',
        requiredEnvVars: ['TRANSLATE_API_KEY'],
      });

      expect(byType.get(TemplateType.DATABASE_API)).toEqual({
        type: TemplateType.DATABASE_API,
        name: '数据库查询API',
        description: '数据库查询API配置示例',
        useCase: '演示如何配置数据库查询接口',
        requiredEnvVars: ['DB_API_URL', 'DB_API_KEY'],
      });
    });
  });

  describe('generateBasicTemplate', () => {
    it('应该生成完整的基础配置模板', () => {
      const template = templateGenerator.generateBasicTemplate();

      expect(template.version).toBe('1.0');
      expect(template.tools).toHaveLength(1);

      const tool = template.tools[0];
      expect(tool.id).toBe('example-api');
      expect(tool.name).toBe('示例API工具');
      expect(tool.description).toBe('这是一个示例API工具配置');
      expect(tool.api).toEqual({
        url: 'https://api.example.com/data',
        method: 'GET',
        timeout: 5000,
      });
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '查询参数',
            minLength: 1,
          },
        },
        required: ['query'],
      });
      expect(tool.response).toEqual({ jsonata: '$.data' });
    });
  });

  describe('generateTemplate', () => {
    it('应该生成基础REST API模板', () => {
      const template = templateGenerator.generateTemplate(TemplateType.BASIC_REST);

      expect(template.version).toBe('1.0');
      expect(template.tools).toHaveLength(1);

      const tool = template.tools[0];
      expect(tool.id).toBe('basic-get-api');
      expect(tool.name).toBe('基础GET API');
      expect(tool.description).toBe('简单的GET请求API示例');
      expect(tool.api).toEqual({
        url: 'https://jsonplaceholder.typicode.com/posts/{{data.postId}}',
        method: 'GET',
        timeout: 5000,
      });
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          postId: {
            type: 'number',
            description: '文章ID',
            minimum: 1,
          },
        },
        required: ['postId'],
      });
      expect(tool.response).toEqual({
        jsonata: '{ "title": title, "content": body, "author": userId }',
      });
    });

    it('应该生成认证API模板', () => {
      const template = templateGenerator.generateTemplate(TemplateType.AUTHENTICATED_API);

      expect(template.version).toBe('1.0');
      expect(template.tools).toHaveLength(1);

      const tool = template.tools[0];
      expect(tool.id).toBe('authenticated-api');
      expect(tool.name).toBe('认证API示例');
      expect(tool.description).toBe('需要API密钥认证的API示例');
      expect(tool.api).toEqual({
        url: 'https://api.example.com/secure/data',
        method: 'GET',
        headers: {
          Authorization: 'Bearer {{env.API_TOKEN}}',
          'X-API-Key': '{{env.API_KEY}}',
          'Content-Type': 'application/json',
        },
        queryParams: {
          format: 'json',
          limit: '{{data.limit}}',
        },
        timeout: 10000,
        retries: 3,
      });
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '返回结果数量限制',
            minimum: 1,
            maximum: 100,
            default: 10,
          },
          category: {
            type: 'string',
            description: '数据分类',
            enum: ['news', 'articles', 'posts'],
          },
        },
        required: ['limit'],
      });
      expect(tool.response).toEqual({
        jsonata: '{ "items": data.items, "total": data.total, "hasMore": data.hasMore }',
        errorPath: 'error.message',
      });
      expect(tool.security).toEqual({
        authentication: {
          type: 'bearer',
          token: '{{env.API_TOKEN}}',
        },
        allowedDomains: ['api.example.com'],
        rateLimiting: {
          windowSeconds: 60,
          maxRequests: 100,
          enabled: true,
        },
      });
      expect(tool.cache).toEqual({
        enabled: true,
        ttl: 300,
        maxSize: 1000,
      });
    });

    it('应该生成复杂数据API模板', () => {
      const template = templateGenerator.generateTemplate(TemplateType.COMPLEX_DATA_API);

      expect(template.version).toBe('1.0');
      expect(template.tools).toHaveLength(1);

      const tool = template.tools[0];
      expect(tool.id).toBe('complex-data-api');
      expect(tool.name).toBe('复杂数据处理API');
      expect(tool.description).toBe('演示复杂数据转换和处理的API');
      expect(tool.api).toEqual({
        url: '{{env.API_ENDPOINT}}/analytics',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer {{env.API_TOKEN}}',
        },
        body: {
          query: '{{data.query}}',
          filters: '{{data.filters}}',
          aggregations: ['sum', 'avg', 'count'],
        },
        timeout: 30000,
      });
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '查询条件',
            minLength: 1,
          },
          filters: {
            type: 'object',
            description: '过滤条件',
            properties: {
              dateRange: {
                type: 'object',
                properties: {
                  start: { type: 'string', format: 'date' },
                  end: { type: 'string', format: 'date' },
                },
              },
              category: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
        required: ['query'],
      });

      const jsonata = tool.response.jsonata ?? '';
      // 逐段断言 JSONata 表达式内容，避免整体镜像
      expect(jsonata).toContain('"total": results.total');
      expect(jsonata).toContain('"processed": results.processed');
      expect(jsonata).toContain('"duration": results.executionTime');
      expect(jsonata).toContain('"id": id');
      expect(jsonata).toContain('"value": value');
      expect(jsonata).toContain('"category": category');
      expect(jsonata).toContain('"score": $round(score, 2)');
      expect(jsonata).toContain('"tags": tags[type="important"].name');
      expect(jsonata).toContain('"sum": $sum(results.data.value)');
      expect(jsonata).toContain('"average": $round($average(results.data.value), 2)');
      expect(jsonata).toContain('"count": $count(results.data)');
      expect(tool.response.errorPath).toBe('error.details.message');
      expect(tool.response.successCondition).toBe('status = "success"');
    });

    it('应该生成天气API模板', () => {
      const template = templateGenerator.generateTemplate(TemplateType.WEATHER_API);

      expect(template.version).toBe('1.0');
      expect(template.tools).toHaveLength(1);

      const tool = template.tools[0];
      expect(tool.id).toBe('weather-api');
      expect(tool.name).toBe('天气查询');
      expect(tool.description).toBe('根据城市名称获取当前天气信息');
      expect(tool.api).toEqual({
        url: 'https://api.openweathermap.org/data/2.5/weather',
        method: 'GET',
        queryParams: {
          q: '{{data.city}}',
          appid: '{{env.WEATHER_API_KEY}}',
          units: 'metric',
          lang: 'zh_cn',
        },
        timeout: 5000,
      });
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          city: {
            type: 'string',
            description: '城市名称（中文或英文）',
            minLength: 1,
          },
        },
        required: ['city'],
      });

      const jsonata = tool.response.jsonata ?? '';
      expect(jsonata).toContain('"city": name');
      expect(jsonata).toContain('"country": sys.country');
      expect(jsonata).toContain('"temperature": $round(main.temp, 1)');
      expect(jsonata).toContain('"feelsLike": $round(main.feels_like, 1)');
      expect(jsonata).toContain('"humidity": main.humidity');
      expect(jsonata).toContain('"pressure": main.pressure');
      expect(jsonata).toContain('"description": weather[0].description');
      expect(jsonata).toContain('"windSpeed": wind.speed');
      expect(jsonata).toContain('"visibility": visibility / 1000');
      expect(tool.response.errorPath).toBe('message');
    });

    it('应该生成翻译API模板', () => {
      const template = templateGenerator.generateTemplate(TemplateType.TRANSLATION_API);

      expect(template.version).toBe('1.0');
      expect(template.tools).toHaveLength(1);

      const tool = template.tools[0];
      expect(tool.id).toBe('translation-api');
      expect(tool.name).toBe('文本翻译');
      expect(tool.description).toBe('将文本从一种语言翻译为另一种语言');
      expect(tool.api).toEqual({
        url: 'https://api.mymemory.translated.net/get',
        method: 'GET',
        queryParams: {
          q: '{{data.text}}',
          langpair: '{{data.from}}|{{data.to}}',
          de: '{{env.TRANSLATE_API_KEY}}',
        },
        timeout: 10000,
      });
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要翻译的文本',
            minLength: 1,
            maxLength: 500,
          },
          from: {
            type: 'string',
            description: '源语言代码',
            enum: ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'],
            default: 'zh',
          },
          to: {
            type: 'string',
            description: '目标语言代码',
            enum: ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es'],
            default: 'en',
          },
        },
        required: ['text', 'from', 'to'],
      });

      const jsonata = tool.response.jsonata ?? '';
      expect(jsonata).toContain('"translatedText": responseData.translatedText');
      expect(jsonata).toContain('"sourceText": quotaFinished ? null : responseData.match');
      expect(jsonata).toContain('"confidence": responseData.match');
      expect(jsonata).toContain('"from": $substring(responseData.match, 0, 2)');
      expect(jsonata).toContain('"to": $substring(responseData.match, 3, 2)');
      expect(tool.response.errorPath).toBe('responseDetails');
    });

    it('应该生成数据库API模板', () => {
      const template = templateGenerator.generateTemplate(TemplateType.DATABASE_API);

      expect(template.version).toBe('1.0');
      expect(template.tools).toHaveLength(1);

      const tool = template.tools[0];
      expect(tool.id).toBe('database-query');
      expect(tool.name).toBe('数据库查询');
      expect(tool.description).toBe('执行数据库查询并返回结果');
      expect(tool.api).toEqual({
        url: '{{env.DB_API_URL}}/query',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer {{env.DB_API_KEY}}',
        },
        body: {
          table: '{{data.table}}',
          fields: '{{data.fields}}',
          where: '{{data.conditions}}',
          limit: '{{data.limit}}',
          orderBy: '{{data.orderBy}}',
        },
        timeout: 15000,
      });
      expect(tool.parameters).toEqual({
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: '表名',
            minLength: 1,
          },
          fields: {
            type: 'array',
            description: '要查询的字段列表',
            items: { type: 'string' },
            minItems: 1,
          },
          conditions: {
            type: 'object',
            description: '查询条件',
            additionalProperties: true,
          },
          limit: {
            type: 'number',
            description: '返回记录数限制',
            minimum: 1,
            maximum: 1000,
            default: 100,
          },
          orderBy: {
            type: 'string',
            description: '排序字段',
          },
        },
        required: ['table', 'fields'],
      });

      const jsonata = tool.response.jsonata ?? '';
      expect(jsonata).toContain('"records": data.rows');
      expect(jsonata).toContain('"total": data.total');
      expect(jsonata).toContain('"fields": data.fields');
      expect(jsonata).toContain('"executionTime": metadata.executionTime');
      expect(jsonata).toContain('"hasMore": data.total > $count(data.rows)');
      expect(tool.response.errorPath).toBe('error.message');
      expect(tool.security).toEqual({
        allowedDomains: ['your-db-api.com'],
        rateLimiting: {
          windowSeconds: 60,
          maxRequests: 50,
          enabled: true,
        },
      });
    });

    it('应该为未知类型降级返回基础模板', () => {
      const template = templateGenerator.generateTemplate('unknown' as TemplateType);

      // 降级行为：与 generateBasicTemplate 完全一致
      expect(template).toEqual(templateGenerator.generateBasicTemplate());
      expect(template.tools[0].id).toBe('example-api');
    });
  });

  describe('generateFullExample', () => {
    it('应该按顺序聚合天气、翻译、认证三个模板', () => {
      const template = templateGenerator.generateFullExample();

      expect(template.version).toBe('1.0');
      expect(template.tools.map((t) => t.id)).toEqual([
        'weather-api',
        'translation-api',
        'authenticated-api',
      ]);

      // 每个工具内容应与对应模板一致
      const weatherTool = templateGenerator.generateTemplate(TemplateType.WEATHER_API).tools[0];
      const translationTool = templateGenerator.generateTemplate(TemplateType.TRANSLATION_API)
        .tools[0];
      const authenticatedTool = templateGenerator.generateTemplate(TemplateType.AUTHENTICATED_API)
        .tools[0];

      expect(template.tools[0]).toEqual(weatherTool);
      expect(template.tools[1]).toEqual(translationTool);
      expect(template.tools[2]).toEqual(authenticatedTool);
    });
  });

  describe('generateJsonSchema', () => {
    it('应该生成完整的 JSON Schema 结构', () => {
      const schema = templateGenerator.generateJsonSchema();

      expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
      expect(schema.title).toBe('API转MCP工具配置');
      expect(schema.description).toBe('API转MCP服务的配置文件格式定义');
      expect(schema.type).toBe('object');
      expect(schema.properties).toEqual({
        version: {
          type: 'string',
          description: '配置文件版本',
          pattern: '^\\d+\\.\\d+$',
        },
        tools: {
          type: 'array',
          description: 'API工具配置列表',
          items: {
            $ref: '#/definitions/ApiToolConfig',
          },
        },
      });
      expect(schema.required).toEqual(['version', 'tools']);
    });

    it('ApiToolConfig 定义应包含全部字段约束', () => {
      const schema = templateGenerator.generateJsonSchema();
      const definitions = schema.definitions as Record<string, Record<string, unknown>>;
      const toolConfig = definitions.ApiToolConfig as Record<string, unknown>;

      expect(toolConfig.type).toBe('object');
      expect(toolConfig.properties).toEqual({
        id: { type: 'string', description: '工具唯一标识', minLength: 1 },
        name: { type: 'string', description: '工具显示名称', minLength: 1 },
        description: { type: 'string', description: '工具描述', minLength: 1 },
        api: { $ref: '#/definitions/ApiEndpointConfig' },
        parameters: { $ref: '#/definitions/JsonSchema' },
        response: { $ref: '#/definitions/ResponseConfig' },
        security: { $ref: '#/definitions/SecurityConfig' },
        cache: { $ref: '#/definitions/CacheConfig' },
      });
      expect(toolConfig.required).toEqual([
        'id',
        'name',
        'description',
        'api',
        'parameters',
        'response',
      ]);
    });
  });

  describe('generateCommentedConfig', () => {
    it('应该生成注释头 + 美化 JSON 的完整注释配置', () => {
      const config = templateGenerator.generateBasicTemplate();
      const commented = templateGenerator.generateCommentedConfig(config);

      const expectedHeader = [
        '// API转MCP工具配置文件',
        '// 此文件定义了如何将REST API转换为MCP工具',
        '//',
        '// 环境变量引用格式: {{env.VARIABLE_NAME}}',
        '// 参数引用格式: {{data.parameterName}}',
        '//',
        '// 更多信息请参考文档: https://github.com/your-org/mcp-knot',
      ].join('\n');

      expect(commented.startsWith(`${expectedHeader}\n\n`)).toBe(true);
      expect(commented).toContain(JSON.stringify(config, null, 2));
      // JSON 部分应该紧跟在注释头之后
      expect(commented).toBe(`${expectedHeader}\n\n${JSON.stringify(config, null, 2)}`);
    });

    it('应该序列化任意传入的配置对象', () => {
      const config = {
        version: '2.5',
        tools: [
          {
            id: 'custom-tool',
            name: '自定义',
            description: '描述',
            api: { url: 'https://example.com', method: 'POST' },
            parameters: { type: 'object' },
            response: {},
          },
        ],
      };
      const commented = templateGenerator.generateCommentedConfig(config);

      expect(commented.endsWith(JSON.stringify(config, null, 2))).toBe(true);
      expect(commented).toContain('"version": "2.5"');
      expect(commented).toContain('"id": "custom-tool"');
    });
  });
});
