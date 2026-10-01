import { describe, it, expect } from 'vitest';
import { LUMALINK_CORE_VERSION, PROTOCOL_MAGIC, PROTOCOL_VERSION } from '../src/index.js';

describe('@lumalink/core foundation exports', () => {
  it('exports core version string', () => {
    expect(LUMALINK_CORE_VERSION).toBe('0.1.0');
  });

  it('exports protocol constants', () => {
    expect(PROTOCOL_MAGIC).toBe('LUMA');
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
