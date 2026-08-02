import { describe, expect, it } from 'vitest';

import { defaultCompatibilityOptions } from '../config.js';
import { resolveInboundLegacyMode } from './adapter.js';

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
