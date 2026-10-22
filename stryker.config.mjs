const projectRoots = {
  share: 'packages/share',
  protocol: 'packages/protocol',
  core: 'packages/core',
  cli: 'packages/cli',
  backend: 'backend',
  frontend: 'frontend',
};

export const mutationProject = process.env.MUTATION_PROJECT ?? 'all';

if (mutationProject !== 'all' && !Object.hasOwn(projectRoots, mutationProject)) {
  throw new Error(`Unknown MUTATION_PROJECT: ${mutationProject}`);
}

export const mutationRoots =
  mutationProject === 'all' ? Object.values(projectRoots) : [projectRoots[mutationProject]];

const reportDirectory = `reports/mutation/${mutationProject}`;

export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  vitest: {
    configFile: './vitest.mutation.config.ts',
    // These packages' import graphs were checked against per-test and static
    // coverage before enabling related-test selection for expensive full runs.
    related: mutationProject === 'backend' || mutationProject === 'core',
  },
  mutate: [
    ...mutationRoots.flatMap((root) => [`${root}/src/**/*.ts`, `${root}/src/**/*.tsx`]),
    '!**/*.d.ts',
    '!**/*.test.ts',
    '!**/*.test.tsx',
    '!**/*.spec.ts',
    '!**/*.spec.tsx',
    '!**/__fixtures__/**',
    '!**/test-utils/**',
    '!packages/core/src/api-to-mcp/integration/mock-api-server.ts',
    '!backend/src/e2e/**',
    '!backend/src/integration/**',
    '!backend/src/test-app.ts',
    // 启动引导入口：import 即拉起服务器/应用，单元测试不可行（与 test-app.ts 同类）
    '!backend/src/index.ts',
    '!frontend/src/index.ts',
    '!frontend/src/test-setup.ts',
  ],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: `${reportDirectory}/mutation.html` },
  jsonReporter: { fileName: `${reportDirectory}/mutation.json` },
  incremental: true,
  incrementalFile: `${reportDirectory}/stryker-incremental.json`,
  ignorePatterns: ['.stryker-tmp', 'reports/mutation', 'coverage'],
  concurrency: 2,
  timeoutMS: 10000,
  tempDirName: `.stryker-tmp/${mutationProject}`,
};
