import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import api from './api';
import { skillErrorMessage, skillService } from './skill';

vi.mock('./api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  handleApiResponse: (response: {
    data: { success: boolean; data?: unknown; error?: { message: string } };
  }) => {
    if (!response.data.success) throw new Error(response.data.error?.message);
    return response.data.data;
  },
}));

describe('Skills API service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.post).mockResolvedValue({
      data: { success: true, data: { revision: 'a'.repeat(64) } },
    });
  });

  it('allows long source imports and uses the selected operation', async () => {
    await skillService.syncSource('team');
    expect(api.post).toHaveBeenLastCalledWith('/skills/sources/team/sync', undefined, {
      timeout: 600000,
    });
    await skillService.syncSource('team', 'update');
    expect(api.post).toHaveBeenLastCalledWith('/skills/sources/team/update', undefined, {
      timeout: 600000,
    });
  });

  it('reports backend errors and distinguishes an uncertain timeout from a failed import', () => {
    const backend = Object.assign(new AxiosError('Request failed', 'ERR_BAD_REQUEST'), {
      response: { data: { error: { message: 'Another skills mutation is in progress' } } },
    });
    expect(skillErrorMessage(backend)).toBe('Another skills mutation is in progress');
    expect(skillErrorMessage(new AxiosError('timeout', 'ECONNABORTED'))).toContain(
      '服务端可能仍在导入',
    );
  });
});
