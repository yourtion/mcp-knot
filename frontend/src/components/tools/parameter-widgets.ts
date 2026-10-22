import { Input, InputNumber, Select, Switch } from 'tdesign-vue-next';
import { defineComponent, h } from 'vue';

import type { PropType } from 'vue';
import type { ComponentsMap, FormFieldItem } from 'vue-json-ui-editor';

// TDesign select values do not include booleans. Index values keep JSON enum
// types intact, including false, 0, and strings that look like numbers.
const ParameterSelect = defineComponent({
  name: 'ParameterSelect',
  props: {
    modelValue: { default: undefined },
    items: { type: Array as PropType<FormFieldItem[]>, default: () => [] },
    disabled: Boolean,
  },
  emits: ['update:modelValue'],
  setup(props, { emit, attrs }) {
    return () => {
      const index = props.items.findIndex((item) => Object.is(item.value, props.modelValue));
      return h(Select, {
        ...attrs,
        value: index < 0 ? undefined : String(index),
        options: props.items.map((item, i) => ({ label: item.label, value: String(i) })),
        disabled: props.disabled,
        clearable: true,
        onChange: (value) =>
          emit(
            'update:modelValue',
            value === '' || value === undefined ? undefined : props.items[Number(value)]?.value,
          ),
      });
    };
  },
});

export const parameterWidgets: ComponentsMap = {
  form: { component: 'div', option: { native: true } },
  text: {
    component: Input,
    option: ({ field }) => ({ name: field.name, 'aria-label': field.label, clearable: true }),
  },
  email: {
    component: Input,
    option: ({ field }) => ({ name: field.name, 'aria-label': field.label }),
  },
  url: {
    component: Input,
    option: ({ field }) => ({ name: field.name, 'aria-label': field.label }),
  },
  number: {
    component: InputNumber,
    option: ({ field }) => ({
      'aria-label': field.label,
      inputProps: { name: field.name },
      min: field.min,
      max: field.max,
      style: { width: '100%' },
    }),
  },
  checkbox: { component: Switch, option: ({ field }) => ({ 'aria-label': field.label }) },
  select: {
    component: ParameterSelect,
    option: ({ field }) => ({ items: field.items, 'aria-label': field.label }),
  },
  arrayadd: { component: 'button', option: { native: true, type: 'button', label: '添加一项' } },
  arrayremove: { component: 'button', option: { native: true, type: 'button', label: '删除' } },
};
