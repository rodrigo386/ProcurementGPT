import { NextResponse } from 'next/server';
import { requireAdmin, NotAdmin } from '@/lib/auth';
import { getServerSupabase } from '@/lib/db/supabase';
import { runPipeline } from '@/lib/ingest/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(_req: Request, { params }: { params: { jobId: string } }) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 });
    throw err;
  }
  const sb = getServerSupabase();
  const { data: job, error } = await sb
    .from('ingestion_jobs')
    .select('status')
    .eq('id', params.jobId)
    .single();
  if (error || !job) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (job.status !== 'error') {
    return NextResponse.json({ error: 'not_in_error_state' }, { status: 400 });
  }
  await sb
    .from('ingestion_jobs')
    .update({
      status: 'queued',
      stage: null,
      progress: 0,
      error_message: null,
      finished_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.jobId);

  await runPipeline(params.jobId);
  return NextResponse.json({ ok: true });
}
