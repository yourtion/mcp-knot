import { mergeConfig } from 'vitest/config';

import configShared from '../../vitest.shared.js';

export default mergeConfig(configShared, {
  test: {
    name: 'protocol',
    include: ['src/**/*.test.ts'],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['node_modules/', 'dist/', '**/*.d.ts', '**/*.test.ts', 'vitest.config.ts'],
      thresholds: {
        global: {
          branches: 80,
          functions: 80,
          lines: 80,
          statements: 80,
        },
      },
    },
  },
});
