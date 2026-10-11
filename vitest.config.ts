import { defineConfig } from 'vitest/config';

import { e2eProjects } from './backend/vitest.e2e.config.js';

export default defineConfig({
  test: {
    // coverage 默认配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        'vitest.config.*',
        'vitest.setup.*',
        'test/',
      ],
    },

    // 项目定义
    //   e2e 项目经 backend/vitest.e2e.config.ts 导出的内联配置数组展开（4 个独立 project：
    //   api-e2e / api-e2e-oauth / api-e2e-validation / api-e2e-outbound，各自隔离端口+setup）。
    projects: [
      './packages/share/vitest.config.ts',
      './packages/protocol/vitest.config.ts',
      './packages/core/vitest.config.ts',
      './packages/cli/vitest.config.ts',
      './backend/vitest.config.ts',
      ...e2eProjects,
      './frontend/vitest.config.ts',
    ],
  },
});
