# Sub-projeto 3 — Retrieval (RAG)

> **Status:** Design (sub-projeto 3 of 7)
> **Date:** 2026-05-02
> **Depends on:** sub-projeto 1 (Fundação) — schema + Node wrappers; sub-projeto 2 (Ingestão) — populated `articles`/`chunks` tables.
> **Consumed by:** sub-projeto 4 (Chat endpoint), sub-projeto 7 (Evals).

## 1. Contexto

A Fundação entregou o schema (`articles`, `chunks` com `embedding vector(1024)` e `tsv tsvector` portuguese FTS) e os wrappers Node (`gemini.ts`, `voyage.ts`, `cohere.ts`, `supabase.ts`). A Ingestão popula essas tabelas a partir de arquivos em `./artigos/`.

Este sub-projeto entrega a camada de **recuperação**: dado uma pergunta do usuário, produz um contexto citável e um prompt de sistema/usuário pronto para o LLM. Não inclui o endpoint de chat nem o streaming SSE — esses são responsabilidade do sub-projeto 4. Aqui se entrega `runRag(query) → { classification, sources, system, user }`, uma função pura (do ponto de vista do consumidor) que o endpoint de chat chamará.

O critério de pronto deste sub-projeto é: dado o corpus já ingerido, `npm run rag:query "<pergunta>"` retorna chunks relevantes com citações numeradas, e `npm run rag:eval` mede recall@5 e MRR contra um golden-set de 10 perguntas em PT-BR.

## 2. Objetivo

Entregar `lib/rag/` (cinco módulos) + uma migration RPC + um harness de avaliação offline. Toda a camada roda em Edge Runtime (sem dependências Node-only). O retriever é híbrido (vetorial + lexical com fusão RRF), seguido de rerank Cohere; um classificador Gemini Flash decide se a pergunta exige retrieval e seleciona o template de prompt.

**Não-objetivos** (delegados a sub-projetos posteriores):
- Endpoint de chat / streaming SSE → sub-projeto 4
- Componentes de UI → sub-projeto 5
- Auth, políticas RLS reais, opt-in LGPD → sub-projeto 6
- Traces Langfuse, framework completo de evals, golden-set extenso, gate em PR → sub-projeto 7
- Reescrita de query multi-turno (segue contexto da conversa) → sub-projeto 4
- Comando `re-embed` para troca de modelo → futuro
- Topic-biased retrieval (ponderar resultados pelo `theory` do classificador) → rejeitado, revisitar via evals
- FTS por idioma (`tsv_en`) → ride a config `portuguese` existente; revisitar via evals

## 3. Stack

- TypeScript strict (já configurado)
- `@supabase/supabase-js` (já presente) — chama os dois RPCs
- `zod` para validar a saída JSON do classificador (adicionar a deps se ainda não estiver)
- `tsx` para rodar os scripts de eval/CLI (devDependency)
- `vitest` para testes unitários (já presente)
- Wrappers existentes em `lib/llm/` (gemini, voyage, cohere) — sem novas dependências de runtime

## 4. Estrutura de pastas

```
/lib
  /rag
    classifier.ts          # Gemini Flash → { theory, intent, language, needsRetrieval }
    retriever.ts           # vector + FTS via RPC, fusão RRF
    reranker.ts            # wrapper sobre lib/llm/cohere.ts
    prompt-builder.ts      # persona + contexto numerado + tokens de citação
    index.ts               # runRag(query) — orquestrador
    types.ts               # Classification, RetrievedChunk, RagResult, SourceRef
/scripts
  rag-query.ts             # CLI: npm run rag:query "<pergunta>"
  /eval
    golden.json            # 10 Q&A pares PT-BR
    run.ts                 # npm run rag:eval — recall@5, MRR, latência
/supabase/migrations
  00000000000002_rag_rpc.sql   # match_chunks() + search_chunks_fts()
/tests/lib/rag
  classifier.test.ts
  retriever.test.ts
  reranker.test.ts
  prompt-builder.test.ts
  index.test.ts
```

## 5. Migration — RPC

`supabase/migrations/00000000000002_rag_rpc.sql` adiciona duas funções:

```sql
create or replace function match_chunks(
  query_embedding vector(1024),
  match_count int default 20
)
returns table (
  chunk_id uuid,
  article_id uuid,
  content text,
  ord int,
  similarity float
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.article_id, c.content, c.ord,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

create or replace function search_chunks_fts(
  query_text text,
  match_count int default 20
)
returns table (
  chunk_id uuid,
  article_id uuid,
  content text,
  ord int,
  rank float
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.article_id, c.content, c.ord,
         ts_rank(c.tsv, websearch_to_tsquery('portuguese', query_text)) as rank
  from chunks c
  where c.tsv @@ websearch_to_tsquery('portuguese', query_text)
  order by rank desc
  limit match_count;
$$;

grant execute on function match_chunks(vector, int) to anon, authenticated, service_role;
grant execute on function search_chunks_fts(text, int) to anon, authenticated, service_role;
```

`security definer` é necessário porque RLS está habilitado nas tabelas mas sem políticas (Fundação). Sub-projeto 6 (Auth) revisita: adiciona políticas e remove `security definer`, ou restringe `grant execute` a `authenticated`.

`websearch_to_tsquery` (não `plainto_tsquery`) para suportar operadores naturais (aspas, `or`, `-termo`) que usuários podem digitar.

## 6. Componentes — contratos

### 6.1 `types.ts`

```ts
export type Intent =
  | 'definition' | 'application' | 'comparison'
  | 'recommendation' | 'smalltalk';

export type Classification = {
  theory: string | null;       // 'kraljic' | 'porter' | ... | null — open-ended
  intent: Intent;
  language: 'pt' | 'en';
  needsRetrieval: boolean;
};

export type RetrievedChunk = {
  chunkId: string;
  articleId: string;
  content: string;
  ord: number;
  articleTitle: string;
  vectorRank: number | null;   // 1-based, null if missing
  ftsRank: number | null;
  rrfScore: number;
  rerankScore: number | null;  // populated after reranker, null pre-rerank
};

export type SourceRef = {
  number: number;              // 1-based, matches the [N] token in the prompt
  articleId: string;
  articleTitle: string;
  chunkId: string;
};

export type RagResult = {
  classification: Classification;
  sources: SourceRef[];
  system: string;
  user: string;
  debug: {
    classifyMs: number;
    embedMs: number;
    vectorMs: number;
    ftsMs: number;
    rerankMs: number;
    totalMs: number;
  };
};
```

### 6.2 `classifier.ts`

```ts
export async function classify(query: string): Promise<Classification>
```

- Uma chamada `getGemini().models.generateContent({ model, contents, config })` (SDK `@google/genai`). Modelo: `GEMINI_MODEL` (env, hoje `gemini-3.1-flash-lite-preview`).
- Usa `config.responseMimeType: 'application/json'` + `config.responseSchema` (JSON Schema) para forçar JSON estruturado. Schema também validado com `zod` no lado cliente como segunda camada.
- `theory` é `string().nullable()` — não é enum fechado. `intent` é enum estrita.
- Erro/JSON malformado/Zod reject → retorna `{ theory: null, intent: 'definition', language: 'pt', needsRetrieval: true }` e loga via `console.warn`. Nunca lança — falha do classificador não pode bloquear o usuário.
- Prompt menciona Kraljic, Porter, Monczka, TCO, SRM como exemplos de `theory`, mas instrui formato livre.
- `needsRetrieval=false` apenas para `intent='smalltalk'` (saudações, agradecimentos, perguntas sobre o próprio bot).

### 6.3 `retriever.ts`

```ts
export type RetrieveOptions = {
  vectorK?: number;   // default 20
  ftsK?: number;      // default 20
  rrfK?: number;      // default 60
  outK?: number;      // default 30 (input do reranker)
};

export async function retrieve(
  query: string,
  opts?: RetrieveOptions,
): Promise<RetrievedChunk[]>
```

- Embeda a query via `lib/llm/voyage.ts:embed()`. **Nota:** o wrapper atual não passa `input_type`. Esta sub-projeto **estende** `embed()` para aceitar um segundo parâmetro opcional `inputType?: 'query' | 'document'` (default `undefined` — comportamento inalterado para callers existentes). O retriever passa `'query'`. A ingestão Python continua sem `input_type` (mudança no Python fica para um sub-projeto futuro de re-embed se evals mostrarem que importa). Os 3 testes existentes de `voyage.test.ts` continuam passando; um teste novo cobre o param opcional.
- Dispara as duas RPCs em paralelo via `Promise.all`.
- RRF: `score(c) = sum_{lista}(1 / (rrfK + rank_lista(c)))`. Dedup por `chunkId`. Ordena desc por `rrfScore`. Toma `outK`.
- Junta `articleTitle` via uma query a `articles` (single round-trip com `in (...)`).
- Não acopla com classifier (decisão Q2-C).

### 6.4 `reranker.ts`

```ts
export async function rerank(
  query: string,
  chunks: RetrievedChunk[],
  topN: number,
): Promise<RetrievedChunk[]>
```

- Wrapper sobre `lib/llm/cohere.ts:rerank()`, que devolve `RerankHit[] = [{ index, relevanceScore }]` (índices na lista de documentos enviada). O reranker mapeia `hit.index → chunks[hit.index]`, anota `chunk.rerankScore = hit.relevanceScore`, e devolve a lista resultante (já em ordem decrescente de relevância). Modelo: `COHERE_RERANK_MODEL` (env, hoje `rerank-multilingual-v3.0`).
- Falha do Cohere → retorna `chunks.slice(0, topN)` (ordem RRF) com `rerankScore = null` e loga `console.warn`. Não lança.
- Se `chunks.length === 0` retorna `[]` sem chamar Cohere.

### 6.5 `prompt-builder.ts`

```ts
export function buildPrompt(
  query: string,
  chunks: RetrievedChunk[],
  classification: Classification,
): { system: string; user: string; sources: SourceRef[] }
```

- **Função pura.** Sem I/O, sem await.
- `system` inclui:
  - Persona da CLAUDE.md ("Especialista sênior em procurement com 20 anos de experiência…")
  - Estrutura de resposta em 4 partes (resposta direta → aprofundamento com citações → aplicação prática → leituras complementares)
  - Hint de idioma (`Responda em português brasileiro` ou `Respond in English`) baseado em `classification.language`
  - Se `chunks.length === 0`: linha forte `"Você não tem fonte na base sobre esta pergunta. Diga isso explicitamente. Não invente teoria, autor, framework, ou citação."`
  - Senão: instrução de citar usando os tokens `[1]`, `[2]`, etc. para cada afirmação técnica
- `user` inclui:
  - Bloco de contexto (se houver chunks): `## [1] {articleTitle}\n\n{content}\n\n---\n\n## [2] ...`
  - Pergunta original
- `sources` retornado em ordem 1..N, alinhado com os tokens `[N]`.

### 6.6 `index.ts`

```ts
export async function runRag(query: string): Promise<RagResult>
```

- Orquestra: `classify` → (curto-circuito se `!needsRetrieval`) → `retrieve` → `rerank` → `buildPrompt`.
- No curto-circuito, `sources=[]`, `chunks=[]`, e `buildPrompt` é chamado normalmente (cai no branch empty-context).
- Popula `debug` com timings via `performance.now()`.

## 7. Eval harness e CLI

### 7.1 `scripts/eval/golden.json`

10 entradas. Schema:

```json
[
  {
    "id": "kraljic-definition",
    "query": "O que é a matriz de Kraljic?",
    "expected_titles": ["A Matriz de Kraljic"],
    "intent": "definition"
  }
]
```

Distribuição: 4 `definition`, 3 `application`, 2 `comparison`, 1 `smalltalk` (com `expected_titles: []`). `expected_titles` em vez de IDs porque IDs mudam por reingestão; títulos são estáveis para o corpus de fixtures + 2-3 artigos reais que o usuário tiver dropado em `./artigos/`.

### 7.2 `scripts/eval/run.ts` — `npm run rag:eval`

- Carrega `golden.json`.
- Resolve `expected_titles → article_id` via uma query: `select id, title from articles where title in (...)`. Se algum título não existir na base, marca a row como `inconclusive` (não conta no recall).
- Para cada row: chama `runRag`, extrai `sources.map(s => s.articleId)`, computa hit@5 e rank do primeiro hit (para MRR).
- Métricas agregadas: **recall@5**, **MRR**, **smalltalk-skip-rate** (% de rows com `intent: 'smalltalk'` em que `needsRetrieval=false`), **mean total latency**.
- Imprime tabela markdown no stdout. Sai 0 sempre (sem gate em PR — sub-projeto 7).

### 7.3 `scripts/rag-query.ts` — `npm run rag:query "<pergunta>"`

- Chama `runRag(query)`.
- Pretty-print: classification (1 linha), top sources com `articleTitle` + `rrfScore` + `rerankScore` (tabela), prompt assembled (truncado em 800 chars), debug timings.
- Single-shot, para iterar localmente.

### 7.4 `package.json`

Adicionar:
```json
"scripts": {
  ...
  "rag:query": "tsx scripts/rag-query.ts",
  "rag:eval": "tsx scripts/eval/run.ts"
}
```

`tsx` em devDependencies se ausente.

## 8. Testing

| Arquivo | Cobre |
|---|---|
| `tests/lib/rag/classifier.test.ts` | (a) JSON válido → resultado tipado, (b) JSON malformado → default seguro, (c) Gemini erro → default seguro, (d) Zod-rejected enum → default seguro |
| `tests/lib/rag/retriever.test.ts` | (a) RRF math em inputs conhecidos (duas listas → ordem fundida esperada), (b) dedup por `chunkId`, (c) FTS vazio → vector preserva ordem, (d) ambos vazios → array vazio |
| `tests/lib/rag/reranker.test.ts` | (a) pass-through com Cohere mockado, (b) Cohere erro → fallback para top-N de input |
| `tests/lib/rag/prompt-builder.test.ts` | (a) tokens `[1]`..`[N]` numerados, (b) `sources[i].number === i+1`, (c) empty-context contém instrução estrita de recusa, (d) language hint flipa seção do system prompt |
| `tests/lib/rag/index.test.ts` | (a) pipeline completo com todos os wrappers mockados, (b) `needsRetrieval=false` curto-circuita retriever + reranker, (c) `debug` populado |

Mocks no boundary: Supabase `.rpc()`, Gemini `generateContent`, Voyage `embed`, Cohere `rerank`. Funções RPC SQL não são unit-testadas (testadas implicitamente pelo eval).

**Não-regressão:** vitest existente (15) + pytest (23) + `/api/health` 200 continuam passando.

## 9. Integration smoke test (manual, requer corpus ingerido)

1. `npm run rag:query "O que é a matriz de Kraljic?"` → topo do ranking deve ser chunks da fixture `sample_pt.md`, `rerankScore > 0`.
2. `npm run rag:eval` → imprime tabela com `recall@5 ≥ 0.6` e `smalltalk-skip-rate = 1.0`.

`recall@5 ≥ 0.6` é barra baixa intencional — prova que o pipeline está vivo e ponta-a-ponta com serviços reais. Sub-projeto 7 sobe a barra com mais dados e métricas mais finas.

## 10. Critérios de sucesso

1. Migration `00000000000002_rag_rpc.sql` aplicada e `match_chunks` + `search_chunks_fts` chamáveis via `supabase.rpc()` com a `anon key`.
2. `lib/rag/{classifier,retriever,reranker,prompt-builder,index,types}.ts` implementados, todos os imports resolvendo, `npm run typecheck` (`tsc --noEmit`) zero erros.
3. 5 arquivos de teste em `tests/lib/rag/` totalizando ≥ 18 testes passando, somando aos 15 pré-existentes (≥ 33 vitest passando).
4. Pytest 23/23 inalterado; `/api/health` segue 200.
5. `npm run rag:query "qual a matriz de Kraljic?"` retorna chunks da fixture com `rerankScore > 0`.
6. `npm run rag:eval` roda em < 30s, imprime recall@5, MRR, smalltalk-skip, latência média; recall@5 ≥ 0.6.
7. Tag `retrieval-complete` no commit final.

## 11. Decisões e justificativas

| Decisão | Por quê |
|---|---|
| RRF, não combinação ponderada | RRF é robusto a escalas diferentes (cosine ∈ [0,1] vs ts_rank ∈ [0,∞)) sem precisar normalizar. Padrão da literatura (Cormack, Clarke, Buettcher 2009). |
| `rrfK = 60` | Constante padrão da literatura RRF. Não há ganho documentado em ajustar para corpora pequenos. |
| Cohere rerank após RRF | A literatura (BEIR, MTEB) mostra ganhos consistentes do reranker. Cohere é o wrapper que já existe; modelo multilingual lida com PT/EN. |
| Classificador NÃO influencia retrieval | Topic-biasing é footgun (decisão Q2-C). Quando o classificador erra, biasing piora. Classifier alimenta apenas: prompt template e short-circuit smalltalk. |
| Schema `theory` aberto, não enum | Permite descobrir teorias do corpus real sem code change. Sub-projeto 7 analisa distribuição empírica. |
| Função pura `prompt-builder` | Testável sem mocks, portável, separa concern de "decidir o que mandar pro LLM" de "buscar dados". |
| `security definer` nas RPCs | RLS habilitado sem políticas (Fundação). Dívida explícita; sub-projeto 6 paga. |
| `websearch_to_tsquery`, não `plainto_tsquery` | Suporta operadores naturais que usuários podem digitar (aspas, `or`, `-termo`). |
| Eval com `expected_titles`, não IDs | Títulos são estáveis entre reingestões; IDs não. |
| Recall@5 ≥ 0.6 como barra | Prova de vida ponta-a-ponta. Barra real fica para sub-projeto 7 (Langfuse + golden expandido + gate em PR). |

## 12. Riscos

| Risco | Mitigação |
|---|---|
| Cohere fora do ar bloqueia respostas | Fallback para ordem RRF, log warn. Não lança. |
| Classificador degrada experiência | Fallback safe-default em qualquer erro. Custo: 1 chamada Flash por pergunta — aceitável (Flash Lite é barato e o prompt é pequeno). |
| `security definer` deixa RPCs abertas pré-Auth | Sub-projeto 6 endurece. Risco baixo enquanto a UI não está pública. |
| `tsv` é português e artigos em inglês ainda usam essa config | Aceito na Fundação. Se evals do sub-projeto 7 mostrarem que EN sofre, adicionar `tsv_en` como migration menor. |
| Edge runtime pode quebrar com alguma dep | Todas as deps escolhidas (`@supabase/supabase-js`, `zod`, fetch via wrappers) são Edge-compatíveis. CI roda `vercel build` quando o sub-projeto 4 entrar; até lá `tsc --noEmit` é a sentinela. |

## 13. Sequência de implementação (esboço)

A ordem de tasks vai para o plano (`docs/superpowers/plans/2026-05-02-retrieval.md`), mas o esqueleto é:

1. Adicionar `zod` (e `tsx` se ausente) ao `package.json`
2. Migration `00000000000002_rag_rpc.sql` + aplicar no DB
3. `types.ts`
4. `classifier.ts` + tests (TDD)
5. `retriever.ts` + tests (TDD na função RRF)
6. `reranker.ts` + tests (TDD no fallback)
7. `prompt-builder.ts` + tests (TDD — função pura, prazerosa)
8. `index.ts` + tests (integração com mocks)
9. `scripts/rag-query.ts` + script `rag:query`
10. `scripts/eval/golden.json` + `scripts/eval/run.ts` + script `rag:eval`
11. Smoke test manual + tag `retrieval-complete`
