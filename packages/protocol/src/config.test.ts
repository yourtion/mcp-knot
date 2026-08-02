import { describe, expect, it } from 'vitest';

import { CompatibilityOptionsSchema, defaultCompatibilityOptions } from './config.js';

describe('CompatibilityOptions', () => {
  it('默认全开', () => {
    expect(defaultCompatibilityOptions).toEqual({
      inbound: { enabled: true, legacyMode: 'shim' },
      outbound: { enabled: true, modernOnly: false, mrtrLegacyDegradation: 'shim' },
      errors: { unified: true },
    });
  });

  it('空对象解析为默认值', () => {
    expect(CompatibilityOptionsSchema.parse({})).toEqual(defaultCompatibilityOptions);
  });

  it('legacyMode 只接受 reject | shim', () => {
    expect(() => CompatibilityOptionsSchema.parse({ inbound: { legacyMode: 'bridge' } })).toThrow();
  });

  it('mrtrLegacyDegradation 只接受 shim | reject', () => {
    expect(() =>
      CompatibilityOptionsSchema.parse({ outbound: { mrtrLegacyDegradation: 'force' } }),
    ).toThrow();
  });

  it('部分覆盖保留其余默认', () => {
    const r = CompatibilityOptionsSchema.parse({ outbound: { modernOnly: true } });
    expect(r.outbound.modernOnly).toBe(true);
    expect(r.inbound.enabled).toBe(true); // 未覆盖的保留默认
  });
});
