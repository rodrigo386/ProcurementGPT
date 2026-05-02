'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { Button } from '@/components/ui/button';

export function ResetPasswordForm() {
  const router = useRouter();
  const [hasSession, setHasSession] = useState<boolean | null>(null);
  const [pwd, setPwd] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const sb = supabaseBrowser();
    sb.auth.getUser().then(({ data }) => {
      setHasSession(!!data.user);
    });
  }, []);

  if (hasSession === false) {
    return (
      <div className="w-full max-w-sm mx-auto p-6 space-y-3">
        <h1 className="text-xl font-semibold">Link expirado</h1>
        <p className="text-sm text-muted-foreground">
          Sua sessão de recuperação não está mais ativa.
        </p>
        <Link href="/forgot-password" className="text-primary hover:underline text-sm">
          Solicitar novo link
        </Link>
      </div>
    );
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pwd !== confirm) {
      setError('As senhas não coincidem.');
      return;
    }
    setLoading(true);
    const sb = supabaseBrowser();
    const { error: err } = await sb.auth.updateUser({ password: pwd });
    setLoading(false);
    if (err) {
      setError(err.message ?? 'Algo deu errado. Tente novamente.');
      return;
    }
    router.push('/chat');
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Redefinir senha</h1>
      </div>
      <div>
        <label htmlFor="pwd" className="block text-sm mb-1">Nova senha</label>
        <input
          id="pwd"
          type="password"
          required
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      <div>
        <label htmlFor="confirm" className="block text-sm mb-1">Confirmar nova senha</label>
        <input
          id="confirm"
          type="password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      {error ? (
        <div role="alert" className="text-sm text-destructive">{error}</div>
      ) : null}
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? 'Redefinindo…' : 'Redefinir'}
      </Button>
    </form>
  );
}
