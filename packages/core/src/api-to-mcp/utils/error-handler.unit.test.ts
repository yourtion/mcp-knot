/**
 * 错误处理器测试
 */

import { describe, expect, it } from 'vitest';

import { ConfigurationError, ErrorHandlerImpl, ErrorSeverity } from './error-handler.js';

import type { ValidationResult } from '../types/api-tool.js';

describe('ErrorHandlerImpl', () => {
  let errorHandler: ErrorHandlerImpl;

  beforeEach(() => {
    errorHandler = new ErrorHandlerImpl();
  });

  describe('createErrorReport', () => {
    it('应该创建无错误的报告', () => {
      const validationResult: ValidationResult = {
        valid: true,
        errors: [],
      };

      const report = errorHandler.createErrorReport(validationResult);

      expect(report.hasErrors).toBe(false);
      expect(report.errorCount).toBe(0);
      expect(report.warningCount).toBe(0);
      expect(report.errors).toHaveLength(0);
      expect(report.summary).toBe('配置验证通过，没有发现错误');
      expect(report.suggestions).toHaveLength(0);
    });

    it('应该创建包含错误的报告', () => {
      const validationResult: ValidationResult = {
        valid: false,
        errors: [
          {
            path: 'tools.0.id',
            message: '工具ID不能为空',
            code: 'MISSING_REQUIRED_PARAMETER',
          },
          {
            path: 'tools.0.api.url',
            message: '无效的URL格式',
            code: 'INVALID_URL',
          },
        ],
      };

      const report = errorHandler.createErrorReport(validationResult);

      expect(report.hasErrors).toBe(true);
      expect(report.errorCount).toBe(2); // 两个都是高级错误
      expect(report.warningCount).toBe(0);
      expect(report.errors).toHaveLength(2);
      expect(report.summary).toContain('2个高级错误');
      expect(report.suggestions.length).toBeGreaterThan(0);
    });

    it('应该正确分类错误严重级别', () => {
      const validationResult: ValidationResult = {
        valid: false,
        errors: [
          {
            path: 'config',
            message: '配置文件不存在',
            code: 'CONFIG_FILE_NOT_FOUND',
          },
          {
            path: 'tools.0.api.url',
            message: '无效的URL',
            code: 'INVALID_URL',
          },
          {
            path: 'tools.0.name',
            message: '类型错误',
            code: 'INVALID_TYPE',
          },
          {
            path: 'unknown',
            message: '未知错误',
            code: 'UNKNOWN_ERROR',
          },
        ],
      };

      const report = errorHandler.createErrorReport(validationResult);

      expect(report.errors[0].severity).toBe(ErrorSeverity.CRITICAL);
      expect(report.errors[1].severity).toBe(ErrorSeverity.HIGH);
      expect(report.errors[2].severity).toBe(ErrorSeverity.MEDIUM);
      expect(report.errors[3].severity).toBe(ErrorSeverity.LOW);
    });
  });

  describe('formatErrorMessage', () => {
    it('应该格式化错误消息', () => {
      const error = {
        path: 'tools.0.api.url',
        message: '无效的URL格式',
        code: 'INVALID_URL',
        severity: ErrorSeverity.HIGH,
        suggestion: '请提供有效的HTTP/HTTPS URL',
      };

      const formatted = errorHandler.formatErrorMessage(error);

      expect(formatted).toContain('❌');
      expect(formatted).toContain('[tools.0.api.url]');
      expect(formatted).toContain('无效的URL格式');
      expect(formatted).toContain('建议: 请提供有效的HTTP/HTTPS URL');
    });

    it('应该处理没有路径的错误', () => {
      const error = {
        path: '',
        message: '全局错误',
        code: 'GLOBAL_ERROR',
        severity: ErrorSeverity.MEDIUM,
      };

      const formatted = errorHandler.formatErrorMessage(error);

      expect(formatted).not.toContain('[]');
      expect(formatted).toContain('全局错误');
    });
  });

  describe('generateSuggestion', () => {
    it('应该为已知错误代码生成建议', () => {
      const error = {
        path: 'config',
        message: '配置文件不存在',
        code: 'CONFIG_FILE_NOT_FOUND',
      };

      const suggestion = errorHandler.generateSuggestion(error);

      expect(suggestion).toBe('请确保配置文件存在且路径正确');
    });

    it('应该根据路径生成建议', () => {
      const urlError = {
        path: 'api.url',
        message: '格式错误',
      };

      const suggestion = errorHandler.generateSuggestion(urlError);

      expect(suggestion).toBe('请提供有效的HTTP/HTTPS URL格式');
    });

    it('应该根据消息内容生成建议', () => {
      const enumError = {
        path: 'method',
        message: 'Invalid enum value',
      };

      const suggestion = errorHandler.generateSuggestion(enumError);

      expect(suggestion).toBe('请使用允许的枚举值');
    });

    it('应该为未知错误生成通用建议', () => {
      const unknownError = {
        path: 'unknown',
        message: '未知错误',
      };

      const suggestion = errorHandler.generateSuggestion(unknownError);

      expect(suggestion).toBe('请检查配置格式是否正确');
    });
  });

  describe('determineSeverity', () => {
    it('应该根据错误代码确定严重级别', () => {
      const criticalError = {
        path: 'config',
        message: '配置文件不存在',
        code: 'CONFIG_FILE_NOT_FOUND',
      };

      const severity = errorHandler.determineSeverity(criticalError);

      expect(severity).toBe(ErrorSeverity.CRITICAL);
    });

    it('应该根据消息内容确定严重级别', () => {
      const requiredError = {
        path: 'field',
        message: 'Required field is missing',
      };

      const severity = errorHandler.determineSeverity(requiredError);

      expect(severity).toBe(ErrorSeverity.HIGH);
    });

    it('应该为未知错误返回低级别', () => {
      const unknownError = {
        path: 'unknown',
        message: '未知错误',
      };

      const severity = errorHandler.determineSeverity(unknownError);

      expect(severity).toBe(ErrorSeverity.LOW);
    });
  });

  describe('createErrorSummary', () => {
    it('应该为空错误列表创建摘要', () => {
      const summary = errorHandler.createErrorSummary([]);

      expect(summary).toBe('配置验证通过，没有发现错误');
    });

    it('应该为混合错误级别创建摘要', () => {
      const errors = [
        {
          path: 'config',
          message: '严重错误',
          code: 'CRITICAL',
          severity: ErrorSeverity.CRITICAL,
        },
        {
          path: 'field1',
          message: '高级错误',
          code: 'HIGH',
          severity: ErrorSeverity.HIGH,
        },
        {
          path: 'field2',
          message: '中级错误',
          code: 'MEDIUM',
          severity: ErrorSeverity.MEDIUM,
        },
        {
          path: 'field3',
          message: '警告',
          code: 'LOW',
          severity: ErrorSeverity.LOW,
        },
      ];

      const summary = errorHandler.createErrorSummary(errors);

      expect(summary).toBe('配置验证发现 1个严重错误、1个高级错误、1个中级错误、1个警告');
    });

    it('零计数的级别不应出现在摘要中', () => {
      const summary = errorHandler.createErrorSummary([
        { path: 'a', message: 'x', code: 'X', severity: ErrorSeverity.HIGH },
        { path: 'b', message: 'y', code: 'Y', severity: ErrorSeverity.HIGH },
      ]);

      expect(summary).toBe('配置验证发现 2个高级错误');
    });

    it('仅低级别错误时输出为警告', () => {
      const summary = errorHandler.createErrorSummary([
        { path: 'a', message: 'x', code: 'X', severity: ErrorSeverity.LOW },
      ]);

      expect(summary).toBe('配置验证发现 1个警告');
    });
  });

  describe('createErrorReport 计数与建议（补强）', () => {
    it('混合级别时 errorCount 只统计 HIGH/CRITICAL，warningCount 只统计 LOW/MEDIUM', () => {
      const report = errorHandler.createErrorReport({
        valid: false,
        errors: [
          { path: 'a', message: 'x', code: 'CONFIG_FILE_NOT_FOUND' }, // CRITICAL
          { path: 'b', message: 'y', code: 'INVALID_URL' }, // HIGH
          { path: 'c', message: 'z', code: 'INVALID_TYPE' }, // MEDIUM
          { path: 'd', message: 'w', code: 'UNKNOWN_ERROR' }, // LOW
        ],
      });

      expect(report.errorCount).toBe(2);
      expect(report.warningCount).toBe(2);
      expect(report.hasErrors).toBe(true);
    });

    it('建议列表去重且为纯字符串数组', () => {
      const report = errorHandler.createErrorReport({
        valid: false,
        errors: [
          { path: 'a', message: 'x', code: 'INVALID_URL' },
          { path: 'b', message: 'y', code: 'INVALID_URL' }, // 相同建议应去重
        ],
      });

      expect(report.suggestions).toEqual([
        '请提供有效的HTTP/HTTPS URL，例如: https://api.example.com',
      ]);
    });

    it('context 透传到每个详细错误', () => {
      const context = { toolId: 't1' };

      const report = errorHandler.createErrorReport(
        {
          valid: false,
          errors: [{ path: 'a', message: 'x', code: 'INVALID_URL' }],
        },
        context,
      );

      expect(report.errors[0].context).toBe(context);
    });

    it('无建议的错误不进入建议列表', () => {
      // code 未知 + path/message 不命中任何建议规则 → 通用建议，仍会出现；
      // 这里验证 INVALID_JSONATA_SYNTAX 的建议存在
      const report = errorHandler.createErrorReport({
        valid: false,
        errors: [{ path: 'response.jsonata', message: '语法错误', code: 'INVALID_JSONATA_SYNTAX' }],
      });

      expect(report.suggestions).toEqual(['请检查JSONata表达式语法，参考: https://jsonata.org/']);
    });
  });

  describe('generateSuggestion 预定义建议表', () => {
    it.each([
      ['CONFIG_FILE_NOT_FOUND', '请确保配置文件存在且路径正确'],
      ['INVALID_CONFIG_FORMAT', '请检查配置文件的JSON格式是否正确'],
      ['DUPLICATE_TOOL_ID', '请确保每个工具的ID都是唯一的'],
      ['INVALID_URL', '请提供有效的HTTP/HTTPS URL，例如: https://api.example.com'],
      ['INVALID_JSONATA_SYNTAX', '请检查JSONata表达式语法，参考: https://jsonata.org/'],
      ['MISSING_REQUIRED_PARAMETER', '请添加所有必需的参数字段'],
      ['INVALID_TYPE', '请检查字段类型是否符合要求'],
      ['INVALID_SYNTAX', '请检查语法格式是否正确'],
    ])('code %s → 精确建议', (code, expected) => {
      expect(errorHandler.generateSuggestion({ path: 'p', message: 'm', code })).toBe(expected);
    });
  });

  describe('generateSuggestion 路径与消息分支', () => {
    it.each([
      ['response.jsonata', '表达式错误', '请检查JSONata表达式语法，确保符合JSONata规范'],
      ['tools.0.id', '无效', '请提供唯一的工具标识符'],
      ['parameters.required', '缺少字段', '请添加所有必需的字段'],
    ])('路径 %s → 路径建议', (path, message, expected) => {
      expect(errorHandler.generateSuggestion({ path, message })).toBe(expected);
    });

    it.each([
      ['Invalid enum value', '请使用允许的枚举值'],
      ['Expected string, received number', '请提供字符串类型的值'],
      ['Expected number, received string', '请提供数字类型的值'],
    ])('消息 %s → 类型建议', (message, expected) => {
      expect(errorHandler.generateSuggestion({ path: 'p', message })).toBe(expected);
    });

    it('未知 code 但路径含 url → 回退到路径建议而非 undefined', () => {
      const suggestion = errorHandler.generateSuggestion({
        path: 'api.url',
        message: 'bad',
        code: 'TOTALLY_UNKNOWN_CODE',
      });

      expect(suggestion).toBe('请提供有效的HTTP/HTTPS URL格式');
    });
  });

  describe('determineSeverity 消息分支（补强）', () => {
    it('消息仅含 required → HIGH', () => {
      expect(errorHandler.determineSeverity({ path: 'p', message: 'This field is required' })).toBe(
        ErrorSeverity.HIGH,
      );
    });

    it('消息仅含 missing → HIGH', () => {
      expect(errorHandler.determineSeverity({ path: 'p', message: 'Value missing here' })).toBe(
        ErrorSeverity.HIGH,
      );
    });

    it('消息仅含 invalid → MEDIUM', () => {
      expect(errorHandler.determineSeverity({ path: 'p', message: 'Invalid input given' })).toBe(
        ErrorSeverity.MEDIUM,
      );
    });

    it('消息仅含 syntax → MEDIUM', () => {
      expect(errorHandler.determineSeverity({ path: 'p', message: 'Bad syntax near x' })).toBe(
        ErrorSeverity.MEDIUM,
      );
    });

    it('未知 code 且消息无关键词 → LOW（不因 code 存在而短路）', () => {
      expect(
        errorHandler.determineSeverity({ path: 'p', message: 'plain', code: 'UNKNOWN_X' }),
      ).toBe(ErrorSeverity.LOW);
    });
  });

  describe('formatErrorMessage 图标与精确格式', () => {
    const iconCases: Array<[ErrorSeverity, string]> = [
      [ErrorSeverity.CRITICAL, '🚨'],
      [ErrorSeverity.HIGH, '❌'],
      [ErrorSeverity.MEDIUM, '⚠️'],
      [ErrorSeverity.LOW, 'ℹ️'],
      ['bogus' as unknown as ErrorSeverity, '❓'],
    ];

    it.each(iconCases)('severity %s → 图标 %s', (severity, icon) => {
      const formatted = errorHandler.formatErrorMessage({
        path: '',
        message: '消息体',
        code: 'X',
        severity,
      });
      expect(formatted.startsWith(`${icon} 消息体`)).toBe(true);
    });

    it('完整格式：图标 + [路径] + 消息 + 缩进建议', () => {
      const formatted = errorHandler.formatErrorMessage({
        path: 'tools.0.api.url',
        message: '无效的URL格式',
        code: 'INVALID_URL',
        severity: ErrorSeverity.HIGH,
        suggestion: '请提供有效的HTTP/HTTPS URL',
      });

      expect(formatted).toBe(
        '❌ [tools.0.api.url] 无效的URL格式\n  建议: 请提供有效的HTTP/HTTPS URL',
      );
    });

    it('无路径无建议 → 仅图标与消息', () => {
      const formatted = errorHandler.formatErrorMessage({
        path: '',
        message: '全局错误',
        code: 'X',
        severity: ErrorSeverity.MEDIUM,
      });

      expect(formatted).toBe('⚠️ 全局错误');
    });
  });
});

describe('ConfigurationError', () => {
  it('应该创建配置错误实例', () => {
    const report = {
      hasErrors: true,
      errorCount: 1,
      warningCount: 0,
      errors: [
        {
          path: 'config',
          message: '配置错误',
          code: 'CONFIG_ERROR',
          severity: ErrorSeverity.HIGH,
        },
      ],
      summary: '配置验证发现 1个高级错误',
      suggestions: ['请检查配置格式'],
    };

    const error = new ConfigurationError('配置验证失败', report, '/path/to/config.json');

    expect(error.name).toBe('ConfigurationError');
    expect(error.message).toBe('配置验证失败');
    expect(error.report).toBe(report);
    expect(error.configPath).toBe('/path/to/config.json');
  });

  it('应该生成格式化的错误报告', () => {
    const report = {
      hasErrors: true,
      errorCount: 1,
      warningCount: 0,
      errors: [
        {
          path: 'tools.0.id',
          message: '工具ID不能为空',
          code: 'MISSING_REQUIRED_PARAMETER',
          severity: ErrorSeverity.HIGH,
          suggestion: '请添加所有必需的参数字段',
        },
      ],
      summary: '配置验证发现 1个高级错误',
      suggestions: ['请添加所有必需的参数字段'],
    };

    const error = new ConfigurationError('配置验证失败', report, 'config.json');
    const formatted = error.getFormattedReport();

    expect(formatted).toContain('配置错误报告 (config.json)');
    expect(formatted).toContain('配置验证发现 1个高级错误');
    expect(formatted).toContain('详细错误信息:');
    expect(formatted).toContain('工具ID不能为空');
    expect(formatted).toContain('修复建议:');
    expect(formatted).toContain('请添加所有必需的参数字段');
  });

  it('无 configPath 时标题不带括号，整体输出精确可预期', () => {
    const report = {
      hasErrors: true,
      errorCount: 1,
      warningCount: 0,
      errors: [
        {
          path: 'tools.0.id',
          message: '工具ID不能为空',
          code: 'MISSING_REQUIRED_PARAMETER',
          severity: ErrorSeverity.HIGH,
          suggestion: '请添加所有必需的参数字段',
        },
      ],
      summary: '配置验证发现 1个高级错误',
      suggestions: ['请添加所有必需的参数字段'],
    };

    const error = new ConfigurationError('配置验证失败', report);
    const formatted = error.getFormattedReport();

    const expected = [
      '配置错误报告 ',
      '='.repeat(50),
      '配置验证发现 1个高级错误',
      '',
      '详细错误信息:',
      '1. ❌ [tools.0.id] 工具ID不能为空\n  建议: 请添加所有必需的参数字段',
      '',
      '修复建议:',
      '1. 请添加所有必需的参数字段',
    ].join('\n');

    expect(formatted).toBe(expected);
  });

  it('多个错误与建议按序号列出', () => {
    const report = {
      hasErrors: true,
      errorCount: 2,
      warningCount: 0,
      errors: [
        {
          path: 'a',
          message: '错误一',
          code: 'INVALID_URL',
          severity: ErrorSeverity.HIGH,
          suggestion: '建议A',
        },
        {
          path: 'b',
          message: '错误二',
          code: 'INVALID_TYPE',
          severity: ErrorSeverity.MEDIUM,
          suggestion: '建议B',
        },
      ],
      summary: '配置验证发现 1个高级错误、1个中级错误',
      suggestions: ['建议A', '建议B'],
    };

    const error = new ConfigurationError('配置验证失败', report, 'c.json');
    const formatted = error.getFormattedReport();

    expect(formatted).toContain('1. ❌ [a] 错误一');
    expect(formatted).toContain('2. ⚠️ [b] 错误二');
    expect(formatted).toContain('1. 建议A');
    expect(formatted).toContain('2. 建议B');
  });
});
