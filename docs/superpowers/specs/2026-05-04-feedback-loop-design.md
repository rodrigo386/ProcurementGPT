# Sub-projeto 9 — Feedback Loop (design)

**Milestone**: 2 — Beta Readiness
**Tag-alvo**: `feedback-loop-complete`
**Data**: 2026-05-04
**Roadmap**: `docs/product/beta-readiness.md`

## Contexto

Sub-projeto 8 (`beta-hardening-complete`) entregou rate limit, error UX, threshold de retrieval e tag `env:beta` — o produto está seguro para abrir beta. Mas sem feedback do usuário, traces no Langfuse mostram apenas "o que foi pedido" e nunca "o que foi bom". Para escopar Milestone 3 com dados reais (≥30 ratings em ≥2 semanas é gate de saída), precisamos de:

1. Botões 👍/👎 inline em cada resposta do assistant.
2. Comentário opcional no 👎.
3. Persistência em DB (RLS owner-only) + score Langfuse para alimentar dashboards.
4. Link "Feedback geral" no header para reports fora do escopo de uma resposta específica.

Este sub-projeto é o último bloqueante antes do primeiro convite de beta.

## Princípios

- **Trace é o anchor, não a mensagem.** O `useChat` strip-a IDs ao persistir no JSONB (`toChatMessages` em `ChatSession.tsx:23`); reconstruir via `${session.id}-${i}` é frágil. Cada turno do `/api/chat` já cria um Langfuse trace com ID único — esse vira a chave estrangeira lógica do feedback. Bonus: alimenta `langfuse.score(traceId, ...)` direto.
- **Não bloquear o produto se Langfuse cair.** UPSERT no DB é o caminho crítico; o `score()` Langfuse é fire-and-forget e seu erro é só logado.
- **Defaults seguros.** RLS owner-only espelhando `sessions`; `comment` capped a 1000 chars no DB e no client; UPSERT idempotente sob constraint `(user_id, trace_id)`.

## Escopo

### 1. Modelo de dados

#### Migration `00000000000008_message_feedback.sql`

```sql
create table message_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  trace_id text not null,
  rating text not null check (rating in ('up','down')),
  comment text check (length(comment) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, trace_id)
);

create index message_feedback_lookup
  on message_feedback(user_id, session_id, created_at desc);

alter table message_feedback enable row level security;

create policy mf_select_own on message_feedback
  for select using (auth.uid() = user_id);
create policy mf_insert_own on message_feedback
  for insert with check (auth.uid() = user_id);
create policy mf_update_own on message_feedback
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy mf_delete_own on message_feedback
  for delete using (auth.uid() = user_id);
```

`trace_id` is opaque text (não FK) porque traces vivem no Langfuse. FKs cascade-delete `user_id` e `session_id` para LGPD erasure mecânica (mesmo padrão de `sessions` em sub-projeto 6b).

### 2. Trace ID propagation

#### `lib/observability/types.ts`

```ts
export interface Trace {
  id: string;                                          // novo
  span(name: string, input?: unknown): Span;
  end(output?: unknown, level?: TraceLevel): void;
  setMetadata(key: string, value: unknown): void;
  setTag(tag: string): void;
}
```

#### `lib/observability/langfuse.ts`

`startTrace` retorna o objeto wrapper com `id` populado:

- Quando keys presentes: `id = lfTrace.id` (Langfuse SDK).
- Quando keys ausentes (no-op): `id = crypto.randomUUID()` — feedback funciona em dev, `score()` vira no-op.

Adicionar função standalone:

```ts
export async function scoreTrace(opts: {
  traceId: string;
  name: string;
  value: number;
  comment?: string;
}): Promise<void> {
  const secret = process.env.LANGFUSE_SECRET_KEY;
  const pub = process.env.LANGFUSE_PUBLIC_KEY;
  if (!secret || !pub) return;
  // lazy-load + cache client (mesma estratégia de startTrace)
  const client = await getClient();
  client.score({
    traceId: opts.traceId,
    name: opts.name,
    value: opts.value,
    comment: opts.comment,
  });
  await client.flushAsync();
}
```

#### `app/api/chat/route.ts`

Estende a annotation publicada no stream com `traceId`:

```ts
data.appendMessageAnnotation({
  sources: rag.sources,
  classification: rag.classification,
  debug: rag.debug,
  traceId: trace.id,
});
```

### 3. UI 👍/👎

#### Novo componente `components/chat/MessageActions.tsx`

Renderiza dois botões ícone (lucide `ThumbsUp` / `ThumbsDown`) abaixo da bolha do assistant. Estados:

- **Sem rating**: `[👍] [👎]` ambos `text-muted-foreground` hover-able.
- **Após 👍**: `[👍✓] [👎]` o ativo ganha `text-primary fill-current`.
- **Após 👎**: `[👍] [👎✓]` + textarea inline opcional aparece (max 1000 chars), com botões "Enviar" e "Cancelar". O 👎 já está salvo no clique inicial; o comentário é um update separado.

Click handler:
1. Otimismo: muda visual local imediatamente.
2. POST `/api/feedback`.
3. Em erro: reverte estado, dispara `toast.error('Não foi possível registrar feedback. Tente novamente.')`.

Props:
```ts
type Props = {
  traceId: string;
  sessionId: string;
  initialRating?: 'up' | 'down';                       // hidratado pelo useChatSessionsRemote no reload
};
```

#### Mudança em `Message.tsx`

```ts
type Props = {
  role: 'user' | 'assistant';
  content: string;
  isStreaming: boolean;
  traceId?: string;
  sessionId?: string;
  initialRating?: 'up' | 'down';
};
```

Renderiza `<MessageActions/>` quando `role === 'assistant' && !isStreaming && traceId && sessionId`. Mensagens antigas sem `traceId` simplesmente não mostram botões — graceful degradation.

#### Mudança em `MessageList.tsx`

Extrai `traceId` da annotation. AI SDK v4 acumula annotations num array por mensagem; a do `/api/chat` é a primeira:

```ts
type Annotation = { traceId?: string } & Record<string, unknown>;

function pickTraceId(m: { annotations?: unknown[] }): string | undefined {
  const ann = m.annotations as Annotation[] | undefined;
  return ann?.find((a) => typeof a?.traceId === 'string')?.traceId;
}
```

Passa `traceId` + `sessionId` adiante para `<Message/>`.

#### Mudança em `ChatSession.tsx`

`useChat` retorna `messages` com `annotations`. O `toChatMessages` atual descarta tudo exceto `role` e `content`; isso continua valendo para PERSISTÊNCIA (não queremos guardar annotations no JSONB). Mas pro RENDER em `MessageList`, passamos messages com annotations preservadas.

```tsx
<MessageList
  messages={messages.map((m) => ({
    id: m.id,
    role: m.role as 'user' | 'assistant',
    content: m.content,
    annotations: m.annotations,
  }))}
  isLoading={isLoading}
  sessionId={session.id}
  initialRatings={ratings}                            // novo prop, vem do hook
/>
```

### 4. Hidratação de ratings após reload

#### `hooks/useChatSessionsRemote.ts`

Após carregar a sessão atual, fetcha ratings:

```ts
const { data: feedbackRows } = await sb
  .from('message_feedback')
  .select('trace_id, rating')
  .eq('session_id', currentId);

const ratings = new Map<string, 'up' | 'down'>(
  (feedbackRows ?? []).map((r) => [r.trace_id, r.rating as 'up' | 'down']),
);
```

Expõe via novo campo do hook return: `ratings: Map<string, 'up'|'down'>`. RLS já filtra por user. Custo: 1 query extra por sessão; aceitável.

### 5. `/api/feedback`

#### `app/api/feedback/route.ts`

```ts
export const runtime = 'nodejs';

const Body = z.object({
  sessionId: z.string().uuid(),
  traceId: z.string().min(1).max(200),
  rating: z.enum(['up', 'down']),
  comment: z.string().max(1000).optional(),
});

export async function POST(req: Request): Promise<Response> {
  // 1. parse body → 400
  // 2. getCurrentUser → 401
  // 3. confirmar sessionId pertence ao user (defesa em profundidade sobre RLS)
  // 4. UPSERT em message_feedback ON CONFLICT (user_id, trace_id) DO UPDATE
  // 5. fire-and-forget scoreTrace (não-bloqueante)
  // 6. 204 No Content
}
```

Errors: zod → 400, no user → 401, session não pertence → 404, DB error → 500. `scoreTrace` failure é só logado, não muda response.

#### Novo helper `lib/feedback.ts`

Server-side helper que centraliza a lógica de UPSERT + score, chamável tanto por `/api/feedback` quanto por testes:

```ts
export async function recordFeedback(input: {
  userId: string;
  sessionId: string;
  traceId: string;
  rating: 'up' | 'down';
  comment?: string;
}): Promise<void> {
  // UPSERT via supabaseServer().from('message_feedback').upsert(...)
  // scoreTrace fire-and-forget
}
```

### 6. Link "Feedback geral" no header

#### Mudança em `components/chat/Header.tsx`

Adiciona, antes do botão de tema:

```tsx
<a
  href="mailto:rgoalves@gmail.com?subject=ProcurementGPT%20feedback"
  aria-label="Enviar feedback"
  title="Enviar feedback geral"
  className="inline-flex h-9 w-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
>
  <MessageSquareText className="h-4 w-4" />
</a>
```

CLAUDE.md gotcha: `Button asChild` da variante shadcn base-nova não funciona — usar `<a>` direto com classes Tailwind.

Email destino é `rgoalves@gmail.com` por enquanto (brand TBD per CLAUDE.md). TODO comment marca a substituição quando empresa for criada.

### 7. Não-objetivos

- **Histórico/admin de feedback** — Milestone 3+. Por enquanto, leitura via SQL direto (`select * from message_feedback ...`) ou Langfuse dashboard.
- **Reaction picker rico** (😂😮 etc.) — só 👍/👎.
- **Feedback por fonte** ("essa fonte foi útil?") — Milestone 3 quando citações voltarem (sub-projeto 11 do roadmap B2B).
- **Voice/sentiment auto-classification** — não vale custo no beta.
- **Edição/exclusão de comment pelo usuário** — write-once após criação. Sub-projeto futuro pode adicionar.
- **Persistência de message IDs no JSONB** — fora de escopo. Trace ID resolve o problema sem schema change na coluna `messages`.
- **Configuração do email feedback via env** — hardcoded por enquanto; quando branding for definido vira `NEXT_PUBLIC_FEEDBACK_EMAIL`.

## Mudanças de arquivos (lista completa)

**Novos:**
- `supabase/migrations/00000000000008_message_feedback.sql`
- `lib/feedback.ts`
- `app/api/feedback/route.ts`
- `components/chat/MessageActions.tsx`
- `tests/api/feedback.test.ts`
- `tests/components/chat/MessageActions.test.tsx`
- `tests/lib/observability/langfuse.test.ts` (se ainda não existe; senão estende)

**Modificados:**
- `lib/observability/types.ts` — `Trace.id: string`
- `lib/observability/langfuse.ts` — `id` no objeto retornado + `scoreTrace()` standalone
- `app/api/chat/route.ts` — annotation ganha `traceId`
- `components/chat/Message.tsx` — render de `<MessageActions/>` quando aplicável
- `components/chat/MessageList.tsx` — extrai `traceId` da annotation, propaga props
- `components/chat/ChatSession.tsx` — preserva `annotations` ao mapear messages
- `components/chat/Header.tsx` — link mailto
- `hooks/useChatSessionsRemote.ts` — fetch de ratings + expor map
- `CLAUDE.md` — sub-projeto 9 row, Milestone 2 progress, novos gotchas

## Testes

**vitest:**
- `tests/api/feedback.test.ts`:
  - 401 sem auth
  - 400 body inválido (rating diferente de up/down, comment > 1000, sessionId não-UUID)
  - 404 quando sessionId não pertence ao user
  - 200/204 happy path com 👍 e com 👎+comment
  - Upsert flip (👍 → 👎 mantém uma única row)
  - Langfuse score chamado com `value=1` e `value=-1`
  - Langfuse falha não impede 204

- `tests/components/chat/MessageActions.test.tsx`:
  - Render base mostra dois botões inativos
  - Click 👍 chama `/api/feedback` com payload correto
  - Click 👎 abre textarea
  - Submit do comment faz second call (update)
  - 500 do `/api/feedback` reverte estado + toast
  - `initialRating='up'` renderiza com 👍 ativo

- `tests/lib/observability/langfuse.test.ts` (extensão se já existe):
  - `scoreTrace` é no-op quando keys ausentes
  - `scoreTrace` chama SDK quando keys presentes

**rag:eval:** sem mudança.
**pytest:** sem mudança.

## Critério de "sub-projeto pronto"

- [ ] Migration 0008 aplicada em prod Supabase
- [ ] `/api/feedback` retorna 204 em sucesso, RLS-protegido
- [ ] Langfuse trace mostra score `user-feedback` com value `1` ou `-1`
- [ ] UI mostra botões abaixo de cada assistant message
- [ ] Click 👎 expande textarea opcional
- [ ] Reload restaura estado de ratings
- [ ] Header mostra link "Feedback geral" → mailto
- [ ] `npm test` passa (target ~165 cases, +8)
- [ ] `npm run typecheck` zero erros
- [ ] CI verde (rag:eval inalterado)
- [ ] CLAUDE.md atualizado
- [ ] Tag `feedback-loop-complete` aplicada

## Riscos / decisões deferidas

- **No-op trace ID**: quando Langfuse keys ausentes, `crypto.randomUUID()` gera ID local. UI funciona, `score()` vira no-op silencioso. Aceitável.
- **Mailto hardcoded**: `rgoalves@gmail.com` até decisão de branding. TODO comment + entry em CLAUDE.md gotchas.
- **`select sessions` defesa em profundidade**: ~10ms extra por feedback. Mantido — alternativa (confiar só na constraint `unique(user_id, trace_id)`) permitiria spammar IDs aleatórios.
- **AI SDK `annotations` shape**: AI SDK v4 documenta `annotations: JSONValue[]`. Tipamos como `unknown[]` e fazemos narrow com `as { traceId?: string } | undefined`. Se v5 mudar, ajustamos.
- **Comment write-once**: usuário não pode editar/apagar via UI. Workaround: re-clicar 👎 reabre textarea para enviar nova versão (que substitui via UPSERT). Suficiente para beta.

## Próximo passo

Após aprovação, invocar `superpowers:writing-plans` para gerar plan executável (TDD + subagent-driven, mesmo padrão de sub-projeto 8).
