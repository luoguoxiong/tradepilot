import { useParams } from 'react-router-dom';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Company Detail</h1>
        <p className="text-sm text-muted-foreground">企业 ID：{id}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>企业信息</CardTitle>
            <CardDescription>基本信息 / 联系人 / 海关数据（阶段 5–7 实现）</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">待实现</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>AI 分析与开发信</CardTitle>
            <CardDescription>匹配度评分 / 邮件草稿（阶段 6 实现）</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">待实现</CardContent>
        </Card>
      </div>
    </div>
  );
}
