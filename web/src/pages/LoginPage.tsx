import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Radar } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

type Mode = 'login' | 'register';

export function LoginPage() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('demo@tradepilot.dev');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isLogin = mode === 'login';

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (isLogin) {
        const res = await api<{ token: string; user: { id: string; email: string; name: string } }>(
          '/auth/login',
          { method: 'POST', body: { email, password } },
        );
        setAuth(res.token, res.user);
      } else {
        const res = await api<{ token: string; user: { id: string; email: string; name: string } }>(
          '/auth/register',
          { method: 'POST', body: { email, password, name: name || email.split('@')[0] } },
        );
        setAuth(res.token, res.user);
      }
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Radar className="mb-1 size-10 text-primary" />
          <CardTitle className="text-xl">TradePilot AI</CardTitle>
          <CardDescription>
            {isLogin ? '登录 AI 外贸客户开发平台' : '创建你的账号'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3" noValidate>
            {!isLogin && (
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="name">
                  姓名
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="email">
                邮箱
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="password">
                密码
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={isLogin ? 'current-password' : 'new-password'}
                required
                minLength={8}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
              {!isLogin && <p className="text-xs text-muted-foreground">至少 8 位字符</p>}
            </div>
            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? '提交中…' : isLogin ? '登录' : '注册'}
            </Button>
          </form>
          <button
            type="button"
            onClick={() => {
              setMode(isLogin ? 'register' : 'login');
              setError(null);
            }}
            className="mt-3 w-full text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            {isLogin ? '没有账号？注册一个' : '已有账号？去登录'}
          </button>
          {isLogin && (
            <p className="mt-3 text-center text-xs text-muted-foreground">
              演示账号：demo@tradepilot.dev / demo123456
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
