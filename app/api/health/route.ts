import { NextResponse } from 'next/server';
import { getServerSupabase } from '@/lib/db/supabase';
import { embed } from '@/lib/llm/voyage';
import { rerank } from '@/lib/llm/cohere';
import { pingOpenAI } from '@/lib/llm/openai';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

type CheckResult = 'ok' | string;

async function safe(fn: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return `error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function checkSupabase(): Promise<CheckResult> {
  return safe(async () => {
    const sb = getServerSupabase();
    const { error } = await sb.from('articles').select('id').limit(1);
    if (error) throw new Error(error.message);
  });
}

export async function GET() {
  const start = Date.now();
  const [supabase, voyage, cohere, openai] = await Promise.all([
    checkSupabase(),
    safe(() => embed(['hello'])),
    safe(() => rerank('a', ['b', 'c'], 1)),
    safe(() => pingOpenAI()),
  ]);
  const ms = Date.now() - start;
  const checks = { supabase, voyage, cohere, openai };
  const ok = Object.values(checks).every((v) => v === 'ok');
  return NextResponse.json({ ok, checks, ms }, { status: ok ? 200 : 503 });
}
