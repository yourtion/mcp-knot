import { describe, expect, it } from 'vitest';

import { defaultCompatibilityOptions } from '../config.js';
import { InboundProtocolAdapter, resolveInboundLegacyMode } from './adapter.js';

describe('InboundProtocolAdapter', () => {
  it('默认 shim → HTTP "stateless"', () => {
    expect(resolveInboundLegacyMode(defaultCompatibilityOptions, 'http')).toBe('stateless');
  });

  it('默认 shim → stdio "serve"', () => {
    expect(resolveInboundLegacyMode(defaultCompatibilityOptions, 'stdio')).toBe('serve');
  });

  it('enabled=false 或 legacyMode=reject → "reject"', () => {
    expect(
      resolveInboundLegacyMode(
        { ...defaultCompatibilityOptions, inbound: { enabled: false, legacyMode: 'shim' } },
        'http',
      ),
    ).toBe('reject');
    expect(
      resolveInboundLegacyMode(
        { ...defaultCompatibilityOptions, inbound: { enabled: true, legacyMode: 'reject' } },
        'stdio',
      ),
    ).toBe('reject');
  });
});

// 类方法：封装 opts 的薄委托，此前仅经纯函数间接覆盖，补直接断言。
describe('InboundProtocolAdapter 类方法', () => {
  it('resolveLegacyMode 与同名纯函数一致', () => {
    const adapter = new InboundProtocolAdapter(defaultCompatibilityOptions);
    expect(adapter.resolveLegacyMode('http')).toBe('stateless');
    expect(adapter.resolveLegacyMode('stdio')).toBe('serve');
  });

  it('resolveLegacyMode 在 reject 配置下返回 reject', () => {
    const adapter = new InboundProtocolAdapter({
      ...defaultCompatibilityOptions,
      inbound: { enabled: false, legacyMode: 'shim' },
    });
    expect(adapter.resolveLegacyMode('http')).toBe('reject');
  });

  it('normalize 把 method/params/meta/era 归一为 NormalizedRequest', () => {
    const adapter = new InboundProtocolAdapter(defaultCompatibilityOptions);
    const r = adapter.normalize({
      method: 'tools/call',
      params: { name: 'foo' },
      meta: { clientInfo: { name: 'c', version: '1' } },
      era: 'legacy',
    });
    expect(r.method).toBe('tools/call');
    expect(r.era).toBe('legacy');
    expect((r.params as { name: string }).name).toBe('foo');
    expect(r.meta.clientInfo?.name).toBe('c');
  });
});
