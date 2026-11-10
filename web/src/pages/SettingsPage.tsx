import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { api, ApiError } from '@/lib/api';
import type { Product } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface IntegrationView {
  provider: string;
  configured: boolean;
  keyPreview: string | null;
}

const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

const PROVIDER_META: Record<string, { title: string; hint: string }> = {
  google: { title: 'Google Search API', hint: 'Google Programmable Search 的 API Key 与 CX' },
  apollo: { title: 'Apollo API', hint: '采购联系人挖掘（阶段 7 接入）' },
  customs: { title: '海关数据 API', hint: '第三方海关数据服务（阶段 7 接入）' },
};

export function SettingsPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">我方产品资料与第三方 API 配置</p>
      </div>
      <ProductsSection />
      <IntegrationsSection />
    </div>
  );
}

// ---------- 产品配置（P0：产品资料配置） ----------

function ProductsSection() {
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [sellingPoints, setSellingPoints] = useState('');
  const [companyIntro, setCompanyIntro] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      // GET /api/products 直接返回数组（小集合不包装分页）
      setProducts(await api<Product[]>('/products'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载产品失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api('/products', {
        method: 'POST',
        body: {
          name,
          ...(description ? { description } : {}),
          keywords: keywords.split(',').map((k) => k.trim()).filter(Boolean),
          sellingPoints: sellingPoints.split(',').map((k) => k.trim()).filter(Boolean),
          ...(companyIntro ? { companyIntro } : {}),
        },
      });
      setName('');
      setDescription('');
      setKeywords('');
      setSellingPoints('');
      setCompanyIntro('');
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      await api(`/products/${id}`, { method: 'DELETE' });
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除失败');
    }
  }

  return (
    <section className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">添加产品</CardTitle>
          <CardDescription>搜索任务与 AI 分析、开发信都将使用这些资料</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleCreate} className="space-y-3">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="产品名称，如：碳纤维鞋垫" required className={inputCls} />
            <input value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder="英文搜索关键词，逗号分隔，如：carbon fiber insoles, arch support" className={inputCls} />
            <input value={sellingPoints} onChange={(e) => setSellingPoints(e.target.value)} placeholder="核心卖点，逗号分隔" className={inputCls} />
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="产品描述（可选）" rows={2} className={`${inputCls} h-auto py-2`} />
            <textarea value={companyIntro} onChange={(e) => setCompanyIntro(e.target.value)} placeholder="我方公司介绍（可选，用于开发信）" rows={2} className={`${inputCls} h-auto py-2`} />
            {error && (
              <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            )}
            <Button type="submit" disabled={saving}>{saving ? '保存中…' : '添加产品'}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">我的产品（{products.length}）</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {products.length === 0 && <p className="py-6 text-center text-sm text-muted-foreground">暂无产品</p>}
          {products.map((p) => (
            <div key={p.id} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{p.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {p.keywords.join(' · ') || '未设置关键词'}
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => handleDelete(p.id)}>
                删除
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  );
}

// ---------- 第三方 API 集成（integrations 表，加密存储） ----------

function IntegrationsSection() {
  const [items, setItems] = useState<IntegrationView[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { apiKey: string; extra: string }>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await api<IntegrationView[]>('/integrations'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载集成配置失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSave(provider: string) {
    setError(null);
    setMessage(null);
    const draft = drafts[provider];
    if (!draft?.apiKey.trim()) {
      setError('请输入 API Key');
      return;
    }
    try {
      let extra: Record<string, string> | undefined;
      if (draft.extra.trim()) {
        // 简单 k=v 约定，如 cx=abc123
        extra = Object.fromEntries(
          draft.extra.split(',').map((pair) => pair.split('=').map((s) => s.trim())).filter((kv) => kv.length === 2),
        );
      }
      const res = await api<IntegrationView>(`/integrations/${provider}`, {
        method: 'PATCH',
        body: { apiKey: draft.apiKey.trim(), extra },
      });
      setMessage(`${PROVIDER_META[provider]?.title ?? provider} 已保存（${res.keyPreview}）`);
      setDrafts((prev) => ({ ...prev, [provider]: { apiKey: '', extra: '' } }));
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    }
  }

  async function handleDelete(provider: string) {
    try {
      await api(`/integrations/${provider}`, { method: 'DELETE' });
      void load();
    } catch {
      // 未配置时删除忽略
    }
  }

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">第三方 API 集成</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Key 经 AES-256-GCM 加密落库，仅显示尾 4 位；未配置的集成自动降级为 Mock（DEMO 数据）
      </p>
      {(message || error) && (
        <p role={error ? 'alert' : 'status'} className={`mb-4 rounded-md px-3 py-2 text-sm ${error ? 'bg-destructive/10 text-destructive' : 'bg-emerald-500/10 text-emerald-700'}`}>
          {error ?? message}
        </p>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        {Object.entries(PROVIDER_META).map(([provider, meta]) => {
          const view = items.find((i) => i.provider === provider);
          const draft = drafts[provider] ?? { apiKey: '', extra: '' };
          return (
            <Card key={provider}>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center justify-between text-base">
                  {meta.title}
                  {view?.configured && (
                    <span className="text-xs font-normal text-muted-foreground">{view.keyPreview}</span>
                  )}
                </CardTitle>
                <CardDescription>{meta.hint}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <input
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [provider]: { ...draft, apiKey: e.target.value } }))}
                  placeholder={view?.configured ? '输入新 Key 覆盖' : 'API Key'}
                  className={inputCls}
                />
                {provider === 'google' && (
                  <input
                    value={draft.extra}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [provider]: { ...draft, extra: e.target.value } }))}
                    placeholder="cx=搜索引擎ID"
                    className={inputCls}
                  />
                )}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => handleSave(provider)}>保存</Button>
                  {view?.configured && (
                    <Button size="sm" variant="ghost" onClick={() => handleDelete(provider)}>清除</Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </section>
  );
}
