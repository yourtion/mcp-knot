import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { MessagePlugin } from 'tdesign-vue-next';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
async function mountToolForm(schema?: ToolInfo['inputSchema'], detail: 'reject' | 'ok' = 'ok') {
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
  } else {
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
  return { context, router };
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
    expect(context.formData.enabled).toBe(false);
    expect(context.formData.tags).toBe(JSON.stringify(['a', 'b'], null, 2));
    expect(context.formData.plain).toBeUndefined();
  });

  it('拉取失败时提示错误并复位加载状态', async () => {
    const { context } = await mountToolForm(undefined, 'reject');

    expect(context.tool).toBeNull();
    expect(context.loading).toBe(false);
    expect(MessagePlugin.error).toHaveBeenCalledWith('获取工具详情失败');
  });

  it('schemaProperties 映射字段并应用缺省回退', async () => {
    const { context } = await mountToolForm({
      type: 'object',
      properties: {
        name: { type: 'string', description: '名称' },
        port: { type: 'number', minimum: 1, maximum: 65535, default: 8080 },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
      required: ['name'],
    });

    const props = context.schemaProperties;
    expect(props).toHaveLength(3);

    const [name, port, mode] = props;
    expect(name).toMatchObject({
      name: 'name',
      type: 'string',
      description: '名称',
      required: true,
      enumValues: [],
    });
    expect(port).toMatchObject({ minimum: 1, maximum: 65535, defaultValue: 8080 });
    expect(mode).toMatchObject({ enumValues: ['fast', 'slow'], required: false });
  });

  it('无输入 schema 时 schemaProperties 为空数组', async () => {
    const { context } = await mountToolForm(undefined);

    expect(context.schemaProperties).toEqual([]);
  });

  it('formLabel 优先描述并标注必填', async () => {
    const { context } = await mountToolForm({
      type: 'object',
      properties: {
        name: { type: 'string', description: '名称' },
        age: { type: 'number' },
      },
      required: ['age'],
    });

    const [name, age] = context.schemaProperties;
    expect(context.formLabel(name)).toBe('名称');
    expect(context.formLabel(age)).toBe('age *');
  });

  it('formRulesForField 仅必填字段生成规则', async () => {
    const { context } = await mountToolForm({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'number' },
      },
      required: ['age'],
    });

    const [name, age] = context.schemaProperties;
    expect(context.formRulesForField(name)).toEqual([]);
    expect(context.formRulesForField(age)).toEqual([{ required: true, message: 'age 是必填参数' }]);
  });

  describe('buildArguments', () => {
    it('跳过空值并解析 array/object 类型字符串', async () => {
      const { context } = await mountToolForm({
        type: 'object',
        properties: {
          name: { type: 'string' },
          count: { type: 'number' },
          tags: { type: 'array' },
          config: { type: 'object' },
        },
      });

      context.formData.name = 'abc';
      context.formData.count = '';
      context.formData.tags = '["a","b"]';
      context.formData.config = '{"k":1}';

      expect(context.buildArguments()).toEqual({
        name: 'abc',
        tags: ['a', 'b'],
        config: { k: 1 },
      });
    });

    it('非法 JSON 字符串原样保留', async () => {
      const { context } = await mountToolForm({
        type: 'object',
        properties: { tags: { type: 'array' } },
      });

      context.formData.tags = '{not json';

      expect(context.buildArguments()).toEqual({ tags: '{not json' });
    });

    it('undefined 与 null 值都被跳过', async () => {
      const { context } = await mountToolForm({
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'string' },
        },
      });

      context.formData.a = null;
      context.formData.b = undefined;

      expect(context.buildArguments()).toEqual({});
    });
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
