"""One-shot migrator: apply every supabase/migrations/*.sql file in order.

Idempotent-ish: each migration uses CREATE ... IF NOT EXISTS where possible, but
this script is intended for a fresh project (verified empty `public` schema).
"""
import os, sys, glob, urllib.parse
from dotenv import load_dotenv

load_dotenv('.env.local')

import psycopg

url = os.environ['NEXT_PUBLIC_SUPABASE_URL']
ref = url.replace('https://', '').split('.')[0]
pw = urllib.parse.quote(os.environ['SUPABASE_DB_PASSWORD'], safe='')
dsn = f'postgresql://postgres:{pw}@db.{ref}.supabase.co:5432/postgres?sslmode=require'

files = sorted(glob.glob('supabase/migrations/*.sql'))
if not files:
    print('no migrations found', file=sys.stderr)
    sys.exit(1)

with psycopg.connect(dsn, autocommit=True) as conn:
    for path in files:
        name = os.path.basename(path)
        with open(path, 'r', encoding='utf-8') as f:
            sql = f.read()
        if not sql.strip():
            print(f'SKIP {name} (empty)')
            continue
        print(f'APPLY {name} ({len(sql)} chars)')
        try:
            with conn.cursor() as cur:
                cur.execute(sql)
        except Exception as e:
            print(f'  FAILED: {e}')
            raise
print('done')
