import { getServerSupabase } from '@/lib/db/supabase';

export const INGEST_BUCKET = 'ingest-uploads';

export async function uploadToIngestBucket(
  path: string,
  buf: Buffer,
  contentType: string,
): Promise<void> {
  const sb = getServerSupabase();
  const { error } = await sb.storage
    .from(INGEST_BUCKET)
    .upload(path, buf, { contentType, upsert: false });
  if (error) throw new Error(`storage upload failed: ${error.message}`);
}

export async function downloadFromIngestBucket(path: string): Promise<Buffer> {
  const sb = getServerSupabase();
  const { data, error } = await sb.storage.from(INGEST_BUCKET).download(path);
  if (error || !data) throw new Error(`storage download failed: ${error?.message ?? 'no data'}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function deleteFromIngestBucket(path: string): Promise<void> {
  const sb = getServerSupabase();
  await sb.storage.from(INGEST_BUCKET).remove([path]);
}
