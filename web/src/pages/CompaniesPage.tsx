import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function CompaniesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
        <p className="text-sm text-muted-foreground">海外企业列表：分页、去重、收藏、批量导入 CRM（阶段 5 实现）</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>企业列表</CardTitle>
          <CardDescription>含匹配评分与采购记录状态</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">暂无数据</CardContent>
      </Card>
    </div>
  );
}
