import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { requireEnv } from '@/lib/env';

let serverInstance: SupabaseClient | null = null;
let browserInstance: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient {
  if (serverInstance) return serverInstance;
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  serverInstance = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serverInstance;
}

export function getBrowserSupabase(): SupabaseClient {
  if (browserInstance) return browserInstance;
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const anonKey = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  browserInstance = createClient(url, anonKey);
  return browserInstance;
}
