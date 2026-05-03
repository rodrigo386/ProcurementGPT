'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { InviteUserDialog } from '@/components/admin/InviteUserDialog';

type AdminUser = {
  id: string;
  email: string;
  role: 'admin' | 'user';
  last_sign_in_at: string | null;
  session_count: number;
  created_at: string;
};

type Props = {
  users: AdminUser[];
  currentUserId: string;
};

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}

function RolePill({ role, pending }: { role: 'admin' | 'user'; pending: boolean }) {
  if (pending) {
    return (
      <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-amber-500/10 text-amber-700 dark:text-amber-300">
        Convite enviado
      </span>
    );
  }
  return role === 'admin' ? (
    <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-primary/10 text-primary">Admin</span>
  ) : (
    <span className="inline-block px-2 py-0.5 rounded-full text-xs bg-muted text-muted-foreground">Usuário</span>
  );
}

export function UsersTable({ users, currentUserId }: Props) {
  const router = useRouter();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  async function patchRole(user_id: string, role: 'admin' | 'user') {
    setBusy(user_id);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id, role }),
      });
      if (res.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  }

  async function resendInvite(email: string) {
    setBusy(email);
    try {
      await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  const adminCount = users.filter((u) => u.role === 'admin').length;
  const pendingCount = users.filter((u) => !u.last_sign_in_at).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Usuários</h2>
          <p className="text-xs text-muted-foreground">
            {users.length} usuários · {adminCount} admins · {pendingCount} pendente{pendingCount === 1 ? '' : 's'}
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>+ Convidar usuário</Button>
      </div>

      <div className="rounded-md border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Papel</TableHead>
              <TableHead>Último acesso</TableHead>
              <TableHead className="text-right">Conversas</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => {
              const pending = !u.last_sign_in_at;
              return (
                <TableRow key={u.id}>
                  <TableCell className={pending ? 'text-muted-foreground' : ''}>{u.email}</TableCell>
                  <TableCell>
                    <RolePill role={u.role} pending={pending} />
                  </TableCell>
                  <TableCell>{formatRelative(u.last_sign_in_at)}</TableCell>
                  <TableCell className="text-right tabular-nums">{u.session_count}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        aria-label="Ações"
                        disabled={busy === u.id || busy === u.email}
                        className="inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none hover:bg-muted hover:text-foreground size-7 disabled:pointer-events-none disabled:opacity-50"
                      >
                        <MoreHorizontal className="h-4 w-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {pending && (
                          <DropdownMenuItem onClick={() => resendInvite(u.email)}>
                            Reenviar convite
                          </DropdownMenuItem>
                        )}
                        {!pending && u.role === 'user' && (
                          <DropdownMenuItem onClick={() => patchRole(u.id, 'admin')}>
                            Promover a admin
                          </DropdownMenuItem>
                        )}
                        {!pending && u.role === 'admin' && u.id !== currentUserId && (
                          <DropdownMenuItem onClick={() => patchRole(u.id, 'user')}>
                            Rebaixar a usuário
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <InviteUserDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}
