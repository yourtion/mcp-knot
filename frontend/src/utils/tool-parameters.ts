import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import { inspectSchema } from 'vue-json-ui-editor';

import type { ErrorObject, ValidateFunction } from 'ajv';
import type { JsonSchema, JsonSchemaProperty } from 'vue-json-ui-editor';

export type Arguments = Record<string, unknown>;
export interface ParameterEditorInstance {
  getArguments(): Arguments | null;
}

export function cloneArguments(value: Arguments): Arguments {
  return JSON.parse(JSON.stringify(value)) as Arguments;
}

export function initialArguments(schema: JsonSchema): Arguments {
  const entries = Object.entries(schema.properties || {})
    .filter(([, property]) => property && property.default !== undefined)
    .map(([key, property]) => [key, property.default]);
  return cloneArguments(Object.fromEntries(entries));
}

// Only standard rendering keywords reach the editor. Remote schemas must not
// supply UI extensions such as component, attrs, or event handlers.
const uiKeywords = [
  'type',
  'title',
  'description',
  'default',
  'enum',
  'required',
  'readOnly',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'format',
  'minItems',
  'maxItems',
] as const;

export function formSchema(schema: JsonSchema, enabled: string[]): JsonSchema {
  const convert = (node: JsonSchemaProperty, name?: string): JsonSchemaProperty => {
    const result = Object.fromEntries(
      uiKeywords.filter((key) => node[key] !== undefined).map((key) => [key, node[key]]),
    ) as JsonSchemaProperty;
    if (name) result.title = node.title || name;
    if (node.properties) {
      result.properties = Object.fromEntries(
        Object.entries(node.properties).map(([key, child]) => [key, convert(child, key)]),
      );
    }
    if (node.items) result.items = convert(node.items);
    return result;
  };
  const result = convert(schema) as JsonSchema;
  result.properties = Object.fromEntries(
    Object.entries(result.properties || {}).filter(([name]) => enabled.includes(name)),
  );
  return result;
}

export function parameterSupport(schema: JsonSchema) {
  return inspectSchema(schema);
}

export function parameterValidator(schema: JsonSchema): {
  validate?: ValidateFunction;
  error?: string;
} {
  try {
    const options = { allErrors: true, strictTypes: false, strictRequired: false };
    const dialect = schema.$schema || 'https://json-schema.org/draft/2020-12/schema';
    const ajv = dialect.includes('draft-07')
      ? new Ajv(options)
      : dialect.includes('2019-09')
        ? new Ajv2019(options)
        : new Ajv2020(options);
    addFormats(ajv);
    return { validate: ajv.compile(schema) };
  } catch {
    return { error: '无法校验此工具的参数定义，请检查 Schema 版本、格式或未解析的引用。' };
  }
}

export function parameterErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors || []).map((error) => {
    const missing = error.keyword === 'required' ? String(error.params.missingProperty) : '';
    const path = missing
      ? `${error.instancePath}/${missing.replace(/~/g, '~0').replace(/\//g, '~1')}`
      : error.instancePath;
    return `${path || '/'}：${error.message || '参数无效'}`;
  });
}
