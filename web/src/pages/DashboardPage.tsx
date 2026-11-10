import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const STATS = [
  { title: '累计发现企业', value: '0' },
  { title: '有效潜在客户', value: '0' },
  { title: 'A 级客户', value: '0' },
  { title: '已生成开发信', value: '0' },
  { title: '待跟进客户', value: '0' },
];

export function DashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">客户开发总览（数据接入于阶段 5 实现）</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {STATS.map((stat) => (
          <Card key={stat.title}>
            <CardHeader className="pb-2">
              <CardDescription>{stat.title}</CardDescription>
              <CardTitle className="text-3xl">{stat.value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>最近任务</CardTitle>
          <CardDescription>搜索任务执行记录（阶段 5 接入）</CardDescription>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">暂无任务</CardContent>
      </Card>
    </div>
  );
}
