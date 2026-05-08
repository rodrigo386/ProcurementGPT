import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAdmin, NotAdmin } from '@/lib/auth';
import { supabaseServer } from '@/lib/db/supabase-server';
import { isValidTheme } from '@/lib/ingest/taxonomy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PatchBody = z
  .object({
    title: z.string().min(3).max(200).optional(),
    theme: z.string().refine(isValidTheme, { message: 'invalid theme' }).optional(),
  })
  .refine((b) => b.title !== undefined || b.theme !== undefined, {
    message: 'at least one field required',
  });

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 });
    throw err;
  }
  const sb = supabaseServer();
  const { error } = await sb.from('articles').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: 'delete_failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 });
    throw err;
  }

  let body: z.infer<typeof PatchBody>;
  try {
    const json = await req.json();
    body = PatchBody.parse(json);
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  const sb = supabaseServer();
  const { error } = await sb.from('articles').update(body).eq('id', params.id);
  if (error) return NextResponse.json({ error: 'update_failed' }, { status: 500 });
  return NextResponse.json({ ok: true });
}
