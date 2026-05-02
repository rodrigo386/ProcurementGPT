'use client';

import { useState } from 'react';
import { supabaseBrowser } from '@/lib/db/supabase-browser';
import { Button } from '@/components/ui/button';

export function ForgotPasswordForm() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    const sb = supabaseBrowser();
    await sb.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/reset-password`,
    });
    setLoading(false);
    setDone(true);
  }

  if (done) {
    return (
      <div className="w-full max-w-sm mx-auto p-6 space-y-3">
        <h1 className="text-xl font-semibold">Verifique seu email</h1>
        <p className="text-sm text-muted-foreground">
          Se este email existir em nossa base, enviamos um link para redefinir a senha.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-sm mx-auto p-6 space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Esqueci minha senha</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Enviaremos um link para redefinir sua senha.
        </p>
      </div>
      <div>
        <label htmlFor="email" className="block text-sm mb-1">Email</label>
        <input
          id="email"
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
      </div>
      <Button type="submit" disabled={loading} className="w-full">
        {loading ? 'Enviando…' : 'Enviar link'}
      </Button>
    </form>
  );
}
