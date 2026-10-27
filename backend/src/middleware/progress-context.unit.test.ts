import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../utils/logger.js';
import { getProgressCallback, runWithProgressContext } from './progress-context.js';

import type { ProgressUpdate } from './progress-context.js';

vi.mock('../utils/logger.js');

describe('request-scoped tool progress', () => {
  beforeEach(() => vi.clearAllMocks());

  it('preserves numeric zero tokens, orders sends and flushes before returning the result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sent: number[] = [];
    const notify = vi.fn(async (update: ProgressUpdate & { progressToken: string | number }) => {
      if (update.progress === 1) await gate;
      sent.push(update.progress);
    });
    let completed = false;
    const running = runWithProgressContext({ progressToken: 0, notify }, async () => {
      const progress = getProgressCallback()!;
      progress(Object.assign({ progress: 1, total: 2 }, { progressToken: 'upstream-token' }));
      progress({ progress: 2, total: 2 });
      return 'tool-result';
    }).then((result) => {
      completed = true;
      return result;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    release();
    expect(await running).toBe('tool-result');
    expect(sent).toEqual([1, 2]);
    expect(notify.mock.calls.map(([update]) => update.progressToken)).toEqual([0, 0]);
    expect(getProgressCallback()).toBeUndefined();
  });

  it('does not inherit an outer caller when a nested operation has no valid progress request', async () => {
    const notify = vi.fn(async () => {});
    await runWithProgressContext({ progressToken: 'outer', notify }, async () => {
      expect(getProgressCallback()).toBeTypeOf('function');
      for (const progressToken of [undefined, null, false, {}, NaN, Infinity]) {
        await runWithProgressContext({ progressToken, notify }, async () => {
          expect(getProgressCallback()).toBeUndefined();
        });
      }
      await runWithProgressContext({ progressToken: 'no-notifier' }, async () => {
        expect(getProgressCallback()).toBeUndefined();
      });
      expect(getProgressCallback()).toBeTypeOf('function');
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('isolates simultaneous callers and ignores captured callbacks after completion', async () => {
    const received = { a: [] as unknown[], b: [] as unknown[] };
    const captured: Array<(update: ProgressUpdate) => void> = [];
    await Promise.all(
      (['a', 'b'] as const).map((progressToken) =>
        runWithProgressContext(
          {
            progressToken,
            notify: async (value) => {
              received[progressToken].push(value);
            },
          },
          async () => {
            await Promise.resolve();
            const callback = getProgressCallback()!;
            captured.push(callback);
            callback({ progress: 1 });
          },
        ),
      ),
    );
    for (const callback of captured) callback({ progress: 999 });
    expect(received.a).toEqual([{ progress: 1, progressToken: 'a' }]);
    expect(received.b).toEqual([{ progress: 1, progressToken: 'b' }]);
    expect(getProgressCallback()).toBeUndefined();
  });

  it('stops on cancellation without changing tool completion or exposing a callback for an already aborted request', async () => {
    const controller = new AbortController();
    const notify = vi.fn(async () => {});
    const result = await runWithProgressContext(
      { progressToken: 'request', notify, signal: controller.signal },
      async () => {
        const callback = getProgressCallback()!;
        callback({ progress: 1 });
        await Promise.resolve();
        controller.abort();
        callback({ progress: 2 });
        return 42;
      },
    );
    expect(result).toBe(42);
    expect(notify).toHaveBeenCalledExactlyOnceWith({ progress: 1, progressToken: 'request' });
    await runWithProgressContext(
      { progressToken: 'aborted', notify, signal: controller.signal },
      async () => {
        expect(getProgressCallback()).toBeUndefined();
      },
    );
  });

  it('handles rejected notifications without rejecting or retrying the completed tool', async () => {
    const notify = vi.fn().mockRejectedValue(new Error('stream closed'));
    const operation = vi.fn(async () => {
      getProgressCallback()!({ progress: 1 });
      return 'done';
    });
    expect(await runWithProgressContext({ progressToken: 'x', notify }, operation)).toBe('done');
    expect(operation).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith('Failed to forward tool progress', {
      error: 'stream closed',
    });
  });

  it('preserves tool errors and closes the progress scope on rejection', async () => {
    const notify = vi.fn(async () => {});
    let callback: ((update: ProgressUpdate) => void) | undefined;
    await expect(
      runWithProgressContext({ progressToken: 'x', notify }, async () => {
        callback = getProgressCallback();
        callback!({ progress: 1 });
        throw new Error('original tool failure');
      }),
    ).rejects.toThrow('original tool failure');
    callback!({ progress: 2 });
    expect(notify).toHaveBeenCalledExactlyOnceWith({ progress: 1, progressToken: 'x' });
    expect(getProgressCallback()).toBeUndefined();
  });
});
