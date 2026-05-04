# Beta Smoke Test — Manual Checklist

Run this checklist before sending a beta invite. Updated 2026-05-03.

## Prereqs
- [ ] Latest `main` deployed to the beta Vercel environment
- [ ] `APP_ENV=beta` configured in Vercel project env
- [ ] `LANGFUSE_*` keys present in Vercel project env
- [ ] Migration 0007 applied to production Supabase

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

If any item fails, file an issue and fix before sending invites.
