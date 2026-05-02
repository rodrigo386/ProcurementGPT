# Sub-projeto 6b — DB-Backed Conversation Persistence

> **Status:** Design (sub-projeto 6b of 7).
> **Date:** 2026-05-02
> **Depends on:** sub-projeto 5 (Chat UI — `useChatSessions` hook contract), sub-projeto 6a (Auth — `auth.users`, RLS policies, `auth.uid()` available in policies).
> **Consumed by:** sub-projeto 6c (Admin UI — read sessions across users), sub-projeto 7 (Eval / observability — may attach trace IDs to messages).

## 1. Contexto

Sub-projeto 5 entregou o chat UI com sidebar de sessões em localStorage. Sub-projeto 6a adicionou auth invite-only e middleware-gated `/chat`. Faltava mover as conversas do localStorage para o banco para que: (a) sobrevivam à troca de browser/dispositivo, (b) sejam removíveis via `delete cascade` quando a conta é apagada (LGPD art. 16), (c) admin (sub-projeto 6c) possa eventualmente inspecionar conversas via política RLS adicional.

Decisão de produto (Q1-A): **DB é a única fonte de verdade quando logado**. Não há toggle "salvar conversas" — aceitar o convite implica aceitar persistência. localStorage é descartado para usuários autenticados.

O critério de pronto: usuário logado abre `/chat`, troca conversas no sidebar (todas vindas do DB), envia mensagens (escritas no DB após cada `onFinish`), refresca o browser e vê o mesmo histórico, abre uma aba anônima logada com a mesma conta e vê o mesmo histórico.

## 2. Objetivo

Entregar:
- Migration `00000000000004_sessions.sql` — tabela `sessions` (1 linha por conversa, `messages` jsonb), índice `(user_id, updated_at desc)`, 4 policies RLS owner-only.
- `hooks/useChatSessionsRemote.ts` — drop-in replacement para `useChatSessions` (mesmo retorno), backed por Supabase via `supabaseBrowser()`.
- `components/chat/ChatRoot.tsx` — uma linha alterada (import).
- `lib/chat-storage.ts` — anotação `@deprecated` (sem mudança de código).
- `hooks/useChatSessions.ts` — anotação `@deprecated` (sem mudança de código).
- `tests/hooks/useChatSessionsRemote.test.tsx` — 5 testes unitários com `supabaseBrowser` mockado.

**Não-objetivos** (delegados):
- Realtime sync entre abas (Supabase Realtime) → futuro
- Admin views de conversas de outros usuários → sub-projeto 6c
- Endpoint de export LGPD self-service → sub-projeto 7+ (cascade FK satisfaz erasure mecanicamente)
- Conversation sharing (read-only link) → futuro
- Rename manual de título, search/filter no sidebar, paginação além de 50 → futuro
- Auto-archive / retenção temporal → sem cap (Q3-a)
- Hook server-side em `/api/chat` para gravar mensagens → sub-projeto 7 se a observabilidade exigir
- Migrar localStorage existente para DB no primeiro login → discard (Q3-a)

## 3. Stack

- `@supabase/supabase-js` (já presente) via `supabaseBrowser()` (sub-projeto 6a)
- Postgres `jsonb`, `gen_random_uuid()`, RLS — todos nativos
- `vitest` + `@testing-library/react` (já presentes) — 1 novo arquivo de teste

Sem novas dependências.

## 4. Estrutura de pastas

```
/hooks
  useChatSessions.ts                # MODIFY — add @deprecated JSDoc only
  useChatSessionsRemote.ts          # NEW — drop-in DB-backed replacement
/lib
  chat-storage.ts                   # MODIFY — add @deprecated JSDoc only
/components/chat
  ChatRoot.tsx                      # MODIFY — import swap (1 line)
/supabase/migrations
  00000000000004_sessions.sql       # NEW — sessions table + RLS
/tests/hooks
  useChatSessionsRemote.test.tsx    # NEW — 5 tests (mock supabaseBrowser)
  useChatSessions.test.tsx          # UNCHANGED — still passes; tests dead code
/tests/lib
  chat-storage.test.ts              # UNCHANGED — still passes; tests dead code
```

The deprecated localStorage modules stay because: (a) their tests pass and removing them would mean removing 9 working tests for no benefit, (b) sub-projeto 7 may want to revive them for an offline mode.

## 5. Migration

`supabase/migrations/00000000000004_sessions.sql`:

```sql
-- Sub-projeto 6b: DB-backed conversation persistence (replaces localStorage for authed users)

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Nova conversa',
  messages jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sessions_user_id_updated_at_idx on sessions (user_id, updated_at desc);

alter table sessions enable row level security;

create policy sessions_owner_select on sessions for select to authenticated
  using (user_id = auth.uid());
create policy sessions_owner_insert on sessions for insert to authenticated
  with check (user_id = auth.uid());
create policy sessions_owner_update on sessions for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy sessions_owner_delete on sessions for delete to authenticated
  using (user_id = auth.uid());
```

**Notes:**
- `id uuid default gen_random_uuid()` — server generates ids; the client lets the DB return them on insert. This replaces sub-projeto 5's `crypto.randomUUID()` client-side generation.
- `user_id` FK with `on delete cascade` — deleting an auth user wipes their sessions in one statement (LGPD article 16 satisfied mechanically).
- `messages jsonb` — single column holds the full ChatMessage[]. Postgres TOAST handles oversized rows transparently (up to ~1 GB).
- `(user_id, updated_at desc)` index — supports the sidebar's "newest first within current user" query without a sequential scan.
- Four owner-only policies on `select`/`insert`/`update`/`delete`. `service_role` bypasses RLS, so the existing chat backend / ingest are unaffected. No admin policy in 6b — that's 6c's call.

## 6. Hook contract — `useChatSessionsRemote`

```ts
// hooks/useChatSessionsRemote.ts
'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ChatMessage } from '@/lib/rag/types';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { deriveTitle, type StoredSession } from '@/lib/chat-storage';
import type { UseChatSessions } from '@/hooks/useChatSessions';

export function useChatSessionsRemote(): UseChatSessions {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [hydrated, setHydrated] = useState(false);

  // Load on mount
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
        setSessions([]);
        setHydrated(true);
        return;
      }
      const rows: StoredSession[] = (data ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        messages: (r.messages as ChatMessage[]) ?? [],
        updatedAt: new Date(r.updated_at).getTime(),
      }));
      if (rows.length === 0) {
        // create one so UI always has a current
        const { data: created, error: insErr } = await sb
          .from('sessions')
          .insert({})
          .select('id, title, messages, updated_at')
          .single();
        if (insErr || !created) {
          setHydrated(true);
          return;
        }
        const fresh: StoredSession = {
          id: created.id,
          title: created.title,
          messages: [],
          updatedAt: new Date(created.updated_at).getTime(),
        };
        setSessions([fresh]);
        setCurrentId(fresh.id);
      } else {
        setSessions(rows);
        setCurrentId(rows[0]!.id);
      }
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const current = sessions.find((s) => s.id === currentId) ?? sessions[0]!;

  const switchTo = useCallback((id: string) => setCurrentId(id), []);

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
    const fresh: StoredSession = {
      id: data.id,
      title: data.title,
      messages: [],
      updatedAt: new Date(data.updated_at).getTime(),
    };
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
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (next.length === 0) {
          // create a fresh one so UI keeps an active session
          createNew();
          return next;
        }
        if (id === currentId) setCurrentId(next[0]!.id);
        return next;
      });
    },
    [createNew, currentId],
  );

  const updateMessages = useCallback(
    async (messages: ChatMessage[]) => {
      const title = deriveTitle(messages);
      const updatedAt = Date.now();
      // Optimistic local update first
      setSessions((prev) =>
        prev.map((s) => (s.id === currentId ? { ...s, messages, title, updatedAt } : s)),
      );
      const sb = supabaseBrowser();
      const { error } = await sb
        .from('sessions')
        .update({ messages, title, updated_at: new Date(updatedAt).toISOString() })
        .eq('id', currentId);
      if (error) {
        console.warn('[useChatSessionsRemote] update failed:', error);
      }
    },
    [currentId],
  );

  // Before hydration, return a stable empty shape (consumers handle null current via guard)
  if (!hydrated || !current) {
    return {
      sessions: [],
      currentId: '',
      current: { id: '', title: '', messages: [], updatedAt: 0 } as StoredSession,
      switchTo,
      createNew,
      deleteSession,
      updateMessages,
    };
  }

  return { sessions, currentId, current, switchTo, createNew, deleteSession, updateMessages };
}
```

**Key differences from `useChatSessions` (localStorage):**
- IDs come from the DB (`gen_random_uuid()`), not from `crypto.randomUUID()` on the client.
- All mutations are async (await Supabase calls); the hook signature stays sync because state updates are local-first (optimistic).
- Errors log via `console.warn` but never throw — failure fallback is "local state is the truth until next reload."
- The "auto-create one session on empty" behavior matches the localStorage hook.
- Pre-hydration return is an empty stable shape; `ChatRoot`'s existing `if (!sessionsApi.current)` guard from sub-projeto 5 (the SSR-safe one) handles the empty `current.id`.

`ChatRoot.tsx` change — two edits:

```diff
- import { useChatSessions } from '@/hooks/useChatSessions';
+ import { useChatSessionsRemote as useChatSessions } from '@/hooks/useChatSessionsRemote';
```

```diff
- if (!sessionsApi.current) {
+ if (!sessionsApi.currentId) {
   return <div className="h-screen bg-background" />;
 }
```

The guard tweak is needed because `useChatSessionsRemote`'s pre-hydration stub returns a non-null `current` object with `id: ''` (the type contract is `current: StoredSession`, not `StoredSession | null`). Guarding on `currentId` (an empty string is falsy) gives the same "render empty shell until ready" behavior across both hooks. The localStorage hook always had a non-empty `currentId` post-mount, so this change is backward-compatible with sub-projeto 5's behavior.

Everything downstream of `ChatRoot` (ChatSession, Sidebar, Header, Composer, Message, MessageList, EmptyState, UserRow) is unchanged.

## 7. Testing

### 7.1 New unit tests

`tests/hooks/useChatSessionsRemote.test.tsx` — 5 tests, jsdom env, mocks `supabaseBrowser`.

Mock pattern:

```tsx
function mockBrowser(opts: {
  selectResult?: { data: any; error: any };
  insertResult?: { data: any; error: any };
  updateResult?: { error: any };
  deleteResult?: { error: any };
}) {
  const builders = {
    select: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue(opts.selectResult ?? { data: [], error: null }),
    insert: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue(opts.insertResult ?? { data: null, error: null }),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockImplementation(() =>
      opts.updateResult ?? opts.deleteResult ?? { error: null },
    ),
  };
  vi.doMock('@/lib/db/supabase-browser', () => ({
    supabaseBrowser: () => ({ from: () => builders }),
  }));
  return builders;
}
```

| # | Test |
|---|---|
| 1 | Empty DB on mount → hook auto-creates one session and selects it |
| 2 | Two existing rows on mount → hook loads them, picks newest as current |
| 3 | `createNew` inserts a row, prepends to local state, switches currentId |
| 4 | `updateMessages` calls update with messages + derived title; local state reflects optimistically |
| 5 | `deleteSession` removes from DB, drops from state, switches current if needed |

### 7.2 Existing tests (unchanged)

- `tests/hooks/useChatSessions.test.tsx` (3 tests) — still passes, hook is `@deprecated` but not removed.
- `tests/lib/chat-storage.test.ts` (6 tests) — still passes.

### 7.3 Manual smoke (acceptance)

I will run `npm run dev` automatically (per user preference saved 2026-05-02). Steps:

1. Start dev, log in as `rgoalves@gmail.com` → land on `/chat`.
2. Empty state shows hero + 4 cards (no localStorage history exists for this DB-backed user).
3. Send "O que é Kraljic?" → response streams, sidebar entry appears with title "O que é Kraljic?".
4. Refresh page → sidebar still shows the conversation; click reloads messages.
5. Open `/chat` in an incognito tab, log in as same user → same sidebar (DB is the source of truth, not browser-local).
6. "+ Nova" → second session appears.
7. Verify in psycopg: `select id, title, jsonb_array_length(messages) from sessions where user_id = '16fab8f7-…' order by updated_at desc`.
8. Delete a session via trash icon → SQL count drops by 1.
9. From psycopg via service-role: `insert into sessions (user_id, title) values ('<some-other-uuid>', 'leak-check')` → refresh sidebar → confirm row does NOT appear (RLS isolates).
10. Cleanup: `delete from sessions where title = 'leak-check'`.
11. `npm test` ≥ 89; typecheck zero; pytest 23/23; `/api/health` 200.

## 8. Critérios de sucesso

1. Migration `00000000000004_sessions.sql` applied; `sessions` table exists with the index and 4 RLS policies.
2. `hooks/useChatSessionsRemote.ts` exported and used by `ChatRoot`.
3. localStorage modules carry `@deprecated` JSDoc; their tests still pass.
4. `npm test` ≥ 89 (84 prior + 5 new); typecheck zero errors.
5. Pytest 23/23 unchanged; `/api/health` 200 unchanged.
6. Smoke 1-11 (§7.3) all pass.
7. RLS isolation verified by step 9 (foreign user's row does not appear).
8. Delete cascade works: removing your `auth.users` row would wipe your sessions (verified by reading the FK definition; not actually tested because we don't delete the admin).
9. Tag `conversation-persistence-complete`.

## 9. Decisões e justificativas

| Decisão | Por quê |
|---|---|
| DB-only when authed (Q1-A) | Single source of truth; invite-acceptance = consent. Avoids localStorage/DB sync complexity. |
| Single table with JSONB messages (Q2-A) | Conversations are read whole, append-only, tiny (KB scale). Normalization (separate `messages` table) buys nothing for this access pattern. |
| Discard localStorage on first login (Q3-a) | No real users have history yet; simplest path. |
| Endpoint stays stateless (Q3-a) | UI already owns persistence via `useChatSessions.updateMessages`. Server-side hook adds coupling without immediate value. |
| No retention cap (Q3-a) | DB handles thousands of rows fine; capping forever loses data. Pagination is a 5-line add when needed. |
| Cascade-only LGPD erasure (Q3-a) | FK does the work; self-service export is real LGPD obligation but only when there are real users. |
| No realtime sync (Q3-a) | Multi-tab is rare; subscription complexity > benefit for v1. |
| Drop-in hook replacement (`useChatSessionsRemote`) | Keeps `ChatRoot`/`ChatSession`/`Sidebar` etc. unchanged. One-line import swap = minimal blast radius. |
| Keep deprecated localStorage modules | 9 working tests stay green; sub-projeto 7 might want them for offline mode. |
| Optimistic local-first writes | UX latency masked; failure fallback is local state until reload. Acceptable because `messages` is recoverable from DB on next mount. |
| Service role bypasses RLS | Existing chat backend / ingest unchanged; no need to teach `getServerSupabase()` about user identity. |

## 10. Riscos

| Risk | Mitigation |
|---|---|
| RLS misconfigured → user sees others' sessions | 4 explicit owner-only policies; manual smoke step 9 verifies isolation by inserting a foreign-user row. |
| Network failure on `updateMessages` | Optimistic local state stays as truth; warn logged; next page reload re-syncs from DB. |
| `useChat` `onFinish` closure captures stale `messages` | Pattern verified in sub-projeto 5: `[...messages, assistant]` works because the closure runs after React's batch. Same pattern reused. |
| Two tabs racing on the same session's `updateMessages` | Last-write-wins; users unlikely to stream concurrently in two tabs. Realtime sync (deferred Q3) would solve. |
| Migration adds 4 RLS policies; if `auth.uid()` is null in some context, queries return nothing | That's the desired behavior — anon users can't read anything. Service-role bypasses anyway. |
| `deriveTitle` lives in deprecated `lib/chat-storage.ts` | Re-exporting from the new hook is fine; the helper is pure logic. If the localStorage module is ever removed, copy `deriveTitle` to a non-deprecated home (e.g., `lib/rag/types.ts` or new `lib/conversation.ts`). |

## 11. Sequência de implementação (esboço)

A ordem detalhada vai para o plano. Esqueleto:

1. Migration `00000000000004_sessions.sql` + apply via psycopg + verify.
2. `useChatSessionsRemote.ts` + 5 tests (TDD).
3. `ChatRoot.tsx` import swap.
4. `@deprecated` JSDoc on `useChatSessions` and `chat-storage.ts`.
5. Manual smoke (`npm run dev` driven by me) + tag `conversation-persistence-complete`.
