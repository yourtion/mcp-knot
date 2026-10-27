import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { MessagePlugin } from 'tdesign-vue-next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';

import { useToolForm } from '../useToolForm';
import * as toolService from '@/services/tool';

import type { ToolInfo } from '@/types/tool';
import type { UnwrapRef } from 'vue';

vi.mock('tdesign-vue-next', () => ({
  MessagePlugin: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/services/tool', () => ({
  getTools: vi.fn(),
  getToolsByServer: vi.fn(),
  getToolDetail: vi.fn(),
  executeTool: vi.fn(),
  testTool: vi.fn(),
  getToolHistory: vi.fn(),
  getToolStats: vi.fn(),
  getToolMonitoring: vi.fn(),
  getToolPerformance: vi.fn(),
}));

const mockToolService = toolService as unknown as Record<string, ReturnType<typeof vi.fn>>;

const makeTool = (inputSchema: ToolInfo['inputSchema']): ToolInfo => ({
  name: 'demo-tool',
  description: '演示工具',
  serverId: 'server-1',
  inputSchema,
  status: 'available',
});

enableAutoUnmount(afterEach);

const DummyView = defineComponent({ template: '<div />' });

/**
 * 组件实例（vm）上的 setup 返回值会被 proxyRefs 自动解包，
 * 因此按解包后的形状描述 useToolForm 的返回类型。
 */
type ToolFormContext = {
  [K in keyof ReturnType<typeof useToolForm>]: UnwrapRef<ReturnType<typeof useToolForm>[K]>;
};

/**
 * 挂载一个调用 useToolForm 的宿主组件并返回其上下文。
 * detail 传 'reject' 时模拟接口失败。
 */
async function mountToolForm(
  schema?: ToolInfo['inputSchema'],
  detail: 'reject' | 'ok' | 'configured' = 'ok',
) {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/tools/:toolName/test', name: 'ToolTest', component: DummyView },
      { path: '/tools/:toolName/detail', name: 'ToolDetail', component: DummyView },
    ],
  });
  await router.push('/tools/demo-tool/test');
  await router.isReady();

  if (detail === 'reject') {
    mockToolService.getToolDetail.mockRejectedValue(new Error('获取失败'));
  } else if (detail === 'ok') {
    mockToolService.getToolDetail.mockResolvedValue(makeTool(schema ?? { type: 'object' }));
  }

  let context: ToolFormContext | undefined;
  const Host = defineComponent({
    setup() {
      // 直接返回组合式函数结果，通过 vm 访问时 ref 会自动解包
      return useToolForm();
    },
    template: '<div />',
  });

  const wrapper = mount(Host, { global: { plugins: [router] } });
  await flushPromises();

  context = wrapper.vm as unknown as ToolFormContext;
  return { context, router, wrapper };
}

describe('useToolForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
  });

  it('挂载后自动拉取工具详情并填充默认表单值', async () => {
    const { context } = await mountToolForm({
      type: 'object',
      properties: {
        name: { type: 'string', default: 'hello' },
        enabled: { type: 'boolean' },
        tags: { type: 'array', default: ['a', 'b'] },
        plain: { type: 'string' },
      },
      required: ['name'],
    });

    expect(mockToolService.getToolDetail).toHaveBeenCalledWith('demo-tool', undefined);
    expect(context.tool?.name).toBe('demo-tool');
    expect(context.loading).toBe(false);
    expect(context.formData.name).toBe('hello');
    expect(context.formData).not.toHaveProperty('enabled');
    expect(context.formData.tags).toEqual(['a', 'b']);
    expect(context.formData.plain).toBeUndefined();
  });

  it('拉取失败时提示错误并复位加载状态', async () => {
    const { context } = await mountToolForm(undefined, 'reject');

    expect(context.tool).toBeNull();
    expect(context.loading).toBe(false);
    expect(MessagePlugin.error).toHaveBeenCalledWith('获取工具详情失败');
  });

  it('编辑器未就绪时阻止生成参数', async () => {
    const { context } = await mountToolForm();
    context.formData.unchecked = '{not json';
    expect(context.buildArguments()).toBeNull();
  });

  it('编辑器校验失败时不使用上一次草稿兜底', async () => {
    const { context } = await mountToolForm();
    const getArguments = vi.fn().mockReturnValue(null);
    context.parameterEditor = { getArguments };
    context.formData.stale = 'previous';
    expect(context.buildArguments()).toBeNull();
    expect(getArguments).toHaveBeenCalledOnce();
  });

  it('保留校验后 JSON 参数的类型、空值与嵌套结构', async () => {
    const { context } = await mountToolForm();
    const args = {
      empty: '',
      count: 0,
      enabled: false,
      value: null,
      tags: ['a'],
      config: { nested: 1 },
    };
    context.parameterEditor = { getArguments: () => args };
    expect(context.buildArguments()).toEqual(args);
  });

  it('默认对象和数组独立复制，重置不会修改工具 schema', async () => {
    const schema: ToolInfo['inputSchema'] = {
      type: 'object',
      properties: {
        tags: { type: 'array', default: ['a'] },
        config: { type: 'object', default: { nested: 1 } },
      },
    };
    const { context } = await mountToolForm(schema);
    (context.formData.tags as string[]).push('changed');
    (context.formData.config as { nested: number }).nested = 2;
    expect(schema.properties?.tags.default).toEqual(['a']);
    expect(schema.properties?.config.default).toEqual({ nested: 1 });
    const before = context.editorKey;
    context.initFormDataDefaults();
    expect(context.formData).toEqual({ tags: ['a'], config: { nested: 1 } });
    expect(context.editorKey).not.toBe(before);
  });

  it('切换路由后获取新工具并重置参数', async () => {
    const { context, router } = await mountToolForm({
      type: 'object',
      properties: { previous: { type: 'string', default: 'old' } },
    });
    mockToolService.getToolDetail.mockResolvedValue({
      ...makeTool({ type: 'object', properties: { next: { type: 'number', default: 0 } } }),
      name: 'next-tool',
    });
    await router.push('/tools/next-tool/test');
    await flushPromises();
    expect(mockToolService.getToolDetail).toHaveBeenLastCalledWith('next-tool', undefined);
    expect(context.toolName).toBe('next-tool');
    expect(context.formData).toEqual({ next: 0 });
  });

  it('卸载后忽略未完成请求的错误', async () => {
    let fail: (error: Error) => void = () => {};
    mockToolService.getToolDetail.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const { context, wrapper } = await mountToolForm(undefined, 'configured');
    expect(context.loading).toBe(true);
    wrapper.unmount();
    fail(new Error('late failure'));
    await flushPromises();
    expect(MessagePlugin.error).not.toHaveBeenCalled();
  });

  it('initFormDataDefaults 先清空旧字段再填默认值', async () => {
    const { context } = await mountToolForm({
      type: 'object',
      properties: {
        name: { type: 'string', default: 'x' },
      },
    });

    context.formData.stale = 'old';
    context.initFormDataDefaults();

    expect(context.formData.stale).toBeUndefined();
    expect(context.formData.name).toBe('x');
  });

  it('goBackToDetail 跳转到工具详情页', async () => {
    const { context, router } = await mountToolForm(undefined);

    context.goBackToDetail();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe('ToolDetail');
    expect(router.currentRoute.value.params.toolName).toBe('demo-tool');
  });
});
