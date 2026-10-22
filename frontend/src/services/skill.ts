import { isAxiosError } from 'axios';

import api, { handleApiResponse } from './api';

import type { ApiResponse } from '@/types/api';
import type { SkillRevision, SkillSource, SkillSourceInfo, SkillSourceInput } from '@/types/skill';

// Imports may run several Git/npm commands, each with a 120-second backend limit.
const importTimeout = 10 * 60 * 1000;
const sourcePath = (id: string) => `/skills/sources/${encodeURIComponent(id)}`;

export const skillService = {
  async listSources(): Promise<SkillSourceInfo[]> {
    return handleApiResponse(await api.get('/skills/sources'));
  },
  async saveSource(source: SkillSourceInput): Promise<SkillSource> {
    return handleApiResponse(await api.post('/skills/sources', source));
  },
  async syncSource(id: string, operation: 'sync' | 'update' = 'sync'): Promise<SkillRevision> {
    return handleApiResponse(
      await api.post(`${sourcePath(id)}/${operation}`, undefined, { timeout: importTimeout }),
    );
  },
  async listRevisions(id: string): Promise<SkillRevision[]> {
    return handleApiResponse(await api.get(`${sourcePath(id)}/revisions`));
  },
};

export function skillErrorMessage(error: unknown): string {
  if (isAxiosError<ApiResponse<unknown>>(error)) {
    if (error.code === 'ECONNABORTED')
      return '请求超时，服务端可能仍在导入。请稍后刷新来源状态后再重试。';
    return error.response?.data.error?.message || error.message;
  }
  return error instanceof Error ? error.message : '操作失败，请重试';
}
