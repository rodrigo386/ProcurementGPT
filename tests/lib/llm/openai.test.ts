import { describe, expect, it, vi } from 'vitest';
import { withRateLimitRetry } from '@/lib/llm/openai';

function rateLimitErr(retrySecs = 1.5) {
  const e = new Error(
    `Rate limit reached for gpt-4o-mini in organization org-X. Limit 200000, Used 200000. Please try again in ${retrySecs}s.`,
  ) as Error & { status: number; code: string };
  e.status = 429;
  e.code = 'rate_limit_exceeded';
  return e;
}

describe('withRateLimitRetry', () => {
  it('returns the result on first-call success without retrying', async () => {
    const call = vi.fn().mockResolvedValue('ok');
    const out = await withRateLimitRetry(call, new AbortController().signal, 'test');
    expect(out).toBe('ok');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('rethrows non-429 errors immediately without retry', async () => {
    const err = new Error('ECONNRESET');
    const call = vi.fn().mockRejectedValueOnce(err);
    await expect(
      withRateLimitRetry(call, new AbortController().signal, 'test'),
    ).rejects.toThrow(/ECONNRESET/);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries once on 429 honoring the "try again in Xs" hint, then succeeds', async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn()
        .mockRejectedValueOnce(rateLimitErr(0.5))
        .mockResolvedValueOnce('after-retry');
      const promise = withRateLimitRetry(
        call,
        new AbortController().signal,
        'test',
      );
      // Advance past the wait (0.5s + 0.5s safety margin = 1000ms)
      await vi.advanceTimersByTimeAsync(1100);
      expect(await promise).toBe('after-retry');
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rethrows the second 429 instead of stacking more retries', async () => {
    vi.useFakeTimers();
    try {
      const call = vi
        .fn()
        .mockRejectedValueOnce(rateLimitErr(0.1))
        .mockRejectedValueOnce(rateLimitErr(0.1));
      const promise = withRateLimitRetry(
        call,
        new AbortController().signal,
        'test',
      );
      const expectation = expect(promise).rejects.toThrow(/Rate limit/);
      await vi.advanceTimersByTimeAsync(1000);
      await expectation;
      expect(call).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the retry when the signal fires during the wait', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const call = vi.fn().mockRejectedValue(rateLimitErr(2));
      const promise = withRateLimitRetry(call, controller.signal, 'test');
      const expectation = expect(promise).rejects.toThrow();
      controller.abort();
      await vi.advanceTimersByTimeAsync(2500);
      await expectation;
      // Only the first attempt happened — the post-wait branch saw the signal aborted
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
