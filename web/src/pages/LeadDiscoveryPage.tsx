import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Loader2 } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import type { Product, SearchTask } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

const COMPANY_TYPES = ['Importer', 'Distributor', 'Wholesaler', 'Retailer'] as const;
const TERMINAL_STATUSES = new Set(['DONE', 'FAILED']);

const STATUS_LABELS: Record<SearchTask['status'], { label: string; className: string }> = {
  PENDING: { label: '排队中', className: 'bg-muted text-muted-foreground' },
  SEARCHING: { label: '搜索企业中', className: 'bg-blue-100 text-blue-700' },
  ENRICHING: { label: '信息补充中', className: 'bg-blue-100 text-blue-700' },
  SCORING: { label: 'AI 分析中', className: 'bg-violet-100 text-violet-700' },
  EMAILING: { label: '生成开发信中', className: 'bg-violet-100 text-violet-700' },
  DONE: { label: '完成', className: 'bg-emerald-100 text-emerald-700' },
  FAILED: { label: '失败', className: 'bg-red-100 text-red-700' },
};

export function TaskStatusBadge({ status }: { status: SearchTask['status'] }) {
  const meta = STATUS_LABELS[status];
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${meta.className}`}>{meta.label}</span>;
}

export function LeadDiscoveryPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [keywords, setKeywords] = useState('carbon fiber insoles');
  const [country, setCountry] = useState<'US' | 'CA'>('US');
  const [companyTypes, setCompanyTypes] = useState<string[]>(['Importer', 'Distributor']);
  const [industryKeywords, setIndustryKeywords] = useState('');
  const [limit, setLimit] = useState(10);
  const [productId, setProductId] = useState('');
  const [runningTask, setRunningTask] = useState<SearchTask | null>(null);
  const [recentTasks, setRecentTasks] = useState<SearchTask[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRecent = useCallback(async () => {
    try {
      const res = await api<{ data: SearchTask[] }>('/search-tasks?page=1&pageSize=5');
      setRecentTasks(res.data);
    } catch {
      // 列表加载失败不打断主流程
    }
  }, []);

  useEffect(() => {
    // GET /api/products 直接返回数组（小集合不包装分页）
    api<Product[]>('/products')
      .then(setProducts)
      .catch(() => setProducts([]));
    void loadRecent();
  }, [loadRecent]);

  // 任务轮询（2s，终态停止——architecture.md §3.2）
  useEffect(() => {
    if (!runningTask || TERMINAL_STATUSES.has(runningTask.status)) return;
    pollRef.current = setInterval(async () => {
      try {
        const task = await api<SearchTask>(`/search-tasks/${runningTask.id}`);
        setRunningTask(task);
        if (TERMINAL_STATUSES.has(task.status)) {
          if (pollRef.current) clearInterval(pollRef.current);
          void loadRecent();
        }
      } catch (err) {
        if (pollRef.current) clearInterval(pollRef.current);
        setError(err instanceof ApiError ? err.message : '任务状态查询失败');
      }
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [runningTask, loadRecent]);

  function toggleType(type: string) {
    setCompanyTypes((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    );
  }

  async function handleSubmit() {
    setError(null);
    setSubmitting(true);
    try {
      const task = await api<SearchTask>('/search-tasks', {
        method: 'POST',
        body: {
          ...(productId ? { productId } : {}),
          productKeywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          country,
          companyTypes,
          ...(industryKeywords.trim()
            ? { industryKeywords: industryKeywords.split(',').map((k) => k.trim()).filter(Boolean) }
            : {}),
          limit,
        },
      });
      setRunningTask(task);
      void loadRecent();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建任务失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  const running = runningTask && !TERMINAL_STATUSES.has(runningTask.status);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Lead Discovery</h1>
        <p className="text-sm text-muted-foreground">
          输入产品与目标市场，自动搜索海外潜在客户（联系人/海关/AI 分析在后续阶段接入）
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>搜索条件</CardTitle>
            <CardDescription>首期市场：美国 / 加拿大</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="product">
                关联产品（可选）
              </label>
              <select
                id="product"
                value={productId}
                onChange={(e) => {
                  setProductId(e.target.value);
                  const p = products.find((x) => x.id === e.target.value);
                  if (p?.keywords.length) setKeywords(p.keywords.join(', '));
                }}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">不关联产品</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="keywords">
                产品关键词（英文，逗号分隔）
              </label>
              <input
                id="keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="country">
                  目标国家
                </label>
                <select
                  id="country"
                  value={country}
                  onChange={(e) => setCountry(e.target.value as 'US' | 'CA')}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="US">United States</option>
                  <option value="CA">Canada</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium" htmlFor="limit">
                  企业数量
                </label>
                <input
                  id="limit"
                  type="number"
                  min={1}
                  max={50}
                  value={limit}
                  onChange={(e) => setLimit(Number(e.target.value) || 10)}
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                />
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-sm font-medium">企业类型</span>
              <div className="flex flex-wrap gap-2 pt-1">
                {COMPANY_TYPES.map((type) => (
                  <button
                    key={type}
                    type="button"
                    onClick={() => toggleType(type)}
                    aria-pressed={companyTypes.includes(type)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      companyTypes.includes(type)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'bg-background text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {type}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="industry">
                行业关键词（可选，逗号分隔）
              </label>
              <input
                id="industry"
                value={industryKeywords}
                onChange={(e) => setIndustryKeywords(e.target.value)}
                placeholder="sporting goods, footwear"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              />
            </div>
            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button className="w-full" onClick={handleSubmit} disabled={submitting || running === true}>
              {submitting ? '提交中…' : running ? '任务执行中…' : '开始自动寻找客户'}
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-4 lg:col-span-3">
          {runningTask && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">当前任务</CardTitle>
                  <TaskStatusBadge status={runningTask.status} />
                </div>
                <CardDescription>
                  {runningTask.params.productKeywords.join(', ')} · {runningTask.params.country} ·{' '}
                  {runningTask.params.companyTypes.join('/')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                {running ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" /> 正在搜索潜在企业…
                  </div>
                ) : runningTask.status === 'DONE' ? (
                  <div className="flex items-center justify-between">
                    <span className="text-sm">
                      已发现 <strong>{runningTask.totalCompanies}</strong> 家企业
                      {runningTask.failedCount > 0 && `（失败 ${runningTask.failedCount}）`}
                    </span>
                    <Button asChild size="sm">
                      <Link to="/companies">
                        查看企业列表 <ArrowRight className="size-4" />
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <p className="text-sm text-destructive">{runningTask.error ?? '任务失败'}</p>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">最近任务</CardTitle>
            </CardHeader>
            <CardContent className="divide-y">
              {recentTasks.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">暂无任务</p>
              )}
              {recentTasks.map((task) => (
                <div key={task.id} className="flex items-center justify-between py-2.5 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{task.params.productKeywords.join(', ')}</p>
                    <p className="text-xs text-muted-foreground">
                      {task.params.country} · {new Date(task.createdAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{task.totalCompanies} 家</span>
                    <TaskStatusBadge status={task.status} />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card className="border-amber-200 bg-amber-50/50">
            <CardContent className="flex items-center gap-2 py-3">
              <Badge variant="demo">Demo</Badge>
              <span className="text-sm text-amber-800">
                未配置 Serper API Key 时，搜索结果为确定性生成的演示数据
              </span>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
