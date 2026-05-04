# Sub-projeto 10 — Admin Chunks Visibility (design)

**Milestone**: 2 (extensão pós-beta) — single-tenant ainda.
**Tag-alvo**: `admin-chunks-visibility-complete`
**Data**: 2026-05-04
**Origem**: `docs/product/beta-readiness.md` seção "Fila pós-beta — Sub-projeto 10"

## Contexto

Sub-projetos 8 + 9 fecharam o Milestone 2 e o produto está deployado em Railway (`https://procurementgpt-production.up.railway.app/`). O primeiro tester ainda não entrou; já antecipamos uma necessidade de operação: explicar ao tester (e a nós mesmos) **quanto da apostila o RAG efetivamente "viu"** quando ele perguntar e a resposta não bater. Sem essa visibilidade, qualquer miss vira chute sobre se foi retrieval ruim ou ingestão incompleta.

Hoje `/admin/articles` mostra metadata + 20 primeiros chunks (`limit(20)` em `ArticleDetail.tsx:43`) com preview de 200 chars. Falta:

1. Listar **todos** os chunks (sem `limit(20)`).
2. Mostrar **% de conteúdo absorvido** — proxy útil mesmo com aproximação por overlap.
3. **Expand inline** para ler o chunk completo (hoje só primeiros 200 chars).

Decisão de escopo travada em conversa de 2026-05-04: **Opção A** (sum-with-overlap simples, denormalizar `source_chars`), **NÃO** Opção B (offsets exatos com reescrita do chunker).

Descoberta que simplifica vs. plano original: `articles.raw_md text NOT NULL` desde a init migration — todo texto parseado já está persistido. Backfill vira SQL inline na própria migration 0009; o script `npm run ingest:backfill-source-chars` originalmente previsto é desnecessário.

## Princípios

- **Denormalizar deliberadamente.** `source_chars` poderia ser computado on-the-fly via `length(raw_md)`, mas armazenar permite mover `raw_md` para Storage no futuro sem quebrar a UI.
- **HTML nativo > biblioteca.** `<details>`/`<summary>` resolve expand/collapse sem dep nova, com a11y nativa de browser.
- **% aproximado é honesto.** Prefix `≈` + nota visual deixam claro que o valor é overcount intencional. Admin sabe que % > 100% acontece em artigos pequenos.
- **Não tocar em chunking.** `MAX_CHUNK_CHARS = 3200` e `OVERLAP_CHARS = 400` (`lib/ingest/chunker.ts`) ficam intactos. Sub-projeto 10 é puramente visibilidade.

## Escopo

### 1. Modelo de dados — Migration 0009

Arquivo: `supabase/migrations/00000000000009_articles_source_chars.sql`

```sql
-- Sub-projeto 10: source_chars permite calcular % de absorção do texto na UI admin.
-- Backfill é trivial porque raw_md (NOT NULL desde a init) já guarda o texto parseado.

alter table articles add column source_chars int;

update articles set source_chars = length(raw_md) where source_chars is null;

alter table articles alter column source_chars set not null;
```

3 statements; em produção atual (4 artigos), executa em <100ms.

### 2. Pipeline de ingestão

Arquivo: `lib/ingest/pipeline.ts`. Linha única adicionada ao `articles.insert`:

```ts
.insert({
  title: meta.title,
  author: meta.author,
  language: meta.language,
  published_at: meta.date,
  source_chars: parsed.text.length,
  raw_md: parsed.text,
  metadata: { content_hash: hash, source_filename: job.filename },
})
```

`parsed.text` (de `parseFile()`) é o mesmo valor que vai pra `raw_md`. Denormalização explícita.

### 3. UI — `components/admin/ArticleDetail.tsx`

#### Tipo `AdminArticle` ganha `source_chars: number`

#### Header

Logo abaixo do bloco de title/author/language/date, adicionar uma linha:

```tsx
<p className="text-xs text-muted-foreground">
  {chunks.length} chunks · ≈{absorvedPct}% absorvido
</p>
```

onde:
```ts
const totalChunkChars = chunks.reduce((sum, c) => sum + c.content.length, 0);
const absorvedPct = article.source_chars > 0
  ? Math.round((totalChunkChars / article.source_chars) * 100)
  : 0;
```

Edge case: `source_chars = 0` (impossível na prática, mas defensivo) → mostra `0%`.

#### Lista de chunks

- Remover `.limit(20)` do supabase select.
- Cada chunk vira `<details>` HTML nativo:

```tsx
<details
  key={c.id}
  className="bg-muted/40 rounded-md border-l-2 border-border text-xs leading-relaxed"
>
  <summary className="cursor-pointer p-2 hover:bg-muted/60">
    <span className="text-muted-foreground mr-2 tabular-nums">#{c.ord}</span>
    {c.content.slice(0, 200)}
    {c.content.length > 200 && '…'}
  </summary>
  <pre className="mt-2 px-3 pb-3 whitespace-pre-wrap font-mono text-[11px]">
    {c.content}
  </pre>
</details>
```

Mantém o card visual existente; troca div→details. Sem JS adicional para state.

### 4. UI — `components/admin/ArticlesSplitView.tsx`

Atualizar o `.select(...)` da query inicial para incluir `source_chars`:

```ts
.select('id, title, author, language, published_at, metadata, ingested_at, source_chars')
```

Estender o tipo `AdminArticle` (importado de `ArticleDetail.tsx`) com a nova field — fica num só lugar via re-export.

### 5. CLAUDE.md

- Adicionar row do sub-projeto 10 na tabela de Status.
- Sub-projeto 10 row na seção Milestone 2 (ou criar Milestone 2.5 — decisão menor; recomendação: row simples na tabela, sem mudar Milestone 2 que está fechado).
- Gotchas:
  - "Se mover `raw_md` para Storage no futuro, manter `source_chars` no row — UI admin depende dele."
  - "% absorvido pode passar de 100% por causa do overlap (400 chars) — comportamento esperado, prefix `≈` indica aproximação."

### 6. Não-objetivos (deliberado)

- **Backfill script Node** — substituído por SQL inline na migration. Mencionado no spec original; refutado durante exploração ao descobrir que `raw_md NOT NULL`.
- **Tracking de offsets exatos** (Opção B do prompt original) — recusado em favor de simplicidade.
- **Re-parse de arquivos no Storage** — bucket é deletado após ingest, não é fonte; raw_md no DB é a fonte canônica do texto extraído.
- **Mostrar texto original lado-a-lado com chunks** — fora de escopo. Se virar dor, novo sub-projeto com Storage de longo prazo.
- **Highlight de overlap entre chunks consecutivos** — alto custo de UI por baixo valor. Refutado.
- **Paginação ou virtualização** — corpus atual ~30 chunks/artigo; renderizar tudo é OK. Se beta tester ingerir livro grande e a página travar, vira sub-projeto Milestone 3.
- **Outras mudanças em `/admin/articles`** — só chunks + %.

## Mudanças de arquivos (lista completa)

**Novos:**
- `supabase/migrations/00000000000009_articles_source_chars.sql`

**Modificados:**
- `lib/ingest/pipeline.ts` — 1 linha no insert
- `components/admin/ArticleDetail.tsx` — type, header com %, `<details>` para cada chunk, remover `limit(20)`
- `components/admin/ArticlesSplitView.tsx` — `source_chars` no select
- `CLAUDE.md` — row + 2 gotchas

**Possíveis (descobrir durante implementação):**
- `tests/components/admin/ArticleDetail.test.tsx` — se já existe, estender; senão criar do zero

## Testes

**vitest:**
- Render do header mostra `"N chunks · ≈X% absorvido"` com cálculo correto dados `source_chars` e chunks.
- `<details>` começa collapsed (sem atributo `open`).
- Click no `<summary>` expande (testável via `userEvent.click` em jsdom; `<details>` toggles `open` attr).
- `source_chars = 0` mostra `"0%"` em vez de `"NaN%"` (edge case defensivo).
- Limite removido: query gerada não tem `.limit(20)` (mock supabaseBrowser e checar argumentos).

**rag:eval, pytest, build:** sem mudança esperada. CI atual cobre todos.

## Critério de "sub-projeto pronto"

- [ ] Migration 0009 aplicada em prod Supabase
- [ ] `select source_chars from articles where source_chars is null` retorna 0 rows
- [ ] Pipeline grava `source_chars` em ingestões novas (smoke: ingerir 1 PDF, verificar coluna)
- [ ] `/admin/articles` no domínio Railway mostra "N chunks · ≈X% absorvido" no detail pane
- [ ] Cada chunk no detail pane vira `<details>` que expande para mostrar conteúdo completo
- [ ] Lista mostra TODOS os chunks do artigo (sem limit)
- [ ] `npm test` passa
- [ ] `npm run typecheck` zero erros
- [ ] `npm run build` passa (Railway redeploy verde)
- [ ] CLAUDE.md atualizado
- [ ] Tag `admin-chunks-visibility-complete` aplicada
- [ ] Entry "Fila pós-beta — Sub-projeto 10" em `docs/product/beta-readiness.md` marcado como concluído

## Riscos / decisões deferidas

- **% > 100%** em artigos pequenos com overlap proporcional alto. UI exibe cru com prefix `≈`. Admin entende.
- **NOT NULL na migration**: depende do backfill ter populado tudo. Como `raw_md` é NOT NULL desde init, não há row órfão. Se a migration falhar no `set not null`, é sinal de bug em outro lugar — investigar antes de relaxar para nullable.
- **Performance da query sem limit**: ~30 chunks/artigo hoje, sem problema. No futuro se virar dor, paginação. Não defensivo agora.
- **Storage policy**: `raw_md` continua sendo source-of-truth do texto. Se for movido para Storage no futuro, manter `source_chars` no row (denormalizado por design).

## Próximo passo

Após aprovação do spec, invocar `superpowers:writing-plans` para gerar plan executável (TDD + subagent-driven, mesmo padrão dos sub-projetos 8 e 9).
