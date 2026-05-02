# Sub-projeto 4 — Chat Endpoint + SSE Streaming

> **Status:** Design (sub-projeto 4 of 7)
> **Date:** 2026-05-02
> **Depends on:** sub-projeto 1 (Fundação), sub-projeto 2 (Ingestão), sub-projeto 3 (Retrieval — `runRag`).
> **Consumed by:** sub-projeto 5 (UI), sub-projeto 6 (Auth + opt-in persistence), sub-projeto 7 (Evals + Langfuse).

## 1. Contexto

A Retrieval entregou `runRag(query)` retornando `{ classification, sources, system, user, debug }` — um pacote pronto para alimentar um LLM. Faltava o endpoint que recebe a conversa do usuário, roda o RAG sobre a última mensagem e devolve a resposta do modelo em streaming.

Este sub-projeto entrega `POST /api/chat`: um endpoint Edge Runtime que aceita histórico de conversa, condensa multi-turn em uma pergunta autônoma, chama `runRag`, e transmite a resposta do Gemini em SSE usando o protocolo do Vercel AI SDK. O endpoint é **stateless** — o cliente segura o histórico. Persistência opt-in fica para sub-projeto 6.

O critério de pronto é: `curl -N -X POST /api/chat` com uma pergunta sobre Kraljic devolve um stream SSE válido contendo tokens da resposta + uma anotação com as fontes citáveis, em < 3s para o primeiro byte.

## 2. Objetivo

Entregar:
- `app/api/chat/route.ts` — endpoint Edge POST.
- `lib/rag/condenser.ts` — função `condenseQuery(messages)` que reescreve a última pergunta como standalone usando contexto das anteriores.
- Pequena adição em `lib/rag/types.ts` — `ChatMessage` type.
- Testes unitários para o condenser (5) e para o handler do endpoint (4).

**Não-objetivos** (delegados):
- UI / componentes de chat → sub-projeto 5
- Auth, RLS, persistência opt-in de conversas → sub-projeto 6
- Rate limiting / proteção contra abuso → sub-projeto 6+
- Langfuse / traces estruturados → sub-projeto 7
- Sumarização de conversas longas → sub-projeto 7
- Tool / function calling → fora de escopo (este produto é RAG puro)
- Múltiplos providers de LLM com fallback → single-provider por design (CLAUDE.md)

## 3. Stack

- Next.js 14 App Router, Edge Runtime
- `ai` (Vercel AI SDK) — `streamText`, `StreamData`, `toDataStreamResponse` (nova dep)
- `@ai-sdk/google` — provider que envolve a Generative AI API (nova dep, tipo idiomático para o AI SDK)
- `@google/genai` (já presente) — continua sendo o SDK para classifier e condenser (calls one-shot, JSON ou texto puro). A divisão é deliberada: o AI SDK é a melhor ferramenta para streaming SSE; o `@google/genai` continua a ferramenta certa para chamadas síncronas.
- `zod` (já presente) — validação do body
- `vitest` (já presente) — unit tests

## 4. Estrutura de pastas

```
/app/api/chat
  route.ts                      # POST handler, Edge runtime
/lib/rag
  condenser.ts                  # condenseQuery(messages) → standalone string
  types.ts                      # MODIFY — add ChatMessage type
/tests/lib/rag
  condenser.test.ts             # 5 unit tests
/tests/api
  chat.test.ts                  # 4 unit tests (mocks runRag, condenser, streamText)
/package.json                   # MODIFY — add ai + @ai-sdk/google
```

## 5. Componentes — contratos

### 5.1 `ChatMessage` (em `lib/rag/types.ts`)

```ts
export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};
```

Compartilhado entre condenser, route handler, e (depois) UI. Não inclui `system` — system messages vêm de `prompt-builder` e são internos ao orquestrador.

### 5.2 `lib/rag/condenser.ts`

```ts
export async function condenseQuery(messages: ChatMessage[]): Promise<string>
```

**Comportamento:**
- `messages` deve ter ≥ 1 elemento e o último ser `role: 'user'`. Caller responsável por garantir; sem validação de runtime (chamado pelo route handler que já valida com zod).
- Se `messages.length === 1`: retorna `messages[0].content.trim()` direto. Sem chamada LLM.
- Senão: uma chamada `getGemini().models.generateContent` com:
  - System prompt (PT-BR): *"Reescreva a última pergunta do usuário como uma pergunta autônoma em português, incorporando contexto necessário das mensagens anteriores. Responda APENAS com a pergunta reescrita, sem explicações, sem aspas, sem prefixos."*
  - `contents` formatado: histórico das mensagens (ex: `Usuário: ...\nAssistente: ...\n...\nÚltima pergunta: <last user msg>`).
  - `config: { maxOutputTokens: 256 }`.
- Resposta tratada: `text.trim()`, remove aspas iniciais/finais (`"..."` ou `'...'`).
- Se a resposta vazia, ou erro/timeout: retorna `messages[messages.length - 1].content.trim()` (raw last user message). Loga `console.warn`. Não lança.

**Por quê não JSON:** a saída é uma única pergunta livre, sem estrutura. JSON seria overhead para zero ganho.

### 5.3 `app/api/chat/route.ts`

```ts
export const runtime = 'edge';
export async function POST(req: Request): Promise<Response>
```

**Fluxo:**

1. **Parse + validate** body com zod:
   ```ts
   const Body = z.object({
     messages: z.array(z.object({
       role: z.enum(['user', 'assistant']),
       content: z.string().min(1),
     })).min(1),
   }).refine(b => b.messages[b.messages.length - 1].role === 'user',
     { message: 'last message must be user' });
   ```
   - Em falha: `Response.json({ error: '...' }, { status: 400 })`.

2. **Condense:** `const standalone = await condenseQuery(messages)`.

3. **RAG:** `const rag = await runRag(standalone)`.

4. **Construct messages para o LLM:**
   ```ts
   const history = messages.slice(0, -1);  // tudo exceto a última user msg
   const llmMessages = [
     ...history.map(m => ({ role: m.role, content: m.content })),
     { role: 'user' as const, content: rag.user }, // user msg substituída pelo prompt RAG-aumentado (com bloco de contexto)
   ];
   ```

5. **Stream:**
   ```ts
   import { createGoogleGenerativeAI } from '@ai-sdk/google';
   import { streamText, StreamData } from 'ai';

   const google = createGoogleGenerativeAI({
     apiKey: requireEnv('GOOGLE_API_KEY'),
   });

   const data = new StreamData();
   data.appendMessageAnnotation({
     sources: rag.sources,
     classification: rag.classification,
     debug: rag.debug,
   });

   const result = await streamText({
     model: google(requireEnv('GEMINI_MODEL')),
     system: rag.system,
     messages: llmMessages,
     onFinish: () => data.close(),
   });

   return result.toDataStreamResponse({ data });
   ```

6. **Erro pré-stream** (durante `streamText` setup): `Response.json({ error: 'chat failed' }, { status: 500 })` com log via `console.error`. Erros mid-stream são surfaceados pelo evento `error` do AI SDK e o cliente os recebe inline.

**Por quê `createGoogleGenerativeAI` em vez de `google` direto:** o factory padrão de `@ai-sdk/google` lê `GOOGLE_GENERATIVE_AI_API_KEY` do env. Este projeto usa `GOOGLE_API_KEY` (consistente com `@google/genai`). Construir o provider explicitamente mantém a env var única.

### 5.4 Mudanças NÃO feitas

`lib/rag/index.ts`, `classifier.ts`, `retriever.ts`, `reranker.ts`, `prompt-builder.ts` — **não tocados.** O contrato de sub-projeto 3 fica estável.

`lib/llm/gemini.ts` — **não tocado.** Continua sendo o wrapper para chamadas síncronas (classifier, condenser, futuras chamadas one-shot).

## 6. Testes

### 6.1 Unit tests

**`tests/lib/rag/condenser.test.ts` — 5 testes:**
1. `messages.length === 1` → retorna `content` direto, Gemini não chamado.
2. Multi-turn → Gemini chamado, retorna a string da resposta (trimmed).
3. Gemini lança erro → retorna `content` da última mensagem do user, log warn emitido.
4. Gemini retorna texto vazio (`{ text: '' }`) → retorna `content` da última mensagem do user.
5. Gemini retorna `'"o que é kraljic?"'` (com aspas) → retorna `o que é kraljic?` (aspas removidas).

Padrão: `vi.doMock('@/lib/llm/gemini', ...)` + `vi.resetModules()` + dynamic import — mesmo padrão de `classifier.test.ts`.

**`tests/api/chat.test.ts` — 4 testes:**
1. Body sem `messages` ou com `messages: []` → 400 com `{ error: ... }`.
2. Última mensagem com `role: 'assistant'` → 400.
3. Happy path: mocks de `condenseQuery` (retorna string), `runRag` (retorna RagResult de teste), `streamText` (retorna `{ toDataStreamResponse: () => new Response('ok') }`). Asserts:
   - `condenseQuery` chamado com a array completa de messages.
   - `runRag` chamado com a string que `condenseQuery` retornou.
   - `streamText` chamado com `system === rag.system` e `messages[messages.length - 1].content === rag.user`.
   - `data.appendMessageAnnotation` chamado uma vez com `{ sources, classification, debug }`.
4. `runRag` lança → 500 com `{ error: ... }`.

Mock dos módulos `@/lib/rag/condenser`, `@/lib/rag` (para `runRag`), `ai` (para `streamText` e `StreamData`), `@ai-sdk/google` (para `google`).

### 6.2 Smoke tests (manuais)

1. **Single turn:**
   ```bash
   curl -N -s -X POST http://localhost:3000/api/chat \
     -H "Content-Type: application/json" \
     -d '{"messages":[{"role":"user","content":"O que é a matriz de Kraljic?"}]}'
   ```
   Espera: stream SSE começa em < 3s; várias linhas `data:` com tokens; uma linha `data:` com annotation contendo `sources` (Kraljic article id) e `classification.theory='kraljic'`. Stream fecha. Status 200.

2. **Multi-turn (testa o condenser):**
   ```bash
   curl -N -s -X POST http://localhost:3000/api/chat \
     -H "Content-Type: application/json" \
     -d '{"messages":[
       {"role":"user","content":"O que é a matriz de Kraljic?"},
       {"role":"assistant","content":"A matriz classifica itens em quatro quadrantes..."},
       {"role":"user","content":"E como aplicar?"}
     ]}'
   ```
   Espera: condenser reescreve para algo como "Como aplicar a matriz de Kraljic?"; sources incluem Kraljic; resposta continua coerente.

3. **Validação:** body inválido (`{}`, ou `{messages:[]}`, ou last message assistant) → 400.

4. **Não-regressão:** `npm test` → pelo menos 48 passando (39 anteriores + 5 condenser + 4 chat). `npm run typecheck` → zero erros. `pytest` → 23/23. `/api/health` → 200.

## 7. Critérios de sucesso

1. `app/api/chat/route.ts` existe, exporta `POST` e `runtime = 'edge'`.
2. `lib/rag/condenser.ts` existe e exporta `condenseQuery(messages): Promise<string>`.
3. `ChatMessage` exportado de `lib/rag/types.ts`.
4. `npm test` ≥ 48 passing (39 + 9 novos).
5. `npm run typecheck` zero erros.
6. Smoke 1 (single turn) funciona — stream em < 3s ttfb, sources presentes.
7. Smoke 2 (multi-turn) funciona — condenser melhora retrieval quando comparado a passar a raw last msg (subjetivamente; sub-projeto 7 quantifica).
8. Smoke 3 (validation) — 400 em todas as variantes inválidas.
9. `pytest` 23/23 e `/api/health` 200 inalterados.
10. Tag `chat-complete` no commit final.

## 8. Decisões e justificativas

| Decisão | Por quê |
|---|---|
| Stateless v1 | LGPD/CLAUDE.md exige opt-in para histórico. Stateless é o menor surface que entrega chat funcionando. Sub-projeto 6 adiciona persistence opt-in com auth — ou seja, persistence depende de algo que ainda não existe. |
| LLM-rewritten standalone query (Q2-C) | Multi-turn é UX padrão. Sem reescrita o retrieval falha em "e como aplicar?". Custo: 1 Flash call extra por multi-turn (skipado em single-turn). |
| Vercel AI SDK (Q3-A) | Cliente e servidor compartilham um protocolo conhecido; sub-projeto 5 ganha `useChat` praticamente grátis. Reinventar SSE + parser é trabalho que não diferencia o produto. |
| Dois SDKs Gemini coexistindo (`@google/genai` + `@ai-sdk/google`) | Cada um na sua especialidade: classifier/condenser são one-shot e ficam idiomáticos com `@google/genai`; o stream do chat fica com a abstração do AI SDK que sub-projeto 5 vai consumir. |
| Sources como `appendMessageAnnotation`, não eventos custom interleaved | Standard do AI SDK. UI lê quando a mensagem completa. Trade-off de UX (UI não pode mostrar fontes "antes do texto") aceito; revisitar em sub-projeto 7 se virar problema percebido. |
| `runtime = 'edge'` | CLAUDE.md exige edge para chat. Voyage/Cohere/Supabase JS são compatíveis. AI SDK é compatível. Único risco real é `@ai-sdk/google` em edge — verificado no smoke. |
| User message replaced by `rag.user` (em vez de adicionar context como system message) | `rag.user` é a forma exata que `prompt-builder` projeta para a chamada do LLM (com bloco de contexto numerado + pergunta). Substituir mantém o LLM vendo a estrutura como o builder pretendeu. History (assistant turns) preserva o contexto da conversa. |
| Condenser não-throw | Mesmo padrão de classifier (sub-projeto 3). Falhas no condenser não devem bloquear a resposta — recall pior é melhor que erro. |
| Sem nova migration | Stateless. Schema atual já suporta sub-projeto 6 quando este adicionar `sessions` + `messages`. |

## 9. Riscos

| Risco | Mitigação |
|---|---|
| `@ai-sdk/google` incompatível com Edge | Smoke test no sub-projeto manual. Se quebrar, mover para `runtime = 'nodejs'` é trivial (1 linha) e custo aceitável até sub-projeto 6. |
| Condenser reescreve mal e quebra recall | Fallback para raw last message é o backstop. Sub-projeto 7 mede o impacto via golden set multi-turn. |
| AI SDK breaking changes entre minor versions | Pin `^4.x` (caret no minor). Major bumps requerem trabalho explícito. |
| Custo: 1 Flash call (classifier) + 1 Flash call (condenser) + 1 Voyage embed + 2 Supabase RPC + 1 Cohere rerank + 1 streamed Flash = ~6 chamadas pagas por turno multi-turn | Aceitável. Flash Lite é barato. Single turn salta o condenser → 5 chamadas. |
| Sem rate limiting → quota burn por abuso | Aceitável enquanto não há UI pública. Sub-projeto 6 endurece. |
| Conversas longas excedem context window | Não em v1. Quando relevante (centenas de turnos), sub-projeto 7 adiciona sumarização. |

## 10. Sequência de implementação (esboço)

A ordem detalhada vai para o plano (`docs/superpowers/plans/2026-05-02-chat.md`). Esqueleto:

1. Adicionar deps `ai` e `@ai-sdk/google` ao `package.json`.
2. Adicionar `ChatMessage` em `lib/rag/types.ts`.
3. `condenser.ts` + tests (TDD, 5 testes).
4. `app/api/chat/route.ts` + tests (TDD, 4 testes).
5. Smoke tests manuais (single + multi + validation).
6. Tag `chat-complete`.
