import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function CrmPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">CRM</h1>
        <p className="text-sm text-muted-foreground">客户状态流转、跟进时间线、下次跟进时间（阶段 7 实现）</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>客户列表</CardTitle>
          <CardDescription>状态筛选：New / Qualified / Contacted / Replied / Negotiating / Won / Lost</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">暂无数据</CardContent>
      </Card>
    </div>
  );
}
