# Projeto: ProcurementGPT — Especialista em Teorias de Compras

## Contexto
Chatbot especialista treinado em centenas de artigos sobre teorias, frameworks e práticas 
de procurement. Produto da IAgentics (www.iagentics.com.br). Audiência: gestores de 
compras brasileiros (PT-BR primário, EN secundário).

## Stack obrigatória
- Next.js 14 App Router + TypeScript strict
- Tailwind + shadcn/ui (tema light/dark)
- Supabase (Postgres + pgvector + Auth + Storage)
- Google Generative AI SDK (Gemini 3.1 Flash Lite (preview) para respostas E classificação)
- Voyage AI para embeddings (`voyage-3-large`, 1024 dims)
- Cohere Rerank 3 para reranking
- Langfuse para observabilidade

## Princípios não-negociáveis
1. **RAG com citações obrigatórias** — toda afirmação técnica cita artigo fonte
2. **Retrieval híbrido** — vetorial + lexical (pt) + reranking, nunca só cosine
3. **Streaming SSE** — resposta começa a aparecer em <2s
4. **Edge Runtime** nas rotas de chat, Node runtime na ingestão
5. **LGPD compliance** — logs sem PII, opt-in para histórico
6. **Custos sob controle** — cache de embeddings, Gemini Flash para todas as chamadas LLM

## Estrutura de pastas
/app
  /api/chat/route.ts          (streaming endpoint)
  /api/ingest/route.ts        (admin: trigger ingestão)
  /(chat)/page.tsx            (UI principal)
  /admin/page.tsx             (gestão de artigos)
/lib
  /rag
    retriever.ts              (busca híbrida + RRF)
    reranker.ts               (Cohere)
    classifier.ts             (Gemini Flash: detecta teoria, intenção)
    prompt-builder.ts         (system prompt + context)
  /db
    supabase.ts
    queries.ts
  /llm
    gemini.ts
    voyage.ts
/components
  /chat (Message, Sources, Input)
  /ui (shadcn)
/scripts
  ingest.py                   (pipeline Python separado)

## Identidade visual
- Branding IAgentics (NÃO use "ProAICircle")
- Cor primária: #0066ff (electric blue)
- Tipografia: Inter
- Logo no header, link pra www.iagentics.com.br

## Comportamento do agente
Persona: "Especialista sênior em procurement com 20 anos de experiência, formação acadêmica 
sólida (Kraljic, Porter, Monczka), didática mas direta, sempre cita fontes."

Estrutura padrão de resposta:
1. Resposta direta (2-3 linhas)
2. Aprofundamento teórico com citações [artigo_X]
3. Aplicação prática (exemplo ou caso)
4. Sugestão de leituras complementares (3 artigos da base)

NÃO inventar teorias. Se não houver fonte na base, dizer explicitamente.

## Variáveis de ambiente
GOOGLE_API_KEY=
VOYAGE_API_KEY=
COHERE_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=

## Comandos
- `npm run dev` — desenvolvimento
- `npm run db:migrate` — aplicar migrations Supabase
- `python scripts/ingest.py --path ./artigos/` — ingerir artigos
- `npm run eval` — rodar evals de qualidade RAG

## O que evitar
- Chunking fixo por N tokens (use semantic chunking)
- Apenas busca vetorial (sempre híbrida)
- Resposta sem citações
- Bibliotecas pesadas no Edge Runtime
- Hardcoded prompts no componente — sempre em /lib/rag/prompt-builder.ts
