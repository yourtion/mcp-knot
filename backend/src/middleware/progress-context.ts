import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '../utils/logger.js';

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

interface ProgressRelay {
  active: boolean;
  pending: Promise<void>;
  onProgress: (update: ProgressUpdate) => void;
}

const progressStore = new AsyncLocalStorage<ProgressRelay | undefined>();

/** Request-local callbacks keep shared upstream clients from mixing callers' tokens. */
export async function runWithProgressContext<T>(
  options: {
    progressToken?: unknown;
    notify?: (update: ProgressUpdate & { progressToken: string | number }) => Promise<void>;
    signal?: AbortSignal;
  },
  operation: () => Promise<T>,
): Promise<T> {
  const { progressToken, notify, signal } = options;
  const validToken =
    typeof progressToken === 'string' ||
    (typeof progressToken === 'number' && Number.isFinite(progressToken));
  if (!validToken || !notify) return progressStore.run(undefined, operation);

  const relay: ProgressRelay = {
    active: !signal?.aborted,
    pending: Promise.resolve(),
    onProgress(update) {
      if (!relay.active) return;
      relay.pending = relay.pending
        .then(async () => {
          if (!signal?.aborted) await notify({ ...update, progressToken });
        })
        .catch((error: unknown) => {
          // A notification transport failure must not retry an already executed
          // tool or produce an unhandled rejection in the SDK's void callback.
          logger.warn('Failed to forward tool progress', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
  };
  const stop = () => {
    relay.active = false;
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    return await progressStore.run(relay, operation);
  } finally {
    stop();
    signal?.removeEventListener('abort', stop);
    // Flush queued notifications before the final tool result closes the stream.
    await relay.pending;
  }
}

export function getProgressCallback(): ((update: ProgressUpdate) => void) | undefined {
  const relay = progressStore.getStore();
  return relay?.active ? relay.onProgress : undefined;
}
