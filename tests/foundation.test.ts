import { describe, it, expect } from 'vitest';
import { LUMALINK_CORE_VERSION, PROTOCOL_MAGIC, PROTOCOL_VERSION } from '@lumalink/core';

describe('Workspace Package Resolution & Foundation', () => {
  it('resolves @lumalink/core via workspace alias', () => {
    expect(LUMALINK_CORE_VERSION).toBeDefined();
    expect(typeof LUMALINK_CORE_VERSION).toBe('string');
  });

  it('exposes immutable protocol definitions', () => {
    expect(PROTOCOL_MAGIC).toBe('LUMA');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
