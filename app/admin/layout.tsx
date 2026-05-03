import { notFound } from 'next/navigation';
import { requireAdmin, NotAdmin } from '@/lib/auth';
import { AdminSidebar } from '@/components/admin/AdminSidebar';

export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireAdmin();
  } catch (err) {
    if (err instanceof NotAdmin) notFound();
    throw err;
  }
  return (
    <div className="flex min-h-screen bg-background">
      <AdminSidebar />
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
