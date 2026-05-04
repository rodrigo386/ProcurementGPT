'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage } from '@/lib/rag/types';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { deriveTitle, type StoredSession } from '@/lib/chat-storage';
import type { UseChatSessions } from '@/hooks/useChatSessions';

type DBRow = {
  id: string;
  title: string;
  messages: ChatMessage[] | null;
  updated_at: string;
};

function rowToSession(r: DBRow): StoredSession {
  return {
    id: r.id,
    title: r.title,
    messages: (r.messages as ChatMessage[]) ?? [],
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

const EMPTY_STUB: StoredSession = { id: '', title: '', messages: [], updatedAt: 0 };

export function useChatSessionsRemote(): UseChatSessions {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [hydrated, setHydrated] = useState(false);
  const [ratings, setRatings] = useState<Map<string, 'up' | 'down'>>(new Map());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sb = supabaseBrowser();
      const { data, error } = await sb
        .from('sessions')
        .select('id, title, messages, updated_at')
        .order('updated_at', { ascending: false });
      if (cancelled) return;
      if (error) {
        console.warn('[useChatSessionsRemote] load failed:', error);
        setHydrated(true);
        return;
      }
      const rows = (data ?? []) as DBRow[];
      if (rows.length === 0) {
        const { data: created, error: insErr } = await sb
          .from('sessions')
          .insert({})
          .select('id, title, messages, updated_at')
          .single();
        if (cancelled) return;
        if (insErr || !created) {
          console.warn('[useChatSessionsRemote] auto-create failed:', insErr);
          setHydrated(true);
          return;
        }
        const fresh = rowToSession(created as DBRow);
        setSessions([fresh]);
        setCurrentId(fresh.id);
      } else {
        const list = rows.map(rowToSession);
        setSessions(list);
        setCurrentId(list[0]!.id);
      }
      setHydrated(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    (async () => {
      const sb = supabaseBrowser();
      const { data, error } = await sb
        .from('message_feedback')
        .select('trace_id, rating')
        .eq('session_id', currentId);
      if (cancelled) return;
      if (error) {
        console.warn('[useChatSessionsRemote] feedback load failed:', error);
        return;
      }
      const next = new Map<string, 'up' | 'down'>();
      for (const r of (data ?? []) as Array<{ trace_id: string; rating: 'up' | 'down' }>) {
        next.set(r.trace_id, r.rating);
      }
      setRatings(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [currentId]);

  const switchTo = useCallback((id: string) => {
    setCurrentId(id);
  }, []);

  const createNew = useCallback(async () => {
    const sb = supabaseBrowser();
    const { data, error } = await sb
      .from('sessions')
      .insert({})
      .select('id, title, messages, updated_at')
      .single();
    if (error || !data) {
      console.warn('[useChatSessionsRemote] createNew failed:', error);
      return;
    }
    const fresh = rowToSession(data as DBRow);
    setSessions((prev) => [fresh, ...prev]);
    setCurrentId(fresh.id);
  }, []);

  const deleteSession = useCallback(
    async (id: string) => {
      const sb = supabaseBrowser();
      const { error } = await sb.from('sessions').delete().eq('id', id);
      if (error) {
        console.warn('[useChatSessionsRemote] delete failed:', error);
        return;
      }
      const remaining = sessions.filter((s) => s.id !== id);
      setSessions(remaining);
      if (id === currentId) {
        if (remaining.length > 0) {
          setCurrentId(remaining[0]!.id);
        } else {
          await createNew();
        }
      }
    },
    [createNew, currentId, sessions],
  );

  const updateMessages = useCallback(
    async (messages: ChatMessage[]) => {
      const title = deriveTitle(messages);
      const updatedAt = Date.now();
      setSessions((prev) =>
        prev.map((s) => (s.id === currentId ? { ...s, messages, title, updatedAt } : s)),
      );
      const sb = supabaseBrowser();
      const { error } = await sb
        .from('sessions')
        .update({
          messages,
          title,
          updated_at: new Date(updatedAt).toISOString(),
        })
        .eq('id', currentId);
      if (error) {
        console.warn('[useChatSessionsRemote] update failed:', error);
      }
    },
    [currentId],
  );

  if (!hydrated) {
    return {
      sessions: [],
      currentId: '',
      current: EMPTY_STUB,
      ratings: new Map(),
      switchTo,
      createNew: createNew as unknown as () => void,
      deleteSession: deleteSession as unknown as (id: string) => void,
      updateMessages: updateMessages as unknown as (messages: ChatMessage[]) => void,
    };
  }

  const current = sessions.find((s) => s.id === currentId) ?? sessions[0] ?? EMPTY_STUB;

  return {
    sessions,
    currentId,
    current,
    ratings,
    switchTo,
    createNew: createNew as unknown as () => void,
    deleteSession: deleteSession as unknown as (id: string) => void,
    updateMessages: updateMessages as unknown as (messages: ChatMessage[]) => void,
  };
}
