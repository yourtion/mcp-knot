import { flushPromises, mount } from '@vue/test-utils';
import { Input, InputNumber, Select, Switch } from 'tdesign-vue-next';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';

import { ParameterSelect } from '../parameter-widgets';
import ToolParameterEditor from '../ToolParameterEditor.vue';
import { initialArguments } from '@/utils/tool-parameters';

import type { JsonSchema } from 'vue-json-ui-editor';

const schema: JsonSchema = {
  type: 'object',
  required: ['query', 'limit', 'active'],
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1, description: 'Search query' },
    limit: { type: 'integer', minimum: 0, maximum: 10 },
    active: { type: 'boolean' },
    optional: { type: 'string' },
  },
};

describe('ToolParameterEditor', () => {
  it('uses TDesign widgets and preserves JSON types without mutating inputs', async () => {
    const input = { query: 'before', limit: 0, active: false };
    const beforeSchema = JSON.stringify(schema);
    const wrapper = mount(ToolParameterEditor, { props: { schema, modelValue: input } });
    expect(wrapper.text()).toContain('Search query');
    expect(wrapper.find('[data-required-field="true"]').text()).toContain('query');
    wrapper.findComponent(Input).vm.$emit('update:modelValue', 'updated');
    wrapper.findComponent(InputNumber).vm.$emit('update:modelValue', 4);
    wrapper.findComponent(Switch).vm.$emit('update:modelValue', true);
    await nextTick();
    expect(wrapper.vm.getArguments()).toEqual({ query: 'updated', limit: 4, active: true });
    expect(input).toEqual({ query: 'before', limit: 0, active: false });
    expect(JSON.stringify(schema)).toBe(beforeSchema);
    wrapper.unmount();
  });

  it('omits disabled optional parameters and permits explicitly enabled empty strings', async () => {
    const wrapper = mount(ToolParameterEditor, {
      props: { schema, modelValue: { query: 'q', limit: 0, active: false } },
    });
    expect(wrapper.vm.getArguments()).not.toHaveProperty('optional');
    await wrapper.find('input[aria-label="启用 optional"]').setValue(true);
    expect(wrapper.vm.getArguments()).toHaveProperty('optional', '');
    await wrapper.find('input[aria-label="启用 optional"]').setValue(false);
    expect(wrapper.vm.getArguments()).not.toHaveProperty('optional');
    wrapper.unmount();
  });

  it('maps TDesign enum indexes back to false and zero', async () => {
    const choices: JsonSchema = {
      type: 'object',
      required: ['choice'],
      properties: { choice: { type: 'boolean', enum: [false, true] } },
    };
    const wrapper = mount(ToolParameterEditor, {
      props: { schema: choices, modelValue: { choice: true } },
    });
    expect(typeof wrapper.findComponent(Select).vm.$.vnode.props?.onChange).toBe('function');
    wrapper.findComponent(Select).vm.$emit('change', '0');
    await nextTick();
    expect(wrapper.vm.getArguments()).toEqual({ choice: false });
    await wrapper.setProps({
      schema: {
        type: 'object',
        required: ['choice'],
        properties: { choice: { type: 'integer', enum: [0, 1] } },
      },
      modelValue: { choice: 1 },
    });
    expect(typeof wrapper.findComponent(Select).vm.$.vnode.props?.onChange).toBe('function');
    wrapper.findComponent(Select).vm.$emit('change', '0');
    await nextTick();
    expect(wrapper.vm.getArguments()).toEqual({ choice: 0 });
    wrapper.unmount();
  });

  it('blocks invalid numbers with field paths and preserves the draft', () => {
    const input = { query: 'q', limit: 11, active: false };
    const wrapper = mount(ToolParameterEditor, { props: { schema, modelValue: input } });
    expect(wrapper.vm.getArguments()).toBeNull();
    expect(input.limit).toBe(11);
    wrapper.unmount();
  });

  it('edits object-array rows and validates nested required fields', async () => {
    const rows: JsonSchema = {
      type: 'object',
      required: ['rows'],
      properties: {
        rows: {
          type: 'array',
          items: {
            type: 'object',
            required: ['name'],
            properties: { name: { type: 'string', minLength: 1 } },
          },
        },
      },
    };
    const wrapper = mount(ToolParameterEditor, {
      props: { schema: rows, modelValue: { rows: [] } },
    });
    await wrapper.find('.json-editor-array-add').trigger('click');
    expect(wrapper.vm.getArguments()).toBeNull();
    wrapper.findComponent(Input).vm.$emit('update:modelValue', 'Ada');
    await nextTick();
    expect(wrapper.vm.getArguments()).toEqual({ rows: [{ name: 'Ada' }] });
    wrapper.unmount();
  });

  it('falls back to JSON and retains null, empty strings, and dynamic keys', async () => {
    const json: JsonSchema = { type: 'object', additionalProperties: true };
    const wrapper = mount(ToolParameterEditor, { props: { schema: json, modelValue: {} } });
    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    await wrapper
      .find('textarea')
      .setValue('{"empty":"","value":null,"zero":0,"flag":false,"a.b":[1,2]}');
    expect(wrapper.vm.getArguments()).toEqual({
      empty: '',
      value: null,
      zero: 0,
      flag: false,
      'a.b': [1, 2],
    });
    await wrapper.find('textarea').setValue('{bad');
    expect(wrapper.vm.getArguments()).toBeNull();
    await wrapper.find('textarea').setValue('[]');
    expect(wrapper.vm.getArguments()).toBeNull();
    wrapper.unmount();
  });

  it('does not leave JSON mode on a parse error and does not submit a previous valid draft', async () => {
    const wrapper = mount(ToolParameterEditor, {
      props: { schema, modelValue: { query: 'q', limit: 1, active: false } },
    });
    await wrapper.find('.parameter-editor__toolbar button').trigger('click');
    await wrapper.find('textarea').setValue('{bad');
    await wrapper.find('.parameter-editor__toolbar button').trigger('click');
    expect(wrapper.find('textarea').exists()).toBe(true);
    expect(wrapper.vm.getArguments()).toBeNull();
    wrapper.unmount();
  });

  it('disables submission when schema compilation fails', () => {
    const wrapper = mount(ToolParameterEditor, {
      props: { schema: { type: 'object', $ref: 'https://example.invalid/schema' }, modelValue: {} },
    });
    expect(wrapper.vm.getArguments()).toBeNull();
    expect(wrapper.find('[role="alert"]').text()).toContain('无法校验');
    wrapper.unmount();
  });

  it('clones defaults and never forwards remote UI extensions', () => {
    const remote: JsonSchema = {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          default: 'q',
          component: 'iframe',
          attrs: { src: 'https://example.invalid' },
        },
      },
    };
    const first = initialArguments(remote);
    first.query = 'changed';
    expect(initialArguments(remote)).toEqual({ query: 'q' });
    const wrapper = mount(ToolParameterEditor, {
      props: { schema: remote, modelValue: initialArguments(remote) },
    });
    expect(wrapper.find('iframe').exists()).toBe(false);
    expect(wrapper.vm.getArguments()).toBeNull();
    wrapper.unmount();
  });
});

it('handles real TDesign option clicks without merging inherited change listeners', async () => {
  const wrapper = mount(ParameterSelect, {
    attachTo: document.body,
    props: {
      modelValue: '0',
      items: [
        { label: '0', value: '0' },
        { label: 'one', value: 'one' },
      ],
    },
    attrs: { popupVisible: true, onChange: vi.fn() },
    global: { stubs: { TSelect: false, TInput: false, TOption: false } },
  });
  try {
    await flushPromises();
    await vi.waitFor(() =>
      expect(document.querySelector('.t-select-option[title="one"]')).not.toBeNull(),
    );
    document.querySelector<HTMLElement>('.t-select-option[title="one"]')!.click();
    await flushPromises();
    expect(wrapper.emitted('update:modelValue')?.slice(-1)[0]).toEqual(['one']);
  } finally {
    wrapper.unmount();
  }
});
