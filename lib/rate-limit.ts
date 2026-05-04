import { supabaseServer } from '@/lib/db/supabase-server';

export const RATE_LIMIT_PER_MIN = 10;
export const RATE_LIMIT_PER_HOUR = 60;

export type RateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSecs: number };

type RpcRow = { allowed: boolean; retry_after_secs: number };

export async function checkChatRateLimit(): Promise<RateLimitResult> {
  const sb = supabaseServer();
  const { data, error } = await sb.rpc('check_rate_limit', {
    p_endpoint: 'chat',
    p_per_min: RATE_LIMIT_PER_MIN,
    p_per_hour: RATE_LIMIT_PER_HOUR,
  });

  // Fail-open: if the RPC fails for any reason, do not shut down chat for all
  // users. The risk of one user occasionally bypassing the limit is much lower
  // than the risk of the product being unusable due to an RPC regression.
  if (error || !Array.isArray(data) || data.length === 0) {
    if (error) console.warn('[rate-limit] RPC failed, fail-open:', error.message);
    return { allowed: true };
  }

  const row = data[0] as RpcRow;
  if (row.allowed) return { allowed: true };
  return { allowed: false, retryAfterSecs: row.retry_after_secs };
}
