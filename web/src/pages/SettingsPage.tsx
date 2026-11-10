import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function SettingsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">AI 模型与第三方 API 配置（阶段 5 实现）</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {['AI 模型配置（DeepSeek）', 'Google Search API', 'Apollo API', '海关数据 API'].map((title) => (
          <Card key={title}>
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
              <CardDescription>无 Key 时自动降级 Mock（DEMO 数据）</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">待实现</CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
