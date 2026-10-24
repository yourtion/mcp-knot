import { beforeEach, describe, expect, it } from 'vitest';

import { ConfigValidator } from './config-validator';

import type { CliConfig } from '../types';

describe('ConfigValidator', () => {
  let validator: ConfigValidator;

  beforeEach(() => {
    validator = new ConfigValidator();
  });

  describe('validateConfig', () => {
    it('应该验证有效的基础配置', () => {
      const validConfig: CliConfig = {
        servers: {
          test_server: {
            command: 'node',
            args: ['server.js'],
          },
        },
      };

      const result = validator.validateConfig(validConfig);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('服务器配置验证', () => {
    it('应该拒绝非对象的servers', () => {
      const config = { servers: 'invalid' };
      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['servers'],
        message: 'servers 必须是对象',
        code: 'SERVERS_NOT_OBJECT',
        severity: 'error',
      });
    });
  });

  describe('单个服务器配置验证', () => {
    it('应该拒绝非对象的服务器配置', () => {
      const config = { servers: { test: 'invalid' } };
      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['servers', 'test'],
        message: '服务器配置必须是对象',
        code: 'SERVER_CONFIG_NOT_OBJECT',
        severity: 'error',
      });
    });

    it('应该拒绝空的command', () => {
      const config = {
        servers: {
          test: { command: '', args: [] },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['servers', 'test', 'command'],
        message: '服务器命令不能为空',
        code: 'EMPTY_COMMAND',
        severity: 'error',
      });
    });

    it('应该拒绝非字符串的command', () => {
      const config = {
        servers: {
          test: { command: 123, args: [] },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['servers', 'test', 'command'],
        message: '服务器命令不能为空',
        code: 'EMPTY_COMMAND',
        severity: 'error',
      });
    });

    it('应该拒绝非数组的args', () => {
      const config = {
        servers: {
          test: { command: 'node', args: 'invalid' },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['servers', 'test', 'args'],
        message: 'args 必须是字符串数组',
        code: 'INVALID_ARGS_TYPE',
        severity: 'error',
      });
    });

    it('应该拒绝非对象的env', () => {
      const config = {
        servers: {
          test: { command: 'node', env: 'invalid' },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['servers', 'test', 'env'],
        message: 'env 必须是对象',
        code: 'INVALID_ENV_TYPE',
        severity: 'error',
      });
    });

    it('应该拒绝无效的timeout', () => {
      const config = {
        servers: {
          test: { command: 'node', timeout: -1 },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['servers', 'test', 'timeout'],
        message: 'timeout 必须是正数',
        code: 'INVALID_TIMEOUT',
        severity: 'error',
      });
    });

    it('应该警告过短的timeout', () => {
      const config: CliConfig = {
        servers: {
          test: { command: 'node', timeout: 1000 },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual({
        path: ['servers', 'test', 'timeout'],
        message: '超时时间可能过短',
        suggestion: '建议设置至少5秒的超时时间',
      });
    });

    it('应该警告过长的timeout', () => {
      const config: CliConfig = {
        servers: {
          test: { command: 'node', timeout: 400000 },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContainEqual({
        path: ['servers', 'test', 'timeout'],
        message: '超时时间可能过长',
        suggestion: '超过5分钟的超时时间可能不合理',
      });
    });
  });

  describe('日志配置验证', () => {
    it('应该接受空的logging配置', () => {
      const config: CliConfig = {
        servers: { test: { command: 'node' } },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
    });

    it('应该拒绝非对象的logging', () => {
      const config = {
        servers: { test: { command: 'node' } },
        logging: 'invalid',
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['logging'],
        message: 'logging 必须是对象',
        code: 'LOGGING_NOT_OBJECT',
        severity: 'error',
      });
    });

    it('应该拒绝无效的日志级别', () => {
      const config = {
        servers: { test: { command: 'node' } },
        logging: { level: 'invalid' },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['logging', 'level'],
        message: '无效的日志级别: invalid',
        code: 'INVALID_LOG_LEVEL',
        severity: 'error',
      });
    });

    it('应该接受有效的日志级别', () => {
      const validLevels = ['debug', 'info', 'warn', 'error'];

      for (const level of validLevels) {
        const config: CliConfig = {
          servers: { test: { command: 'node' } },
          logging: { level: level as CliConfig['logging']['level'] },
        };

        const result = validator.validateConfig(config);
        expect(result.valid).toBe(true);
      }
    });

    it('应该拒绝非字符串的日志文件路径', () => {
      const config = {
        servers: { test: { command: 'node' } },
        logging: { file: 123 },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['logging', 'file'],
        message: '日志文件路径必须是字符串',
        code: 'INVALID_LOG_FILE_TYPE',
        severity: 'error',
      });
    });
  });

  describe('传输配置验证', () => {
    it('应该接受空的transport配置', () => {
      const config: CliConfig = {
        servers: { test: { command: 'node' } },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
    });

    it('应该拒绝非对象的transport', () => {
      const config = {
        servers: { test: { command: 'node' } },
        transport: 'invalid',
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['transport'],
        message: 'transport 必须是对象',
        code: 'TRANSPORT_NOT_OBJECT',
        severity: 'error',
      });
    });

    it('应该拒绝不支持的传输类型', () => {
      const config = {
        servers: { test: { command: 'node' } },
        transport: { type: 'websocket' },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual({
        path: ['transport', 'type'],
        message: '不支持的传输类型: websocket',
        code: 'UNSUPPORTED_TRANSPORT_TYPE',
        severity: 'error',
      });
    });

    it('应该接受stdio传输类型', () => {
      const config: CliConfig = {
        servers: { test: { command: 'node' } },
        transport: { type: 'stdio' },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
    });
  });

  describe('业务逻辑验证', () => {
    it('应该警告无效的服务器ID命名', () => {
      const config: CliConfig = {
        servers: {
          '123invalid': { command: 'node' },
          'invalid-name!': { command: 'python' },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(
        result.warnings.some(
          (w) => w.path.includes('123invalid') && w.message.includes('服务器ID建议使用字母开头'),
        ),
      ).toBe(true);
    });

    it('应该警告重复的服务器命令', () => {
      const config: CliConfig = {
        servers: {
          server1: { command: 'node', args: ['app.js'] },
          server2: { command: 'node', args: ['app.js'] },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings.some((w) => w.message.includes('检测到重复的服务器命令'))).toBe(true);
    });
  });

  describe('工具方法', () => {
    it('应该创建验证错误', () => {
      const error = validator.createValidationError('测试错误', { test: true });

      expect(error.message).toBe('测试错误');
      expect(error.code).toBe('INVALID_CONFIG_FORMAT');
      expect(error.details).toEqual({ test: true });
    });

    it('应该格式化验证结果', () => {
      const result = {
        valid: false,
        errors: [
          {
            path: ['servers', 'test'],
            message: '测试错误',
            code: 'TEST_ERROR',
            severity: 'error' as const,
          },
        ],
        warnings: [
          {
            path: ['logging'],
            message: '测试警告',
            suggestion: '测试建议',
          },
        ],
      };

      const formatted = validator.formatValidationResult(result);

      expect(formatted).toContain('❌ 配置验证失败');
      expect(formatted).toContain('错误:');
      expect(formatted).toContain('[servers.test] 测试错误');
      expect(formatted).toContain('警告:');
      expect(formatted).toContain('[logging] 测试警告');
      expect(formatted).toContain('建议: 测试建议');
    });

    it('应该格式化成功的验证结果', () => {
      const result = {
        valid: true,
        errors: [],
        warnings: [],
      };

      const formatted = validator.formatValidationResult(result);

      expect(formatted).toBe('✅ 配置验证通过');
    });
  });

  describe('结构校验的精确性', () => {
    it('null 配置只应产生一条 CONFIG_NULL 错误', () => {
      const result = validator.validateConfig(null);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        path: [],
        message: '配置不能为空',
        code: 'CONFIG_NULL',
        severity: 'error',
      });
    });

    it('undefined 配置应与 null 一样被拒绝', () => {
      const result = validator.validateConfig(undefined);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('CONFIG_NULL');
    });

    it('非对象配置只应产生一条 CONFIG_NOT_OBJECT 错误', () => {
      const result = validator.validateConfig('invalid config');

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('CONFIG_NOT_OBJECT');
    });

    it('缺少 servers 字段时只应产生一条 MISSING_REQUIRED_FIELD 错误', () => {
      const result = validator.validateConfig({ logging: { level: 'info' } });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toEqual(['servers']);
    });

    it('验证异常时应记录原始异常消息与空 path', () => {
      const invalidConfig = {
        get servers() {
          throw new Error('测试异常');
        },
      };

      const result = validator.validateConfig(invalidConfig);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        path: [],
        message: '配置验证失败: 测试异常',
        code: 'VALIDATION_ERROR',
        severity: 'error',
      });
    });

    it('空 servers 对象只应产生 NO_SERVERS 错误', () => {
      const result = validator.validateConfig({ servers: {} });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('NO_SERVERS');
    });
  });

  describe('禁用服务器的警告判定', () => {
    it('部分服务器启用时不应给出全部禁用警告', () => {
      const config = {
        servers: {
          server1: { command: 'node', disabled: true },
          server2: { command: 'python' },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('disabled 为非 true 的真值时不应视为禁用', () => {
      const config = {
        servers: {
          server1: { command: 'node', disabled: 'yes' },
          server2: { command: 'python', disabled: 1 },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('全部禁用时警告应包含建议文本', () => {
      const config = {
        servers: {
          server1: { command: 'node', disabled: true },
        },
      };

      const result = validator.validateConfig(config);

      expect(result.warnings).toEqual([
        {
          path: ['servers'],
          message: '所有服务器都被禁用',
          suggestion: '至少启用一个服务器以确保CLI正常工作',
        },
      ]);
    });
  });

  describe('服务器字段类型与边界', () => {
    it('空白字符串 command 应被拒绝', () => {
      const result = validator.validateConfig({
        servers: { test: { command: '   ' } },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({
        path: ['servers', 'test', 'command'],
        message: '服务器命令不能为空',
        code: 'EMPTY_COMMAND',
        severity: 'error',
      });
    });

    it('缺少 command 时应被拒绝', () => {
      const result = validator.validateConfig({
        servers: { test: { args: ['x'] } },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toEqual(['servers', 'test', 'command']);
    });

    it('args 未提供或为合法数组时不应报错', () => {
      const result = validator.validateConfig({
        servers: {
          s1: { command: 'node' },
          s2: { command: 'python', args: ['a.py'] },
        },
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('env 为 null 时应被拒绝', () => {
      const result = validator.validateConfig({
        servers: { test: { command: 'node', env: null } },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].code).toBe('INVALID_ENV_TYPE');
    });

    it('timeout 为 0 或非数字时应被拒绝', () => {
      const zero = validator.validateConfig({
        servers: { test: { command: 'node', timeout: 0 } },
      });
      expect(zero.valid).toBe(false);
      expect(zero.errors).toHaveLength(1);
      expect(zero.errors[0].code).toBe('INVALID_TIMEOUT');

      const str = validator.validateConfig({
        servers: { test: { command: 'node', timeout: '10s' } },
      });
      expect(str.valid).toBe(false);
      expect(str.errors).toHaveLength(1);
      expect(str.errors[0].code).toBe('INVALID_TIMEOUT');
    });

    it('timeout 预警边界：4999 警告、5000 不警告、300000 不警告、300001 警告', () => {
      const short = validator.validateConfig({
        servers: { test: { command: 'node', timeout: 4999 } },
      });
      expect(short.valid).toBe(true);
      expect(short.warnings).toHaveLength(1);
      expect(short.warnings[0].message).toBe('超时时间可能过短');

      const boundaryLow = validator.validateConfig({
        servers: { test: { command: 'node', timeout: 5000 } },
      });
      expect(boundaryLow.warnings).toHaveLength(0);

      const boundaryHigh = validator.validateConfig({
        servers: { test: { command: 'node', timeout: 300000 } },
      });
      expect(boundaryHigh.warnings).toHaveLength(0);

      const long = validator.validateConfig({
        servers: { test: { command: 'node', timeout: 300001 } },
      });
      expect(long.valid).toBe(true);
      expect(long.warnings).toHaveLength(1);
      expect(long.warnings[0].message).toBe('超时时间可能过长');
    });

    it('timeout 为 0 触发错误的同时不应触发过短预警', () => {
      const result = validator.validateConfig({
        servers: { test: { command: 'node', timeout: 0 } },
      });

      expect(result.warnings).toHaveLength(0);
    });
  });

  describe('可选配置段的缺省行为', () => {
    it('logging 为空对象时应视为有效', () => {
      const result = validator.validateConfig({
        servers: { test: { command: 'node' } },
        logging: {},
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('transport 为空对象时应视为有效', () => {
      const result = validator.validateConfig({
        servers: { test: { command: 'node' } },
        transport: {},
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('业务逻辑警告的精确性', () => {
    it('合法服务器ID不应产生命名警告', () => {
      const result = validator.validateConfig({
        servers: { 'my_server-1': { command: 'node' } },
      });

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('非法服务器ID应产生带建议的命名警告', () => {
      const result = validator.validateConfig({
        servers: { '1bad id!': { command: 'node' } },
      });

      expect(result.warnings).toEqual([
        {
          path: ['servers', '1bad id!'],
          message: '服务器ID建议使用字母开头，只包含字母、数字、下划线和连字符',
          suggestion: '例如: my_server, api-server, fileServer1',
        },
      ]);
    });

    it('相同命令但不同参数不应判定为重复', () => {
      const result = validator.validateConfig({
        servers: {
          server1: { command: 'node', args: ['a.js'] },
          server2: { command: 'node', args: ['b.js'] },
        },
      });

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('不同命令的服务器不应判定为重复', () => {
      const result = validator.validateConfig({
        servers: {
          server1: { command: 'node' },
          server2: { command: 'python' },
        },
      });

      expect(result.warnings).toHaveLength(0);
    });

    it('完全重复的命令应产生指向后续服务器的警告', () => {
      const result = validator.validateConfig({
        servers: {
          server1: { command: 'node', args: ['app.js'] },
          server2: { command: 'node', args: ['app.js'] },
        },
      });

      expect(result.warnings).toEqual([
        {
          path: ['servers', 'server2'],
          message: '检测到重复的服务器命令',
          suggestion: '确保不同的服务器使用不同的命令或参数',
        },
      ]);
    });
  });

  describe('formatValidationResult 精确输出', () => {
    it('错误列表中空 path 不应输出方括号前缀', () => {
      const result = validator.validateConfig(null);
      const formatted = validator.formatValidationResult(result);

      expect(formatted).toBe('❌ 配置验证失败\n\n错误:\n  • 配置不能为空');
    });

    it('警告不带建议时不应输出建议行', () => {
      const formatted = validator.formatValidationResult({
        valid: true,
        errors: [],
        warnings: [{ path: ['servers'], message: '仅有消息' }],
      });

      expect(formatted).toBe('✅ 配置验证通过\n\n警告:\n  • [servers] 仅有消息');
    });

    it('警告带建议时应完整输出建议行', () => {
      const formatted = validator.formatValidationResult({
        valid: true,
        errors: [],
        warnings: [{ path: ['servers'], message: '消息', suggestion: '建议内容' }],
      });

      expect(formatted).toBe('✅ 配置验证通过\n\n警告:\n  • [servers] 消息\n    建议: 建议内容');
    });
  });
});
