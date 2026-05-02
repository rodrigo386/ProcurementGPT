'use client';
import { createBrowserClient } from '@supabase/ssr';

// IMPORTANT: literal process.env.NEXT_PUBLIC_* access — Next.js inlines these
// at build time. Using requireEnv(name) here would not work because Next does
// not statically analyze dynamic process.env[name] references in client code.
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let cached: ReturnType<typeof createBrowserClient> | null = null;

export function supabaseBrowser() {
  if (cached) return cached;
  if (!URL || !ANON_KEY) {
    throw new Error(
      'Supabase env vars not bundled. NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set in .env.local at build time.',
    );
  }
  cached = createBrowserClient(URL, ANON_KEY);
  return cached;
}
