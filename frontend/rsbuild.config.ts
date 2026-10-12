import { defineConfig } from '@rsbuild/core';
import { pluginLess } from '@rsbuild/plugin-less';
import { pluginVue } from '@rsbuild/plugin-vue';
import path from 'node:path';

export default defineConfig({
  plugins: [pluginVue(), pluginLess()],
  source: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
    // 定义全局常量
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'development'),
    },
  },
  server: {
    port: 8180,
    proxy: {
      '/api': {
        target: process.env.MCP_KNOT_DEV_API_URL || 'http://localhost:8181',
        changeOrigin: true,
      },
    },
  },
  html: {
    title: 'MCP Knot 管理界面',
    mountId: 'app',
  },
  performance: {
    // 代码分割配置
    chunkSplit: {
      strategy: 'split-by-experience',
      override: {
        chunks: 'all',
        cacheGroups: {
          // 将Vue相关库打包到一起
          vue: {
            test: /[\\/]node_modules[\\/](vue|vue-router|pinia)[\\/]/,
            name: 'vendor-vue',
            priority: 20,
          },
          // 将TDesign UI库单独打包
          tdesign: {
            test: /[\\/]node_modules[\\/]tdesign-vue-next[\\/]/,
            name: 'vendor-tdesign',
            priority: 15,
          },
          // 其他第三方库
          vendors: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            priority: 10,
          },
        },
      },
    },
    // 预加载和预获取
    preload: {
      type: 'all-chunks',
    },
    prefetch: {
      type: 'async-chunks',
    },
  },
  output: {
    // 生产环境优化
    minify: {
      js: true,
      css: true,
      html: true,
    },
    // 启用source map用于生产环境调试
    sourceMap: {
      js: 'source-map',
      css: true,
    },
    // 文件名hash用于缓存
    filenameHash: true,
    // 清理输出目录
    cleanDistPath: true,
  },
});
