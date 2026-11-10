import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '@/lib/api';
import type { SearchTask } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CrmStatusBadge } from './CrmPage';

interface CrmSummary {
  totalCustomers: number;
  byStatus: Record<string, number>;
  dueFollowUps: { id: string; name: string; crmStatus: string; nextFollowUpAt: string }[];
}

const STATS = [
  { key: 'companies', title: '累计发现企业' },
  { key: 'customers', title: 'CRM 客户' },
  { key: 'due', title: '待跟进（7 天内）' },
] as const;

export function DashboardPage() {
  const [summary, setSummary] = useState<CrmSummary | null>(null);
  const [totalCompanies, setTotalCompanies] = useState<number | null>(null);
  const [recentTasks, setRecentTasks] = useState<SearchTask[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CrmSummary>('/crm/summary')
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : '加载汇总失败'));
    api<PaginatedUnknown>('/companies?page=1&pageSize=1')
      .then((res) => setTotalCompanies(res.pagination.totalItems))
      .catch(() => setTotalCompanies(null));
    api<{ data: SearchTask[] }>('/search-tasks?page=1&pageSize=5')
      .then((res) => setRecentTasks(res.data))
      .catch(() => setRecentTasks([]));
  }, []);

  const values: Record<string, number | null> = {
    companies: totalCompanies,
    customers: summary?.totalCustomers ?? null,
    due: summary?.dueFollowUps.length ?? null,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">客户开发总览</p>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        {STATS.map((stat) => (
          <Card key={stat.key}>
            <CardHeader className="pb-2">
              <CardDescription>{stat.title}</CardDescription>
              <CardTitle className="text-3xl">{values[stat.key] ?? '—'}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">待跟进客户</CardTitle>
            <CardDescription>7 天内到期，按时间排序</CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {!summary && <p className="py-4 text-sm text-muted-foreground">加载中…</p>}
            {summary && summary.dueFollowUps.length === 0 && (
              <p className="py-4 text-sm text-muted-foreground">暂无待跟进——在客户详情设置下次跟进时间</p>
            )}
            {summary?.dueFollowUps.map((c) => (
              <div key={c.id} className="flex items-center justify-between py-2.5 text-sm">
                <Link to={`/companies/${c.id}`} className="font-medium hover:underline">
                  {c.name}
                </Link>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {new Date(c.nextFollowUpAt).toLocaleDateString()}
                  </span>
                  <CrmStatusBadge status={c.crmStatus} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">最近任务</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            {recentTasks.length === 0 && <p className="py-4 text-sm text-muted-foreground">暂无任务</p>}
            {recentTasks.map((task) => (
              <div key={task.id} className="flex items-center justify-between py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{task.params.productKeywords.join(', ')}</p>
                  <p className="text-xs text-muted-foreground">
                    {task.params.country} · {task.totalCompanies} 家企业 ·{' '}
                    {new Date(task.createdAt).toLocaleString()}
                  </p>
                </div>
                <Badge variant={task.status === 'DONE' ? 'secondary' : 'outline'}>{task.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

interface PaginatedUnknown {
  pagination: { totalItems: number };
}
