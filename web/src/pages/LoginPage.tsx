import { Radar } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-muted">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <Radar className="mx-auto size-10 text-primary" />
          <CardTitle className="text-xl">TradePilot AI</CardTitle>
          <CardDescription>AI 外贸客户开发平台（登录将于阶段 5 实现）</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="email">
              邮箱
            </label>
            <input
              id="email"
              type="email"
              placeholder="demo@tradepilot.dev"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <Button className="w-full" disabled>
            登录（阶段 5 开放）
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
