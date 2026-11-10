import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import type { CrmActivity } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CrmStatusBadge } from '@/pages/CrmPage';

const FLOW = ['NEW', 'QUALIFIED', 'CONTACTED', 'REPLIED', 'NEGOTIATING', 'WON', 'LOST'] as const;
const STATUS_LABELS: Record<string, string> = {
  NEW: '新客户',
  QUALIFIED: '已合格',
  CONTACTED: '已联系',
  REPLIED: '已回复',
  NEGOTIATING: '谈判中',
  WON: '已成交',
  LOST: '已流失',
};
const ACTIVITY_LABELS: Record<string, string> = {
  NOTE: '备注',
  STATUS_CHANGE: '状态',
  FOLLOW_UP: '跟进',
};

const inputCls =
  'flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

export function CrmStatusPanel({
  companyId,
  crmStatus,
  nextFollowUpAt,
  activities,
  onChanged,
}: {
  companyId: string;
  crmStatus: string;
  nextFollowUpAt: string | null;
  activities: CrmActivity[];
  onChanged: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [nextAt, setNextAt] = useState(nextFollowUpAt ? nextFollowUpAt.slice(0, 10) : '');

  async function transition(to: string) {
    setError(null);
    setLoading(true);
    try {
      await api(`/crm/customers/${companyId}/transition`, { method: 'POST', body: { to } });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '流转失败');
    } finally {
      setLoading(false);
    }
  }

  async function addActivity(e: FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    setError(null);
    setLoading(true);
    try {
      await api(`/crm/customers/${companyId}/activities`, {
        method: 'POST',
        body: {
          type: 'FOLLOW_UP',
          content: content.trim(),
          ...(nextAt ? { nextFollowUpAt: new Date(`${nextAt}T09:00:00Z`).toISOString() } : {}),
        },
      });
      setContent('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '添加失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">客户状态与跟进</CardTitle>
          <CrmStatusBadge status={crmStatus} />
        </div>
        <CardDescription>
          下次跟进：{nextFollowUpAt ? new Date(nextFollowUpAt).toLocaleDateString() : '未设置'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* 状态流转器：仅展示合法下一状态（服务端状态机兜底校验） */}
        <div className="flex flex-wrap items-center gap-1.5">
          {FLOW.map((s, i) => {
            const active = FLOW.indexOf(crmStatus as (typeof FLOW)[number]) === i;
            return (
              <span key={s} className="flex items-center gap-1.5">
                {i > 0 && <span className="text-muted-foreground">→</span>}
                <span className={`text-xs ${active ? 'font-bold text-foreground' : 'text-muted-foreground'}`}>
                  {STATUS_LABELS[s]}
                </span>
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {(['QUALIFIED', 'CONTACTED', 'REPLIED', 'NEGOTIATING', 'WON', 'LOST'] as const)
            .filter((s) => s !== crmStatus)
            .map((s) => (
              <Button key={s} variant="outline" size="sm" disabled={loading} onClick={() => transition(s)}>
                流转到「{STATUS_LABELS[s]}」
              </Button>
            ))}
        </div>

        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        <form onSubmit={addActivity} className="flex flex-wrap items-center gap-2">
          <input
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="跟进记录，如：发送样品目录"
            aria-label="跟进内容"
            className={`${inputCls} min-w-48 flex-1`}
          />
          <input
            type="date"
            value={nextAt}
            onChange={(e) => setNextAt(e.target.value)}
            aria-label="下次跟进日期"
            className={inputCls}
          />
          <Button type="submit" size="sm" disabled={loading || !content.trim()}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : null} 添加跟进
          </Button>
        </form>

        <ol className="max-h-64 space-y-2 overflow-y-auto border-t pt-3">
          {activities.length === 0 && <li className="text-sm text-muted-foreground">暂无跟进记录</li>}
          {activities.map((a) => (
            <li key={a.id} className="flex gap-2 text-sm">
              <span className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
                {ACTIVITY_LABELS[a.type] ?? a.type}
              </span>
              <div className="min-w-0">
                <p>{a.content}</p>
                <p className="text-xs text-muted-foreground">
                  {new Date(a.createdAt).toLocaleString()}
                  {a.nextFollowUpAt ? ` · 下次跟进 ${new Date(a.nextFollowUpAt).toLocaleDateString()}` : ''}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
