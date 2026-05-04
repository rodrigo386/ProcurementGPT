import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_KEYS = {
  pub: process.env.LANGFUSE_PUBLIC_KEY,
  sec: process.env.LANGFUSE_SECRET_KEY,
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env.LANGFUSE_PUBLIC_KEY = ORIGINAL_KEYS.pub;
  process.env.LANGFUSE_SECRET_KEY = ORIGINAL_KEYS.sec;
});

describe('startTrace', () => {
  it('returns a no-op trace with a UUID id when keys are missing', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const { startTrace } = await import('@/lib/observability/langfuse');
    const t = await startTrace({ name: 'test' });
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/i);
    t.span('s').end({});
    t.setTag('x');
    t.setMetadata('k', 'v');
    t.end();
  });

  it('exposes the Langfuse trace id when keys are present', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pub';
    process.env.LANGFUSE_SECRET_KEY = 'sec';
    vi.doMock('langfuse', () => ({
      Langfuse: vi.fn().mockImplementation(() => ({
        trace: vi.fn(() => ({
          id: 'lf-trace-abc',
          update: vi.fn(),
          span: vi.fn(() => ({ end: vi.fn() })),
        })),
        flushAsync: vi.fn().mockResolvedValue(undefined),
      })),
    }));
    const { startTrace } = await import('@/lib/observability/langfuse');
    const t = await startTrace({ name: 'test' });
    expect(t.id).toBe('lf-trace-abc');
  });
});

describe('scoreTrace', () => {
  it('is a no-op when keys are missing', async () => {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    const { scoreTrace } = await import('@/lib/observability/langfuse');
    await expect(
      scoreTrace({ traceId: 't1', name: 'user-feedback', value: 1 }),
    ).resolves.toBeUndefined();
  });

  it('calls Langfuse.score with the right body and flushes', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pub';
    process.env.LANGFUSE_SECRET_KEY = 'sec';
    const score = vi.fn();
    const flushAsync = vi.fn().mockResolvedValue(undefined);
    vi.doMock('langfuse', () => ({
      Langfuse: vi.fn().mockImplementation(() => ({
        trace: vi.fn(() => ({
          id: 'tx',
          update: vi.fn(),
          span: vi.fn(() => ({ end: vi.fn() })),
        })),
        score,
        flushAsync,
      })),
    }));
    const { startTrace, scoreTrace } = await import('@/lib/observability/langfuse');
    await startTrace({ name: 'warm' });
    await scoreTrace({ traceId: 't1', name: 'user-feedback', value: -1, comment: 'meh' });
    expect(score).toHaveBeenCalledWith({
      traceId: 't1',
      name: 'user-feedback',
      value: -1,
      comment: 'meh',
    });
    expect(flushAsync).toHaveBeenCalled();
  });
});
