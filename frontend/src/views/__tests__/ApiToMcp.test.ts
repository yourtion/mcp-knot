import { flushPromises, mount } from '@vue/test-utils';
import { MessagePlugin } from 'tdesign-vue-next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import ApiToMcp from '../ApiToMcp.vue';
import { apiToMcpService } from '@/services/api-to-mcp';

vi.mock('@/services/api-to-mcp', () => ({
  apiToMcpService: {
    getConfigs: vi.fn(),
    getConfigStats: vi.fn(),
    createConfig: vi.fn(),
    updateConfig: vi.fn(),
  },
}));
vi.mock('tdesign-vue-next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('tdesign-vue-next')>()),
  MessagePlugin: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

async function open() {
  const wrapper = mount(ApiToMcp, {
    global: {
      stubs: {
        TDialog: {
          props: ['visible'],
          emits: ['confirm'],
          template:
            '<section v-if="visible"><slot /><button class="save-config" @click="$emit(\'confirm\')">保存</button></section>',
        },
        TForm: { template: '<div><slot /></div>' },
        TFormItem: { template: '<div><slot /></div>' },
        TInput: {
          props: ['modelValue', 'placeholder'],
          emits: ['update:modelValue'],
          template:
            '<input :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
        TTextarea: {
          props: ['modelValue', 'placeholder'],
          emits: ['update:modelValue'],
          template:
            '<textarea :placeholder="placeholder" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
        },
      },
    },
  });
  await flushPromises();
  await wrapper
    .findAll('button')
    .find((button) => button.text().includes('添加API配置'))!
    .trigger('click');
  await wrapper.get('input[placeholder="API配置名称"]').setValue('Search');
  await wrapper
    .get('input[placeholder="https://api.example.com/endpoint"]')
    .setValue('https://api.example.com/search');
  return wrapper;
}

describe('API configuration form validation', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(apiToMcpService.getConfigs).mockResolvedValue({ configs: [] });
    vi.mocked(apiToMcpService.getConfigStats).mockResolvedValue({
      totalConfigs: 0,
      activeConfigs: 0,
      totalTools: 0,
      lastUpdated: '2026-10-21T10:00:00Z',
    });
    vi.mocked(apiToMcpService.createConfig).mockResolvedValue({ id: 'test', message: 'Created' });
  });

  it('submits validated headers and nested parameter schemas with required fields and numeric enums', async () => {
    const wrapper = await open();
    const headers = { 'X-Client': 'web' };
    const parameters = {
      type: 'object',
      required: ['filters'],
      properties: {
        filters: {
          type: 'object',
          required: ['count'],
          properties: { count: { type: 'number', minimum: 0, enum: [1, 2] } },
        },
      },
    };
    // Description, headers and parameter Schema appear in this order in the form.
    await wrapper.findAll('textarea')[1].setValue(JSON.stringify(headers));
    await wrapper.findAll('textarea')[2].setValue(JSON.stringify(parameters));
    await wrapper.get('.save-config').trigger('click');
    await flushPromises();
    expect(apiToMcpService.createConfig).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        name: 'Search',
        api: { url: 'https://api.example.com/search', method: 'GET', headers },
        parameters,
      }),
    );
    expect(MessagePlugin.success).toHaveBeenCalledWith('配置创建成功');
  });

  it.each(['[]', 'null', '"text"', '42'])(
    'rejects a non-object header JSON value: %s',
    async (json) => {
      const wrapper = await open();
      await wrapper.findAll('textarea')[1].setValue(json);
      await wrapper.get('.save-config').trigger('click');
      await flushPromises();
      expect(apiToMcpService.createConfig).not.toHaveBeenCalled();
      expect(MessagePlugin.error).toHaveBeenCalledWith('JSON 必须是对象');
    },
  );

  it('rejects non-string header values without submitting a configuration', async () => {
    const wrapper = await open();
    await wrapper.findAll('textarea')[1].setValue('{"X-Count":3}');
    await wrapper.get('.save-config').trigger('click');
    await flushPromises();
    expect(apiToMcpService.createConfig).not.toHaveBeenCalled();
    expect(MessagePlugin.error).toHaveBeenCalledWith('请求头的值必须是字符串');
  });

  it.each([
    '{"type":"array"}',
    '{"properties":[]}',
    '{"properties":{"count":{"type":"invalid"}}}',
    '{"required":"name"}',
    '{"required":[123]}',
    '{"required":',
  ])('rejects an invalid parameter schema: %s', async (json) => {
    const wrapper = await open();
    await wrapper.findAll('textarea')[2].setValue(json);
    await wrapper.get('.save-config').trigger('click');
    await flushPromises();
    expect(apiToMcpService.createConfig).not.toHaveBeenCalled();
    expect(MessagePlugin.error).toHaveBeenCalled();
  });
});
