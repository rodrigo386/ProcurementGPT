'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageActions } from './MessageActions';

type Props = {
  role: 'user' | 'assistant';
  content: string;
  isStreaming: boolean;
  traceId?: string;
  sessionId?: string;
  initialRating?: 'up' | 'down';
};

export function Message({ role, content, isStreaming, traceId, sessionId, initialRating }: Props) {
  if (role === 'user') {
    return (
      <li className="flex justify-end">
        <div className="bg-primary text-primary-foreground max-w-[75%] rounded-2xl px-4 py-2 whitespace-pre-wrap break-words">
          {content}
        </div>
      </li>
    );
  }
  return (
    <li className="flex justify-start">
      <div className="bg-card border border-border max-w-[85%] rounded-2xl px-4 py-3">
        <div className="prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
        </div>
        {isStreaming ? (
          <span
            data-streaming-dot
            className="inline-block ml-1 h-2 w-2 rounded-full bg-primary animate-pulse"
            aria-label="Gerando"
          />
        ) : null}
        {!isStreaming && traceId && sessionId ? (
          <MessageActions traceId={traceId} sessionId={sessionId} initialRating={initialRating} />
        ) : null}
      </div>
    </li>
  );
}
