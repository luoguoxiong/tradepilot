import { useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import type { LeadScore } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const GRADE_STYLE: Record<string, string> = {
  A: 'bg-emerald-100 text-emerald-700',
  B: 'bg-blue-100 text-blue-700',
  C: 'bg-amber-100 text-amber-700',
  D: 'bg-red-100 text-red-700',
};

const SUB_SCORE_LABELS: Record<string, string> = {
  product: '产品匹配 30%',
  business: '业务匹配 25%',
  customs: '采购记录 25%',
  contact: '联系人 10%',
  region: '地区 10%',
};

export function LeadScoreCard({
  companyId,
  latest,
  historyCount,
  onScored,
}: {
  companyId: string;
  latest: LeadScore | null;
  historyCount: number;
  onScored: (score: LeadScore) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runScoring() {
    setError(null);
    setLoading(true);
    try {
      const score = await api<LeadScore>(`/companies/${companyId}/lead-scores`, { method: 'POST' });
      onScored(score);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'AI 分析失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-violet-500" /> AI 匹配度分析
          </CardTitle>
          {latest ? (
            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${GRADE_STYLE[latest.grade ?? 'D']}`}>
              {latest.score} 分 · {latest.grade} 级
            </span>
          ) : (
            <Badge variant="secondary">未评分</Badge>
          )}
        </div>
        <CardDescription>
          六项解释性输出 · 权重：产品30/业务25/采购25/联系人10/地区10
          {latest?.model?.startsWith('mock') && ' · 当前为规则降级结果（未配置 LLM Key）'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {!latest && !loading && (
          <p className="text-sm text-muted-foreground">尚未评分——点击下方按钮发起 AI 匹配分析。</p>
        )}

        {latest && (
          <div className="space-y-4">
            {latest.subScores && (
              <div className="grid grid-cols-5 gap-2">
                {Object.entries(SUB_SCORE_LABELS).map(([key, label]) => {
                  const value = latest.subScores?.[key] ?? 0;
                  return (
                    <div key={key} className="space-y-1">
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-violet-500" style={{ width: `${value}%` }} />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        {label.split(' ')[0]} {value}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}

            <section aria-label="客户匹配原因">
              <h4 className="text-xs font-semibold uppercase text-muted-foreground">客户匹配原因</h4>
              <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
                {latest.matchReasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </section>

            <div className="grid gap-3 sm:grid-cols-2">
              {(
                [
                  ['潜在采购需求', latest.purchaseNeeds],
                  ['可能的合作机会', latest.opportunities],
                  ['客户开发建议', latest.suggestions],
                  ['数据缺失与不确定性', latest.uncertaintyNotes],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-md bg-muted/50 p-3">
                  <h4 className="text-xs font-semibold uppercase text-muted-foreground">{label}</h4>
                  <p className="mt-1 text-sm">{value ?? '—'}</p>
                </div>
              ))}
            </div>

            <p className="text-xs text-muted-foreground">
              模型：{latest.model ?? '—'}
              {latest.promptTokens != null && ` · tokens ${latest.promptTokens}/${latest.completionTokens ?? 0}`}
              {' · '}
              {new Date(latest.createdAt).toLocaleString()}（历史 {historyCount} 次）
            </p>
          </div>
        )}

        <Button variant="outline" size="sm" onClick={runScoring} disabled={loading}>
          {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {latest ? '重新评分' : '发起 AI 匹配分析'}
        </Button>
      </CardContent>
    </Card>
  );
}
