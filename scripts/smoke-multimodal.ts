#!/usr/bin/env tsx
import { config } from 'dotenv';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

config({ path: resolve(process.cwd(), '.env.local') });

import { parsePdfMultimodal } from '@/lib/ingest/multimodal-parse';

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: tsx scripts/smoke-multimodal.ts <pdf-path>');
    process.exit(1);
  }
  const buf = readFileSync(path);
  console.log(`[smoke] file=${path} bytes=${buf.length}`);
  console.log(`[smoke] OPENAI_MODEL=${process.env.OPENAI_MODEL ?? 'gpt-4o-mini (default)'}`);
  console.log(`[smoke] OPENAI_API_KEY present=${!!process.env.OPENAI_API_KEY}`);
  const t = Date.now();
  try {
    const out = await parsePdfMultimodal(buf);
    console.log(`[smoke] success in ${Date.now() - t}ms; blocks=${out.blocks.length}`);
    const counts = out.blocks.reduce<Record<string, number>>((acc, b) => {
      acc[b.type] = (acc[b.type] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`[smoke] kinds=${JSON.stringify(counts)}`);
    console.log(`[smoke] first 3 blocks:`);
    for (const b of out.blocks.slice(0, 3)) {
      console.log(JSON.stringify(b, null, 2).slice(0, 400));
    }
  } catch (err) {
    console.error(`[smoke] FAILED in ${Date.now() - t}ms`);
    if (err instanceof Error) {
      console.error(`[smoke] error.name=${err.name}`);
      console.error(`[smoke] error.message=${err.message}`);
      console.error(`[smoke] error.constructor=${err.constructor?.name}`);
      console.error(`[smoke] error.stack=${(err.stack ?? '').slice(0, 1500)}`);
      // Try to surface SDK-specific fields
      const e = err as unknown as Record<string, unknown>;
      for (const k of ['status', 'statusText', 'code', 'cause']) {
        if (e[k] !== undefined) {
          try {
            console.error(`[smoke] error.${k}=${JSON.stringify(e[k])}`);
          } catch {
            console.error(`[smoke] error.${k}=<unstringifiable>`);
          }
        }
      }
    } else {
      console.error(`[smoke] error (non-Error): ${String(err)}`);
    }
    process.exit(1);
  }
}

main();
