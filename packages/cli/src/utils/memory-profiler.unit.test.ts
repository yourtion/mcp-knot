/**
 * CLI 内存分析器单元测试
 *
 * 通过 mock process.memoryUsage / Date.now 驱动确定性的内存数字，
 * 覆盖快照记录、泄漏报告与报告摘要打印。
 */

import { UnifiedLogger } from '@mcp-core/mcp-knot-share';
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CliMemoryProfiler, cliMemoryProfiler } from './memory-profiler';

const HEAP_BASE = 1024;

function mockMemorySequence(values: number[]): void {
  const spy = vi.spyOn(process, 'memoryUsage');
  for (const heapUsed of values) {
    spy.mockImplementationOnce(
      () =>
        ({
          heapUsed,
          rss: heapUsed + 10,
          external: 0,
          arrayBuffers: 0,
        }) as NodeJS.MemoryUsage,
    );
  }
}

describe('CliMemoryProfiler', () => {
  let profiler: CliMemoryProfiler;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    // 快照是否采集 fd 取决于 /proc/self/fd 是否存在（Linux 有、macOS 无），
    // 统一 mock 为不可用，保证断言跨平台确定；fd 路径由专门用例覆盖
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    profiler = new CliMemoryProfiler();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('recordBeforeRestart / recordAfterRestart', () => {
    it('应记录重启前后的堆内存并生成快照', () => {
      mockMemorySequence([HEAP_BASE, HEAP_BASE + 2048]);
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});

      profiler.recordBeforeRestart();
      const snapshot = profiler.recordAfterRestart();

      expect(snapshot).toEqual({
        iteration: 1,
        timestamp: new Date('2026-01-01T00:00:00Z').getTime(),
        memoryBefore: HEAP_BASE,
        memoryAfter: HEAP_BASE + 2048,
        memoryDelta: 2048,
        fileDescriptorsBefore: undefined,
      });
    });

    it('未先调用 recordBeforeRestart 时应抛出错误', () => {
      expect(() => profiler.recordAfterRestart()).toThrow('必须先调用 recordBeforeRestart()');
    });

    it('/proc/self/fd 可用时（Linux）快照应记录 fd 数量', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readdirSync').mockReturnValue(['0', '1', '2', '3'] as unknown as string[]);
      mockMemorySequence([HEAP_BASE, HEAP_BASE + 2048]);
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});

      profiler.recordBeforeRestart();
      const snapshot = profiler.recordAfterRestart();

      expect(snapshot.fileDescriptorsBefore).toBe(4);
    });

    it('多次重启时迭代编号应递增', () => {
      mockMemorySequence([HEAP_BASE, HEAP_BASE + 100, HEAP_BASE + 200, HEAP_BASE + 300]);
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});

      profiler.recordBeforeRestart();
      const first = profiler.recordAfterRestart();
      profiler.recordBeforeRestart();
      const second = profiler.recordAfterRestart();

      expect(first.iteration).toBe(1);
      expect(second.iteration).toBe(2);
      expect(second.memoryBefore).toBe(HEAP_BASE + 200);
      expect(second.memoryDelta).toBe(100);
    });

    it('内存增量日志应带正负号区分增长与回落', () => {
      const infoSpy = vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});

      // 增长：after > before，日志带 "+" 前缀
      mockMemorySequence([1024, 2048]);
      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('增量: +1.00 KB'));

      // 回落：after < before，日志无 "+" 前缀（负增量按原始字节输出）
      infoSpy.mockClear();
      mockMemorySequence([2048, 1024]);
      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('增量: -1024.00 B'));
    });

    it('重启前日志应输出格式化后的堆内存与 RSS', () => {
      const debugSpy = vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      mockMemorySequence([2 * 1024 * 1024]);

      profiler.recordBeforeRestart();

      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('堆: 2.00 MB'));
      expect(debugSpy).toHaveBeenCalledWith(expect.stringContaining('RSS: 2.00 MB'));
    });
  });

  describe('generateReport', () => {
    it('无快照时应返回全零且不判定泄漏', () => {
      const report = profiler.generateReport();

      expect(report).toEqual({
        totalIterations: 0,
        totalMemoryGrowth: 0,
        averageGrowthPerIteration: 0,
        leakDetected: false,
        snapshots: [],
      });
    });

    it('应基于首尾快照计算总增长与平均增长', () => {
      mockMemorySequence([
        1000, // 第一轮 before
        2000, // 第一轮 after
        3000, // 第二轮 before
        4000, // 第二轮 after
      ]);
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});

      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();
      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();

      const report = profiler.generateReport();

      expect(report.totalIterations).toBe(2);
      expect(report.totalMemoryGrowth).toBe(4000 - 1000);
      expect(report.averageGrowthPerIteration).toBe((4000 - 1000) / 2);
      expect(report.leakDetected).toBe(false);
      expect(report.snapshots).toHaveLength(2);
    });

    it('平均增长超过 5MB 时应判定泄漏', () => {
      mockMemorySequence([0, 6 * 1024 * 1024]);
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});

      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();

      expect(profiler.generateReport().leakDetected).toBe(true);
    });

    it('平均增长恰好等于 5MB 时不判定泄漏（阈值严格大于）', () => {
      mockMemorySequence([0, 5 * 1024 * 1024]);
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});

      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();

      const report = profiler.generateReport();
      expect(report.averageGrowthPerIteration).toBe(5 * 1024 * 1024);
      expect(report.leakDetected).toBe(false);
    });
  });

  describe('printReportSummary', () => {
    function withLoggerSpies() {
      return {
        info: vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {}),
        warn: vi.spyOn(UnifiedLogger.prototype, 'warn').mockImplementation(() => {}),
        debug: vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {}),
      };
    }

    it('无快照时应打印零迭代的报告头', () => {
      const spies = withLoggerSpies();

      profiler.printReportSummary();

      expect(spies.info).toHaveBeenCalledWith('=== 内存泄漏分析报告 ===');
      expect(spies.info).toHaveBeenCalledWith('总迭代次数: 0');
      expect(spies.info).toHaveBeenCalledWith('总内存增长: 0.00 B');
      expect(spies.info).toHaveBeenCalledWith('平均每次增长: 0.00 B');
      expect(spies.info).toHaveBeenCalledWith('检测到泄漏: 否 ✅');
      expect(spies.warn).not.toHaveBeenCalled();
      // 无快照时不打印“最近 5 次重启”区块
      expect(spies.info).not.toHaveBeenCalledWith('最近 5 次重启的内存变化:');
    });

    it('检测到泄漏时应输出泄漏警告', () => {
      const spies = withLoggerSpies();
      mockMemorySequence([0, 6 * 1024 * 1024]);

      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();

      profiler.printReportSummary();

      expect(spies.info).toHaveBeenCalledWith('检测到泄漏: 是 ⚠️');
      expect(spies.warn).toHaveBeenCalledWith(
        expect.stringContaining('检测到可能的内存泄漏！平均每次重启增长 6.00 MB'),
      );
    });

    it('无泄漏但有迭代时应输出未泄漏结论', () => {
      const spies = withLoggerSpies();
      mockMemorySequence([1024, 2048]);

      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();

      profiler.printReportSummary();

      expect(spies.info).toHaveBeenCalledWith('未检测到明显的内存泄漏 ✅');
      expect(spies.warn).not.toHaveBeenCalled();
    });

    it('快照超过 5 次时只展示最近 5 次', () => {
      const spies = withLoggerSpies();
      // 6 轮重启，每轮内存增长 1KB
      for (let i = 0; i < 6; i++) {
        mockMemorySequence([i * 1024, (i + 1) * 1024]);
        profiler.recordBeforeRestart();
        profiler.recordAfterRestart();
      }

      profiler.printReportSummary();

      expect(spies.info).toHaveBeenCalledWith('最近 5 次重启的内存变化:');
      const iterationLines = spies.info.mock.calls.filter(([msg]) =>
        /^  迭代 \d+:/.test(String(msg)),
      );
      expect(iterationLines).toHaveLength(5);
      expect(iterationLines[0][0]).toContain('迭代 2:');
      expect(iterationLines[4][0]).toContain('迭代 6:');
    });
  });

  describe('reset', () => {
    it('应清空快照与迭代计数', () => {
      mockMemorySequence([1024, 2048]);
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});

      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();
      profiler.reset();

      expect(profiler.generateReport().totalIterations).toBe(0);
      // 重置后未记录 before 再调用应重新抛错
      expect(() => profiler.recordAfterRestart()).toThrow('必须先调用 recordBeforeRestart()');
    });
  });

  describe('getCurrentMemoryUsage', () => {
    it('应返回当前堆内存、RSS 与外部内存', () => {
      vi.spyOn(process, 'memoryUsage').mockImplementation(
        () =>
          ({
            heapUsed: 111,
            rss: 222,
            external: 333,
            arrayBuffers: 0,
          }) as NodeJS.MemoryUsage,
      );

      expect(profiler.getCurrentMemoryUsage()).toEqual({
        heapUsed: 111,
        rss: 222,
        external: 333,
      });
    });
  });

  describe('formatBytes 输出（经日志消息观察）', () => {
    it('应按 1024 进制格式化为 B/KB/MB/GB', () => {
      const infoSpy = vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});

      const cases: Array<[number, string]> = [
        [512, '512.00 B'],
        [1536, '1.50 KB'],
        [5 * 1024 * 1024, '5.00 MB'],
        [3 * 1024 * 1024 * 1024, '3.00 GB'],
      ];

      for (const [before, expected] of cases) {
        infoSpy.mockClear();
        mockMemorySequence([before, before]);
        profiler.recordBeforeRestart();
        profiler.recordAfterRestart();

        expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(`后: ${expected}`));
      }
    });

    it('超过 GB 后单位不再继续放大', () => {
      const infoSpy = vi.spyOn(UnifiedLogger.prototype, 'info').mockImplementation(() => {});
      vi.spyOn(UnifiedLogger.prototype, 'debug').mockImplementation(() => {});

      // 2048 GB：unitIndex 已到 GB 上限，不再引入更大单位
      mockMemorySequence([2048 * 1024 ** 3, 2048 * 1024 ** 3]);
      profiler.recordBeforeRestart();
      profiler.recordAfterRestart();

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('2048.00 GB'));
    });
  });

  describe('全局单例', () => {
    it('应导出可用的全局分析器实例', () => {
      expect(cliMemoryProfiler).toBeInstanceOf(CliMemoryProfiler);
    });
  });
});
