# Beta Smoke Test — Manual Checklist

Run this checklist before sending a beta invite. Updated 2026-05-04.

## Prereqs
- [ ] Latest `main` deployed to the beta Railway service
- [ ] `APP_ENV=beta` configured in Railway service variables
- [ ] `LANGFUSE_*` keys present in Railway service variables
- [ ] Migration 0007 (`rate_limit_events` + `check_rate_limit` RPC) applied to production Supabase
- [ ] Migration 0008 (`message_feedback` + RLS) applied to production Supabase
- [ ] Railway domain (`https://<service>.up.railway.app`) added to Supabase Auth → Site URL + Redirect URLs
- [ ] Same Railway domain added as authorized redirect URI in Google OAuth Console (`/auth/callback`)

## Auth
- [ ] `/login` email + senha login works
- [ ] `/login` Google OAuth login works
- [ ] `/admin/users` invite sends a magic link; clicking it logs the new user in
- [ ] `/forgot-password` sends a reset email; setting new password works; login with new password works

## Chat — desktop
- [ ] `/chat` loads with empty state and 4 suggestion cards
- [ ] Clicking a suggestion fills the composer
- [ ] Sending a message starts streaming inside 3 s
- [ ] Stop button cancels mid-stream
- [ ] Refreshing during streaming reloads the conversation cleanly (no broken state)
- [ ] Theme toggle: system / light / dark all render correctly
- [ ] Markdown (lists, bold, headings) renders correctly
- [ ] Sidebar: switching between sessions remounts cleanly; deleting works

## Chat — mobile
- [ ] `/chat` on a mobile viewport (DevTools or real device) shows the hamburger
- [ ] Drawer opens and closes
- [ ] Composer is reachable above the keyboard

## Failure modes
- [ ] Delete the `sb-*` cookies in DevTools mid-session, send a message → user is redirected to `/login`
- [ ] Send 11 messages within 60 s → toast "Limite de mensagens atingido…" appears; 11th message does not stream
- [ ] Ask "o que você sabe sobre origami?" → response explicitly says it has no source on the topic (no hallucinated frameworks)

## Admin
- [ ] As admin, `/admin/{users,articles,ingest}` all load
- [ ] As non-admin, `/admin` returns 404
- [ ] Ingest a small PDF; job moves through queued → parsing → chunking → embedding → done

## Observability
- [ ] Latest message appears as a `chat.turn` trace in Langfuse with tag `env:beta`
- [ ] Trace shows 6 nested spans (condense, classify, retrieve, rerank, build-prompt, generate)
- [ ] Rerank span shows `top1Score` and `kept` fields
- [ ] An origami-style query trace carries the `low-confidence` tag

## Feedback (sub-projeto 9)
- [ ] Click 👍 on an assistant message → `aria-pressed=true` and a row appears in `select * from message_feedback where rating='up'` (Supabase SQL editor)
- [ ] Click 👎 → textarea opens; submit a comment → row updated with `rating='down'` and `comment` populated
- [ ] Reload the page → previously-rated message shows the rating active
- [ ] Langfuse trace shows a `user-feedback` score with value `1` or `-1`
- [ ] Header "feedback geral" icon opens an email draft to the configured address

## Follow-up chips (sub-projeto 11)
- [ ] Após uma resposta fundamentada (ex.: "O que é a matriz de Kraljic?"), 3 chips aparecem abaixo da resposta dentro de ~1 s do fim do stream
- [ ] Click num chip envia o texto como nova mensagem do usuário; chips do turno anterior somem assim que o novo turno renderiza
- [ ] Após pergunta fora da base ("o que é blockchain?"), aparecem chips de reformulação (ex.: matriz de Kraljic, TCO, modelos de Cox/Cousins) — não chips genéricos sobre blockchain
- [ ] Stop button durante streaming → chips NÃO aparecem para aquele turno
- [ ] Tema dark e light: chips legíveis em ambos
- [ ] Mobile (largura ≤ 480 px): chips wrappam em múltiplas linhas, área de click ≥44 px de altura
- [ ] Langfuse: trace tem span `suggest-followups` com `mode=deepen` ou `mode=redirect` e `count` correspondente
- [ ] Quando o helper retorna `[]` (zod falha, timeout 3 s, etc.), trace ganha tag `followups:empty` e turno principal completa normalmente

## Sub-projeto 12 — Multimodal Ingestion

- [ ] Re-ingerir 1 PDF com tabela conhecida (ex: Kraljic): `/admin/articles` mostra ≥1 chunk com badge azul `table`; abrir o chunk mostra markdown da tabela com células corretas.
- [ ] Re-ingerir 1 PDF com fluxograma: `/admin/articles` mostra ≥1 chunk com badge roxo `figure`; abrir mostra description coerente do fluxo.
- [ ] No `/chat`, query "matriz de Kraljic" recupera resposta que reflete os labels da tabela (não só parágrafos próximos).
- [ ] Erro path: ingerir PDF corrompido → ou o job vira `error` com mensagem clara, ou completa com `articles.metadata.parser='text-only-fallback'` (verificar via Supabase dashboard).
- [ ] DOCX com tabela: `/admin/articles` mostra chunk `table`; markdown bem-formado com header divider.

If any item fails, file an issue and fix before sending invites.
