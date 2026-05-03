import { NextResponse } from 'next/server';
import { requireAdmin, NotAdmin } from '@/lib/auth';
import { getServerSupabase } from '@/lib/db/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_RUNNING_MINUTES = 5;
const DONE_RETENTION_DAYS = 7;

export async function GET() {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 });
    throw err;
  }

  const sb = getServerSupabase();

  // Cleanup 1: delete done jobs older than 7 days.
  const cutoffDone = new Date(Date.now() - DONE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await sb.from('ingestion_jobs').delete().eq('status', 'done').lt('finished_at', cutoffDone);

  // Cleanup 2: mark stale-running jobs as error.
  const cutoffStale = new Date(Date.now() - STALE_RUNNING_MINUTES * 60 * 1000).toISOString();
  await sb
    .from('ingestion_jobs')
    .update({
      status: 'error',
      error_message: 'Job interrompido (sem progresso por mais de 5 minutos)',
      finished_at: new Date().toISOString(),
    })
    .eq('status', 'running')
    .lt('updated_at', cutoffStale);

  // List jobs ordered: running, queued, error, done; then created_at desc within group.
  const { data, error } = await sb
    .from('ingestion_jobs')
    .select(
      'id, filename, status, stage, progress, chunks_count, error_message, created_at, updated_at, finished_at, mime_type, size_bytes',
    )
    .order('created_at', { ascending: false });
  if (error) return NextResponse.json({ error: 'list_failed' }, { status: 500 });

  const priority: Record<string, number> = { running: 0, queued: 1, error: 2, done: 3 };
  const jobs = (data ?? []).slice().sort((a: Record<string, unknown>, b: Record<string, unknown>) => {
    const pa = priority[a.status as string] ?? 9;
    const pb = priority[b.status as string] ?? 9;
    if (pa !== pb) return pa - pb;
    return (b.created_at as string).localeCompare(a.created_at as string);
  });

  return NextResponse.json({ jobs });
}
