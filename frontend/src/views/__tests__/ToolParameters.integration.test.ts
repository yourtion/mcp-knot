import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { InputNumber } from 'tdesign-vue-next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';

import ToolExecute from '../ToolExecute.vue';
import ToolTest from '../ToolTest.vue';

import type { ToolInfo } from '@/types/tool';

const api = vi.hoisted(() => ({ getToolDetail: vi.fn(), executeTool: vi.fn(), testTool: vi.fn() }));
vi.mock('@/services/tool', () => api);
vi.mock('tdesign-vue-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tdesign-vue-next')>()),
  MessagePlugin: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

const tool: ToolInfo = {
  name: 'search',
  description: 'Search',
  serverId: 'test-server',
  status: 'available',
  inputSchema: {
    type: 'object',
    required: ['limit', 'enabled'],
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', default: 0, minimum: 0, maximum: 10 },
      enabled: { type: 'boolean', default: false },
      unused: { type: 'string' },
    },
  },
};

async function open(mode: 'execute' | 'test') {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools/:toolName/execute', name: 'ToolExecute', component: ToolExecute },
      { path: '/tools/:toolName/test', name: 'ToolTest', component: ToolTest },
      { path: '/tools/:toolName', name: 'ToolDetail', component: { template: '<div />' } },
    ],
  });
  await router.push(`/tools/search/${mode}`);
  await router.isReady();
  const wrapper = mount(mode === 'execute' ? ToolExecute : ToolTest, {
    global: {
      plugins: [createPinia(), router],
      stubs: {
        TLoading: true,
        ExecutionDetail: {
          props: ['execution'],
          template: '<pre class="execution-result">{{ execution.toolName }}</pre>',
        },
      },
    },
  });
  await flushPromises();
  return { wrapper, router };
}

describe('tool execution/test parameter integration', () => {
  beforeEach(() => {
    api.getToolDetail.mockReset().mockImplementation(async (name) => ({ ...tool, name }));
    api.executeTool.mockReset().mockImplementation(async (name) => ({
      toolName: name,
      executionId: 'one',
      result: [],
      isError: false,
    }));
    api.testTool.mockReset().mockResolvedValue({
      validation: { isValid: true, errors: [], warnings: [] },
      canExecute: true,
      serverId: 'test-server',
      serverStatus: 'connected',
    });
  });

  it.each(['execute', 'test'] as const)(
    '%s sends validated, typed arguments through the existing service',
    async (mode) => {
      const { wrapper } = await open(mode);
      const action = wrapper
        .findAll('button')
        .find((button) => button.text() === (mode === 'execute' ? '执行' : '验证参数'))!;
      await action.trigger('click');
      await flushPromises();
      expect(mode === 'execute' ? api.executeTool : api.testTool).toHaveBeenCalledWith('search', {
        arguments: { limit: 0, enabled: false },
      });
      wrapper.unmount();
    },
  );

  it.each(['execute', 'test'] as const)(
    '%s blocks invalid input before making an API call',
    async (mode) => {
      const { wrapper } = await open(mode);
      wrapper.findComponent(InputNumber).vm.$emit('update:modelValue', 11);
      await flushPromises();
      await wrapper
        .findAll('button')
        .find((button) => button.text() === (mode === 'execute' ? '执行' : '验证参数'))!
        .trigger('click');
      expect(api.executeTool).not.toHaveBeenCalled();
      expect(api.testTool).not.toHaveBeenCalled();
      expect(wrapper.find('[role="alert"]').text()).toContain('/limit');
      wrapper.unmount();
    },
  );

  it('uses JSON fallback for primitive arrays and never submits malformed JSON', async () => {
    api.getToolDetail.mockResolvedValue({
      ...tool,
      inputSchema: {
        type: 'object',
        required: ['tags'],
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      },
    });
    const { wrapper } = await open('execute');
    const action = wrapper.findAll('button').find((button) => button.text() === '执行')!;
    await wrapper.find('textarea').setValue('{bad');
    await action.trigger('click');
    expect(api.executeTool).not.toHaveBeenCalled();
    await wrapper.find('textarea').setValue('{"tags":["vue","mcp"]}');
    await action.trigger('click');
    await flushPromises();
    expect(api.executeTool).toHaveBeenCalledWith('search', { arguments: { tags: ['vue', 'mcp'] } });
    wrapper.unmount();
  });

  it('resets JSON drafts to schema defaults', async () => {
    const { wrapper } = await open('execute');
    await wrapper.find('.parameter-editor__toolbar button').trigger('click');
    await wrapper.find('textarea').setValue('{"limit":5,"enabled":true}');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '重置')!
      .trigger('click');
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '执行')!
      .trigger('click');
    await flushPromises();
    expect(api.executeTool).toHaveBeenCalledWith('search', {
      arguments: { limit: 0, enabled: false },
    });
    wrapper.unmount();
  });

  it('keeps optional parameter selection through parent v-model updates', async () => {
    const { wrapper } = await open('execute');
    await wrapper.find('input[aria-label="启用 unused"]').setValue(true);
    await flushPromises();
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '执行')!
      .trigger('click');
    await flushPromises();
    expect(api.executeTool).toHaveBeenCalledWith('search', {
      arguments: { limit: 0, enabled: false, unused: '' },
    });
    wrapper.unmount();
  });

  it('ignores tool details that arrive after a newer route request', async () => {
    const { wrapper, router } = await open('execute');
    let finish: (value: ToolInfo) => void = () => {};
    api.getToolDetail.mockImplementation((name) =>
      name === 'slow'
        ? new Promise<ToolInfo>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ ...tool, name }),
    );
    await router.push('/tools/slow/execute');
    await router.push('/tools/new/execute');
    await flushPromises();
    finish({ ...tool, name: 'slow' });
    await flushPromises();
    expect(wrapper.find('.mcp-page__title').text()).toContain('new');
    wrapper.unmount();
  });

  it('reloads on route changes and ignores results from the previous tool', async () => {
    let finish: (value: unknown) => void = () => {};
    api.executeTool.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const { wrapper, router } = await open('execute');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === '执行')!
      .trigger('click');
    await router.push('/tools/next/execute');
    await flushPromises();
    finish({ toolName: 'search', executionId: 'old', result: [], isError: false });
    await flushPromises();
    expect(api.getToolDetail).toHaveBeenLastCalledWith('next', undefined);
    expect(wrapper.find('.mcp-page__title').text()).toContain('next');
    expect(wrapper.find('.execution-result').exists()).toBe(false);
    wrapper.unmount();
  });
});
