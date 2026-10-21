/**
 * Backend 包 Vitest setup 文件
 * 负责 backend 特有的清理逻辑，通用清理由根 vitest.setup.ts 处理
 */
import { afterAll, afterEach } from 'vitest';

/**
 * Backend 专用的清理函数
 * 清理配置实例和 dashboard 服务
 * E2E 测试服务器由各 E2E project 的 setup 管理生命周期。
 * 使用 try-catch 容错，因为测试文件可能 mock 了相关模块
 */
async function cleanupBackendTestState(): Promise<void> {
  const results = await Promise.allSettled([
    import('./src/utils/config.js'),
    import('./src/api/dashboard/index.js'),
  ]);

  // 清理配置实例
  if (results[0].status === 'fulfilled') {
    const configModule = results[0].value;
    if ('resetConfigInstances' in configModule) {
      configModule.resetConfigInstances();
    }
  }

  // 清理 dashboard 服务
  if (results[1].status === 'fulfilled') {
    const dashboardModule = results[1].value;
    dashboardModule.shutdownDashboardServices?.();
  }
}

afterEach(async () => {
  await cleanupBackendTestState();
});

afterAll(async () => {
  await cleanupBackendTestState();
});
