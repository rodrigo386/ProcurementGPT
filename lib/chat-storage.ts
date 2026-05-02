import type { ChatMessage } from '@/lib/rag/types';

export type StoredSession = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
};

const KEY = 'pgpt:sessions:v1';
const CAP = 50;
const DEFAULT_TITLE = 'Nova conversa';
const MAX_TITLE_CHARS = 60;

function safeRead(): unknown {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function safeWrite(value: StoredSession[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch (err) {
    console.warn('[chat-storage] write failed:', err);
  }
}

export function loadSessions(): StoredSession[] {
  const raw = safeRead();
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (s): s is StoredSession =>
      !!s &&
      typeof s.id === 'string' &&
      typeof s.title === 'string' &&
      Array.isArray(s.messages) &&
      typeof s.updatedAt === 'number',
  );
}

export function saveSessions(sessions: StoredSession[]): void {
  const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  const capped = sorted.slice(0, CAP);
  safeWrite(capped);
}

export function createSession(): StoredSession {
  const id =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `s_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return { id, title: DEFAULT_TITLE, messages: [], updatedAt: Date.now() };
}

export function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === 'user');
  const text = (firstUser?.content ?? '').trim();
  if (!text) return DEFAULT_TITLE;
  if (text.length <= MAX_TITLE_CHARS) return text;
  return text.slice(0, MAX_TITLE_CHARS) + '…';
}
