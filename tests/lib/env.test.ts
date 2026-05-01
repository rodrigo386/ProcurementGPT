import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { requireEnv, optionalEnv } from '@/lib/env';

describe('requireEnv', () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  it('returns the value when set', () => {
    process.env.FOO = 'bar';
    expect(requireEnv('FOO')).toBe('bar');
  });

  it('throws a descriptive error when missing', () => {
    delete process.env.FOO;
    expect(() => requireEnv('FOO')).toThrow(/FOO/);
  });

  it('throws when value is an empty string', () => {
    process.env.FOO = '';
    expect(() => requireEnv('FOO')).toThrow(/FOO/);
  });
});

describe('optionalEnv', () => {
  it('returns undefined when missing', () => {
    delete process.env.NOT_SET;
    expect(optionalEnv('NOT_SET')).toBeUndefined();
  });

  it('returns the value when set', () => {
    process.env.OPT = 'x';
    expect(optionalEnv('OPT')).toBe('x');
  });
});
