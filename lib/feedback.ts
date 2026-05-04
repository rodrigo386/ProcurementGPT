import { supabaseServer } from '@/lib/db/supabase-server';
import { scoreTrace } from '@/lib/observability/langfuse';

export type FeedbackInput = {
  userId: string;
  sessionId: string;
  traceId: string;
  rating: 'up' | 'down';
  comment?: string;
};

export type FeedbackResult =
  | { ok: true }
  | { ok: false; status: 404 | 500 };

export async function recordFeedback(input: FeedbackInput): Promise<FeedbackResult> {
  const sb = supabaseServer();

  // Defense-in-depth on top of RLS: confirm the session belongs to this user
  // before writing a feedback row that references it. RLS would also block the
  // upsert via the foreign key chain, but a clean 404 beats an opaque 500.
  const { data: session } = await sb
    .from('sessions')
    .select('id')
    .eq('id', input.sessionId)
    .eq('user_id', input.userId)
    .maybeSingle();
  if (!session) {
    return { ok: false, status: 404 };
  }

  const { error } = await sb
    .from('message_feedback')
    .upsert(
      {
        user_id: input.userId,
        session_id: input.sessionId,
        trace_id: input.traceId,
        rating: input.rating,
        comment: input.comment ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,trace_id' },
    );
  if (error) {
    console.error('[feedback] upsert failed:', error.message);
    return { ok: false, status: 500 };
  }

  // Mirror to Langfuse fire-and-forget; failures are logged, not propagated.
  void scoreTrace({
    traceId: input.traceId,
    name: 'user-feedback',
    value: input.rating === 'up' ? 1 : -1,
    comment: input.comment,
  }).catch((err) => {
    console.warn('[feedback] scoreTrace failed:', err);
  });

  return { ok: true };
}
