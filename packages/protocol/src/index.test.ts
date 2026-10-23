import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './index.js';

describe('protocol 公共导出', () => {
  it('PROTOCOL_VERSION 为 0.0.1（占位版本常量）', () => {
    expect(PROTOCOL_VERSION).toBe('0.0.1');
  });
});
