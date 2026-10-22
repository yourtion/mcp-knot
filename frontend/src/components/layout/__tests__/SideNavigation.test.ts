import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import SideNavigation from '../SideNavigation.vue';

const createTestRouter = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/dashboard', component: { template: '<div>Dashboard</div>' } },
      { path: '/servers', component: { template: '<div>Servers</div>' } },
      { path: '/tools', component: { template: '<div>Tools</div>' } },
      { path: '/skills', component: { template: '<div>Skills</div>' } },
      { path: '/groups', component: { template: '<div>Groups</div>' } },
      { path: '/api-to-mcp', component: { template: '<div>ApiToMcp</div>' } },
      { path: '/debug', component: { template: '<div>Debug</div>' } },
      { path: '/config', component: { template: '<div>Config</div>' } },
    ],
  });

describe('SideNavigation', () => {
  let router: ReturnType<typeof createTestRouter>;

  beforeEach(async () => {
    router = createTestRouter();
    router.push('/dashboard');
    await router.isReady();
  });

  it('should render the logo area with MCP Knot text when expanded', () => {
    const wrapper = mount(SideNavigation, {
      props: { collapsed: false },
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.side-navigation__logo').exists()).toBe(true);
    expect(wrapper.find('.side-navigation__logo-text').exists()).toBe(true);
    expect(wrapper.find('.side-navigation__logo-text').text()).toBe('MCP Knot');
  });

  it('should hide MCP Knot text when collapsed', () => {
    const wrapper = mount(SideNavigation, {
      props: { collapsed: true },
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.side-navigation__logo-text').exists()).toBe(false);
  });

  it('should render the side-navigation container', () => {
    const wrapper = mount(SideNavigation, {
      props: { collapsed: false },
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.side-navigation').exists()).toBe(true);
  });

  it('should render all navigation items as text', () => {
    const wrapper = mount(SideNavigation, {
      props: { collapsed: false },
      global: {
        plugins: [router],
      },
    });

    const text = wrapper.text();
    expect(text).toContain('仪表板');
    expect(text).toContain('服务器管理');
    expect(text).toContain('工具管理');
    expect(text).toContain('技能管理');
    expect(text).toContain('组管理');
  });

  it('should render the logo icon', () => {
    const wrapper = mount(SideNavigation, {
      props: { collapsed: false },
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.side-navigation__logo-icon').exists()).toBe(true);
  });

  it('should navigate via router when menu change fires', async () => {
    const pushSpy = vi.spyOn(router, 'push');

    const wrapper = mount(SideNavigation, {
      props: { collapsed: false },
      global: {
        plugins: [router],
      },
    });

    // Simulate menu change by calling the handler directly
    const vm = wrapper.vm as unknown as {
      handleMenuChange: (value: string | number) => void;
    };
    vm.handleMenuChange('/servers');

    expect(pushSpy).toHaveBeenCalledWith('/servers');
  });
});
