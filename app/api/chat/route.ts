import { z } from 'zod';
import { streamText, StreamData } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { requireEnv } from '@/lib/env';
import { runRag } from '@/lib/rag';
import { condenseQuery } from '@/lib/rag/condenser';
import type { ChatMessage } from '@/lib/rag/types';
import { startTrace, flushAsync } from '@/lib/observability/langfuse';
import { getCurrentUser } from '@/lib/auth';
import { checkChatRateLimit } from '@/lib/rate-limit';
import type { TraceLevel } from '@/lib/observability/types';

export const runtime = 'nodejs';

const Body = z
  .object({
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant']),
          content: z.string().min(1),
        }),
      )
      .min(1),
    sessionId: z.string().uuid().optional(),
  })
  .refine(
    (b) => b.messages.length > 0 && b.messages[b.messages.length - 1]!.role === 'user',
    { message: 'last message must be from user' },
  );

export async function POST(req: Request): Promise<Response> {
  let parsed;
  try {
    const json = await req.json();
    parsed = Body.parse(json);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'invalid body' },
      { status: 400 },
    );
  }

  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const rl = await checkChatRateLimit();
  if (!rl.allowed) {
    return Response.json(
      { error: 'rate_limited', retry_after_secs: rl.retryAfterSecs },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfterSecs) } },
    );
  }

  const messages: ChatMessage[] = parsed.messages;
  const env = process.env.APP_ENV ?? 'production';

  const trace = await startTrace({
    name: 'chat.turn',
    userId: user.id,
    sessionId: parsed.sessionId,
    input: { messages },
    tags: [`env:${env}`],
  });

  try {
    const condenseSpan = trace.span('condense', { messages });
    const standalone = await condenseQuery(messages);
    condenseSpan.end({ standalone });

    const rag = await runRag(standalone, { parentTrace: trace });

    const history = messages.slice(0, -1);
    const llmMessages: ChatMessage[] = [
      ...history,
      { role: 'user', content: rag.user },
    ];

    const google = createGoogleGenerativeAI({
      apiKey: requireEnv('GOOGLE_API_KEY'),
    });

    const data = new StreamData();
    data.appendMessageAnnotation({
      sources: rag.sources,
      classification: rag.classification,
      debug: rag.debug,
      traceId: trace.id,
    });

    const generateSpan = trace.span('generate', { systemLen: rag.system.length });

    const result = streamText({
      model: google(requireEnv('GEMINI_MODEL')),
      system: rag.system,
      messages: llmMessages,
      onFinish: async ({ text, usage, finishReason }) => {
        generateSpan.end({
          tokens_in: usage.promptTokens,
          tokens_out: usage.completionTokens,
          finish_reason: finishReason,
          chars_out: text.length,
        });
        const aborted = finishReason === 'error';
        const level: TraceLevel = aborted ? 'WARNING' : 'DEFAULT';
        if (aborted) trace.setTag('aborted');
        trace.end(
          { answer: text, sources: rag.sources, finishReason },
          level,
        );
        await flushAsync();
        data.close();
      },
    });

    return result.toDataStreamResponse({ data });
  } catch (err) {
    console.error('[api/chat] failed:', err);
    const message = err instanceof Error ? err.message : String(err);
    trace.end({ error: message }, 'ERROR');
    await flushAsync();
    return Response.json({ error: 'chat failed' }, { status: 500 });
  }
}
