import { createRouter, createWebHistory } from 'vue-router';

import MainLayout from '@/components/layout/MainLayout.vue';
import { useAuthStore } from '@/stores/auth';
import Login from '@/views/Login.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: Login,
      meta: {
        requiresAuth: false,
        title: '登录',
      },
    },
    {
      path: '/',
      component: MainLayout,
      meta: { requiresAuth: true },
      children: [
        {
          path: '',
          redirect: '/dashboard',
        },
        {
          path: 'dashboard',
          name: 'Dashboard',
          component: () => import('@/views/Dashboard.vue'),
          meta: {
            title: '仪表板',
          },
        },
        {
          path: 'servers',
          name: 'Servers',
          component: () => import('@/views/Servers.vue'),
          meta: {
            title: '服务器管理',
          },
        },
        {
          path: 'tools',
          name: 'Tools',
          component: () => import('@/views/Tools.vue'),
          meta: {
            title: '工具管理',
          },
        },
        {
          path: 'tools/:toolName/detail',
          name: 'ToolDetail',
          component: () => import('@/views/ToolDetail.vue'),
          meta: {
            title: '工具详情',
          },
        },
        {
          path: 'tools/:toolName/test',
          name: 'ToolTest',
          component: () => import('@/views/ToolTest.vue'),
          meta: {
            title: '工具测试',
          },
        },
        {
          path: 'tools/:toolName/execute',
          name: 'ToolExecute',
          component: () => import('@/views/ToolExecute.vue'),
          meta: {
            title: '工具执行',
          },
        },
        {
          path: 'skills',
          name: 'Skills',
          component: () => import('@/views/Skills.vue'),
          meta: { title: '技能管理' },
        },
        {
          path: 'groups',
          name: 'Groups',
          component: () => import('@/views/Groups.vue'),
          meta: {
            title: '组管理',
          },
        },
        {
          path: 'api-to-mcp',
          name: 'ApiToMcp',
          component: () => import('@/views/ApiToMcp.vue'),
          meta: {
            title: 'API到MCP管理',
          },
        },
        {
          path: 'debug',
          name: 'Debug',
          component: () => import('@/views/Debug.vue'),
          meta: {
            title: '调试工具',
          },
        },
        {
          path: 'config',
          name: 'Config',
          component: () => import('@/views/Config.vue'),
          meta: {
            title: '系统配置',
          },
        },
      ],
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      component: () => import('@/views/NotFound.vue'),
      meta: {
        title: '页面未找到',
      },
    },
  ],
});

router.beforeEach(async (to, _from, next) => {
  const authStore = useAuthStore();

  if (to.meta.title) {
    document.title = `${to.meta.title} - MCP Knot`;
  }

  if (to.name === 'Login' && authStore.isAuthenticated) {
    next('/dashboard');
    return;
  }

  if (to.meta.requiresAuth) {
    if (!authStore.isAuthenticated) {
      const isValid = await authStore.validateToken();
      if (!isValid) {
        next({
          name: 'Login',
          query: { redirect: to.fullPath },
        });
        return;
      }
    }
  }

  next();
});

export default router;
