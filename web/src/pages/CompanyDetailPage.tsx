import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, ApiError } from '@/lib/api';
import type { Company, Contact, CustomsRecord } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DemoBadge } from './CompaniesPage';

interface CompanyDetail extends Company {
  contacts: Contact[];
  customsRecords: CustomsRecord[];
  latestScore: { score: number | null; grade: string | null } | null;
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all">{value || '—'}</span>
    </div>
  );
}

export function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) return;
    api<CompanyDetail>(`/companies/${id}`)
      .then(setCompany)
      .catch((err) => setError(err instanceof ApiError ? err.message : '加载失败'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="space-y-4" role="status" aria-busy="true" aria-label="加载中">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    );
  }
  if (error || !company) {
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {error ?? '未找到企业'}
        </p>
        <Link to="/companies" className="text-sm underline">
          返回企业列表
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-bold tracking-tight">{company.name}</h1>
          <DemoBadge source={company.source} />
          {company.crmStatus && <Badge variant="secondary">{company.crmStatus}</Badge>}
        </div>
        <p className="text-sm text-muted-foreground">
          {company.country} · {company.website ?? '无官网'}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">企业信息</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <InfoRow label="官网" value={company.website} />
            <InfoRow label="企业邮箱" value={company.email} />
            <InfoRow label="LinkedIn" value={company.linkedinUrl} />
            <InfoRow label="主营产品" value={company.mainProducts.join(', ')} />
            <InfoRow label="简介" value={company.description} />
            <InfoRow label="搜索时间" value={new Date(company.searchedAt).toLocaleString()} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">AI 匹配度分析</CardTitle>
            <CardDescription>六项解释性评分（阶段 6 交付）</CardDescription>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            {company.latestScore
              ? `${company.latestScore.score ?? '—'} 分（${company.latestScore.grade ?? '—'} 级）`
              : '尚未评分——阶段 6 后在此发起 AI 匹配分析'}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">采购联系人</CardTitle>
            <CardDescription>联系人挖掘（Apollo）在阶段 7 接入</CardDescription>
          </CardHeader>
          <CardContent>
            {company.contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无联系人</p>
            ) : (
              <ul className="divide-y text-sm">
                {company.contacts.map((contact) => (
                  <li key={contact.id} className="flex items-center justify-between py-2">
                    <div>
                      <p className="font-medium">{contact.name}</p>
                      <p className="text-xs text-muted-foreground">{contact.title}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{contact.email ?? '—'}</span>
                      <DemoBadge source={contact.source} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">海关采购记录</CardTitle>
            <CardDescription>验证真实采购需求（阶段 7 完整接入）</CardDescription>
          </CardHeader>
          <CardContent>
            {company.customsRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground">暂无进口记录（不代表无采购需求）</p>
            ) : (
              <ul className="divide-y text-sm">
                {company.customsRecords.map((record) => (
                  <li key={record.id} className="py-2">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{record.productDescription ?? '—'}</span>
                      <DemoBadge source={record.source} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {record.shipmentDate.slice(0, 10)} · HS {record.hsCode ?? '—'} ·{' '}
                      {record.quantity ?? '—'} · 供应商：{record.supplierCountry ?? '—'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
