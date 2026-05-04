import type { Trace, Span, TraceLevel } from './types';

const NOOP_SPAN: Span = { end() {} };

let cachedClient: {
  trace: (opts: unknown) => unknown;
  score: (body: unknown) => unknown;
  flushAsync: () => Promise<void>;
} | null = null;

async function getClient(): Promise<NonNullable<typeof cachedClient> | null> {
  const secret = process.env.LANGFUSE_SECRET_KEY;
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  if (!secret || !pub) return null;
  if (!cachedClient) {
    const { Langfuse } = await import('langfuse');
    cachedClient = new Langfuse({
      secretKey: secret,
      publicKey: pub,
      baseUrl: process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com',
    }) as unknown as typeof cachedClient;
  }
  return cachedClient;
}

export async function startTrace(opts: {
  name: string;
  userId?: string;
  sessionId?: string;
  input?: unknown;
  tags?: string[];
  metadata?: Record<string, unknown>;
}): Promise<Trace> {
  const client = await getClient();
  if (!client) {
    const localId = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : 'noop-' + Math.random();
    return {
      id: localId,
      span: () => NOOP_SPAN,
      end: () => {},
      setMetadata: () => {},
      setTag: () => {},
    };
  }

  const lfTrace = client.trace({
    name: opts.name,
    userId: opts.userId,
    sessionId: opts.sessionId,
    input: opts.input,
    tags: opts.tags,
    metadata: opts.metadata,
  }) as {
    id: string;
    update: (p: unknown) => void;
    span: (p: unknown) => { end: (p: unknown) => void };
  };

  return {
    id: lfTrace.id,
    span(name, input) {
      const lfSpan = lfTrace.span({ name, input });
      return {
        end(output, level) {
          lfSpan.end({ output, level });
        },
      };
    },
    end(output, level) {
      lfTrace.update({ output, level });
    },
    setMetadata(key, value) {
      lfTrace.update({ metadata: { [key]: value } });
    },
    setTag(tag) {
      lfTrace.update({ tags: [tag] });
    },
  };
}

export async function scoreTrace(opts: {
  traceId: string;
  name: string;
  value: number;
  comment?: string;
}): Promise<void> {
  const client = await getClient();
  if (!client) return;
  client.score({
    traceId: opts.traceId,
    name: opts.name,
    value: opts.value,
    comment: opts.comment,
  });
  await client.flushAsync();
}

export async function flushAsync(): Promise<void> {
  if (!cachedClient) return;
  await cachedClient.flushAsync();
}
