# Sub-projeto 13 — Auto-classified Library

**Status:** spec
**Data:** 2026-05-08
**Milestone:** pós-Milestone 2 (admin-ergonomics; precede o backfill canônico de Milestone 3)
**Tag de saída prevista:** `auto-classified-library-complete`

## Objetivo

Substituir a heurística de extração de título (`extractMetadata` em `lib/ingest/metadata.ts:36-64`) por um classificador LLM que lê o conteúdo do artigo e devolve `{ title, theme, summary }`. O título passa a refletir o assunto central do artigo em vez de pescar a primeira linha plausível (que hoje captura headers de journal como `"Available online at www.sciencesphere.org/ijispm"` ou linhas de afiliação institucional). O `theme` mapeia o artigo a uma de 11 categorias fixas de procurement, viabilizando uma navegação tipo pasta no `/admin/articles` (sidebar à esquerda com lista de temas + contagem).

A pipeline também ganha um campo `summary` opcional — uma linha de até 200 chars que descreve o conteúdo central — útil pro admin escanear a lista sem abrir cada artigo. Admin pode sobrepor `title` e `theme` manualmente via PATCH quando o LLM erra; conteúdo do artigo (chunks, embeddings) não muda nessa edição.

## Princípios

1. **Taxonomia fixa de 11 temas** — sem proliferação de near-duplicates, sem custo de UI para gerenciar a lista. Sub-temas, tags livres e hierarquias ficam fora de escopo.
2. **Backfill via `raw_md`** — os 3 artigos atuais (e quaisquer futuros pré-existentes) são reclassificados a partir do `articles.raw_md` que já está no DB. Não exige re-upload nem re-ingestão da pipeline multimodal.
3. **Fail-soft** — falha na chamada LLM nunca bloqueia ingestão. Em qualquer erro (timeout, JSON inválido, zod fail) o pipeline cai em `{ title: filenameStem(filename), theme: 'Outros', summary: '' }` e segue.
4. **Override manual barato** — PATCH simples no endpoint existente `/api/admin/articles/[id]`; UI inline no detail pane. Sem audit trail, sem versioning — o que importa é dar ao admin a saída.
5. **Retrieval inalterado** — `chunks.metadata` não ganha `theme`; o reranker, classifier e prompt-builder não conhecem a noção de "tema". Theme é metadado puramente administrativo (organização da biblioteca).
6. **YAGNI** — sem drag-and-drop, sem rebatch ao adicionar tema, sem UI pra editar a taxonomia, sem filtro por tema no chat side. Tudo isso pode entrar em sub-projeto futuro se precisar.

## Arquitetura

```
POST /api/admin/ingest/run/[jobId] (Node, fire-and-forget)
  ↓
runPipeline(jobId)
  ↓
download blob from Storage
  ↓
parseSource(buf, mime, filename)            (sub-projeto 12)
  ↓
chunker (chunkBlocks ou chunkText)          (sub-projeto 12)
  ↓
sourceText = blocks→text join | parsed.text
  ↓
sha256(blob) + dedup check (REORDERED — antes do classify pra economizar OpenAI em hits)
  ├─ dedup hit → mark job done, return cedo (NÃO chama classifyContent)
  └─ no dedup ↓
  ↓
[NOVO] classifyContent(sourceText, filename) → { title, theme, summary }
  ↓
articles insert { title, theme, summary, ...meta-existente }
  ↓
embeddings + chunks insert (inalterado)
```

Backfill paralelo (admin-driven, manual):

```
npm run articles:reclassify
  ↓
script lê todos os articles (id, raw_md, source_filename)
  ↓
para cada artigo:
  classifyContent(raw_md, source_filename) → { title, theme, summary }
  update articles set title=$1, theme=$2, summary=$3 where id=$4
  ↓
log final com breakdown por tema
```

Override admin (UI):

```
admin abre /admin/articles, seleciona artigo
  ↓
detail pane mostra dropdown de tema + botão lápis pro título
  ↓
edita inline → PATCH /api/admin/articles/[id] { title?: string, theme?: string }
  ↓
Server: requireAdmin → valida theme contra TAXONOMY → update
  ↓
UI atualiza row local sem refetch
```

## Componentes

### Backend — novos

| Arquivo | Responsabilidade |
|---|---|
| `lib/ingest/taxonomy.ts` | Constante `TAXONOMY` com os 11 temas (literal union TypeScript). Helper `isValidTheme(s): s is Theme`. Re-exports `Theme = (typeof TAXONOMY)[number]`. |
| `lib/ingest/classify-content.ts` | `classifyContent(text: string, filename: string): Promise<{ title: string; theme: Theme; summary: string }>`. Chama OpenAI `gpt-4o-mini` com `response_format: { type: 'json_object' }` e prompt em PT-BR; valida com zod; fail-soft pro fallback `{ title: filenameStem(filename), theme: 'Outros', summary: '' }`. Hard timeout 15s via AbortController. |
| `scripts/reclassify.ts` | CLI `tsx scripts/reclassify.ts [--dry-run]`. Lê `articles` (id, raw_md, metadata->>'source_filename'), chama `classifyContent` pra cada, executa `update articles set title=, theme=, summary= where id=`. Imprime breakdown por tema no fim. |
| `app/api/admin/articles/[id]/route.ts` (PATCH novo) | Aceita JSON body `{ title?: string, theme?: string }`. Valida com zod (`title.min(3).max(200).optional()`, `theme.refine(isValidTheme).optional()`, ao menos 1 dos campos presente). Faz update parcial. requireAdmin gate (404 pra non-admin). |

### Backend — modificados

| Arquivo | Mudança |
|---|---|
| `lib/ingest/pipeline.ts` | Após `parseSource` produzir `sourceText` (linhas 39-44 do código atual), chama `classifyContent(sourceText, job.filename)` e usa o resultado nos campos `title`, `theme`, `summary` do `insert articles`. `extractMetadata` continua sendo chamado pra `author`/`language`/`date`, mas seu campo `title` é ignorado. |
| `lib/ingest/metadata.ts` | Mantém comportamento; o campo `title` que ele retorna passa a ser ignorado pelo `pipeline.ts`. Não remover ainda — é usado por `scripts/ingest.py` legacy (que continua intacto). |
| `package.json` | Adiciona script `articles:reclassify` apontando pra `tsx scripts/reclassify.ts`. |

### Frontend — modificados

| Arquivo | Mudança |
|---|---|
| `components/admin/ArticlesSplitView.tsx` | Layout muda de 2-col (`[1.4fr_1fr]`) para 3-col (`[180px_1.4fr_1fr]`). Coluna esquerda nova: `<ThemeSidebar>` com lista vertical de 12 itens (Todos + 11 temas) e contagem por tema. Tabela central filtra por `selectedTheme` (default `'all'`). Multi-select e bulk delete (sub-projeto entregue) continuam funcionando dentro do filtro ativo. |
| `components/admin/ThemeSidebar.tsx` (novo) | Recebe `articles: ArticleRow[]`, `selectedTheme: Theme \| 'all'`, `onSelect: (t) => void`. Renderiza lista vertical de buttons; cada button mostra `<label>` (PT-BR) + badge com contagem (`articles.filter(a => a.theme === theme).length`). Item ativo destacado com `bg-primary/10`. Itens com contagem 0 ficam visíveis mas com texto cinza claro. |
| `components/admin/ArticleDetail.tsx` | Adiciona dropdown de tema acima do bloco de chunks (`<select>` ou `<DropdownMenu>` shadcn-equivalente). Botão lápis ao lado do `<h3>` título → expande pra `<input>` inline + Salvar/Cancelar. Both fields fazem PATCH ao salvar; chamam `onUpdated(id, { title, theme })` que o `<ArticlesSplitView>` usa pra atualizar o `rows` state local. Adiciona render do `summary` (uma linha cinza abaixo do título quando presente). |

### Sem alteração

- `lib/rag/*` — retriever, classifier, reranker, prompt-builder, condenser, runRag. Theme não vaza pro chat.
- `app/api/chat/route.ts` — sources annotation continua reportando título do artigo; vai ser o título novo (LLM-derived), o que é uma melhoria automática.
- `useChat`, `useChatSessionsRemote`, schema `sessions`. Nenhuma mudança.
- Eval (`scripts/eval/run.ts`) — lookup por título continua funcionando, MAS os 5 títulos esperados no `golden.json` precisam estar entre os títulos que o LLM produz pros 4 artigos da corpus. Risco enumerado em "Riscos" abaixo.

## Data flow

### Taxonomia (`lib/ingest/taxonomy.ts`)

```ts
export const TAXONOMY = [
  'Kraljic',
  'Sourcing Estratégico',
  'SRM',
  'TCO',
  'Sustentabilidade',
  'Risco / Resiliência',
  'Negociação / Contratos',
  'Performance / KPIs',
  'Digital / Tecnologia',
  'Setor Público',
  'Outros',
] as const;

export type Theme = (typeof TAXONOMY)[number];

export function isValidTheme(s: string): s is Theme {
  return (TAXONOMY as readonly string[]).includes(s);
}

export const THEME_DESCRIPTIONS: Record<Theme, string> = {
  'Kraljic': 'Matriz de Kraljic, categorização de itens, portfolio de compras',
  'Sourcing Estratégico': 'Strategic sourcing, seleção de fornecedores, RFx',
  'SRM': 'Supplier Relationship Management, gestão de fornecedores',
  'TCO': 'Total Cost of Ownership, custo total, análise de custo-benefício',
  'Sustentabilidade': 'Compras sustentáveis, ESG, ISO 20400/26000, circularidade',
  'Risco / Resiliência': 'Risco da cadeia, resiliência, contingência, disruptions',
  'Negociação / Contratos': 'Técnicas de negociação, gestão contratual, SLA',
  'Performance / KPIs': 'Indicadores de compras, savings, métricas de procurement',
  'Digital / Tecnologia': 'P2P, e-procurement, IA, automação, plataformas digitais',
  'Setor Público': 'Compras públicas, licitação, lei 14.133, transparência',
  'Outros': 'Não se encaixa nas demais categorias OU artigo de procurement geral',
};
```

`THEME_DESCRIPTIONS` é injetado no prompt do classificador pra dar contexto ao LLM.

### Classificador (`lib/ingest/classify-content.ts`)

System prompt (PT-BR):

```
Você é um especialista em procurement (compras corporativas) classificando artigos
acadêmicos. Receba um trecho de texto extraído do artigo e devolva JSON com
EXATAMENTE 3 campos:

- title: string em português (ou idioma original do artigo se não for PT) com
  60-100 caracteres que reflete o ASSUNTO CENTRAL do artigo. NÃO copie headers,
  números de página, nomes de revistas ou afiliações institucionais. Pense:
  "qual é o tema único deste artigo?" e escreva como um título de capítulo.

- theme: um de exatamente: ${TAXONOMY.join(' | ')}.
  Use as descrições abaixo pra guiar:
${descriptionsBlock}

- summary: string de até 200 caracteres com uma única frase resumindo a contribuição
  central do artigo. Sem chavões, sem "este artigo discute".

Não inclua explicações fora do JSON. Responda EXCLUSIVAMENTE com o objeto.
```

User block: o texto do artigo, truncado em ~6000 chars (input). Se o `sourceText` for menor, manda o todo.

Schema zod:

```ts
const ClassifySchema = z.object({
  title: z.string().min(10).max(200),
  theme: z.string().refine(isValidTheme, 'invalid theme'),
  summary: z.string().max(220).default(''),
});
```

Pós-processamento:
1. `title.trim()` — remove whitespace.
2. Strip aspas envolvendo (`"foo"` ou `'foo'`) caso o LLM as adicione.
3. Se `title.length < 10` após strip → fallback.

Fallback completo:

```ts
const filenameStem = filename.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim();
return { title: filenameStem || 'Sem título', theme: 'Outros' as Theme, summary: '' };
```

### Pipeline integration

Em `lib/ingest/pipeline.ts`, após o cálculo de `sourceText` (sub-projeto 12 já produz isso):

```ts
// dedup-first: economize a chamada OpenAI quando o artigo já existe
const hash = sha256(blob);
const { data: existing } = await sb
  .from('articles')
  .select('id')
  .eq('metadata->>content_hash', hash)
  .maybeSingle();

if (existing) {
  // mark job as deduplicated and return — sub-projeto 12 já fazia isso
  // (não chama classifyContent neste caminho)
  return;
}

// dedup miss: prossegue com classify + insert
const classified = await classifyContent(sourceText, job.filename);
// extractMetadata segue sendo chamado, mas só pra author/language/date
const meta = extractMetadata(sourceText, job.filename);

const { data: article, error: insArtErr } = await sb
  .from('articles')
  .insert({
    title: classified.title,
    theme: classified.theme,
    summary: classified.summary,
    author: meta.author,
    language: meta.language,
    published_at: meta.date,
    source_chars: sourceText.length,
    raw_md: sourceText,
    metadata: { content_hash: hash, source_filename: job.filename, parser },
  })
  .select('id')
  .single();
```

(O fluxo de dedup em `pipeline.ts` hoje já roda — só estamos garantindo que `classifyContent` venha depois.)

### Backfill script

```ts
// scripts/reclassify.ts (esboço)
const dryRun = process.argv.includes('--dry-run');
const sb = getServerSupabase();
const { data: rows } = await sb
  .from('articles')
  .select('id, raw_md, metadata')
  .order('ingested_at', { ascending: true });

for (const r of rows ?? []) {
  const filename = (r.metadata as Record<string, unknown>)?.['source_filename'] as string ?? '';
  const c = await classifyContent(r.raw_md, filename);
  console.log(`[${r.id.slice(0, 8)}] → "${c.title}" / ${c.theme}`);
  if (!dryRun) {
    await sb.from('articles')
      .update({ title: c.title, theme: c.theme, summary: c.summary })
      .eq('id', r.id);
  }
}
```

NPM script: `"articles:reclassify": "tsx scripts/reclassify.ts"`.

### PATCH endpoint

`app/api/admin/articles/[id]/route.ts` ganha um handler `PATCH`:

```ts
const Body = z
  .object({
    title: z.string().min(3).max(200).optional(),
    theme: z.string().refine(isValidTheme, 'invalid theme').optional(),
  })
  .refine((b) => b.title !== undefined || b.theme !== undefined, 'no fields to update');

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try { await requireAdmin(); }
  catch (err) { if (err instanceof NotAdmin) return new NextResponse('Not Found', { status: 404 }); throw err; }
  const json = await req.json();
  let body;
  try { body = Body.parse(json); }
  catch (err) { return Response.json({ error: 'invalid_body' }, { status: 400 }); }
  const sb = supabaseServer();
  const { error } = await sb.from('articles').update(body).eq('id', params.id);
  if (error) return Response.json({ error: 'update_failed' }, { status: 500 });
  return Response.json({ ok: true });
}
```

### UI sidebar

`<ThemeSidebar>` produz uma lista de buttons:

```tsx
const counts = useMemo(() => {
  const map = new Map<Theme | 'all', number>();
  map.set('all', articles.length);
  for (const t of TAXONOMY) {
    map.set(t, articles.filter((a) => a.theme === t).length);
  }
  return map;
}, [articles]);

return (
  <div className="border-r border-border p-2 space-y-0.5 text-sm">
    <ThemeButton label="Todos" theme="all" count={counts.get('all')!} active={selected === 'all'} onClick={() => onSelect('all')} />
    <div className="h-px bg-border my-1" />
    {TAXONOMY.map((t) => (
      <ThemeButton
        key={t}
        label={t}
        theme={t}
        count={counts.get(t) ?? 0}
        active={selected === t}
        onClick={() => onSelect(t)}
      />
    ))}
  </div>
);
```

`<ThemeButton>` é um `<button>` com classes Tailwind: `flex items-center justify-between w-full px-2 py-1.5 rounded hover:bg-accent`, ativo recebe `bg-primary/10 text-primary`. Contagem em `<span>` à direita com `text-xs text-muted-foreground tabular-nums`.

`<ArticlesSplitView>` filtra `rows` por `selectedTheme !== 'all' ? rows.filter(r => r.theme === selectedTheme) : rows` antes de aplicar o `search`. Multi-select + bulk delete continuam operando sobre o `filtered` array. Single-delete handler agora também recebe `theme` na callback pra atualizar contagens.

### UI override

No `<ArticleDetail>`:
- Below the title `<h3>`, render `summary` em `text-xs text-muted-foreground italic` quando presente.
- Replace o `<h3>` static por componente `<EditableTitle>` que alterna entre view (clicável) e edit (input + Salvar/Cancelar).
- Add `<select>` de tema acima do bloco de chunks: `<select value={article.theme} onChange={...}>` com 11 options. Mudança imediata → PATCH.
- Toast de sucesso/erro via `sonner` (já no layout root).

`onUpdated` callback propaga pro `<ArticlesSplitView>` que faz `setRows(prev => prev.map(r => r.id === id ? { ...r, ...patch } : r))`.

## Schema (migration `00000000000010_articles_theme.sql`)

```sql
-- Sub-projeto 13 — auto-classified library
alter table articles
  add column theme text not null default 'Outros',
  add column summary text;

alter table articles
  add constraint articles_theme_check
    check (theme in (
      'Kraljic',
      'Sourcing Estratégico',
      'SRM',
      'TCO',
      'Sustentabilidade',
      'Risco / Resiliência',
      'Negociação / Contratos',
      'Performance / KPIs',
      'Digital / Tecnologia',
      'Setor Público',
      'Outros'
    ));

create index articles_theme_idx on articles (theme);
```

Default `'Outros'` garante que rows existentes (3 artigos atuais) ficam consistentes mesmo antes do backfill rodar. Constraint check protege contra digit insert acidental.

**Mudança futura na taxonomia:** alterar `TAXONOMY` no TS exige migration nova pra ajustar a CHECK constraint. Isso é trade-off aceito do design "fixed list".

## Erro e edge cases

| Caso | Comportamento |
|---|---|
| Falha de rede / 5xx no OpenAI | catch → fallback `{ title: filenameStem, theme: 'Outros', summary: '' }`. Pipeline segue. |
| OpenAI retorna JSON inválido / zod fail | fallback (mesmo). NÃO faz retry — fail-soft é mais barato que outra chamada. |
| OpenAI retorna `theme` fora da taxonomia | zod refine rejeita → fallback. Caller pode logar pra inspeção. |
| Timeout 15s | AbortController dispara → fallback. |
| Texto < 200 chars (PDF muito curto) | `classifyContent` ainda chama o LLM mas com texto curto. LLM provavelmente retorna `'Outros'`. Aceitável. |
| `raw_md` vazio no backfill (legacy?) | Skip — log warning. Improvável (todos os rows existentes têm `raw_md`). |
| Admin edita título com 0 chars | PATCH zod rejeita (`min(3)`). 400. |
| Admin tenta setar tema inválido (manipulação manual) | PATCH zod refine rejeita. 400. |
| Backfill falha mid-loop | Cada artigo é update independente. Erros são logados e o loop segue. Re-rodar é idempotente (sobrescreve). |
| Dedup hit na ingestão | `parseSource` ainda roda, gerando `sourceText`, mas `classifyContent` NÃO é chamado (dedup check vem antes — ver "Pipeline integration"). Zero desperdício OpenAI em hits. |

## Observabilidade

Sub-projeto 13 não estende Langfuse (ingestão segue não-traced). Logs novos:
- `console.info` ao chegar em `classifyContent`: `[ingest/classify] sending text bytes=${len}`.
- `console.info` ao retornar: `[ingest/classify] result title="${title}" theme=${theme}`.
- `console.warn` em fallback: `[ingest/classify] fallback for ${filename}: ${error.message}`.
- Backfill script imprime tabela markdown ao fim com contagem por tema.

## Custo e latência

OpenAI gpt-4o-mini pricing (2026-05):
- Input: $0.15/1M tokens
- Output: $0.60/1M tokens

Por artigo (~6000 chars input ≈ 1500 tokens; ~250 tokens output):
- Input: $0.000225
- Output: $0.00015
- **~$0.0004/artigo**

100 artigos: ~$0.04 + 1-2 min sequencial. **Verde.**

## Testing

### Vitest novos (~30 testes)

`lib/ingest/taxonomy.test.ts` (~3)
- `TAXONOMY` tem exatamente 11 entradas.
- `isValidTheme('Kraljic') === true`.
- `isValidTheme('foo') === false`.

`lib/ingest/classify-content.test.ts` (~10)
- Sucesso happy path: mock OpenAI retorna JSON válido → resultado correto.
- Mock retorna `theme` fora da taxonomia → fallback.
- Mock retorna `title` < 10 chars → fallback.
- Mock retorna JSON inválido → fallback.
- Mock lança network error → fallback.
- Mock retorna sem `summary` → `summary === ''` (default).
- Mock retorna title com aspas envolventes → strip funciona.
- AbortController 15s dispara → fallback.
- System prompt menciona o nome de pelo menos 5 dos 11 temas (smoke).
- User content é truncado em ~6000 chars (mock recebe assertion).

`lib/ingest/pipeline.test.ts` (estender — ~3)
- Pipeline com mock `classifyContent` retornando `{ title: 'X', theme: 'Kraljic', summary: 'Y' }` → article insert recebe esses 3 campos.
- Pipeline com `classifyContent` lançando → article insert ainda acontece (fallback path).
- Dedup hit antes de `classifyContent` → `classifyContent` NÃO é chamado (mitigação aceita).

`tests/api/admin/articles-patch.test.ts` (~6)
- Non-admin → 404.
- Body vazio → 400.
- Body com `theme` inválido → 400.
- Body com `title` < 3 chars → 400.
- Admin + body válido (só `title`) → 200, supabase update chamado com `{ title }` apenas.
- Admin + body válido (só `theme`) → 200.

`components/admin/ThemeSidebar.test.tsx` (~4)
- Renderiza 12 botões (Todos + 11 temas).
- Contagem por tema reflete o array `articles` passado.
- Clicar num botão chama `onSelect(theme)`.
- Item ativo recebe classes de destaque.

`components/admin/ArticleDetail.test.tsx` (estender — ~4)
- Renderiza dropdown de tema com valor atual.
- Clicar lápis abre input de título; salvar dispara PATCH.
- `summary` renderiza quando presente.
- `summary` não renderiza quando ausente.

### Pytest

Sem mudança. `scripts/ingest.py` legacy não é tocado.

### Eval

`scripts/eval/golden.json` continua usando `expected_titles`. **Risco:** Se o LLM produzir títulos diferentes dos esperados (ex: produzir `"Categorização estratégica de itens de compras"` em vez de `"A Matriz de Kraljic"`), o lookup em `resolveExpectedIds` retorna empty e a query vira `inconclusive`. Mitigação:

1. Após o backfill rodar, listar os 4 títulos novos via psycopg.
2. Atualizar `golden.json` `expected_titles` pros novos títulos canônicos.
3. Re-rodar `npm run rag:eval` localmente.
4. Commit dos novos títulos junto com o sub-projeto.

Este passo (passo 9 do critério de saída) é manual e depende do backfill. **CI vai falhar até o realinhamento ser commitado.**

### Smoke manual (atualizar `docs/product/beta-smoke-test.md`)

- Re-uploadar 1 PDF qualquer: confere que `/admin/articles` mostra um título coerente com o conteúdo (não header de journal) e o tema correto.
- Sidebar `/admin/articles`: clicar num tema com 0 artigos → tabela mostra "nenhum artigo neste tema" (ou vazia, como hoje).
- Editar título via lápis no detail pane: persiste após F5.
- Editar tema via dropdown: artigo "muda de pasta" — sidebar contagens atualizam.
- Tentar setar tema fora da taxonomia (dev tools, fetch direto): 400.

### Cobertura total estimada

- Vitest: 257 → ~287 (+30)
- Pytest: 23 (sem mudança)
- Typecheck: zero erros mantido

## Variáveis de ambiente

Sem novas. `OPENAI_API_KEY` (já existe pós-sub-projeto da troca Gemini→OpenAI). `OPENAI_MODEL` opcional, default `gpt-4o-mini` no código.

## Migrations

`supabase/migrations/00000000000010_articles_theme.sql` — adiciona `theme` (not null, default `'Outros'`, check constraint) + `summary` (nullable) + `articles_theme_idx`.

## Critério de saída (tag `auto-classified-library-complete`)

1. `lib/ingest/taxonomy.ts`, `lib/ingest/classify-content.ts`, `scripts/reclassify.ts` implementados e cobertos pelos vitest novos.
2. Migration `0010` aplicada no Supabase de prod (manual via dashboard ou MCP, depois confirmação via psycopg).
3. `lib/ingest/pipeline.ts` chama `classifyContent` em ordem que evita gasto desperdiçado em dedup hits.
4. Endpoint PATCH `/api/admin/articles/[id]` aceita `{ title?, theme? }` com validação zod.
5. `<ThemeSidebar>` renderizado em `/admin/articles`; layout 3-col funciona em desktop ≥1024px.
6. `<ArticleDetail>` mostra `summary`, dropdown de tema, lápis pra título; PATCHs persistem.
7. `npm run articles:reclassify` re-classifica os artigos atuais com sucesso. `psql` mostra todos com `theme` e `title` razoáveis.
8. `golden.json` realinhado com os novos títulos canônicos pós-backfill; `npm run rag:eval` passa com `recall@5 ≥ 0.85`.
9. Smoke manual em `docs/product/beta-smoke-test.md` passa nos 5 itens.
10. CI verde (typecheck + vitest + pytest + rag:eval).
11. CLAUDE.md atualizado com a entrada do sub-projeto 13 + gotchas pertinentes (taxonomia hardcoded em 2 lugares, fallback em ingestão, eval depender de title alignment).

## Riscos e mitigação

| Risco | Probabilidade | Mitigação |
|---|---|---|
| LLM produz títulos genéricos / chatos pros 4 artigos da corpus, eval `recall@5` continua falhando porque `golden.json` espera títulos antigos | alta | Critério de saída #8 explicitamente exige realinhamento do golden. Não tentar fazer o LLM produzir os títulos exatos do golden — em vez disso, atualizar o golden pros títulos que o LLM produzir consistentemente. |
| Taxonomia de 11 temas não cobre algum artigo bem; LLM joga muita coisa em "Outros" | média | "Outros" é fallback aceito. Se um corpus de 50+ artigos tiver >30% em "Outros", revisita-se a taxonomia. Migration nova exigida pra alterar a CHECK constraint. |
| LLM classifica errado de jeito sistemático (ex: confunde Kraljic com SRM) | média | Override admin por dropdown corrige caso a caso. Se virar dor, refinar `THEME_DESCRIPTIONS` no prompt e re-rodar `npm run articles:reclassify` (idempotente). |
| Backfill descontrola se algum row tiver `raw_md` muito grande (>50KB) | baixa | Loop sequencial com try/catch por artigo; falha em 1 não para os outros. Custo OpenAI por artigo segue ≤$0.001. |
| Migration `0010` falha em prod (constraint check rejeita rows existentes) | baixa | Default `'Outros'` garante que rows pré-existentes ficam válidos. Antes de aplicar a migration, double-check via `select count(*) from articles where theme is not null` (deve ser 0 antes). |
| Admin edita tema mas UI não re-conta no sidebar | baixa | `onUpdated` callback no detail pane atualiza o `rows` state em `<ArticlesSplitView>`; o `<ThemeSidebar>` re-renderiza com novo `useMemo` baseado em `rows`. Test cobre. |
| Bulk delete (sub-projeto anterior) interage mal com filtro por tema | baixa | Bulk delete opera sobre `filtered` rows. Após delete, `setRows` remove os ids; sidebar re-conta. Comportamento esperado. |
| Mexer no campo `articles.title` por PATCH quebra alguma view ou lookup | baixa | `articles_with_email` view, RLS policies, `chunks.metadata.source_filename` — nenhum referencia title. `golden.json` referencia títulos por nome no eval; o realinhamento do passo #8 cobre. |
| `extractMetadata` ainda chamado mas seu `title` ignorado é confuso pra leitor | baixa | Comment claro no `pipeline.ts`. Em sub-projeto futuro, `extractMetadata` pode ser refatorado pra retornar só `{ author, language, date }`. |

## Fora de escopo (futuro)

- Sub-temas hierárquicos (Kraljic / Categorização vs Kraljic / Quadrantes).
- Tags livres em adição ao tema fixo (ex: ['Kraljic', 'risco-financeiro']).
- UI pra editar a taxonomia sem migration.
- Drag-and-drop pra reclassificar artigo no sidebar.
- Filtro por tema no chat side (gating retrieval por tema selecionado pelo user).
- Audit trail das edições admin (quem mudou o quê, quando).
- LLM-suggested theme com confidence score; admin aceita/rejeita.
- Embeddings ao nível de artigo (em adição aos chunks) pra busca semântica de "artigos similares".
- Re-classificar automaticamente quando a taxonomia muda.
- Multi-language nos labels da taxonomia (UI EN/PT toggle).
