import { NextResponse } from 'next/server';
import { requireAdmin, NotAdmin } from '@/lib/auth';
import { runPipeline } from '@/lib/ingest/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Bound function lifetime; on Vercel Pro maxDuration default is 60s, max 300s.
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: { jobId: string } }) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 });
    throw err;
  }
  await runPipeline(params.jobId);
  return NextResponse.json({ ok: true });
}
