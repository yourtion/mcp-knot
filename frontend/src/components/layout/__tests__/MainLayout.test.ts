import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import MainLayout from '../MainLayout.vue';

// Mock child components to isolate tests
vi.mock('../SideNavigation.vue', () => ({
  default: {
    name: 'MockSideNav',
    template: '<div class="mock-side-nav" :collapsed="collapsed" />',
    props: ['collapsed'],
  },
}));

vi.mock('../AppHeader.vue', () => ({
  default: {
    name: 'MockAppHeader',
    template: '<div class="mock-app-header" />',
    props: ['collapsed'],
    emits: ['toggle-sidebar'],
  },
}));

const createTestRouter = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', redirect: '/dashboard' },
      { path: '/dashboard', component: { template: '<div>Dashboard</div>' } },
      { path: '/servers', component: { template: '<div>Servers</div>' } },
    ],
  });

const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
};

describe('MainLayout', () => {
  let router: ReturnType<typeof createTestRouter>;

  beforeEach(async () => {
    vi.stubGlobal('localStorage', localStorageMock);
    localStorageMock.getItem.mockReturnValue(null);
    router = createTestRouter();
    router.push('/dashboard');
    await router.isReady();
  });

  it('should render sidebar and main content areas', () => {
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.sidebar').exists()).toBe(true);
    expect(wrapper.find('.main-content').exists()).toBe(true);
    expect(wrapper.find('.page-content').exists()).toBe(true);
  });

  it('should read collapsed state from localStorage on mount', async () => {
    localStorageMock.getItem.mockImplementation((key: string) =>
      key === 'sidebar_collapsed' ? 'true' : null,
    );

    const wrapper = mount(MainLayout, {
      global: {
        plugins: [router],
      },
    });

    await wrapper.vm.$nextTick();

    const sidebar = wrapper.find('.sidebar');
    expect(sidebar.classes()).toContain('collapsed');
  });

  it('should default to expanded sidebar when no localStorage value', () => {
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.sidebar').classes()).not.toContain('collapsed');
  });

  it('should toggle sidebar collapsed state and persist to localStorage', async () => {
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.sidebar').classes()).not.toContain('collapsed');

    wrapper.findComponent({ name: 'MockAppHeader' }).vm.$emit('toggle-sidebar');
    await wrapper.vm.$nextTick();

    expect(wrapper.find('.sidebar').classes()).toContain('collapsed');
    expect(localStorageMock.setItem).toHaveBeenCalledWith('sidebar_collapsed', 'true');
  });

  it('should render router-view content inside page-content', () => {
    const wrapper = mount(MainLayout, {
      global: {
        plugins: [router],
      },
    });

    expect(wrapper.find('.page-content').exists()).toBe(true);
  });

  it('should pass collapsed prop to SideNavigation', async () => {
    localStorageMock.getItem.mockImplementation((key: string) =>
      key === 'sidebar_collapsed' ? 'true' : null,
    );

    const wrapper = mount(MainLayout, {
      global: {
        plugins: [router],
      },
    });

    await wrapper.vm.$nextTick();

    const sideNav = wrapper.find('.mock-side-nav');
    expect(sideNav.attributes('collapsed')).toBe('true');
  });
});
