/**
 * 缓存键管理器测试
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type CacheKeyManager,
  CacheKeyManagerImpl,
  type CacheKeyStrategy,
  CacheKeyUtils,
  createCacheKeyManager,
  defaultCacheKeyStrategy,
  hierarchicalCacheKeyStrategy,
  simpleCacheKeyStrategy,
} from './cache-key-manager.js';

// Mock日志记录器
vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('CacheKeyManagerImpl', () => {
  let keyManager: CacheKeyManager;

  beforeEach(() => {
    keyManager = new CacheKeyManagerImpl();
  });

  describe('基本键生成', () => {
    it('应该生成有效的缓存键', () => {
      const toolId = 'test-tool';
      const parameters = { param1: 'value1', param2: 'value2' };

      const key = keyManager.generateKey(toolId, parameters);

      expect(key).toBeDefined();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
      expect(key).toContain(toolId);
    });

    it('应该为相同参数生成相同的键', () => {
      const toolId = 'test-tool';
      const parameters = { param1: 'value1', param2: 'value2' };

      const key1 = keyManager.generateKey(toolId, parameters);
      const key2 = keyManager.generateKey(toolId, parameters);

      expect(key1).toBe(key2);
    });

    it('应该为不同参数生成不同的键', () => {
      const toolId = 'test-tool';
      const params1 = { param1: 'value1' };
      const params2 = { param1: 'value2' };

      const key1 = keyManager.generateKey(toolId, params1);
      const key2 = keyManager.generateKey(toolId, params2);

      expect(key1).not.toBe(key2);
    });

    it('应该为不同工具生成不同的键', () => {
      const parameters = { param1: 'value1' };

      const key1 = keyManager.generateKey('tool1', parameters);
      const key2 = keyManager.generateKey('tool2', parameters);

      expect(key1).not.toBe(key2);
    });

    it('应该处理空参数对象', () => {
      const toolId = 'empty-params-tool';
      const parameters = {};

      const key = keyManager.generateKey(toolId, parameters);

      expect(key).toBeDefined();
      expect(key).toContain(toolId);
    });

    it('应该处理复杂的参数对象', () => {
      const toolId = 'complex-tool';
      const parameters = {
        user: {
          name: 'John',
          age: 30,
        },
        tags: ['tag1', 'tag2'],
        metadata: {
          source: 'api',
          version: '1.0',
        },
      };

      const key = keyManager.generateKey(toolId, parameters);

      expect(key).toBeDefined();
      expect(typeof key).toBe('string');
      expect(key.length).toBeGreaterThan(0);
    });
  });

  describe('参数验证', () => {
    it('应该在工具ID为空时抛出错误', () => {
      expect(() => {
        keyManager.generateKey('', { param: 'value' });
      }).toThrow('工具ID不能为空');
    });

    it('应该在参数不是对象时抛出错误', () => {
      expect(() => {
        keyManager.generateKey('tool', null as unknown as Record<string, unknown>);
      }).toThrow('参数必须是一个对象');

      expect(() => {
        keyManager.generateKey('tool', 'invalid' as unknown as Record<string, unknown>);
      }).toThrow('参数必须是一个对象');
    });
  });

  describe('策略管理', () => {
    it('应该设置和获取策略', () => {
      const customStrategy: CacheKeyStrategy = {
        name: 'custom',
        generateKey: (toolId, params) => `custom:${toolId}:${JSON.stringify(params)}`,
      };

      keyManager.setStrategy(customStrategy);
      const currentStrategy = keyManager.getStrategy();

      expect(currentStrategy.name).toBe('custom');
    });

    it('应该在设置无效策略时抛出错误', () => {
      expect(() => {
        keyManager.setStrategy(null as unknown as CacheKeyStrategy);
      }).toThrow('无效的缓存键策略');

      expect(() => {
        keyManager.setStrategy({} as CacheKeyStrategy);
      }).toThrow('无效的缓存键策略');
    });

    it('应该使用自定义策略生成键', () => {
      const customStrategy: CacheKeyStrategy = {
        name: 'custom',
        generateKey: (toolId, params) => `custom_${toolId}_${Object.keys(params).length}`,
      };

      keyManager.setStrategy(customStrategy);
      const key = keyManager.generateKey('test', { a: 1, b: 2 });

      expect(key).toBe('custom_test_2');
    });
  });

  describe('键验证', () => {
    it('应该验证有效的键', () => {
      const key = keyManager.generateKey('test-tool', { param: 'value' });
      const isValid = keyManager.validateKey(key);

      expect(isValid).toBe(true);
    });

    it('应该拒绝无效的键', () => {
      expect(keyManager.validateKey('')).toBe(false);
      expect(keyManager.validateKey(null as unknown as string)).toBe(false);
      expect(keyManager.validateKey(undefined as unknown as string)).toBe(false);
    });

    it('应该使用策略的验证函数', () => {
      const customStrategy: CacheKeyStrategy = {
        name: 'custom',
        generateKey: (toolId, _params) => `${toolId}:custom`,
        validateKey: (key) => key.endsWith(':custom'),
      };

      keyManager.setStrategy(customStrategy);

      expect(keyManager.validateKey('test:custom')).toBe(true);
      expect(keyManager.validateKey('test:invalid')).toBe(false);
    });
  });

  describe('键信息提取', () => {
    it('应该提取键信息', () => {
      const toolId = 'test-tool';
      const key = keyManager.generateKey(toolId, { param: 'value' });
      const keyInfo = keyManager.extractKeyInfo(key);

      expect(keyInfo).toBeDefined();
      expect(keyInfo?.toolId).toBe(toolId);
      expect(keyInfo?.hash).toBeDefined();
    });

    it('应该在无效键时返回null', () => {
      const keyInfo = keyManager.extractKeyInfo('invalid-key');
      expect(keyInfo).toBeNull();
    });
  });

  describe('工具键模式', () => {
    it('应该生成工具键模式', () => {
      const pattern = keyManager.generateToolKeyPattern('test-tool');

      expect(pattern).toBeDefined();
      expect(pattern).toContain('test-tool');
    });

    it('应该在工具ID为空时抛出错误', () => {
      expect(() => {
        keyManager.generateToolKeyPattern('');
      }).toThrow('工具ID不能为空');
    });
  });

  describe('工具键匹配', () => {
    it('应该正确匹配工具的键', () => {
      const toolId = 'test-tool';
      const key = keyManager.generateKey(toolId, { param: 'value' });

      expect(keyManager.isKeyForTool(key, toolId)).toBe(true);
      expect(keyManager.isKeyForTool(key, 'other-tool')).toBe(false);
    });

    it('应该处理无效输入', () => {
      expect(keyManager.isKeyForTool('', 'tool')).toBe(false);
      expect(keyManager.isKeyForTool('key', '')).toBe(false);
    });
  });

  describe('批量键生成', () => {
    it('应该生成多个键', () => {
      const toolId = 'batch-tool';
      const parametersList = [{ param: 'value1' }, { param: 'value2' }, { param: 'value3' }];

      const keys = keyManager.generateKeysForTool(toolId, parametersList);

      expect(keys).toHaveLength(3);
      expect(keys[0]).not.toBe(keys[1]);
      expect(keys[1]).not.toBe(keys[2]);
    });

    it('应该跳过无效的参数对象', () => {
      const toolId = 'batch-tool';
      const parametersList = [
        { param: 'value1' },
        null,
        { param: 'value2' },
        undefined,
        'invalid',
      ] as unknown as Record<string, unknown>[];

      const keys = keyManager.generateKeysForTool(toolId, parametersList);

      expect(keys).toHaveLength(2);
    });

    it('应该在工具ID为空时抛出错误', () => {
      expect(() => {
        keyManager.generateKeysForTool('', []);
      }).toThrow('工具ID不能为空');
    });

    it('应该在参数列表不是数组时抛出错误', () => {
      expect(() => {
        keyManager.generateKeysForTool('tool', null as unknown as Record<string, unknown>[]);
      }).toThrow('参数列表必须是数组');
    });
  });
});

describe('缓存键策略', () => {
  describe('defaultCacheKeyStrategy', () => {
    it('应该生成正确格式的键', () => {
      const key = defaultCacheKeyStrategy.generateKey('test-tool', {
        param: 'value',
      });

      expect(key).toMatch(/^test-tool:[a-f0-9]{16}$/);
    });

    it('应该验证键格式', () => {
      expect(defaultCacheKeyStrategy.validateKey?.('test-tool:1234567890abcdef')).toBe(true);
      expect(defaultCacheKeyStrategy.validateKey?.('invalid-key')).toBe(false);
    });

    it('应该提取键信息', () => {
      const key = 'test-tool:1234567890abcdef';
      const info = defaultCacheKeyStrategy.extractInfo?.(key);

      expect(info).toEqual({
        toolId: 'test-tool',
        hash: '1234567890abcdef',
      });
    });
  });

  describe('simpleCacheKeyStrategy', () => {
    it('应该生成简单格式的键', () => {
      const key = simpleCacheKeyStrategy.generateKey('test-tool', {
        param: 'value',
      });

      expect(key).toMatch(/^test-tool_[a-f0-9]{8}$/);
    });

    it('应该验证简单键格式', () => {
      expect(simpleCacheKeyStrategy.validateKey?.('test-tool_12345678')).toBe(true);
      expect(simpleCacheKeyStrategy.validateKey?.('invalid-key')).toBe(false);
    });
  });

  describe('hierarchicalCacheKeyStrategy', () => {
    it('应该生成层次化格式的键', () => {
      const key = hierarchicalCacheKeyStrategy.generateKey('test-tool', {
        param: 'value',
      });

      expect(key).toMatch(/^default:test-tool:[a-f0-9]{12}$/);
    });

    it('应该使用自定义命名空间', () => {
      const key = hierarchicalCacheKeyStrategy.generateKey('test-tool', {
        namespace: 'custom',
        param: 'value',
      });

      expect(key).toMatch(/^custom:test-tool:[a-f0-9]{12}$/);
    });

    it('应该验证层次化键格式', () => {
      expect(hierarchicalCacheKeyStrategy.validateKey?.('ns:tool:123456789abc')).toBe(true);
      expect(hierarchicalCacheKeyStrategy.validateKey?.('invalid-key')).toBe(false);
    });
  });
});

describe('CacheKeyUtils', () => {
  let keyManager: CacheKeyManager;

  beforeEach(() => {
    keyManager = new CacheKeyManagerImpl();
  });

  describe('filterKeysForTool', () => {
    it('应该过滤出特定工具的键', () => {
      const keys = [
        keyManager.generateKey('tool1', { param: 'value1' }),
        keyManager.generateKey('tool2', { param: 'value2' }),
        keyManager.generateKey('tool1', { param: 'value3' }),
      ];

      const tool1Keys = CacheKeyUtils.filterKeysForTool(keys, 'tool1', keyManager);

      expect(tool1Keys).toHaveLength(2);
    });
  });

  describe('groupKeysByTool', () => {
    it('应该按工具ID分组键', () => {
      const keys = [
        keyManager.generateKey('tool1', { param: 'value1' }),
        keyManager.generateKey('tool2', { param: 'value2' }),
        keyManager.generateKey('tool1', { param: 'value3' }),
      ];

      const groups = CacheKeyUtils.groupKeysByTool(keys, keyManager);

      expect(groups.tool1).toHaveLength(2);
      expect(groups.tool2).toHaveLength(1);
    });
  });

  describe('validateKeys', () => {
    it('应该验证键列表', () => {
      const validKey = keyManager.generateKey('tool', { param: 'value' });
      const keys = [validKey, 'invalid-key'];

      const result = CacheKeyUtils.validateKeys(keys, keyManager);

      expect(result.valid).toHaveLength(1);
      expect(result.invalid).toHaveLength(1);
      expect(result.valid[0]).toBe(validKey);
      expect(result.invalid[0]).toBe('invalid-key');
    });
  });

  describe('generateKeyStats', () => {
    it('应该生成键统计信息', () => {
      const keys = [
        keyManager.generateKey('tool1', { param: 'value1' }),
        keyManager.generateKey('tool2', { param: 'value2' }),
        keyManager.generateKey('tool1', { param: 'value3' }),
        'invalid-key',
      ];

      const stats = CacheKeyUtils.generateKeyStats(keys, keyManager);

      expect(stats.total).toBe(4);
      expect(stats.valid).toBe(3);
      expect(stats.invalid).toBe(1);
      expect(stats.toolGroups.tool1).toBe(2);
      expect(stats.toolGroups.tool2).toBe(1);
    });
  });
});

describe('createCacheKeyManager', () => {
  it('应该创建默认策略的管理器', () => {
    const manager = createCacheKeyManager();
    const strategy = manager.getStrategy();

    expect(strategy.name).toBe('default');
  });

  it('应该创建简单策略的管理器', () => {
    const manager = createCacheKeyManager('simple');
    const strategy = manager.getStrategy();

    expect(strategy.name).toBe('simple');
  });

  it('应该创建层次化策略的管理器', () => {
    const manager = createCacheKeyManager('hierarchical');
    const strategy = manager.getStrategy();

    expect(strategy.name).toBe('hierarchical');
  });

  it('应该对未知策略使用默认策略', () => {
    const manager = createCacheKeyManager('unknown');
    const strategy = manager.getStrategy();

    expect(strategy.name).toBe('default');
  });
});

describe('错误处理', () => {
  let keyManager: CacheKeyManager;

  beforeEach(() => {
    keyManager = new CacheKeyManagerImpl();
  });

  it('应该处理循环引用对象', () => {
    const circularObj: Record<string, unknown> = {};
    circularObj.self = circularObj;

    expect(() => {
      keyManager.generateKey('test', circularObj);
    }).toThrow();
  });

  it('应该处理大型对象', () => {
    const largeObj = {
      data: 'x'.repeat(10000),
      array: Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        value: `item-${i}`,
      })),
    };

    const key = keyManager.generateKey('large-test', largeObj);

    expect(key).toBeDefined();
    expect(typeof key).toBe('string');
  });

  it('应该处理特殊字符', () => {
    const specialParams = {
      unicode: '你好世界',
      emoji: '🚀🎉',
      special: '!@#$%^&*()',
    };

    const key = keyManager.generateKey('special-test', specialParams);

    expect(key).toBeDefined();
    expect(typeof key).toBe('string');
  });
});

describe('性能测试', () => {
  let keyManager: CacheKeyManager;

  beforeEach(() => {
    keyManager = new CacheKeyManagerImpl();
  });

  it('应该快速生成大量键', () => {
    const startTime = Date.now();
    const keys: string[] = [];

    for (let i = 0; i < 1000; i++) {
      const key = keyManager.generateKey('perf-test', {
        index: i,
        data: `value-${i}`,
      });
      keys.push(key);
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    expect(keys).toHaveLength(1000);
    expect(duration).toBeLessThan(1000); // 应该在1秒内完成
  });

  it('应该处理并发键生成', async () => {
    const promises = Array.from({ length: 100 }, (_, i) =>
      Promise.resolve(keyManager.generateKey('concurrent-test', { index: i })),
    );

    const keys = await Promise.all(promises);

    expect(keys).toHaveLength(100);
    expect(new Set(keys).size).toBe(100); // 所有键都应该是唯一的
  });
});
