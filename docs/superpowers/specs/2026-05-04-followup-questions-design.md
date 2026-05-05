# Sub-projeto 11 — Follow-up Questions

**Status:** spec
**Data:** 2026-05-04
**Milestone:** 2 — Beta Readiness (extensão pós-feedback-loop)
**Tag de saída prevista:** `followup-questions-complete`

## Objetivo

Após cada resposta do assistant em `/api/chat`, sugerir **3 perguntas curtas** que o usuário pode clicar para continuar a conversa. As sugestões aparecem como chips clicáveis logo abaixo da última mensagem do assistant. O clique envia o texto do chip como uma nova mensagem do usuário, igual a digitar e mandar.

A feature se comporta de duas formas distintas dependendo do caminho do RAG:

- **Caminho fundamentado** (`chunks ≥ MIN_RELEVANCE` retornaram do reranker): sugere 3 perguntas que **aprofundam** o tema, ancoradas no material recuperado.
- **Caminho refusal** (reranker zerou todos os chunks): sugere 3 **reformulações** ou tópicos próximos de procurement (Kraljic, TCO, Cox, Cousins, Monczka, Porter, Dyer, sourcing estratégico, gestão de fornecedores) que provavelmente estão na base.

Em ambos os casos as sugestões são uma anotação SSE (não persistida) e desaparecem assim que o próximo turno renderiza.

## Princípios

1. **Fail-soft:** uma falha em sugerir follow-ups nunca quebra ou degrada o turno principal. Em qualquer erro, a anotação é `{ followups: [] }` e a UI não renderiza chips.
2. **Sem mudança de schema:** as sugestões vivem só em memória do componente do turno corrente. Não vão para o JSONB de `sessions.messages`. Sub-projeto 11 trata isso como metadado de turno, não como payload de mensagem.
3. **Latência alvo:** ≤500ms p50 para o passo de sugestão. Roda *depois* do stream da resposta principal terminar, então não impacta TTFT.
4. **Observável:** novo span `suggest-followups` aninhado em `chat.turn`. Tag `followups:empty` no trace quando o array sai vazio (útil para auditar frequência sem abrir traces individuais).
5. **Idioma segue o classifier** (`classification.language`): PT-BR primário, EN secundário. Mesmo prompt estrutural, traduzido.
6. **YAGNI:** sem A/B test de quantidade, sem persistência por mensagem, sem telemetria de click-through, sem hover/preview, sem animação de entrada.

## Arquitetura

```
POST /api/chat (Node)
  ↓
condense → classify → retrieve → rerank → build-prompt → generate (streamText)
                                                              ↓
                                                       onFinish dispara
                                                              ↓
                                              [NOVO] suggestFollowups(...)
                                                              ↓
                                              data.appendMessageAnnotation({ followups })
                                                              ↓
                                              trace.end + flushAsync + data.close
```

`suggestFollowups` é sequencial dentro do `onFinish`, depois que o texto principal terminou de streamar. O caller já viu a resposta inteira; o stream da `StreamData` continua aberto até o `data.close()` final, então a annotation chega normalmente como segundo evento de annotation no SSE (a primeira já carrega `sources`/`classification`/`debug`/`traceId` do sub-projeto 9).

A chamada é envolvida em try/catch isolado. Em qualquer falha (timeout 3s, JSON inválido, modelo recusou, network), retorna `[]` e o turno segue normalmente.

## Componentes

### Backend

| Arquivo | Novo? | Responsabilidade |
|---|---|---|
| `lib/rag/followups.ts` | novo | Função pura `suggestFollowups({ query, answer, chunks, classification, parentTrace }) → Promise<string[]>`. Monta prompt (modos `deepen`/`redirect`), chama Gemini Flash Lite com structured JSON output, valida com zod, retorna array (vazio em erro). Span `suggest-followups` aninhado em `parentTrace`. |
| `lib/llm/gemini.ts` | extender | Reusa o wrapper existente `@google/genai`. Se já houver helper para JSON mode, reusa; caso contrário, adiciona overload pequeno que aceita `responseMimeType: 'application/json'` e `responseSchema`. |
| `app/api/chat/route.ts` | extender | Dentro do `onFinish` atual, depois de `generateSpan.end`, chama `suggestFollowups` e `data.appendMessageAnnotation({ followups })` antes de `trace.end`. Skip do passo se `finishReason === 'error'` ou `'abort'` ou `text.length < 20`. |

### Frontend

| Arquivo | Novo? | Responsabilidade |
|---|---|---|
| `components/chat/FollowupChips.tsx` | novo | Recebe `followups: string[]`, `onPick: (text: string) => void`, `disabled?: boolean`. Renderiza N chips Tailwind (border, hover, focus-visible, `role="button"`, `tabIndex={0}`, Enter/Space ativam o click, aria-label). Wrap em flex-wrap para mobile. |
| `components/chat/Message.tsx` | extender | Aceita props `followups?: string[]` e `isLast?: boolean`. Renderiza `<FollowupChips>` apenas se `role === 'assistant' && !isStreaming && isLast && followups?.length`. |
| `components/chat/MessageList.tsx` (ou onde `useChat().messages` é mapeado) | extender | Calcula `isLast` por mensagem (`index === messages.length - 1`). Lê `followups` da última annotation que tenha a chave `followups`. Conecta `onPick` a `append({ role: 'user', content })` do hook `useChat`. |

### Sem alteração

- `lib/rag/prompt-builder.ts` — o REFUSAL_INSTRUCTION continua exatamente como está; o switch refusal/grounded já é detectado pelo array `chunks` no caller, então `suggestFollowups` reusa o mesmo sinal sem precisar mudar o prompt-builder.
- `lib/rag/reranker.ts`, `lib/rag/retriever.ts`, `lib/rag/classifier.ts`, `lib/rag/condenser.ts`, `runRag` — nada toca.
- `useChatSessionsRemote`, schema `sessions`, RLS, migrations — nada toca.
- Eval (`npm run rag:eval`) e CI gate (`recall@5 ≥ 0.85`) — nada toca.

## Data flow

### Caminho fundamentado (chunks recuperados ≥ 1)

```ts
suggestFollowups input:
  query: string                    // standalone do condenser
  answer: string                   // text completo do streamText.onFinish
  chunks: { title: string; snippet: string }[]   // rag.sources mapeados; snippet = chunk.content.slice(0, 240)
  classification: { language: 'pt' | 'en'; ... }
  parentTrace: Trace
  mode: 'deepen'                   // derivado: chunks.length > 0
```

System prompt (PT-BR):

> Você é um assistente que sugere 3 perguntas curtas de follow-up para um usuário que acabou de receber uma resposta sobre teoria de procurement. As perguntas devem aprofundar o tema, ser respondíveis a partir do material abaixo, e ter no máximo 90 caracteres cada. Não inclua a pergunta original. Não use IDs, números entre colchetes, nem cite fontes. Retorne JSON com a forma `{ "followups": [string, string, string] }`.

User prompt:

```
## Pergunta original
{query}

## Resposta dada
{answer}

## Material disponível
- {title 1}: {snippet 1}
- {title 2}: {snippet 2}
- ...
```

### Caminho refusal (chunks vazios)

```ts
mode: 'redirect'                   // derivado: chunks.length === 0
chunks: []                         // não passa material
```

System prompt (PT-BR):

> Você é um assistente que ajuda um usuário cuja pergunta não foi respondida porque a base de conhecimento não tinha material sobre o tópico. Sugira 3 reformulações ou tópicos próximos de procurement (matriz de Kraljic, TCO, modelos de Cox / Cousins / Monczka, sourcing estratégico, gestão de fornecedores, Porter, Dyer, etc.) que possam estar na base. Não prometa que a base cobre o tema; apenas sugira reformulações. No máximo 90 caracteres cada. Retorne JSON com a forma `{ "followups": [string, string, string] }`.

User prompt:

```
## Pergunta original (não respondida)
{query}
```

### Idioma EN

Quando `classification.language === 'en'`, troca system prompt e nomes de seções para EN. Mesma estrutura de output.

### Schema de output (zod)

```ts
const FollowupsSchema = z.object({
  followups: z.array(z.string().min(3).max(120)).min(1).max(3),
});
```

Pós-processamento depois do parse:
1. `trim()` em cada string.
2. Remove duplicatas (case-insensitive).
3. Remove qualquer item igual à `query` original (case-insensitive trim).
4. Se sobrar `< 1`, retorna `[]`. Se sobrar 1 ou 2, retorna o que sobrou (UX aceita 1-3, não força 3).

### Anotação SSE

```ts
data.appendMessageAnnotation({ followups: ['...', '...', '...'] });
```

Aparece como segunda annotation no stream do turno (a primeira já carrega `sources`/`classification`/`debug`/`traceId`). Cliente lê com:

```ts
const followups = lastAssistantMessage?.annotations
  ?.flatMap(a => (a && typeof a === 'object' && 'followups' in a) ? [a.followups as string[]] : [])
  ?.at(-1) ?? [];
```

### Click handler

```ts
function onPick(text: string) {
  append({ role: 'user', content: text });
}
```

`append` é do hook `useChat` (Vercel AI SDK), já em uso no `ChatSession`. Como `/api/chat` tem rate limit per-user (10/min, 60/h via sub-projeto 8), click vira request normal e respeita o limit; toast 429 já cobre o caso de excesso.

## Erro e edge cases

| Caso | Comportamento |
|---|---|
| `streamText` aborta (Stop ou erro upstream) — `finishReason !== 'stop'` | **Skip** `suggestFollowups`. Não faz sentido sugerir continuação para resposta truncada. |
| Resposta principal vazia (`text.length < 20`) | **Skip** — provavelmente algo deu errado upstream. |
| Gemini timeout (>3s) | `AbortController` cancela, span `WARNING` com `{ error: 'timeout' }`, retorna `[]`. |
| Gemini lança qualquer outro erro | `try/catch` interno; retorna `[]`. |
| JSON do Gemini falha schema zod | Retorna `[]`. Logado em `console.warn` sem conteúdo da query (LGPD). |
| Após dedup/trim/filter sobra 0 itens | Retorna `[]`. |
| Cliente desconecta antes da annotation chegar | `data.append` falha silencioso, `flushAsync` ainda envia trace. Inerentemente OK. |
| Click num chip durante outro request em voo | Comportamento padrão do `useChat` (enfileira/bloqueia). Herda. |
| Click num chip que dispara rate limit | Toast 429 já implementado em sub-projeto 8. Herda. |
| Sessão multi-turno: chips ficam só na última | `isLast` reavaliado a cada render do `MessageList`; chips do penúltimo turno desaparecem assim que o último turno renderiza. |
| Followups idênticas à query original | Filtradas no backend antes de retornar. |

## Observabilidade

- Span novo `suggest-followups` em `chat.turn`:
  - input: `{ mode: 'deepen' | 'redirect', chunkCount: number, queryLen: number }`
  - output (sucesso): `{ count: number, latencyMs: number }`
  - output (falha): `{ error: string }`, `level: 'WARNING'`
- Tag de trace: `followups:empty` quando array sai vazio (qualquer motivo).
- Sem novo `userId`/`sessionId` — herda do trace pai.
- Não loga texto da query/answer/chunks no Langfuse além do que já vai (mantém consistência LGPD com o restante do pipeline).

## Testing

### Vitest novos (~25 testes)

`lib/rag/followups.test.ts`
- Retorna 3 strings em modo `deepen` quando Gemini devolve JSON válido (mock).
- Retorna 3 strings em modo `redirect` (chunks=[]) — verifica que system prompt muda.
- Retorna `[]` quando Gemini lança (timeout/network).
- Retorna `[]` quando JSON falha schema zod (extra keys, < 1 string, > 3 strings, item > 120 chars).
- Filtra duplicatas e a query original (case-insensitive trim).
- Trunca snippets dos chunks para 240 chars no prompt.
- Usa system prompt EN quando `classification.language === 'en'`.
- Chama `parentTrace.span('suggest-followups', ...)` e `.end` (mock do trace).
- `level: 'WARNING'` no span quando retorna `[]` por erro.
- Respeita `AbortController` 3s (vitest fake timers).

`app/api/chat/route.test.ts` (estender existente)
- `data.appendMessageAnnotation` é chamado com `{ followups: [...] }` em sucesso.
- `data.appendMessageAnnotation` é chamado com `{ followups: [] }` quando `suggestFollowups` falha.
- Followups **não** são chamados quando `finishReason === 'error'` ou `'abort'`.
- Followups **não** são chamados quando `text.length < 20`.
- Tag `followups:empty` adicionada ao trace quando array vazio.

`components/chat/FollowupChips.test.tsx` (RTL)
- Renderiza N chips quando recebe `followups`.
- Não renderiza nada quando `followups=[]` ou `disabled=true`.
- Click chama `onPick` com texto exato do chip.
- Enter/Space no chip também dispara `onPick` (a11y — keyboard activation).
- `aria-label` presente; `tabIndex={0}` correto.

`components/chat/Message.test.tsx` (estender existente)
- Chips renderizam apenas quando `role === 'assistant' && !isStreaming && isLast && followups?.length`.
- Chips **não** renderizam em `isLast === false`.
- Chips **não** renderizam durante streaming.
- Chips **não** renderizam para `role === 'user'`.

### Pytest

Sem mudança (pipeline de ingest não toca).

### Eval

Sem mudança em `npm run rag:eval`. CI gate (`recall@5 ≥ 0.85`) inalterado.

### Smoke manual (atualizar `docs/product/beta-smoke-test.md`)

- Após resposta fundamentada, 3 chips aparecem; click envia como nova mensagem do usuário.
- Após pergunta fora da base ("o que é blockchain?"), 3 chips de reformulação aparecem; click numa delas leva a uma resposta fundamentada.
- Stop button durante stream → chips não aparecem.
- Modo dark/light: chips legíveis em ambos.
- Mobile: chips wrappam em múltiplas linhas, área de click ≥44px.

### Cobertura total estimada

- Vitest: 143 → ~168 (+25)
- Pytest: 23 (sem mudança)
- Typecheck: zero erros mantido

## Variáveis de ambiente

Sem novas. Reusa `GOOGLE_API_KEY` e `GEMINI_MODEL` existentes.

## Migrations

Sem migration nova. Sub-projeto 11 não toca o schema.

## Critério de saída (tag `followup-questions-complete`)

1. `lib/rag/followups.ts` implementado e coberto pelos vitest novos.
2. Span `suggest-followups` aparece em traces Langfuse de `/api/chat`.
3. `/chat` UI renderiza 3 chips abaixo da última mensagem do assistant em ambos os caminhos (fundamentado e refusal).
4. Click num chip envia nova mensagem e os chips do turno anterior somem assim que o novo turno renderiza.
5. Smoke test em `docs/product/beta-smoke-test.md` passa nos 5 itens manuais.
6. CI verde (typecheck + vitest + pytest + rag:eval).
7. CLAUDE.md atualizado com a entrada do sub-projeto 11 e gotchas pertinentes (formato dos JSONB de annotations no SSE, regra de não persistir followups).

## Riscos e mitigação

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Followups sugerem temas fora da base e geram refusal em cascata no clique | média | Aceitável para v1 — refusal é honesto. Prompt instrui "respondíveis a partir do material abaixo" no caminho fundamentado. Se virar dor real depois, dá para evoluir para retrieval auxiliar (opção C da Pergunta 5) sem refazer nada. |
| Gemini Flash Lite preview muda contrato de structured output | baixa | Tudo passa por validação zod; falha cai no `[]`. Não há acoplamento à forma exata além do schema. |
| Latência da chamada extra perceptível | baixa | Roda depois do stream; usuário já vê a resposta. p50 alvo <500ms; hard timeout 3s. |
| Conteúdo dos chips infringe persona / sugere fora de procurement | baixa | System prompt restrito a procurement no modo redirect; modo deepen é amarrado ao material. Manual smoke cobre. |
| Falha do followup engole o trace | baixa | `try/catch` envolve só a chamada; `trace.end` + `flushAsync` rodam fora desse bloco. |

## Fora de escopo (futuro)

- Persistir followups por mensagem (requer schema change em `sessions.messages`).
- Métrica de click-through rate (poderia entrar como Langfuse score em sub-projeto futuro).
- A/B test de número de chips (3 vs 4 vs 2) ou de prompts diferentes.
- Hover/preview do conteúdo da follow-up.
- Animação de entrada dos chips.
- Retrieval auxiliar para fortalecer o caminho refusal (opção C da Pergunta 5).
