import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireAdmin, NotAdmin } from '@/lib/auth';
import { getServerSupabase } from '@/lib/db/supabase';
import { uploadToIngestBucket } from '@/lib/db/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  let admin;
  try {
    admin = await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 });
    throw err;
  }

  const fd = await req.formData();
  const file = fd.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'missing_file' }, { status: 400 });
  }
  if (!ALLOWED_MIMES.has(file.type)) {
    return NextResponse.json({ error: 'unsupported_type' }, { status: 400 });
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 400 });
  }

  const jobId = randomUUID();
  const safeName = file.name.replace(/[^\w.\-]/g, '_');
  const storagePath = `${admin.user.id}/${jobId}/${safeName}`;
  const buf = Buffer.from(await file.arrayBuffer());

  await uploadToIngestBucket(storagePath, buf, file.type);

  const sb = getServerSupabase();
  const { data, error } = await sb
    .from('ingestion_jobs')
    .insert({
      id: jobId,
      user_id: admin.user.id,
      filename: safeName,
      storage_path: storagePath,
      size_bytes: file.size,
      mime_type: file.type,
      status: 'queued',
      progress: 0,
    })
    .select('id')
    .single();
  if (error || !data) {
    return NextResponse.json({ error: 'job_insert_failed' }, { status: 500 });
  }
  return NextResponse.json({ jobId: data.id });
}
