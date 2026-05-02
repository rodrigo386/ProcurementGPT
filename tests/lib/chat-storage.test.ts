import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { ChatMessage } from '@/lib/rag/types';

beforeEach(() => {
  // jsdom is not active in this file; emulate localStorage via a Map.
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
  vi.resetModules();
});

const userMsg = (content: string): ChatMessage => ({ role: 'user', content });

describe('chat-storage', () => {
  it('loadSessions returns [] when localStorage is empty', async () => {
    const { loadSessions } = await import('@/lib/chat-storage');
    expect(loadSessions()).toEqual([]);
  });

  it('loadSessions returns [] when stored JSON is malformed', async () => {
    localStorage.setItem('pgpt:sessions:v1', 'not valid json {');
    const { loadSessions } = await import('@/lib/chat-storage');
    expect(loadSessions()).toEqual([]);
  });

  it('saveSessions round-trips through loadSessions', async () => {
    const { loadSessions, saveSessions } = await import('@/lib/chat-storage');
    const sessions = [
      { id: 'a', title: 'one', messages: [userMsg('hi')], updatedAt: 100 },
      { id: 'b', title: 'two', messages: [userMsg('yo')], updatedAt: 200 },
    ];
    saveSessions(sessions);
    const loaded = loadSessions();
    expect(loaded).toHaveLength(2);
    expect(loaded.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });

  it('saveSessions caps to 50 by dropping oldest by updatedAt', async () => {
    const { loadSessions, saveSessions } = await import('@/lib/chat-storage');
    const sessions = Array.from({ length: 60 }, (_, i) => ({
      id: `s${i}`,
      title: `t${i}`,
      messages: [],
      updatedAt: i,
    }));
    saveSessions(sessions);
    const loaded = loadSessions();
    expect(loaded).toHaveLength(50);
    // Newest 50 (updatedAt 10..59) should be kept; oldest 10 dropped
    const ids = new Set(loaded.map((s) => s.id));
    expect(ids.has('s59')).toBe(true);
    expect(ids.has('s10')).toBe(true);
    expect(ids.has('s9')).toBe(false);
    expect(ids.has('s0')).toBe(false);
  });

  it('createSession produces unique ids and the default title', async () => {
    const { createSession } = await import('@/lib/chat-storage');
    const a = createSession();
    const b = createSession();
    expect(a.id).not.toBe(b.id);
    expect(a.messages).toEqual([]);
    expect(a.title).toBe('Nova conversa');
    expect(typeof a.updatedAt).toBe('number');
  });

  it('deriveTitle truncates >60 chars with ellipsis and falls back to default', async () => {
    const { deriveTitle } = await import('@/lib/chat-storage');
    expect(deriveTitle([])).toBe('Nova conversa');
    expect(deriveTitle([userMsg('Curto')])).toBe('Curto');
    const long = 'a'.repeat(80);
    const got = deriveTitle([userMsg(long)]);
    expect(got.length).toBe(61); // 60 chars + '…'
    expect(got.endsWith('…')).toBe(true);
  });
});
