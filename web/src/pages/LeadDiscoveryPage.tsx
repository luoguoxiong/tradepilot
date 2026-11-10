import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function LeadDiscoveryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Lead Discovery</h1>
        <p className="text-sm text-muted-foreground">
          输入产品关键词与目标市场，自动搜索海外潜在客户（阶段 5 实现）
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>搜索条件</CardTitle>
          <CardDescription>产品关键词 / 目标国家 / 企业类型 / 搜索数量</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">表单与任务进度将在此实现</CardContent>
      </Card>
    </div>
  );
}
