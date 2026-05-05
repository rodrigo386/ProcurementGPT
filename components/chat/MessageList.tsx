'use client';

import { useEffect, useRef } from 'react';
import { Message } from './Message';
import type { ChatMessage } from '@/lib/rag/types';

type Annotation = { traceId?: string; followups?: string[] };

type UIMessage = ChatMessage & {
  id?: string;
  annotations?: unknown[];
};

type Props = {
  messages: UIMessage[];
  isLoading: boolean;
  sessionId?: string;
  initialRatings?: Map<string, 'up' | 'down'>;
  onPickFollowup?: (text: string) => void;
};

const STICK_THRESHOLD_PX = 80;

function pickTraceId(m: UIMessage): string | undefined {
  const ann = m.annotations as Annotation[] | undefined;
  const found = ann?.find((a) => typeof a?.traceId === 'string');
  return found?.traceId;
}

function pickFollowups(m: UIMessage): string[] | undefined {
  const ann = m.annotations as Annotation[] | undefined;
  const found = ann?.find((a) => Array.isArray(a?.followups));
  return found?.followups;
}

export function MessageList({
  messages,
  isLoading,
  sessionId,
  initialRatings,
  onPickFollowup,
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < STICK_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  const lastIdx = messages.length - 1;

  return (
    <div ref={ref} className="flex-1 overflow-y-auto">
      <ol className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {messages.map((m, i) => {
          const traceId = pickTraceId(m);
          const initialRating = traceId ? initialRatings?.get(traceId) : undefined;
          const followups = pickFollowups(m);
          const isLast = i === lastIdx;
          return (
            <Message
              key={m.id ?? i}
              role={m.role === 'assistant' ? 'assistant' : 'user'}
              content={m.content}
              isStreaming={isLoading && isLast && m.role === 'assistant'}
              traceId={traceId}
              sessionId={sessionId}
              initialRating={initialRating}
              followups={followups}
              isLast={isLast}
              onPickFollowup={onPickFollowup}
            />
          );
        })}
      </ol>
    </div>
  );
}
