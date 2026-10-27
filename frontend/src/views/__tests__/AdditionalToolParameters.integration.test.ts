import { flushPromises, mount } from '@vue/test-utils';
import { InputNumber } from 'tdesign-vue-next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ApiToMcp from '../ApiToMcp.vue';
import Debug from '../Debug.vue';
import ToolParameterEditor from '@/components/tools/ToolParameterEditor.vue';

import type { ApiToolConfig } from '@/types/api-to-mcp';
import type { ToolInfo, JsonSchema } from '@/types/tool';

const services = vi.hoisted(() => ({
  getTools: vi.fn(),
  debugTest: vi.fn(),
  getPerformanceStats: vi.fn(),
  getConfigs: vi.fn(),
  getConfigStats: vi.fn(),
  getConfigDetails: vi.fn(),
  testConfig: vi.fn(),
}));
vi.mock('@/services/tool', () => ({ getTools: services.getTools }));
vi.mock('@/services/debug', () => ({
  testTool: services.debugTest,
  getPerformanceStats: services.getPerformanceStats,
  getErrorAnalysis: vi.fn(),
  getMcpMessages: vi.fn(),
}));
vi.mock('@/services/api-to-mcp', () => ({ apiToMcpService: services }));
vi.mock('tdesign-vue-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tdesign-vue-next')>()),
  MessagePlugin: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const schema: JsonSchema = {
  type: 'object',
  required: ['limit', 'enabled'],
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 0, maximum: 10, default: 0 },
    enabled: { type: 'boolean', default: false },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      },
    },
  },
};

function tool(name = 'echo', inputSchema = schema): ToolInfo {
  return { name, serverId: 'qa', status: 'available', description: name, inputSchema };
}

function config(id = 'first', parameters = schema): ApiToolConfig {
  return {
    id,
    name: id,
    description: id,
    api: { url: 'http://localhost/isolated', method: 'POST' },
    parameters: parameters as ApiToolConfig['parameters'],
    response: {},
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const stubs = {
  TTabs: { template: '<div><slot /></div>' },
  TTabPanel: { template: '<section><slot /></section>' },
  TLoading: true,
  TInput: {
    props: ['modelValue', 'placeholder'],
    emits: ['update:modelValue'],
    template:
      '<input :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
  },
  TButton: {
    props: ['disabled', 'loading'],
    emits: ['click'],
    template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
  },
  TDialog: {
    props: ['visible', 'header'],
    emits: ['update:visible', 'close'],
    template:
      '<section v-if="visible" :aria-label="header"><button class="close-dialog" @click="$emit(\'update:visible\', false); $emit(\'close\')">关闭</button><slot /></section>',
  },
  TTable: {
    props: ['data'],
    template:
      '<div><div v-for="row in data" :key="row.id"><slot name="actions" :row="row" /></div></div>',
  },
  TForm: { template: '<div><slot /></div>' },
  TFormItem: { template: '<div><slot /></div>' },
};

type Mode = 'debug' | 'api';
function render(mode: Mode) {
  return mount(mode === 'debug' ? Debug : ApiToMcp, { global: { stubs } });
}
type Wrapper = ReturnType<typeof render>;
const wrappers: Wrapper[] = [];
function button(wrapper: Wrapper, label: string) {
  return wrapper.findAll('button').find((item) => item.text() === label)!;
}
async function open(mode: Mode) {
  const wrapper = render(mode);
  wrappers.push(wrapper);
  await flushPromises();
  if (mode === 'debug') {
    await wrapper.get('input[placeholder="工具名称"]').setValue('echo');
    await button(wrapper, '加载参数').trigger('click');
  } else {
    await wrapper
      .findAll('button')
      .find((item) => item.text() === '测试')!
      .trigger('click');
  }
  await flushPromises();
  return wrapper;
}
function execute(wrapper: Wrapper, mode: Mode) {
  return button(wrapper, mode === 'debug' ? '执行' : '执行测试');
}
function call(mode: Mode) {
  return mode === 'debug' ? services.debugTest : services.testConfig;
}
async function rawMode(wrapper: Wrapper) {
  const editor = wrapper.getComponent(ToolParameterEditor);
  const toggle = editor.find('.parameter-editor__toolbar button');
  if (toggle.exists() && toggle.text() === '编辑 JSON') await toggle.trigger('click');
  return editor.get('textarea');
}

beforeEach(() => {
  vi.resetAllMocks();
  services.getTools.mockResolvedValue({
    tools: [tool()],
    total: 1,
    groupId: 'default',
    toolsByServer: {},
  });
  services.debugTest.mockResolvedValue({ result: { marker: 'debug-success' }, executionTime: 1 });
  services.getPerformanceStats.mockResolvedValue({
    stats: { totalRequests: 0, averageResponseTime: 0, errorRate: 0, topTools: [] },
  });
  services.getConfigs.mockResolvedValue({
    configs: ['first', 'second'].map((id) => ({
      ...config(id),
      status: 'active',
      toolsGenerated: 1,
      lastUpdated: '',
    })),
  });
  services.getConfigStats.mockResolvedValue({
    totalConfigs: 2,
    activeConfigs: 2,
    totalTools: 2,
    lastUpdated: '',
  });
  services.getConfigDetails.mockImplementation(async (id) => config(id));
  services.testConfig.mockResolvedValue({
    success: true,
    response: { marker: 'api-success' },
    executionTime: 1,
  });
});
afterEach(() => {
  wrappers.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe.each(['debug', 'api'] as const)('%s parameter editor integration', (mode) => {
  it('submits typed defaults using the existing endpoint', async () => {
    const wrapper = await open(mode);
    await execute(wrapper, mode).trigger('click');
    await flushPromises();
    const args = { limit: 0, enabled: false };
    if (mode === 'debug') {
      expect(services.getTools).toHaveBeenCalledWith({ groupId: 'default', serverId: undefined });
      expect(call(mode)).toHaveBeenCalledExactlyOnceWith({
        toolName: 'echo',
        serverId: 'qa',
        groupId: 'default',
        arguments: args,
      });
    } else {
      expect(services.getConfigDetails).toHaveBeenCalledWith('first');
      expect(call(mode)).toHaveBeenCalledExactlyOnceWith('first', args);
    }
  });

  it.each([
    '{bad',
    '[]',
    'null',
    '{"limit":"0","enabled":false}',
    '{"limit":11,"enabled":false}',
    '{}',
  ])('blocks invalid arguments before HTTP execution: %s', async (json) => {
    const wrapper = await open(mode);
    await (await rawMode(wrapper)).setValue(json);
    await execute(wrapper, mode).trigger('click');
    expect(call(mode)).not.toHaveBeenCalled();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
  });

  it('retains nested arrays and scalar types across JSON/form switching', async () => {
    const wrapper = await open(mode);
    const args = { limit: 3, enabled: false, entries: [{ name: 'nested' }] };
    await (await rawMode(wrapper)).setValue(JSON.stringify(args));
    await wrapper
      .getComponent(ToolParameterEditor)
      .get('.parameter-editor__toolbar button')
      .trigger('click');
    await execute(wrapper, mode).trigger('click');
    await flushPromises();
    expect(call(mode).mock.calls[0][mode === 'debug' ? 0 : 1]).toEqual(
      mode === 'debug' ? expect.objectContaining({ arguments: args }) : args,
    );
  });

  it('validates real form changes and reports the offending parameter', async () => {
    const wrapper = await open(mode);
    wrapper.getComponent(InputNumber).vm.$emit('update:modelValue', -1);
    await execute(wrapper, mode).trigger('click');
    expect(call(mode)).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('/limit');
  });

  it('falls back to validated JSON for unsupported schemas', async () => {
    const union = {
      type: 'object',
      properties: { value: { oneOf: [{ type: 'string' }, { type: 'integer' }] } },
      required: ['value'],
    } as unknown as JsonSchema;
    services.getTools.mockResolvedValue({ tools: [tool('echo', union)] });
    services.getConfigDetails.mockResolvedValue(config('first', union));
    const wrapper = await open(mode);
    expect(wrapper.text()).toContain('复杂类型');
    await (await rawMode(wrapper)).setValue('{"value":0}');
    await execute(wrapper, mode).trigger('click');
    await flushPromises();
    expect(call(mode)).toHaveBeenCalledTimes(1);
  });

  it('blocks execution when the schema cannot compile', async () => {
    const broken = {
      type: 'object',
      properties: { value: { $ref: 'https://qa.invalid/missing' } },
    } as unknown as JsonSchema;
    services.getTools.mockResolvedValue({ tools: [tool('echo', broken)] });
    services.getConfigDetails.mockResolvedValue(config('first', broken));
    const wrapper = await open(mode);
    await execute(wrapper, mode).trigger('click');
    expect(call(mode)).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('无法校验');
  });

  it('keeps the editor unavailable when the schema response is malformed', async () => {
    const missing = null as unknown as JsonSchema;
    services.getTools.mockResolvedValue({ tools: [tool('echo', missing)] });
    services.getConfigDetails.mockResolvedValue(config('first', missing));
    const wrapper = await open(mode);
    expect(wrapper.findComponent(ToolParameterEditor).exists()).toBe(false);
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(execute(wrapper, mode).attributes('disabled')).toBeDefined();
    expect(call(mode)).not.toHaveBeenCalled();
  });

  it('retains the draft after execution failure and permits retry', async () => {
    call(mode).mockRejectedValueOnce(new Error('isolated failure'));
    const wrapper = await open(mode);
    await (await rawMode(wrapper)).setValue('{"limit":7,"enabled":false}');
    await execute(wrapper, mode).trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('isolated failure');
    expect(wrapper.getComponent(ToolParameterEditor).get('textarea').element.value).toContain('7');
    await execute(wrapper, mode).trigger('click');
    await flushPromises();
    expect(call(mode)).toHaveBeenCalledTimes(2);
  });

  it('prevents duplicate execution while a request is pending', async () => {
    const pending = deferred<unknown>();
    call(mode).mockReturnValueOnce(pending.promise);
    const wrapper = await open(mode);
    await execute(wrapper, mode).trigger('click');
    await execute(wrapper, mode).trigger('click');
    expect(call(mode)).toHaveBeenCalledTimes(1);
    pending.resolve(mode === 'debug' ? { result: {} } : { success: true });
    await flushPromises();
  });

  it('offers recovery after the schema request fails', async () => {
    (mode === 'debug' ? services.getTools : services.getConfigDetails).mockRejectedValueOnce(
      new Error('schema unavailable'),
    );
    const wrapper = await open(mode);
    expect(wrapper.get('[role="alert"]').text()).toContain('schema unavailable');
    expect(execute(wrapper, mode).attributes('disabled')).toBeDefined();
    await button(wrapper, '重试').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(ToolParameterEditor).exists()).toBe(true);
  });
});

describe('parameter session isolation', () => {
  it('does not reload and discard an already loaded debug draft', async () => {
    const wrapper = await open('debug');
    await (await rawMode(wrapper)).setValue('{"limit":6,"enabled":false}');
    expect(button(wrapper, '加载参数').attributes('disabled')).toBeDefined();
    await button(wrapper, '加载参数').trigger('click');
    await execute(wrapper, 'debug').trigger('click');
    expect(services.getTools).toHaveBeenCalledTimes(1);
    expect(services.debugTest).toHaveBeenCalledWith(
      expect.objectContaining({ arguments: { limit: 6, enabled: false } }),
    );
  });

  it('invalidates debug drafts/results immediately when the tool or server changes', async () => {
    const pending = deferred<unknown>();
    services.debugTest.mockReturnValueOnce(pending.promise);
    const wrapper = await open('debug');
    await execute(wrapper, 'debug').trigger('click');
    await wrapper.get('input[placeholder="服务器ID（可选）"]').setValue('other');
    pending.resolve({ result: { marker: 'stale-debug' } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('stale-debug');
    expect(wrapper.findComponent(ToolParameterEditor).exists()).toBe(false);
    await button(wrapper, '加载参数').trigger('click');
    await flushPromises();
    expect(services.getTools).toHaveBeenLastCalledWith({ groupId: 'default', serverId: 'other' });
    expect(wrapper.get('[role="alert"]').text()).toContain('未找到匹配');
  });

  it('ignores a debug schema response for the previous tool', async () => {
    const pending = deferred<unknown>();
    services.getTools.mockReturnValueOnce(pending.promise);
    const wrapper = await open('debug');
    await wrapper.get('input[placeholder="工具名称"]').setValue('next');
    services.getTools.mockResolvedValue({ tools: [tool('next')] });
    await button(wrapper, '加载参数').trigger('click');
    await flushPromises();
    pending.resolve({
      tools: [tool('echo', { type: 'object', properties: { stale: { type: 'string' } } })],
    });
    await flushPromises();
    await execute(wrapper, 'debug').trigger('click');
    expect(services.debugTest).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'next', arguments: { limit: 0, enabled: false } }),
    );
  });

  it('resets the API draft on close/reopen and ignores the previous execution result', async () => {
    const pending = deferred<unknown>();
    services.testConfig.mockReturnValueOnce(pending.promise);
    const wrapper = await open('api');
    await (await rawMode(wrapper)).setValue('{"limit":9,"enabled":true}');
    await execute(wrapper, 'api').trigger('click');
    await wrapper.get('.close-dialog').trigger('click');
    await wrapper
      .findAll('button')
      .filter((item) => item.text() === '测试')[1]
      .trigger('click');
    await flushPromises();
    pending.resolve({ success: true, response: 'stale-api-result' });
    await flushPromises();
    expect(wrapper.text()).not.toContain('stale-api-result');
    await execute(wrapper, 'api').trigger('click');
    await flushPromises();
    expect(services.testConfig).toHaveBeenLastCalledWith('second', { limit: 0, enabled: false });
  });

  it('ignores API schema responses after close and opening a different config', async () => {
    const pending = deferred<ApiToolConfig>();
    services.getConfigDetails.mockReturnValueOnce(pending.promise);
    const wrapper = await open('api');
    expect(execute(wrapper, 'api').attributes('disabled')).toBeDefined();
    await wrapper.get('.close-dialog').trigger('click');
    await wrapper
      .findAll('button')
      .filter((item) => item.text() === '测试')[1]
      .trigger('click');
    await flushPromises();
    pending.resolve(config('first', { type: 'object', properties: { stale: { type: 'string' } } }));
    await flushPromises();
    await execute(wrapper, 'api').trigger('click');
    expect(services.testConfig).toHaveBeenCalledWith('second', { limit: 0, enabled: false });
  });
});
