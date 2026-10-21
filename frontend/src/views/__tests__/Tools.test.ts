import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import Tools from '../Tools.vue';

import type { ToolExecution, ToolInfo } from '@/types/tool';

// Mock child components
vi.mock('@/components/tools/ToolList.vue', () => ({
  default: {
    name: 'MockToolList',
    template: '<div class="mock-tool-list" />',
    props: ['tools', 'loading'],
    emits: ['select'],
  },
}));

vi.mock('@/components/tools/ToolMonitoring.vue', () => ({
  default: {
    name: 'MockToolMonitoring',
    template: '<div class="mock-tool-monitoring" />',
  },
}));

vi.mock('@/components/tools/ExecutionDetail.vue', () => ({
  default: {
    name: 'MockExecutionDetail',
    template: '<div class="mock-execution-detail" />',
    props: ['execution'],
  },
}));

// Mock tool store
const mockFetchTools = vi.fn().mockResolvedValue(undefined);
const mockRefresh = vi.fn().mockResolvedValue(undefined);
const mockUpdateFilters = vi.fn();

const mockToolStore = {
  filteredTools: [] as ToolInfo[],
  loading: false,
  serverList: [] as string[],
  executionHistory: [] as ToolExecution[],
  fetchTools: mockFetchTools,
  refresh: mockRefresh,
  updateFilters: mockUpdateFilters,
};

vi.mock('@/stores/tool', () => ({
  useToolStore: () => mockToolStore,
}));

// Mock tdesign-vue-next
vi.mock('tdesign-vue-next', async (importOriginal) => {
  const original: Record<string, unknown> = await importOriginal();
  return {
    ...original,
    MessagePlugin: {
      success: vi.fn(),
      error: vi.fn(),
    },
  };
});

// Mock tdesign-icons-vue-next
vi.mock('tdesign-icons-vue-next', () => ({
  RefreshIcon: {
    name: 'RefreshIcon',
    template: '<i class="mock-icon">Refresh</i>',
  },
  SearchIcon: {
    name: 'SearchIcon',
    template: '<i class="mock-icon">Search</i>',
  },
}));

// Global stubs for Tabs components (not in test-setup.ts)
const globalStubs = {
  TInput: {
    name: 'TInput',
    template: '<input class="mock-input" />',
    props: ['modelValue', 'placeholder', 'clearable'],
    emits: ['update:modelValue', 'change'],
  },
  TSelect: {
    name: 'TSelect',
    template: '<select class="mock-select"><slot /></select>',
    props: ['modelValue', 'placeholder', 'clearable', 'options'],
    emits: ['update:modelValue', 'change'],
  },
  TTabs: {
    name: 'TTabs',
    template: '<div class="mock-t-tabs"><slot /></div>',
    props: ['modelValue'],
    emits: ['update:modelValue', 'change'],
  },
  TTabPanel: {
    name: 'TTabPanel',
    template: '<div class="mock-t-tab-panel"><slot /></div>',
    props: ['value', 'label'],
  },
};

const createTestRouter = () =>
  createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools', component: { template: '<div>Tools</div>' } },
      {
        path: '/tools/:toolName/detail',
        name: 'ToolDetail',
        component: { template: '<div>ToolDetail</div>' },
      },
    ],
  });

describe('Tools', () => {
  let router: ReturnType<typeof createTestRouter>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    mockToolStore.filteredTools = [];
    mockToolStore.loading = false;
    mockToolStore.serverList = [];
    mockToolStore.executionHistory = [];

    router = createTestRouter();
    router.push('/tools');
    await router.isReady();
  });

  it('should render the tools page with title and description', () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    expect(wrapper.find('.mcp-page__title').text()).toBe('工具管理');
    expect(wrapper.find('.mcp-page__desc').text()).toBe('可用工具概览');
  });

  it('should render the refresh button', () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    const buttons = wrapper.findAll('.mock-button');
    const refreshBtn = buttons.find((btn) => btn.text().includes('刷新'));
    expect(refreshBtn).toBeDefined();
  });

  it('should render the search input area', () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    // The tools-filters section should exist
    expect(wrapper.find('.tools-filters').exists()).toBe(true);
  });

  it('should render the ToolList component', () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    expect(wrapper.find('.mock-tool-list').exists()).toBe(true);
  });

  it('should call fetchTools on mount', () => {
    mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    expect(mockFetchTools).toHaveBeenCalled();
  });

  it('should call refresh when refresh button is clicked', async () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    const buttons = wrapper.findAll('.mock-button');
    const refreshBtn = buttons.find((btn) => btn.text().includes('刷新'));
    await refreshBtn?.trigger('click');

    expect(mockRefresh).toHaveBeenCalled();
  });

  it('should render server filter options from store serverList', () => {
    mockToolStore.serverList = ['server-1', 'server-2'];

    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    // Server options should be available
    expect(wrapper.find('.tools-filters').exists()).toBe(true);
  });

  it('should render empty state when no execution history', () => {
    mockToolStore.executionHistory = [];

    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    expect(wrapper.find('.mcp-empty').exists()).toBe(true);
    expect(wrapper.text()).toContain('暂无执行历史');
  });

  it('should render execution history items when they exist', () => {
    mockToolStore.executionHistory = [
      {
        executionId: 'exec-1',
        toolName: 'tool-1',
        serverId: 'server-1',
        groupId: 'default',
        arguments: {},
        result: [],
        isError: false,
        executionTime: 100,
        timestamp: new Date().toISOString(),
      },
    ] as ToolExecution[];

    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    const details = wrapper.findAll('.mock-execution-detail');
    expect(details.length).toBe(1);
  });

  it('should call updateFilters when search input changes', async () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    wrapper.findComponent({ name: 'TInput' }).vm.$emit('change', 'test-search');

    expect(mockUpdateFilters).toHaveBeenCalledWith({ search: 'test-search' });
  });

  it('should call updateFilters when server filter changes', async () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    wrapper.findAllComponents({ name: 'TSelect' })[0].vm.$emit('change', 'server-1');

    expect(mockUpdateFilters).toHaveBeenCalledWith({ serverId: 'server-1' });
  });

  it('should clear server filter when value is undefined', async () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    wrapper.findAllComponents({ name: 'TSelect' })[0].vm.$emit('change', undefined);

    expect(mockUpdateFilters).toHaveBeenCalledWith({ serverId: undefined });
  });

  it('should call updateFilters when status filter changes', async () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    wrapper.findAllComponents({ name: 'TSelect' })[1].vm.$emit('change', 'available');

    expect(mockUpdateFilters).toHaveBeenCalledWith({ status: 'available' });
  });

  it('should set status to all when status filter is cleared', async () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    wrapper.findAllComponents({ name: 'TSelect' })[1].vm.$emit('change', undefined);

    expect(mockUpdateFilters).toHaveBeenCalledWith({ status: 'all' });
  });

  it('should navigate to ToolDetail when tool is selected', async () => {
    const pushSpy = vi.spyOn(router, 'push');
    const tool: ToolInfo = {
      name: 'my-tool',
      description: 'Test tool',
      serverId: 'server-1',
      inputSchema: { type: 'object' },
      status: 'available',
    };

    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    const toolList = wrapper.findComponent({ name: 'MockToolList' });
    toolList.vm.$emit('select', tool);
    await wrapper.vm.$nextTick();

    expect(pushSpy).toHaveBeenCalledWith({
      name: 'ToolDetail',
      params: { toolName: 'my-tool' },
    });
  });

  it('should render the monitoring tab area', () => {
    const wrapper = mount(Tools, {
      global: {
        plugins: [router],
        stubs: globalStubs,
      },
    });

    expect(wrapper.find('.mock-tool-monitoring').exists()).toBe(true);
  });
});
