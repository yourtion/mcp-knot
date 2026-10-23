/**
 * MCP 内容类型工具测试
 * 覆盖类型守卫、内容归一化与工厂函数
 */
import {
  createTextContent,
  isImageContent,
  isResourceContent,
  isTextContent,
  normalizeMcpContent,
} from './mcp-content.js';

describe('MCP 内容类型守卫', () => {
  const text = { type: 'text' as const, text: 'hello' };
  const image = { type: 'image' as const, data: 'base64', mimeType: 'image/png' };
  const resource = { type: 'resource' as const, uri: 'file:///tmp/a.txt' };

  it('isTextContent 仅识别 text 类型', () => {
    expect(isTextContent(text)).toBe(true);
    expect(isTextContent(image)).toBe(false);
    expect(isTextContent(resource)).toBe(false);
  });

  it('isImageContent 仅识别 image 类型', () => {
    expect(isImageContent(image)).toBe(true);
    expect(isImageContent(text)).toBe(false);
    expect(isImageContent(resource)).toBe(false);
  });

  it('isResourceContent 仅识别 resource 类型', () => {
    expect(isResourceContent(resource)).toBe(true);
    expect(isResourceContent(text)).toBe(false);
    expect(isResourceContent(image)).toBe(false);
  });
});

describe('normalizeMcpContent', () => {
  it('对象自带 type 时保留原类型与字段', () => {
    const item = { type: 'image', data: 'abc', mimeType: 'image/png' };
    expect(normalizeMcpContent(item)).toEqual(item);
  });

  it('对象缺少 type 时补默认 text 类型', () => {
    const item = { text: '没有类型字段' };
    expect(normalizeMcpContent(item)).toEqual({ type: 'text', text: '没有类型字段' });
  });

  it('非对象输入转换为文本内容', () => {
    expect(normalizeMcpContent('plain text')).toEqual({ type: 'text', text: 'plain text' });
    expect(normalizeMcpContent(42)).toEqual({ type: 'text', text: '42' });
    expect(normalizeMcpContent(null)).toEqual({ type: 'text', text: 'null' });
  });
});

describe('createTextContent', () => {
  it('创建 type 为 text 的内容项', () => {
    expect(createTextContent('你好')).toEqual({ type: 'text', text: '你好' });
  });
});
