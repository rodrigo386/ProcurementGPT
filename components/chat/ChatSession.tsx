'use client';

import { useChat, type Message as AIMessage } from 'ai/react';
import type { ChatMessage } from '@/lib/rag/types';
import type { StoredSession } from '@/lib/chat-storage';
import { EmptyState } from './EmptyState';
import { MessageList } from './MessageList';
import { Composer } from './Composer';

type Props = {
  session: StoredSession;
  onMessagesChange: (messages: ChatMessage[]) => void;
};

function toChatMessages(messages: AIMessage[]): ChatMessage[] {
  return messages
    .filter((m): m is AIMessage & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
}

export function ChatSession({ session, onMessagesChange }: Props) {
  const { messages, input, setInput, handleSubmit, isLoading, stop } = useChat({
    api: '/api/chat',
    id: session.id,
    initialMessages: session.messages.map((m, i) => ({
      id: `${session.id}-${i}`,
      role: m.role,
      content: m.content,
    })),
    onFinish: (assistant) => {
      const next = toChatMessages([...messages, assistant]);
      onMessagesChange(next);
    },
  });

  return (
    <>
      {messages.length === 0 ? (
        <EmptyState onPick={(text) => setInput(text)} />
      ) : (
        <MessageList
          messages={messages.map((m) => ({
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
          }))}
          isLoading={isLoading}
        />
      )}
      <Composer
        input={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        isLoading={isLoading}
        onStop={stop}
      />
    </>
  );
}
