# Sub-projeto 12 — Multimodal Ingestion (Tables, Flows, Charts)

**Status:** spec
**Data:** 2026-05-07
**Milestone:** pós-Milestone 2 (quality-of-retrieval upgrade; alinhamento com Milestone 3 B2B a confirmar)
**Tag de saída prevista:** `multimodal-ingestion-complete`

## Objetivo

Enriquecer a pipeline de ingestão para preservar tabelas, diagramas/fluxos e gráficos como conteúdo retrievable, em vez de descartá-los junto com o "texto cru". Resultado prático: a query "matriz de Kraljic" recupera o markdown da tabela 2x2 (não um parágrafo perto dela); a query "fluxo S2P" recupera a descrição textual do fluxograma; a query "gasto por categoria" recupera os labels e valores extraídos do gráfico de barras.

A pipeline atual (`lib/ingest/parser.ts` → `pdf-parse@1.1.1` + `mammoth.extractRawText`) extrai apenas texto cru. Tabelas viram strings desalinhadas; diagramas e gráficos somem por completo. Há também um guard explícito que rejeita PDFs com <500 chars de texto extraído (escaneados / OCR-only). Sub-projeto 12 troca o caminho do PDF por uma chamada multimodal ao Gemini (que aceita o PDF nativo e lê tanto texto quanto layout) e estende o chunker para emitir chunks tipados por kind. DOCX ganha extração de tabelas via `mammoth.convertToHtml`. TXT permanece igual.

## Princípios

1. **Retrocompatível com o schema atual** — `chunks.metadata` é JSONB, então `kind`/`page`/`caption` entram via metadata sem migration nova. `chunks` table inalterada na estrutura.
2. **Fail-soft em camadas** — se a chamada multimodal falhar (timeout, rede, JSON inválido após retry), pipeline cai para o parser texto-only atual; o job preserva `metadata.parser='text-only-fallback'` para auditoria. Ingestão nunca falha por causa do path multimodal.
3. **Sem nova dependência de runtime** — `@google/genai` já é usado em condenser/classifier/followups; reaproveita. Sem LlamaParse, sem Docling, sem Marker, sem render PDF→PNG.
4. **Retrieval inalterado** — chunks novos (kind=`table`, kind=`figure`) entram no mesmo fluxo de embedding + RPC vetorial + FTS + RRF + rerank. O classifier não filtra por kind; o reranker não trata diferente. Ganho automático: chunks de tabela rankeiam bem em queries que mencionam termos da tabela porque o markdown contém os labels.
5. **YAGNI** — sem render visual de figuras no UI, sem OCR adicional via Tesseract, sem reprocessamento automático em massa, sem retrieval especializado por kind, sem hover/preview de tabelas no chat. Tudo isso pode ser sub-projeto futuro se a métrica de retrieval pedir.
6. **Eval-gated** — golden set ganha 5 pares focados em conteúdo estruturado; CI gate `recall@5 ≥ 0.85` mantido. Mudança de pipeline sem auditoria de retrieval é não-aceita.

## Arquitetura

```
POST /api/admin/ingest/run/[jobId] (Node, fire-and-forget)
  ↓
runPipeline(jobId)
  ↓
download blob from Storage
  ↓
parseSource(buf, mime, filename)               ← novo dispatcher
  ├─ PDF  → parsePdfMultimodal(buf)            ← novo módulo (Gemini multimodal)
  │            ├─ sucesso → { blocks: Block[], pageCount }
  │            └─ erro    → fallback para parsePdfTextOnly(buf) → { text, pageCount }
  ├─ DOCX → parseDocxWithTables(buf)           ← novo módulo (mammoth.convertToHtml + table → markdown)
  │            └─ { blocks: Block[] }
  └─ TXT  → parseTxt(buf)                      ← passa por { text }
  ↓
chunker:
  - se temos `blocks`: chunkBlocks(blocks)     ← novo path
  - se temos `text` (TXT ou fallback PDF):     chunkText(text)
  ↓
metadata + sha256 + dedup (inalterado)
  ↓
articles insert (inalterado, exceto: metadata.parser registrado)
  ↓
embeddings (inalterado, batches de 16)
  ↓
chunks insert com metadata.kind / metadata.page / metadata.caption
```

### Por que multimodal nativo (Gemini Files API) em vez de página-por-página

| Opção | Custo/artigo (30 págs) | Latência | Infra | Implementação |
|---|---|---|---|---|
| **A.** Render página → PNG → 30 chamadas Gemini multimodal | $0.30–0.90 | 1–2 min | render PDF→PNG (pdfjs-dist + canvas/sharp no Node) | complexa |
| **B.** LlamaParse / Docling / Marker | $0.10–0.45 ou GPU | 30s–vários min | API paga ou Python ML stack no Railway | infra nova |
| **C. ✅ Gemini multimodal sobre PDF nativo (1 call)** | **~$0.01–0.05** | **30–90s** | **zero** | **adopta** |

`@google/genai` aceita PDF como `inlineData` (base64) ou via Files API (upload prévio). Para PDFs <20 MB, inline é mais simples; para PDFs maiores ou repetidos, Files API. Os artigos da corpus atual (4) e os esperados pra Milestone 3 ficam abaixo de 20 MB com folga, então **inline** é o caminho default; se um PDF estourar (≥20 MB), pipeline cai pro Files API automaticamente.

## Componentes

### Backend — novos módulos

| Arquivo | Responsabilidade |
|---|---|
| `lib/ingest/types.ts` | Adiciona `Block` discriminated union (`text` \| `table` \| `figure`), `ParsedSource = { blocks: Block[]; pageCount?: number }` ou `{ text: string; pageCount?: number }`. |
| `lib/ingest/multimodal-parse.ts` | `parsePdfMultimodal(buf: Buffer): Promise<{ blocks: Block[]; pageCount: number }>`. Constrói prompt instrutivo + zod schema, chama `@google/genai` com `responseMimeType: 'application/json'` e `responseSchema`, valida output, retorna blocks. Hard timeout 120s via AbortController. Retry 1x em caso de zod fail com instrução adicional. |
| `lib/ingest/docx-parse.ts` | `parseDocxWithTables(buf: Buffer): Promise<{ blocks: Block[] }>`. Usa `mammoth.convertToHtml`, parseia HTML resultante (cheerio ou regex simples), extrai `<table>` como markdown via helper `htmlTableToMarkdown`, intercala blocks de texto e tabelas na ordem do documento. Sem captions automáticas no DOCX (mammoth não preserva legendas adjacentes ao table). |
| `lib/ingest/parse-source.ts` | Dispatcher por mime: PDF → multimodal (com fallback), DOCX → tables-aware, TXT → trivial. Encapsula a decisão de fallback. |
| `lib/ingest/html-table.ts` | Utility puro: `htmlTableToMarkdown(html: string): string`. Lê `<table>`, escapa `\|` e quebras de linha em células, emite tabela markdown bem-formada (header divider). Implementação default: regex sobre o HTML produzido pelo `mammoth.convertToHtml` (output bem comportado: `<table><tr><td>...</td></tr></table>` sem CSS nem atributos exóticos). Se durante o execute-phase a regex falhar em DOCX reais, adiciona-se `node-html-parser` como dep nova (~30 KB) — decisão diferida pro plan. |

### Backend — módulos modificados

| Arquivo | Mudança |
|---|---|
| `lib/ingest/parser.ts` | Renomeado conceitualmente: vira `parsePdfTextOnly` (export adicional, mantém o atual `parseFile` como wrapper de retrocompatibilidade marcado `@deprecated` para o Python ingest legacy). Logic atual permanece intacta — é o fallback. |
| `lib/ingest/chunker.ts` | Mantém `chunkText`. Adiciona `chunkBlocks(blocks: Block[]): Array<{ content: string; metadata: { kind, page?, caption? } }>`. Text blocks contíguos são agrupados como hoje (paragraph + sliding window 3200/400). Cada table block vira 1 chunk dedicado: `caption + "\n\n" + markdown` (sem split mesmo se passar de 3200 — tabelas quebradas perdem semântica; aceitamos). Cada figure block vira 1 chunk: `caption + "\n\n" + description`. |
| `lib/ingest/pipeline.ts` | Substitui `parseFile` por `parseSource`. Substitui `chunkText(parsed.text)` por: `parsed.blocks ? chunkBlocks(parsed.blocks) : chunkText(parsed.text)`. Insere `metadata.kind` etc. em cada chunk row. Insere `metadata.parser: 'multimodal' \| 'text-only' \| 'text-only-fallback'` no article row. |
| `lib/llm/gemini.ts` | Estende para aceitar `inlineData: { mimeType: 'application/pdf', data: base64 }` no input. Reusa `responseMimeType: 'application/json'` + `responseSchema` se já houver helper; senão adiciona overload pequeno. |

### Frontend — Admin UI

| Arquivo | Mudança |
|---|---|
| `components/admin/ArticleDetail.tsx` | Cada `<details>` de chunk ganha badge à esquerda do "Chunk N": `text` (cinza), `table` (azul), `figure` (roxo), e número de página em superscript se disponível (`p.5`). Layout mantido. |

### Sem alteração

- `lib/rag/*` — retriever, classifier, reranker, prompt-builder, condenser, runRag. Chunks novos entram pelo mesmo caminho.
- `app/api/chat/route.ts` — anotações SSE, sources, traces. O `sources` array já carrega `chunk.content` truncado, então tabelas/figuras aparecem nele naturalmente (mas o UI atual oculta esse array, então sem impacto visual no chat).
- `useChat`, `useChatSessionsRemote`, schema `sessions`. Nenhuma mudança.
- Eval (`scripts/eval/run.ts`) — só ganha 5 pares novos no JSON; lógica idêntica.
- CI gate `recall@5 ≥ 0.85`.
- `scripts/ingest.py` (Python legacy) — fica como está. Se um sub-projeto futuro quiser paridade Python↔TS, faz separado. Sub-projeto 12 só mexe no path Node usado pelo `/admin/ingest`.

## Data flow

### Bloco multimodal — system prompt (PT, idioma fixo no prompt)

```
Você é um extrator estruturado de artigos acadêmicos sobre procurement.
Receba o PDF e retorne um array de blocos representando o conteúdo do
documento NA ORDEM EM QUE APARECE. Cada bloco é um de três tipos:

- text: parágrafo ou seção corrida. Junte parágrafos relacionados.
- table: qualquer tabela. Devolva o conteúdo como Markdown bem formado
  (linhas separadas por |, header divider com ---). Capture a legenda
  da tabela (ex: "Tabela 2: Matriz de Kraljic") em "caption".
- figure: diagrama, fluxograma, gráfico, ou qualquer figura visual NÃO
  textual. Em "description", produza 80–250 palavras descrevendo o que
  a figura mostra (eixos do gráfico, valores legíveis, nós do
  fluxograma e relações, elementos do diagrama). Em "caption", o
  rótulo (ex: "Figura 3: Fluxo de aprovação"). Em "figureKind", uma
  de: "flow" (fluxograma, processo), "chart" (gráfico com dados),
  "diagram" (diagrama conceitual sem dados).

Regras:
- NÃO invente conteúdo. Se uma figura é ilegível, descreva o que vê
  ("gráfico de barras com 5 categorias, valores não legíveis").
- NÃO inclua headers/footers/numeração de página repetidos.
- NÃO inclua TOC (sumário).
- Page é o número da página (1-indexed) onde o bloco começa.
- Output JSON estrito conforme schema.
```

### Schema zod do output

```ts
const BlockSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    page: z.number().int().min(1),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal('table'),
    page: z.number().int().min(1),
    markdown: z.string().min(1),
    caption: z.string().optional(),
  }),
  z.object({
    type: z.literal('figure'),
    page: z.number().int().min(1),
    description: z.string().min(20),
    caption: z.string().optional(),
    figureKind: z.enum(['flow', 'chart', 'diagram']),
  }),
]);

const MultimodalOutputSchema = z.object({
  blocks: z.array(BlockSchema).min(1),
});
```

### chunkBlocks comportamento

```ts
chunkBlocks(blocks) → Array<ChunkRow>

ChunkRow = {
  content: string;
  metadata: {
    kind: 'text' | 'table' | 'figure';
    page?: number;
    caption?: string;
    figureKind?: 'flow' | 'chart' | 'diagram';
  }
}
```

Algoritmo:
1. Itera os blocks na ordem.
2. **Text contíguo**: enquanto blocks[i].type === 'text', acumula em buffer string (separado por `\n\n`). Ao atingir 3200 chars OU ao topar com bloco não-text, flush via lógica idêntica ao `chunkText` atual (paragraph-aware, 3200 max, 400 overlap se split necessário). Cada chunk resultante grava `metadata.kind = 'text'` e `metadata.page = página do primeiro paragraph do buffer`.
3. **Table**: emite imediatamente como 1 chunk: `content = (caption ? caption + "\n\n" : "") + markdown`. `metadata.kind='table'`, `metadata.page`, `metadata.caption`. Sem split mesmo se >3200 (caso raro; aceitamos).
4. **Figure**: emite imediatamente como 1 chunk: `content = (caption ? caption + "\n\n" : "") + description`. `metadata.kind='figure'`, `metadata.page`, `metadata.caption`, `metadata.figureKind`.

### Reprocessamento dos 4 artigos atuais

`runPipeline` continua chamando `deleteFromIngestBucket(job.storage_path)` em sucesso (comportamento atual). Sub-projeto 12 NÃO adiciona flag de preservação de fonte — significa que reprocessar os 4 artigos atuais exige re-upload manual do PDF original pelo admin via `/admin/ingest`.

Workflow concreto pro backfill:
1. No `/admin/articles`, admin deleta os 4 artigos atuais (cascade já remove chunks).
2. No `/admin/ingest`, admin re-uploada cada PDF. Os PDFs originais precisam estar disponíveis localmente — o pipeline atual deleta o blob do Storage após sucesso (`deleteFromIngestBucket` em `runPipeline`), então o bucket não tem cópia. Sub-projeto 12 não tenta resolver "o admin perdeu o PDF original".
3. Pipeline novo roda no path multimodal; chunks novos com kind correto.

**Decisão deliberada:** sub-projeto 12 NÃO automatiza um "reprocess all" porque (a) corpus atual = 4 artigos, (b) o gain é detectável manualmente no `/admin/articles`, (c) automação de reprocess+swap+rollback é complexidade que cabe num sub-projeto separado se a corpus crescer. Adicionar flag `keep_source` na tabela `ingestion_jobs` precisaria de migration 0010 só para servir esse caso de borda — não vale agora.

## Erro e edge cases

| Caso | Comportamento |
|---|---|
| Gemini multimodal lança rede / 5xx | catch → log → `parsePdfTextOnly` (parser atual, retorna `{ text, pageCount }`) → dispatcher detecta `text` em vez de `blocks` → `chunkText` segue. `articles.metadata.parser='text-only-fallback'` registrado para auditoria. Stage do job permanece `parsing` durante o fallback (sem stage novo). |
| Gemini retorna JSON que não passa zod | retry 1x com instrução: "Sua resposta anterior não bateu com o schema. Retorne EXATAMENTE este shape: {...}". Se segundo retorno falhar, fallback texto-only. |
| Gemini retorna `blocks: []` (vazio) | trata como falha → fallback texto-only. Artigo sem blocos provavelmente é PDF corrompido ou totalmente em imagens ilegíveis. |
| PDF >20 MB (excede inline base64 limit) | upload via Files API: `client.files.create({ file: { bytes: buf, mimeType: 'application/pdf' } })`, depois prompt referencia o file. Files API limpa após 48h, então pipeline não precisa cleanup. |
| PDF com >1000 páginas | rejeita upfront com erro claro `"PDF muito grande (>1000 páginas, limite Gemini Files)"`. Job vira `error` com essa mensagem. (Improvável no corpus de procurement.) |
| Gemini timeout 120s | AbortController dispara → fallback texto-only. |
| DOCX com tabela aninhada | mammoth converte tabela aninhada como tabela inline; html-to-md trata como string sem tentar entender hierarquia. Aceitável v1. |
| DOCX sem tabelas | `convertToHtml` ainda funciona; html-to-md emite só blocks de texto; comportamento idêntico ao atual. |
| TXT com markdown table embutida | TXT segue `chunkText`. Não tenta detectar tabelas no TXT. (YAGNI.) |
| OCR-only PDF (totalmente escaneado, sem text layer) | Gemini multimodal lê visualmente — provavelmente extrai blocks corretamente. Guard atual <500 chars **só dispara no fallback**. No path multimodal, o guard equivalente é "blocks: [] → fallback → guard <500 → erro". |
| Reprocesso parcial: artigo já existe (dedup hit) | inalterado — pipeline atual já faz dedup por sha256 antes de chamar parser. Não há work duplicado. |

## Observabilidade

Não estende Langfuse (ingestão não é traced no Langfuse hoje — só `/api/chat` é, sub-projeto 7). Ingestão usa `console.error`/`console.warn` + `ingestion_jobs.error_message` como hoje. Adicionar Langfuse em ingestão é outro sub-projeto se quisermos.

Logs novos:
- `console.warn` quando multimodal falha e cai pro fallback (com filename, message).
- `console.warn` quando zod falha após retry.
- `console.info` no fim do pipeline com counts: `{ articleId, parser, textBlocks, tableBlocks, figureBlocks, totalChunks }`.

## Custo e latência (estimativa)

Gemini 3.1 Flash Lite preview pricing (atual):
- Input: ~$0.10/1M tokens (texto), $0.30/1M tokens equivalentes (PDF multimodal pages)
- Output: ~$0.40/1M tokens

PDF acadêmico de 30 páginas:
- ~50K input tokens (PDF nativo, pages contam como tokens equivalentes a ~250-400 cada)
- ~15K output tokens (blocks JSON, ~500 tokens por bloco × 30 blocks médios)
- **~$0.020/artigo**

100 artigos: ~$2 + 1–2h ingestão (sequencial).

Latência por artigo: 30–90s (single call multimodal); enquadra-se confortavelmente no padrão fire-and-forget atual em Railway.

## Testing

### Vitest novos (~30 testes)

`lib/ingest/multimodal-parse.test.ts` (~10)
- Sucesso: mock `@google/genai` retornando JSON válido com 1 text + 1 table + 1 figure → `parsePdfMultimodal` retorna 3 blocks na ordem correta com tipos certos.
- Sucesso: blocks contém 5 figures com diferentes `figureKind` → todos preservados.
- Falha de rede: mock lança Error → throws (caller faz fallback, não esse módulo).
- Zod fail no primeiro call → retry com prompt adicional → segundo call passa → retorna blocks.
- Zod fail em ambos os calls → throws.
- Output `blocks: []` → throws com mensagem específica.
- AbortController 120s → throws timeout (vitest fake timers).
- PDF >20 MB → usa Files API (mock `client.files.create`), confere que prompt referencia o file ID.
- PDF >1000 páginas → rejeita upfront (mock pdfjs metadata leitura ou simplesmente `buf.length` proxy se simples).
- Headers/footers/page-numbers absent no output (testa via prompt — confere que prompt instrui).

`lib/ingest/docx-parse.test.ts` (~6)
- DOCX sem tabela → 1 text block com conteúdo concatenado.
- DOCX com 1 tabela 3x3 no meio → text + table + text na ordem; markdown da tabela tem header divider e 3 colunas.
- DOCX com 2 tabelas → 2 table blocks.
- Tabela com `|` em célula → escapado como `\|`.
- Tabela com quebra de linha em célula → vira espaço.
- DOCX vazio → throws com mensagem clara.

`lib/ingest/html-table.test.ts` (~5)
- `<table>` simples 2x2 → markdown 2x2 com divider.
- `<table>` sem `<thead>` → primeira `<tr>` vira header.
- Célula com `|` → escapado.
- Célula com `<br>` → vira espaço.
- Tabela aninhada (table dentro de td) → string textual da tabela aninhada, sem tentar reformatar.

`lib/ingest/chunker.test.ts` (estender — ~5)
- `chunkBlocks` com 1 text block longo → chunks paragraph-aware idênticos a `chunkText` para mesmo input.
- `chunkBlocks` com 1 table block → 1 chunk com `metadata.kind='table'` e content = caption + markdown.
- `chunkBlocks` com 1 figure block → 1 chunk com `metadata.kind='figure'`, `metadata.figureKind`.
- `chunkBlocks` ordering: text + table + text + figure + text → 4 chunks (último text agrupa último parágrafo).
- `chunkBlocks` com text que excede 3200 → split com overlap 400, todos com `kind='text'`.

`lib/ingest/pipeline.test.ts` (estender — ~4)
- Pipeline com mock `parsePdfMultimodal` retornando blocks → chunks inseridos com metadata.kind correto.
- Pipeline com mock `parsePdfMultimodal` lançando → fallback para `parsePdfTextOnly`, article ganha `metadata.parser='text-only-fallback'`.
- Pipeline com DOCX → chama `parseDocxWithTables`, não chama multimodal.
- Pipeline com TXT → chama `parseTxt`, não chama multimodal nem mammoth.

### Pytest

Sem mudança. `scripts/ingest.py` não é tocado.

### Eval

`scripts/eval/golden.json` ganha 5 pares novos (todos no idioma PT, ângulo "structured-content"):

```json
{ "query": "como é estruturada a matriz de Kraljic?", "expected_chunks": ["...kraljic-matrix-table-chunk-id..."] }
{ "query": "quais são os 4 quadrantes da matriz de Kraljic?", "expected_chunks": [...] }
{ "query": "qual é o fluxo do processo source-to-pay?", "expected_chunks": [...] }
{ "query": "quem são os stakeholders no diagrama de procurement?", "expected_chunks": [...] }
{ "query": "qual a distribuição de gastos por categoria no artigo X?", "expected_chunks": [...] }
```

(IDs reais ficam pendentes até reprocessar os 4 artigos atuais; o spec instrui criar os pares como parte do plano de execução.)

CI gate (`recall@5 ≥ 0.85`) inalterado. Sub-projeto entrega só quando o gate passa **incluindo os 5 pares novos**.

### Smoke manual (atualizar `docs/product/beta-smoke-test.md`)

- Re-ingerir 1 PDF com tabela conhecida (Kraljic): `/admin/articles` mostra ≥1 chunk com badge `table`, conteúdo mostra markdown da tabela com células corretas.
- Re-ingerir 1 PDF com fluxograma: `/admin/articles` mostra ≥1 chunk `figure` com description coerente.
- No `/chat`, query "matriz de Kraljic" recupera resposta que reflete os labels da tabela (rerank rankeou o chunk-tabela alto).
- Tipo de erro: ingerir PDF corrompido → job vira `error` com mensagem; ou pipeline cai no fallback texto-only e completa com `metadata.parser='text-only-fallback'`.
- DOCX com tabela: `/admin/articles` mostra chunk `table`.

### Cobertura total estimada

- Vitest: 203 → ~233 (+30)
- Pytest: 23 (sem mudança)
- Typecheck: zero erros mantido

## Variáveis de ambiente

Sem novas. Reusa `GOOGLE_API_KEY` e `GEMINI_MODEL`.

(Opcional v2: `INGEST_PARSER=multimodal|text-only|auto` — kill switch para forçar texto-only se Gemini multimodal causar regressão; default `auto`. v1 entrega só `auto` hardcoded.)

## Migrations

Sem migration nova. `chunks.metadata` é JSONB; `kind`/`page`/`caption`/`figureKind` entram como keys soltas. `articles.metadata.parser` idem.

(Sub-projeto 13 ou futuro pode adicionar `chunks.kind` como coluna real para indexar — mas v1 não precisa: vamos pelo metadata jsonb e medimos se filtragem por kind vira hot path.)

## Critério de saída (tag `multimodal-ingestion-complete`)

1. `lib/ingest/multimodal-parse.ts`, `lib/ingest/docx-parse.ts`, `lib/ingest/html-table.ts`, `lib/ingest/parse-source.ts` implementados e cobertos pelos vitest novos.
2. `lib/ingest/chunker.ts` exporta `chunkBlocks` em paridade comportamental com `chunkText` para text contíguo.
3. `lib/ingest/pipeline.ts` usa `parseSource` + dispatch text-vs-blocks; fallback testado.
4. Os 4 artigos atuais re-ingeridos via `/admin/ingest` (delete prévio em `/admin/articles`, depois re-upload do PDF original); cada artigo tem ≥1 chunk não-text se o PDF original tiver tabelas/figuras.
5. Golden set ganha 5 pares novos (queries de tabela/fluxo/gráfico). `npm run rag:eval` passa com `recall@5 ≥ 0.85` no set expandido.
6. `/admin/articles` mostra badges `text`/`table`/`figure` + número de página.
7. Smoke manual em `docs/product/beta-smoke-test.md` passa nos 5 itens.
8. CI verde (typecheck + vitest + pytest + rag:eval).
9. CLAUDE.md atualizado com a entrada do sub-projeto 12 e gotchas pertinentes (regra de fallback, regra de não persistir source-PDF por default, custo médio por artigo, comportamento de PDFs >20 MB / >1000 páginas).

## Riscos e mitigação

| Risco | Probabilidade | Mitigação |
|---|---|---|
| Gemini hallucina valores numéricos em gráficos (chart kind) | média | Description é texto, não dado estruturado. Prompt instrui "se ilegível, diga 'valores não legíveis'". Eval pair "qual a distribuição de gastos" mede recall, não precision numérica. Se virar dor real, sub-projeto futuro extrai dados de gráficos via vision dedicada. |
| Custo escala mal se corpus passar para milhares de artigos | baixa | $0.02/artigo × 1000 = $20. Mesmo 10K artigos = $200 one-time. Trivial. |
| Gemini Flash Lite preview muda contrato de structured output | baixa | Tudo passa por validação zod com retry. Falha cai em fallback texto-only; pipeline continua funcionando degraded. |
| PDFs com layout muito atípico (multicoluna acadêmica densa) confundem o modelo | média | Prompt instrui ordem de leitura. Se virar problema sistêmico, adiciona uma instrução "leia coluna por coluna" no prompt. v1 aceita alguma reordenação. |
| `chunks.metadata` jsonb sem índice → queries por kind ficam lentas | baixa | Sub-projeto 12 não filtra por kind no retrieval. Se um sub-projeto futuro precisar, adiciona índice GIN ou coluna real então. |
| Reprocessar 4 artigos descarta histórico de chunks (sources antigas em conversas viram dangling) | baixa | A relação é via `chunks.id`/`articles.id`. Conversas guardam só o array `sources` no JSONB do turno (com snapshot do título/snippet). Apagar/recriar chunks não quebra UI. Eval golden refs precisam ser atualizadas — combina com item 5 do critério de saída. |
| Mammoth html-to-md emite tabela mal-formada em DOCX exótico | baixa | Eval cobre PDF principalmente; DOCX é nicho. Falha do html-to-md cai em try/catch → reverte ao texto cru via `extractRawText` (fallback dentro do path DOCX). |
| Retry duplica custo Gemini quando JSON falha | baixa | Retry só dispara em zod fail (raro com structured output). Hard cap 1 retry. |
| Admin perdeu o PDF original e precisa reprocessar | baixa | Storage limpa o blob após sucesso (comportamento atual). Para o backfill dos 4 artigos atuais, o admin precisa ter o PDF localmente. Se virar dor, sub-projeto futuro adiciona migration + flag `keep_source` em `ingestion_jobs`. |

## Fora de escopo (futuro)

- Reprocessamento automático em massa via UI (`/admin/articles` botão "reprocess all").
- Render visual das figuras na UI admin (preserva PNG, mostra thumbnail).
- OCR via Tesseract para PDFs em que Gemini multimodal falha de visão.
- Extração estruturada de dados de gráficos (chart kind ganha `data: { x: number, y: number }[]` em vez de só description).
- Coluna real `chunks.kind` + índice; filtragem por kind no retriever ou reranker.
- Pipeline Python (`scripts/ingest.py`) ganhar paridade multimodal.
- Langfuse instrumentation para ingestão.
- Detecção e dedup de tabelas que aparecem em múltiplos artigos (review consolidado).
- DOCX com diagramas embutidos via vision (raros).
- Chips de "ver tabela completa" no chat quando o assistant mencionar uma tabela retrieved.
