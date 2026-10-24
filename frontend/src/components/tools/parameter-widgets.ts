import { Input, InputNumber, Select, Switch } from 'tdesign-vue-next';
import { defineComponent, h, withDirectives } from 'vue';

import type { Component, DirectiveBinding, PropType } from 'vue';
import type { ComponentsMap, FormFieldItem } from 'vue-json-ui-editor';

// TDesign 1.x forwards arbitrary attributes to its wrapper, not the native input.
// Keep accessible names on the focusable control when the widget mounts or updates.
function labelInput(el: HTMLElement, binding: DirectiveBinding<{ label: unknown; role?: string }>) {
  const input = el.querySelector('input');
  if (!input) return;
  input.setAttribute('aria-label', String(binding.value.label || ''));
  if (binding.value.role) input.setAttribute('role', binding.value.role);
}
const controlLabel = { mounted: labelInput, updated: labelInput };
function accessibleInput(component: Component, role?: string) {
  return defineComponent({
    inheritAttrs: false,
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue', 'change'],
    setup(props, { attrs, emit }) {
      return () =>
        withDirectives(
          h(component, {
            ...attrs,
            ...props,
            'onUpdate:modelValue': (value: unknown) => emit('update:modelValue', value),
            onChange: (value: unknown) => emit('change', value),
          }),
          [[controlLabel, { label: attrs['aria-label'], role }]],
        );
    },
  });
}
const ParameterInput = accessibleInput(Input);
const ParameterNumber = accessibleInput(InputNumber, 'spinbutton');

// TDesign select values do not include booleans. Index values keep JSON enum
// types intact, including false, 0, and strings that look like numbers.
export const ParameterSelect = defineComponent({
  name: 'ParameterSelect',
  props: {
    modelValue: {
      type: [String, Number, Boolean, Object, Array] as PropType<
        string | number | boolean | Record<string, unknown> | unknown[] | null
      >,
      default: undefined,
    },
    items: { type: Array as PropType<FormFieldItem[]>, default: () => [] },
    disabled: Boolean,
  },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit, attrs }) {
    return () => {
      const index = props.items.findIndex((item) => Object.is(item.value, props.modelValue));
      return withDirectives(
        h(Select, {
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
        }),
        [[controlLabel, { label: attrs['aria-label'] }]],
      );
    };
  },
});

const ParameterSwitch = defineComponent({
  props: { modelValue: Boolean, disabled: Boolean },
  emits: ['update:modelValue', 'change'],
  setup(props, { emit }) {
    return () =>
      h(Switch, {
        modelValue: props.modelValue,
        disabled: props.disabled,
        role: 'switch',
        tabindex: props.disabled ? -1 : 0,
        'aria-checked': props.modelValue,
        'aria-disabled': props.disabled,
        style: { width: 'auto', alignSelf: 'flex-start' },
        'onUpdate:modelValue': (value: boolean | string | number) =>
          emit('update:modelValue', Boolean(value)),
        onKeydown: (event: KeyboardEvent) => {
          if (!props.disabled && (event.key === ' ' || event.key === 'Enter')) {
            event.preventDefault();
            emit('update:modelValue', !props.modelValue);
          }
        },
      });
  },
});

export const parameterWidgets: ComponentsMap = {
  form: { component: 'div', option: { native: true } },
  text: {
    component: ParameterInput,
    option: ({ field }) => ({ name: field.name, 'aria-label': field.label, clearable: true }),
  },
  email: {
    component: ParameterInput,
    option: ({ field }) => ({ name: field.name, 'aria-label': field.label }),
  },
  url: {
    component: ParameterInput,
    option: ({ field }) => ({ name: field.name, 'aria-label': field.label }),
  },
  number: {
    component: ParameterNumber,
    option: ({ field }) => ({
      'aria-label': field.label,
      inputProps: { name: field.name },
      min: field.min,
      max: field.max,
      style: { width: '100%' },
    }),
  },
  checkbox: { component: ParameterSwitch, option: ({ field }) => ({ 'aria-label': field.label }) },
  select: {
    component: ParameterSelect,
    option: ({ field }) => ({ items: field.items, 'aria-label': field.label }),
  },
  arrayadd: { component: 'button', option: { native: true, type: 'button', label: '添加一项' } },
  arrayremove: { component: 'button', option: { native: true, type: 'button', label: '删除' } },
};
