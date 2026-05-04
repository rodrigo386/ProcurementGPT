import { Suspense } from 'react';
import { LoginForm } from '@/components/auth/LoginForm';

export default function LoginPage() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
