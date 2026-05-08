"""Create the ingest-uploads bucket + admin-only path-scoped RLS policies.

Equivalent of what was done manually in the dashboard for the original project.
Idempotent: checks for existing bucket/policies before creating.
"""
import os, urllib.parse
from dotenv import load_dotenv

load_dotenv('.env.local')
import psycopg

url = os.environ['NEXT_PUBLIC_SUPABASE_URL']
ref = url.replace('https://', '').split('.')[0]
pw = urllib.parse.quote(os.environ['SUPABASE_DB_PASSWORD'], safe='')
dsn = f'postgresql://postgres:{pw}@db.{ref}.supabase.co:5432/postgres?sslmode=require'

BUCKET = 'ingest-uploads'

with psycopg.connect(dsn, autocommit=True) as conn:
    with conn.cursor() as cur:
        # 1. Bucket (private)
        cur.execute(
            """
            insert into storage.buckets (id, name, public, file_size_limit)
            values (%s, %s, false, 104857600)
            on conflict (id) do nothing
            returning id
            """,
            (BUCKET, BUCKET),
        )
        row = cur.fetchone()
        print(f'bucket: {"created" if row else "already exists"} ({BUCKET})')

        # 2. RLS policies on storage.objects (admin-only, path-scoped to auth.uid())
        # The pipeline uploads to <user_id>/<filename> — see lib/db/storage.ts
        # Drop any pre-existing same-named policies first (idempotency)
        for pname in (
            'ingest_uploads_admin_select',
            'ingest_uploads_admin_insert',
            'ingest_uploads_admin_update',
            'ingest_uploads_admin_delete',
        ):
            cur.execute(f'drop policy if exists {pname} on storage.objects')

        # CREATE POLICY can't accept parameter placeholders; inline the literal.
        # BUCKET is a constant we control, so no SQL-injection risk.
        b = BUCKET.replace("'", "''")
        cur.execute(
            f"""
            create policy ingest_uploads_admin_select on storage.objects
              for select to authenticated
              using (
                bucket_id = '{b}'
                and is_admin()
                and (storage.foldername(name))[1] = auth.uid()::text
              )
            """
        )
        cur.execute(
            f"""
            create policy ingest_uploads_admin_insert on storage.objects
              for insert to authenticated
              with check (
                bucket_id = '{b}'
                and is_admin()
                and (storage.foldername(name))[1] = auth.uid()::text
              )
            """
        )
        cur.execute(
            f"""
            create policy ingest_uploads_admin_update on storage.objects
              for update to authenticated
              using (
                bucket_id = '{b}'
                and is_admin()
                and (storage.foldername(name))[1] = auth.uid()::text
              )
              with check (
                bucket_id = '{b}'
                and is_admin()
                and (storage.foldername(name))[1] = auth.uid()::text
              )
            """
        )
        cur.execute(
            f"""
            create policy ingest_uploads_admin_delete on storage.objects
              for delete to authenticated
              using (
                bucket_id = '{b}'
                and is_admin()
                and (storage.foldername(name))[1] = auth.uid()::text
              )
            """
        )
        print('storage.objects policies: 4 created (select/insert/update/delete, admin + path-scoped)')

        cur.execute("select id, public, file_size_limit from storage.buckets where id = %s", (BUCKET,))
        print('verify:', cur.fetchone())
