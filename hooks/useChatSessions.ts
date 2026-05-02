'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage } from '@/lib/rag/types';
import {
  type StoredSession,
  createSession,
  deriveTitle,
  loadSessions,
  saveSessions,
} from '@/lib/chat-storage';

export type UseChatSessions = {
  sessions: StoredSession[];
  currentId: string;
  current: StoredSession;
  switchTo: (id: string) => void;
  createNew: () => void;
  deleteSession: (id: string) => void;
  updateMessages: (messages: ChatMessage[]) => void;
};

export function useChatSessions(): UseChatSessions {
  const [sessions, setSessions] = useState<StoredSession[]>(() => {
    if (typeof window === 'undefined') return [];
    const loaded = loadSessions();
    if (loaded.length === 0) {
      const fresh = createSession();
      saveSessions([fresh]);
      return [fresh];
    }
    return loaded;
  });
  const [currentId, setCurrentId] = useState<string>(() => sessions[0]?.id ?? '');

  // If we mounted on the server with empty sessions, hydrate after mount.
  useEffect(() => {
    if (sessions.length > 0) return;
    const loaded = loadSessions();
    if (loaded.length === 0) {
      const fresh = createSession();
      saveSessions([fresh]);
      setSessions([fresh]);
      setCurrentId(fresh.id);
    } else {
      setSessions(loaded);
      setCurrentId(loaded[0]!.id);
    }
  }, [sessions.length]);

  const current = sessions.find((s) => s.id === currentId) ?? sessions[0]!;

  const persist = useCallback((next: StoredSession[]) => {
    setSessions(next);
    saveSessions(next);
  }, []);

  const switchTo = useCallback((id: string) => {
    setCurrentId(id);
  }, []);

  const createNew = useCallback(() => {
    const fresh = createSession();
    persist([fresh, ...sessions]);
    setCurrentId(fresh.id);
  }, [persist, sessions]);

  const deleteSession = useCallback(
    (id: string) => {
      const next = sessions.filter((s) => s.id !== id);
      if (next.length === 0) {
        const fresh = createSession();
        persist([fresh]);
        setCurrentId(fresh.id);
        return;
      }
      persist(next);
      if (id === currentId) setCurrentId(next[0]!.id);
    },
    [persist, sessions, currentId],
  );

  const updateMessages = useCallback(
    (messages: ChatMessage[]) => {
      const next = sessions.map((s) =>
        s.id === currentId
          ? { ...s, messages, title: deriveTitle(messages), updatedAt: Date.now() }
          : s,
      );
      persist(next);
    },
    [persist, sessions, currentId],
  );

  return { sessions, currentId, current, switchTo, createNew, deleteSession, updateMessages };
}
