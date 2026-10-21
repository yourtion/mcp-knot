import { defineConfig } from 'vitest/config';

import { mutationRoots } from './stryker.config.mjs';

// Reuse each package's existing unit-test configuration. Protocol E2E projects
// use fixed server ports and continue to run in the regular test/CI workflows.
export default defineConfig({
  test: {
    projects: mutationRoots.map((root: string) => `./${root}/vitest.config.ts`),
  },
});
