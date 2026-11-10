import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function EmailStudioPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Email Studio</h1>
        <p className="text-sm text-muted-foreground">英文开发信生成、编辑与多轮跟进邮件（阶段 6 实现）</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>开发信草稿</CardTitle>
          <CardDescription>Subject / Body / Follow-up 1 / Follow-up 2 —— 仅草稿，不自动发送</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">待实现</CardContent>
      </Card>
    </div>
  );
}
