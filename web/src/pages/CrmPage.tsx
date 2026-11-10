import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Download, Upload } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth';
import type { Company, Paginated } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

const STATUS_TABS = ['ALL', 'NEW', 'QUALIFIED', 'CONTACTED', 'REPLIED', 'NEGOTIATING', 'WON', 'LOST'] as const;
const STATUS_LABELS: Record<string, string> = {
  NEW: '新客户',
  QUALIFIED: '已合格',
  CONTACTED: '已联系',
  REPLIED: '已回复',
  NEGOTIATING: '谈判中',
  WON: '已成交',
  LOST: '已流失',
};

export function CrmStatusBadge({ status }: { status: string }) {
  const style: Record<string, string> = {
    NEW: 'bg-zinc-100 text-zinc-700',
    QUALIFIED: 'bg-blue-100 text-blue-700',
    CONTACTED: 'bg-indigo-100 text-indigo-700',
    REPLIED: 'bg-violet-100 text-violet-700',
    NEGOTIATING: 'bg-amber-100 text-amber-700',
    WON: 'bg-emerald-100 text-emerald-700',
    LOST: 'bg-red-100 text-red-700',
  };
  return <span className={`inline-flex rounded-md px-2 py-0.5 text-xs font-medium ${style[status] ?? 'bg-muted'}`}>{STATUS_LABELS[status] ?? status}</span>;
}

export function CrmPage() {
  const [result, setResult] = useState<Paginated<Company> | null>(null);
  const [status, setStatus] = useState<string>('ALL');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '10' });
      if (status !== 'ALL') params.set('status', status);
      if (q.trim()) params.set('q', q.trim());
      setResult(await api<Paginated<Company>>(`/crm/customers?${params.toString()}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载客户列表失败');
    } finally {
      setLoading(false);
    }
  }, [status, q, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function exportCsv(type: 'companies' | 'contacts') {
    try {
      const res = await fetch(`/api/crm/export?type=${type}`, {
        headers: { Authorization: `Bearer ${useAuthStore.getState().token ?? ''}` },
      });
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tradepilot-${type}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError('导出失败，请重试');
    }
  }

  async function importCsv(file: File) {
    setImportMsg(null);
    setError(null);
    try {
      const csv = await file.text();
      const type = file.name.includes('contact') ? 'contacts' : 'companies';
      const res = await api<{ created: number; updated: number; skipped: number }>('/crm/import', {
        method: 'POST',
        body: { type, csv },
      });
      setImportMsg(`导入完成：新建 ${res.created}、更新 ${res.updated}、跳过 ${res.skipped}`);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '导入失败');
    }
  }

  const rows = result?.data ?? [];
  const pagination = result?.pagination;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">CRM</h1>
          <p className="text-sm text-muted-foreground">客户全生命周期：状态流转、跟进时间线、下次跟进</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportCsv('companies')}>
            <Download className="size-4" /> 导出客户
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportCsv('contacts')}>
            <Download className="size-4" /> 导出联系人
          </Button>
          <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
            <Upload className="size-4" /> 导入 CSV
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".csv"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importCsv(f);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {importMsg && (
        <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
          {importMsg}
        </p>
      )}

      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-2 pb-3">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => {
                setStatus(tab);
                setPage(1);
              }}
              aria-pressed={status === tab}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                status === tab ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-accent'
              }`}
            >
              {tab === 'ALL' ? '全部' : STATUS_LABELS[tab]}
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="按企业名搜索…"
            aria-label="搜索客户"
            className="ml-auto h-9 w-56 rounded-md border border-input bg-background px-3 text-sm"
          />
        </CardHeader>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="px-6 py-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {loading ? (
            <div className="space-y-2 p-6" role="status" aria-busy="true" aria-label="加载中">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="py-12 text-center" role="status">
              <p className="text-sm font-medium">暂无客户</p>
              <p className="mt-1 text-sm text-muted-foreground">在 Companies 页选择企业「批量导入 CRM」</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="px-4 py-2">客户</th>
                  <th className="px-4 py-2">状态</th>
                  <th className="px-4 py-2">匹配评分</th>
                  <th className="px-4 py-2">下次跟进</th>
                  <th className="px-4 py-2">最近动态</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-2.5">
                      <Link to={`/companies/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      <p className="text-xs text-muted-foreground">{c.country}</p>
                    </td>
                    <td className="px-4 py-2.5">
                      <CrmStatusBadge status={c.crmStatus ?? 'NEW'} />
                    </td>
                    <td className="px-4 py-2.5 text-muted-foreground">
                      {c.latestScore ? `${c.latestScore.score ?? '—'}（${c.latestScore.grade ?? '—'}）` : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-muted-foreground">
                      {c.nextFollowUpAt ? new Date(c.nextFollowUpAt).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-2.5 max-w-40 truncate text-xs text-muted-foreground">
                      {c.latestActivity?.content ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {pagination && pagination.totalPages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </Button>
          <span className="text-muted-foreground">
            {pagination.page} / {pagination.totalPages}（共 {pagination.totalItems} 家）
          </span>
          <Button variant="outline" size="sm" disabled={page >= pagination.totalPages} onClick={() => setPage(page + 1)}>
            下一页
          </Button>
        </div>
      )}
    </div>
  );
}
