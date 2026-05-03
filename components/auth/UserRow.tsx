'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LogOut, Shield } from 'lucide-react';
import { supabaseBrowser } from '@/lib/db/supabase-browser';

export function UserRow() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    const sb = supabaseBrowser();
    sb.auth.getUser().then(async ({ data }) => {
      const u = data.user;
      setEmail(u?.email ?? null);
      if (!u) return;
      const { data: profile } = await sb.from('profiles').select('role').eq('id', u.id).maybeSingle();
      setIsAdmin(((profile as { role?: string } | null)?.role ?? 'user') === 'admin');
    });
  }, []);

  if (!email) return null;

  const initial = email[0]?.toUpperCase() ?? '?';

  async function handleLogout() {
    const sb = supabaseBrowser();
    await sb.auth.signOut();
    router.refresh();
    router.push('/login');
  }

  return (
    <div className="border-t border-border">
      {isAdmin && (
        <Link
          href="/admin"
          className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Shield className="h-4 w-4" />
          <span>Admin</span>
        </Link>
      )}
      <div className="flex items-center gap-2 p-3">
        <div className="h-7 w-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-semibold shrink-0">
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="truncate text-sm">{email}</div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          aria-label="Sair"
          className="text-muted-foreground hover:text-foreground transition-colors"
          title="Sair"
        >
          <LogOut className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
