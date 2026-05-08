"""Create admin auth.users row + promote to admin role via service role."""
import os, sys, json, urllib.request, urllib.error, urllib.parse
from dotenv import load_dotenv

load_dotenv('.env.local')

EMAIL = 'rgoalves@gmail.com'
PASSWORD = sys.argv[1] if len(sys.argv) > 1 else None
if not PASSWORD:
    print('usage: bootstrap_admin.py <password>', file=sys.stderr)
    sys.exit(1)

base_url = os.environ['NEXT_PUBLIC_SUPABASE_URL']
srv = os.environ['SUPABASE_SERVICE_ROLE_KEY']

body = json.dumps({
    'email': EMAIL,
    'password': PASSWORD,
    'email_confirm': True,
}).encode()
req = urllib.request.Request(
    f'{base_url}/auth/v1/admin/users',
    data=body,
    headers={
        'apikey': srv,
        'Authorization': f'Bearer {srv}',
        'Content-Type': 'application/json',
    },
    method='POST',
)
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        resp = json.loads(r.read())
        print(f'created auth user: id={resp["id"]} email={resp["email"]}')
        user_id = resp['id']
except urllib.error.HTTPError as e:
    body = e.read()
    if e.code == 422 and b'already' in body.lower():
        print(f'user already exists; looking up id...')
        # Look up existing user
        req2 = urllib.request.Request(
            f'{base_url}/auth/v1/admin/users?per_page=100',
            headers={'apikey': srv, 'Authorization': f'Bearer {srv}'},
        )
        with urllib.request.urlopen(req2, timeout=15) as r:
            users = json.loads(r.read()).get('users', [])
        match = next((u for u in users if u['email'] == EMAIL), None)
        if not match:
            print(f'could not find existing user with email {EMAIL}', file=sys.stderr)
            sys.exit(1)
        user_id = match['id']
        print(f'found existing: id={user_id}')
    else:
        print(f'HTTPError {e.code}: {body[:300]}', file=sys.stderr)
        sys.exit(1)

# Promote profile to admin via SQL
import urllib.parse
import psycopg
ref = base_url.replace('https://', '').split('.')[0]
pw = urllib.parse.quote(os.environ['SUPABASE_DB_PASSWORD'], safe='')
dsn = f'postgresql://postgres:{pw}@db.{ref}.supabase.co:5432/postgres?sslmode=require'

with psycopg.connect(dsn, autocommit=True) as conn:
    with conn.cursor() as cur:
        # The handle_new_user trigger should have created the profile row.
        # Defensive: insert if missing (shouldn't happen but cheap to check).
        cur.execute(
            "insert into profiles (id, role) values (%s, 'admin') on conflict (id) do update set role = 'admin' returning id, role",
            (user_id,),
        )
        row = cur.fetchone()
        print(f'profile: id={row[0]} role={row[1]}')

print(f'\nDone. Login at http://localhost:3000/login with:')
print(f'  email: {EMAIL}')
print(f'  password: <the one you provided>')
