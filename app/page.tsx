import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function Landing() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background">
      <div className="text-center max-w-md px-6 space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">ProcurementGPT</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Especialista em teorias e práticas de procurement, treinado em centenas de artigos.
          </p>
        </div>
        <Button asChild>
          <Link href="/login">Entrar</Link>
        </Button>
      </div>
    </main>
  );
}
