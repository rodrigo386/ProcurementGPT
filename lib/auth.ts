import type { User } from '@supabase/supabase-js';
import { supabaseServer } from '@/lib/db/supabase-server';

export type Profile = {
  id: string;
  role: 'user' | 'admin';
  display_name: string | null;
};

export class NotAuthenticated extends Error {
  constructor() {
    super('NOT_AUTHENTICATED');
    this.name = 'NotAuthenticated';
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const {
    data: { user },
  } = await supabaseServer().auth.getUser();
  return user ?? null;
}

export async function requireUser(): Promise<User> {
  const u = await getCurrentUser();
  if (!u) throw new NotAuthenticated();
  return u;
}

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabaseServer()
    .from('profiles')
    .select('id, role, display_name')
    .eq('id', userId)
    .maybeSingle();
  if (error) return null;
  return (data as Profile | null) ?? null;
}
