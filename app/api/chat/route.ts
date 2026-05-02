import { z } from 'zod';
import { streamText, StreamData } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { requireEnv } from '@/lib/env';
import { runRag } from '@/lib/rag';
import { condenseQuery } from '@/lib/rag/condenser';
import type { ChatMessage } from '@/lib/rag/types';

export const runtime = 'edge';

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
  })
  .refine((b) => b.messages[b.messages.length - 1]!.role === 'user', {
    message: 'last message must be from user',
  });

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

  const messages: ChatMessage[] = parsed.messages;

  try {
    const standalone = await condenseQuery(messages);
    const rag = await runRag(standalone);

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
    });

    const result = streamText({
      model: google(requireEnv('GEMINI_MODEL')),
      system: rag.system,
      messages: llmMessages,
      onFinish: () => {
        data.close();
      },
    });

    return result.toDataStreamResponse({ data });
  } catch (err) {
    console.error('[api/chat] failed:', err);
    return Response.json({ error: 'chat failed' }, { status: 500 });
  }
}
