import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Star, StarOff } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import type { Company, Paginated } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';

export function DemoBadge({ source }: { source: string }) {
  if (source !== 'demo') return <span className="text-xs text-muted-foreground">{source}</span>;
  return <Badge variant="demo">Demo</Badge>;
}

export function CompaniesPage() {
  const [result, setResult] = useState<Paginated<Company> | null>(null);
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [onlyFavorite, setOnlyFavorite] = useState(false);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '10' });
      if (q.trim()) params.set('q', q.trim());
      if (country) params.set('country', country);
      if (onlyFavorite) params.set('isFavorite', 'true');
      setResult(await api<Paginated<Company>>(`/companies?${params.toString()}`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载企业列表失败');
    } finally {
      setLoading(false);
    }
  }, [q, country, onlyFavorite, page]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleFavorite(company: Company) {
    try {
      await api(`/companies/${company.id}/favorite`, {
        method: 'PATCH',
        body: { isFavorite: !company.isFavorite },
      });
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function importCrm() {
    if (selected.size === 0) return;
    setImportMsg(null);
    try {
      const res = await api<{ imported: number; skipped: number }>('/companies/import-crm', {
        method: 'POST',
        body: { companyIds: Array.from(selected) },
      });
      setImportMsg(`已导入 ${res.imported} 家到 CRM${res.skipped ? `，跳过 ${res.skipped} 家（已在 CRM）` : ''}`);
      setSelected(new Set());
      void load();
    } catch (err) {
      setImportMsg(null);
      setError(err instanceof ApiError ? err.message : '导入失败');
    }
  }

  const rows = result?.data ?? [];
  const pagination = result?.pagination;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
        <p className="text-sm text-muted-foreground">海外企业列表：分页、筛选、收藏、批量导入 CRM</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="按企业名搜索…"
              aria-label="搜索企业"
              className="h-9 w-64 rounded-md border border-input bg-background px-3 text-sm"
            />
            <select
              value={country}
              onChange={(e) => {
                setCountry(e.target.value);
                setPage(1);
              }}
              aria-label="目标国家筛选"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">全部国家</option>
              <option value="US">US</option>
              <option value="CA">CA</option>
            </select>
            <Button
              variant={onlyFavorite ? 'default' : 'outline'}
              size="sm"
              onClick={() => {
                setOnlyFavorite(!onlyFavorite);
                setPage(1);
              }}
            >
              <Star className="size-4" /> 只看收藏
            </Button>
            <div className="ml-auto flex items-center gap-2">
              {importMsg && <span className="text-sm text-emerald-600">{importMsg}</span>}
              <Button size="sm" onClick={importCrm} disabled={selected.size === 0}>
                批量导入 CRM（{selected.size}）
              </Button>
            </div>
          </div>
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
              <p className="text-sm font-medium">暂无企业</p>
              <p className="mt-1 text-sm text-muted-foreground">去 Lead Discovery 发起第一次搜索</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                  <th className="w-10 px-4 py-2">
                    <input
                      type="checkbox"
                      aria-label="全选"
                      checked={rows.length > 0 && rows.every((c) => selected.has(c.id))}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked ? new Set(rows.map((c) => c.id)) : new Set(),
                        )
                      }
                    />
                  </th>
                  <th className="px-4 py-2">企业</th>
                  <th className="px-4 py-2">国家</th>
                  <th className="px-4 py-2">主营产品</th>
                  <th className="px-4 py-2">来源</th>
                  <th className="px-4 py-2">状态</th>
                  <th className="w-16 px-4 py-2">收藏</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/40">
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${c.name}`}
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelect(c.id)}
                      />
                    </td>
                    <td className="px-4 py-2.5">
                      <Link to={`/companies/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      {c.website && (
                        <p className="truncate text-xs text-muted-foreground">{c.website}</p>
                      )}
                    </td>
                    <td className="px-4 py-2.5">{c.country}</td>
                    <td className="max-w-52 truncate px-4 py-2.5 text-muted-foreground">
                      {c.mainProducts.join(', ') || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <DemoBadge source={c.source} />
                    </td>
                    <td className="px-4 py-2.5">
                      {c.crmStatus ? (
                        <Badge variant="secondary">{c.crmStatus}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">未导入</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <button
                        type="button"
                        onClick={() => toggleFavorite(c)}
                        aria-label={c.isFavorite ? '取消收藏' : '收藏'}
                        className="text-amber-500"
                      >
                        {c.isFavorite ? <Star className="size-4 fill-current" /> : <StarOff className="size-4" />}
                      </button>
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
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pagination.totalPages}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </Button>
        </div>
      )}
    </div>
  );
}
