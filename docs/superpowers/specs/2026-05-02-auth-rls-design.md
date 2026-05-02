# Sub-projeto 6a — Auth + RLS

> **Status:** Design (sub-projeto 6a of 7; sub-projeto 6 split into 6a/6b/6c).
> **Date:** 2026-05-02
> **Depends on:** sub-projeto 1 (Fundação — RLS enabled but with no policies; Supabase Auth available), sub-projeto 5 (Chat UI — sidebar exists; will gain a user-row at the bottom).
> **Consumed by:** sub-projeto 6b (Opt-in DB persistence — needs auth identity), sub-projeto 6c (Admin UI — needs admin role).

## 1. Contexto

A Fundação habilitou Supabase Auth e ligou RLS em todas as tabelas — sem políticas. O efeito prático: apenas a `service_role` key consegue ler/escrever, e o frontend cliente nunca tocou o banco diretamente. Sub-projetos 2-5 entregaram ingestão, retrieval, chat endpoint e UI funcionando todos via service-role.

Este sub-projeto introduz identidade: contas de usuário (criadas por convite via dashboard), login com email/senha + Google OAuth, e políticas RLS reais para `articles`/`chunks` e a nova tabela `profiles`. O `/chat` passa a exigir login. Persistência de conversas no banco fica para sub-projeto 6b (este sub-projeto não cria `sessions`/`messages`).

O critério de pronto: usuário convidado pelo admin no dashboard consegue (a) entrar com email/senha, (b) entrar com Google se o email do Google bater com o convite, (c) recuperar senha via email, (d) ver `/chat` (que continua funcionando como em sub-projeto 5), (e) sair pela sidebar. Usuário não-convidado vê erro claro. Usuário não-logado em `/chat` é redirecionado para `/login?next=/chat`.

## 2. Objetivo

Entregar:
- Páginas: `/login`, `/forgot-password`, `/reset-password`
- Route handler: `/auth/callback`
- `middleware.ts` que protege `/chat` e `/admin`
- `app/page.tsx` repurposed como landing pública com botão "Entrar"
- Componentes: `LoginForm`, `ForgotPasswordForm`, `ResetPasswordForm`, `UserRow` (na sidebar)
- Helpers: `lib/db/supabase-browser.ts`, `lib/db/supabase-server.ts`, `lib/auth.ts`
- Sidebar atualizada com user-row (avatar + email + Sair)
- Migration: tabela `profiles`, trigger de auto-criação, políticas RLS para `profiles`/`articles`/`chunks`, função `is_admin()`

**Não-objetivos** (delegados):
- Persistência opt-in de conversas (`sessions`, `messages`, sidebar reading from DB) → sub-projeto 6b
- Admin UI (gestão de usuários, ingestão via UI, deleção de artigos) → sub-projeto 6c
- Magic link, MFA, email branding, account deletion, audit log
- Rate limiting do `/api/chat`
- Múltiplos OAuth providers além de Google
- Per-user language preference

## 3. Stack

- `@supabase/ssr` — server-side cookie helpers para Next.js App Router (nova dep)
- `@supabase/supabase-js` (já presente) — auth client APIs
- Next.js 14 middleware (`middleware.ts` na raiz do projeto)
- shadcn/ui primitives já existentes (button, textarea — usar `input` se a CLI ainda não trouxe)
- `vitest` + `@testing-library/react` para testes (já presentes)

## 4. Estrutura de pastas

```
/app
  page.tsx                              # MODIFY — landing page com botão "Entrar"
  /login/page.tsx                       # NEW — server component, mounts <LoginForm/>
  /forgot-password/page.tsx             # NEW — mounts <ForgotPasswordForm/>
  /reset-password/page.tsx              # NEW — mounts <ResetPasswordForm/>
  /auth/callback/route.ts               # NEW — Edge route handler for OAuth/PKCE
/components
  /auth
    LoginForm.tsx                       # NEW — email/password + Google OAuth + forgot link
    ForgotPasswordForm.tsx              # NEW
    ResetPasswordForm.tsx               # NEW
    UserRow.tsx                         # NEW — avatar + email + Sair (sidebar bottom)
  /chat
    Sidebar.tsx                         # MODIFY — append <UserRow/> at bottom
/lib
  /db
    supabase.ts                         # MODIFY — keep getServerSupabase as-is (service-role); existing getBrowserSupabase deprecated for auth-aware features
    supabase-browser.ts                 # NEW — createBrowserClient from @supabase/ssr
    supabase-server.ts                  # NEW — createServerClient from @supabase/ssr (cookie-aware)
  auth.ts                               # NEW — getCurrentUser, requireUser, getProfile
middleware.ts                           # NEW — checks /chat, /admin sessions
/supabase/migrations
  00000000000003_profiles_and_rls.sql   # NEW — profiles table, trigger, is_admin(), RLS policies
/tests
  /lib
    auth.test.ts                        # NEW — 5 tests
  /components/auth
    LoginForm.test.tsx                  # NEW — 4 tests
    ForgotPasswordForm.test.tsx         # NEW — 2 tests
    ResetPasswordForm.test.tsx          # NEW — 3 tests
    UserRow.test.tsx                    # NEW — 2 tests
  middleware.test.ts                    # NEW — 3 tests
package.json                            # MODIFY — add @supabase/ssr
```

## 5. Componentes — contratos

### 5.1 `lib/db/supabase-browser.ts`

```ts
'use client';
import { createBrowserClient } from '@supabase/ssr';
import { requireEnv } from '@/lib/env';

let cached: ReturnType<typeof createBrowserClient> | null = null;
export function supabaseBrowser() {
  if (cached) return cached;
  cached = createBrowserClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  );
  return cached;
}
```

Used by all client auth components. Reads cookies, persists session.

### 5.2 `lib/db/supabase-server.ts`

```ts
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { requireEnv } from '@/lib/env';

export function supabaseServer() {
  const cookieStore = cookies();
  return createServerClient(
    requireEnv('NEXT_PUBLIC_SUPABASE_URL'),
    requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
    {
      cookies: {
        get: (name) => cookieStore.get(name)?.value,
        set: (name, value, options) => {
          try { cookieStore.set({ name, value, ...options }); } catch { /* read-only contexts */ }
        },
        remove: (name, options) => {
          try { cookieStore.set({ name, value: '', ...options }); } catch {}
        },
      },
    },
  );
}
```

Used by server components, route handlers, and `lib/auth.ts`.

### 5.3 `lib/auth.ts`

```ts
import type { User } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/db/supabase-server';

export type Profile = { id: string; role: 'user' | 'admin'; display_name: string | null };

export async function getCurrentUser(): Promise<User | null> {
  const { data: { user } } = await supabaseServer().auth.getUser();
  return user ?? null;
}

export class NotAuthenticated extends Error { constructor() { super('NOT_AUTHENTICATED'); } }

export async function requireUser(): Promise<User> {
  const u = await getCurrentUser();
  if (!u) throw new NotAuthenticated();
  return u;
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabaseServer()
    .from('profiles')
    .select('id, role, display_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) return null;
  return data as Profile | null;
}
```

### 5.4 `middleware.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

export async function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get: (name) => req.cookies.get(name)?.value,
        set: (name, value, options) => {
          res.cookies.set({ name, value, ...options });
        },
        remove: (name, options) => {
          res.cookies.set({ name, value: '', ...options });
        },
      },
    },
  );
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    const url = new URL('/login', req.url);
    url.searchParams.set('next', req.nextUrl.pathname);
    return NextResponse.redirect(url);
  }
  return res;
}

export const config = {
  matcher: ['/chat/:path*', '/admin/:path*'],
};
```

### 5.5 `components/auth/LoginForm.tsx`

Client component. State: `email`, `password`, `loading`, `error`. Two buttons: "Entrar" (calls `supabase.auth.signInWithPassword({ email, password })`) and "Continuar com Google" (calls `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + '/auth/callback' }})`). On success, `router.push(searchParams.get('next') ?? '/chat')`. On error, sets `error` to a friendly PT-BR message:
- Generic "Email ou senha incorretos." for `Invalid login credentials`
- Specific "Este email não foi convidado. Solicite acesso ao administrador." when error code is `signup_disabled` (Google OAuth path)
- "Algo deu errado. Tente novamente." for unknown errors
"Esqueci minha senha" link points to `/forgot-password`. Helper text: "Você foi convidado? Use o email do convite."

### 5.6 `components/auth/ForgotPasswordForm.tsx`

Email input + "Enviar link" button. On submit:
```ts
await supabase.auth.resetPasswordForEmail(email, {
  redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
});
```
The email's recovery link goes through `/auth/callback` (PKCE exchange establishes session cookies), which then 302s to `/reset-password` with the user already authenticated in recovery state. Show success state regardless of whether the email exists: "Verifique seu email — enviamos um link para redefinir a senha." (avoid email enumeration).

### 5.7 `components/auth/ResetPasswordForm.tsx`

Two password inputs (new + confirm). Submit calls `supabase.auth.updateUser({ password })` on the browser client — this works because the user already has an authenticated session (set by `/auth/callback` during the email flow). On success, `router.push('/chat')`. On password mismatch, inline error before submit. Page-level: if there's no session present (user navigated directly to `/reset-password`), show "Solicite um novo link" with a button to `/forgot-password`.

### 5.8 `app/auth/callback/route.ts`

```ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/db/supabase-server';

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code');
  const next = req.nextUrl.searchParams.get('next') ?? '/chat';
  if (code) {
    const supabase = supabaseServer();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next, req.url));
}
```

Edge runtime compatible (the `cookies()` helper works in Edge).

### 5.9 `components/auth/UserRow.tsx`

```tsx
type Props = { email: string; onLogout: () => void };
```

Renders a horizontal row at the bottom of the Sidebar: an initial-circle avatar (first letter of email, brand color), the email truncated, and a "Sair" button. Click "Sair" calls `onLogout` which the parent (Sidebar) provides — Sidebar gets a new prop `currentEmail: string | null` and uses it to render UserRow only when present.

`Sidebar.tsx` modification: read the user's email via a server-component-passed prop (preferred) or via a `useEffect` calling `supabaseBrowser().auth.getUser()` (fallback if the upstream component is too far). For simplicity v1: client-side fetch via supabaseBrowser in a `useEffect`, store in state. ChatRoot stays untouched.

### 5.10 `app/page.tsx` (modify)

Simple centered layout: product name, one-line tagline, "Entrar" button → `/login`. No marketing copy yet (brand TBD). Existing layout file already provides theme and html structure.

## 6. Database — migration

`supabase/migrations/00000000000003_profiles_and_rls.sql`:

```sql
-- Profiles: one row per auth.users; auto-created via trigger.
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role text not null default 'user' check (role in ('user', 'admin')),
  display_name text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Helper to break self-referential RLS recursion
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce((select role = 'admin' from profiles where id = auth.uid()), false);
$$;

-- Profiles policies
create policy profiles_self_read on profiles for select to authenticated
  using (id = auth.uid());
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_read on profiles for select to authenticated
  using (is_admin());

-- Auto-create profile on auth.users insert
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- articles + chunks: authenticated users can read; mutations stay service-role
create policy articles_authenticated_read on articles for select to authenticated using (true);
create policy chunks_authenticated_read on chunks for select to authenticated using (true);

grant execute on function is_admin() to anon, authenticated, service_role;
```

**Bootstrap admin** (manual after first invite):
```sql
update profiles set role = 'admin' where id = (select id from auth.users where email = '<your-email>' limit 1);
```

## 7. Supabase dashboard setup (one-time, manual)

The plan walks through these steps explicitly. None can be automated from code:
1. **Authentication → Providers → Google:** enable, paste Client ID + Secret from Google Cloud Console (user creates the OAuth credentials separately).
2. **Authentication → URL Configuration:**
   - Site URL: `http://localhost:3000` (dev), production URL when shipping
   - Redirect URLs: add `http://localhost:3000/auth/callback`
3. **Authentication → Settings:**
   - Enable email confirmations: ON
   - Allow new users to sign up: **OFF** (invite-only)
4. **Authentication → Users → Invite user:** invite your own email to bootstrap.

## 8. Testing

### 8.1 Unit tests (vitest)

| File | # Tests | Covers |
|---|---|---|
| `tests/lib/auth.test.ts` | 5 | getCurrentUser (auth/null), requireUser throws on null, getProfile (row/null) |
| `tests/components/auth/LoginForm.test.tsx` | 4 | password submit, Google button, error display, forgot link |
| `tests/components/auth/ForgotPasswordForm.test.tsx` | 2 | submit calls resetPasswordForEmail, success state |
| `tests/components/auth/ResetPasswordForm.test.tsx` | 3 | submit, redirect on success, password mismatch |
| `tests/components/auth/UserRow.test.tsx` | 2 | renders email, Sair calls onLogout |
| `tests/middleware.test.ts` | 3 | unauth → redirect with next; auth → pass; api/chat not matched |

All Supabase client calls mocked at the boundary (`@/lib/db/supabase-browser`, `@/lib/db/supabase-server`).

### 8.2 Smoke (manual, requires Supabase Auth configured per §7)

1. Apply migration via psycopg.
2. Invite yourself via dashboard, click invite email, set password.
3. Bootstrap admin via SQL (see §6).
4. `npm run dev`, navigate to:
   - `/chat` while logged out → 302 to `/login?next=/chat`
   - `/login` → enter credentials → land on `/chat`; sidebar shows email + Sair
   - "Sair" → 302 to `/login`
   - "Continuar com Google" with matching email → land on `/chat`
   - "Continuar com Google" with non-invited email → friendly error, stay on `/login`
   - "Esqueci minha senha" → enter email → check inbox → click link → set new password → land on `/chat`
5. Regressions: `npm test` (≥ 65 + 19 new = 84), typecheck zero, pytest 23/23, `/api/health` 200, `/chat` works (logged-in path).

## 9. Critérios de sucesso

1. New routes `/login`, `/forgot-password`, `/reset-password`, `/auth/callback` all render/respond.
2. `middleware.ts` gates `/chat` and `/admin` (matcher excludes `/api/chat`).
3. Migration `00000000000003_profiles_and_rls.sql` applied; `profiles` table exists; trigger fires on new `auth.users` row; `is_admin()` returns false for users without the role and true for admins.
4. Google OAuth login works for an invited email; fails clearly for non-invited.
5. Email/password login + reset flow works.
6. Sidebar shows the logged-in user's email at the bottom; Sair logs out.
7. `npm test` ≥ 84 (65 prior + 19 new); typecheck zero errors.
8. Pytest 23/23 unchanged; `/api/health` 200 unchanged.
9. Bootstrap admin SQL documented in plan (with explicit task step).
10. Tag `auth-rls-complete` on the final commit.

## 10. Decisões e justificativas

| Decisão | Por quê |
|---|---|
| Invite-only (Q2-B) | User pick. Implies admin manages users via Supabase dashboard until 6c. OAuth signup must match an existing invited email. |
| Email/password + Google OAuth (Q1-B+C) | User pick. More surface than magic-link, but familiar. Google OAuth fast-tracks B2B users. |
| `/chat` auth-gated (Q3-A) | Invite-only + anonymous chat is incoherent. Cleanest mental model. |
| `profiles` table (Q4-b) | Standard Supabase pattern; gives 6b/6c a stable shape for adding role-aware behavior. |
| User row in sidebar bottom (Q4-a) | Sidebar already exists; header stays minimal. ChatGPT pattern users recognize. |
| Standard reset flow (Q4-a) | Supabase makes this trivial; not implementing it strands invited users. |
| `middleware.ts` for gating (Q4-a) | Single chokepoint. Cheaper to maintain than per-page checks. |
| Default Supabase email templates (Q4-a) | Brand TBD; revisit when company name lands. |
| `is_admin()` security-definer helper | Avoids RLS recursion on `profiles`. Standard pattern. |
| Service-role bypasses RLS for chat backend / ingest | Existing flows keep working unchanged. The pipeline doesn't need user identity yet (6b changes that). |
| Email enumeration mitigation in forgot-password | Always show "check your email" success regardless. Standard practice. |

## 11. Riscos

(See Section 5 of the brainstorm — captured in spec body §5.5, §5.6, §6, §7.)

| Risk | Mitigation |
|---|---|
| Supabase dashboard config required (Site URL, redirect URLs, OAuth credentials) | §7 documents the steps explicitly |
| Self-referential RLS on `profiles` could recurse | `is_admin()` security-definer helper (§6) |
| Middleware adds latency to every gated request | `@supabase/ssr` does local cookie verification (~1-3ms) |
| Insert trigger on `auth.users` could break signup if it throws | Trigger does only one insert with hardcoded fields; failure modes are FK violations which can't happen by construction |
| Existing `/chat` assumed anonymous; middleware breaks it for unauthed dev | Plan creates the admin user before middleware lands; dev experience continuous |
| Google OAuth with non-invited email returns generic Supabase error | LoginForm catches and shows friendly PT-BR error (§5.5) |
| Bootstrap admin requires manual SQL | Plan task step + 6c features fail loudly without it |

## 12. Sequência de implementação (esboço)

A ordem detalhada vai para o plano. Esqueleto:

1. Add dep `@supabase/ssr`.
2. Migration `00000000000003_profiles_and_rls.sql` + apply via psycopg.
3. Supabase dashboard setup (manual — documented but not part of npm-test surface).
4. Bootstrap admin user (invite via dashboard → set password → run UPDATE).
5. `lib/db/supabase-browser.ts` + `lib/db/supabase-server.ts`.
6. `lib/auth.ts` + 5 unit tests (TDD).
7. `app/auth/callback/route.ts` (no test; covered by manual smoke).
8. `components/auth/LoginForm.tsx` + 4 tests (TDD).
9. `components/auth/ForgotPasswordForm.tsx` + 2 tests (TDD).
10. `components/auth/ResetPasswordForm.tsx` + 3 tests (TDD).
11. `components/auth/UserRow.tsx` + 2 tests (TDD).
12. `app/login/page.tsx`, `app/forgot-password/page.tsx`, `app/reset-password/page.tsx` (mount the forms).
13. `app/page.tsx` modify — landing with "Entrar".
14. `middleware.ts` + 3 tests.
15. `components/chat/Sidebar.tsx` modify — append `<UserRow/>`.
16. Smoke + tag `auth-rls-complete`.
