import { useState } from 'react';
import { Check, Copy, Loader2, Mail, RefreshCw, Save } from 'lucide-react';

import { api, ApiError } from '@/lib/api';
import type { Contact, EmailDraft } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const inputCls =
  'flex min-h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`复制${label}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {copied ? '已复制' : '复制'}
    </Button>
  );
}

export function EmailDraftsCard({
  companyId,
  contacts,
  onSaved,
}: {
  companyId: string;
  contacts: Contact[];
  onSaved: () => void;
}) {
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [contactId, setContactId] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const active = drafts.find((d) => d.id === activeId) ?? null;

  function updateActive(patch: Partial<EmailDraft>) {
    if (!active) return;
    setDrafts((prev) => prev.map((d) => (d.id === active.id ? { ...d, ...patch } : d)));
  }

  async function generate() {
    setError(null);
    setMessage(null);
    setLoading(true);
    try {
      const draft = await api<EmailDraft>(`/companies/${companyId}/email-drafts`, {
        method: 'POST',
        body: contactId ? { contactId } : {},
      });
      setDrafts((prev) => [draft, ...prev].slice(0, 20));
      setActiveId(draft.id);
      setMessage('已生成新草稿（仅草稿，不自动发送）');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '生成失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  async function save() {
    if (!active) return;
    setError(null);
    setSaving(true);
    try {
      const saved = await api<EmailDraft>(`/companies/email-drafts/${active.id}`, {
        method: 'PATCH',
        body: {
          subject: active.subject,
          body: active.body,
          followUp1: active.followUp1 ?? '',
          followUp2: active.followUp2 ?? '',
        },
      });
      setDrafts((prev) => prev.map((d) => (d.id === saved.id ? saved : d)));
      setMessage('草稿已保存到 CRM');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="size-4 text-blue-500" /> 英文开发信（仅草稿）
        </CardTitle>
        <CardDescription>生成 → 编辑 → 复制/保存到 CRM；MVP 不自动发送</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            aria-label="选择收件联系人"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">收件人：未指定</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.title}）
              </option>
            ))}
          </select>
          <Button size="sm" onClick={generate} disabled={loading}>
            {loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            {drafts.length ? '重新生成' : '生成开发信'}
          </Button>
          {drafts.length > 0 && (
            <select
              value={activeId ?? ''}
              onChange={(e) => setActiveId(e.target.value)}
              aria-label="历史草稿"
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              {drafts.map((d, i) => (
                <option key={d.id} value={d.id}>
                  草稿 {drafts.length - i}（{d.model}）
                </option>
              ))}
            </select>
          )}
        </div>

        {message && (
          <p role="status" className="rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {message}
          </p>
        )}
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {active ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <input
                value={active.subject}
                onChange={(e) => updateActive({ subject: e.target.value })}
                aria-label="邮件主题"
                className={inputCls}
              />
              <CopyButton text={active.subject} label="主题" />
            </div>
            <div className="flex items-start gap-2">
              <textarea
                value={active.body}
                onChange={(e) => updateActive({ body: e.target.value })}
                aria-label="邮件正文"
                rows={10}
                className={`${inputCls} h-auto`}
              />
              <CopyButton text={active.body} label="正文" />
            </div>
            {(
              [
                ['Follow-up 1', 'followUp1'],
                ['Follow-up 2', 'followUp2'],
              ] as const
            ).map(([label, key]) => (
              <div key={key} className="flex items-start gap-2">
                <textarea
                  value={active[key] ?? ''}
                  onChange={(e) => updateActive({ [key]: e.target.value })}
                  aria-label={label}
                  rows={5}
                  className={`${inputCls} h-auto`}
                />
                <CopyButton text={active[key] ?? ''} label={label} />
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={saving}>
                <Save className="size-4" /> 保存草稿
              </Button>
              <span className="text-xs text-muted-foreground">
                模型：{active.model ?? '—'} · {new Date(active.createdAt).toLocaleString()}
              </span>
            </div>
          </div>
        ) : (
          !loading && <p className="text-sm text-muted-foreground">尚未生成——选择联系人（可选）后点击生成。</p>
        )}
      </CardContent>
    </Card>
  );
}
