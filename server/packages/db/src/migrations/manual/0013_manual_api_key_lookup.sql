-- 0013_manual · api_key 鉴权查找策略（P1-X-22 / 06 §5.1）
-- 依据：ER 01 §2.9 `api_key`（`key_hash` 唯一索引）+ 0001 §3 `login_lookup` 同构范式。
-- 背景：入站开放 API 请求只带 `x-api-key`，此时 org 未知，无法用 withOrg 打开 org 上下文；
--       故追加 apikey_lookup 策略：仅当 `app.apikey='1'`（ApiKeyService 专用事务）时放行 SELECT，
--       且调用方必须以 key_hash（sha256）等值命中——明文永不落库、不参与查询。
-- 范围：仅 FOR SELECT（不在该上下文写）；写操作（last_used_at 记账）仍走 withOrg。
-- 幂等，由 src/migrate.ts 在 drizzle 产物之后按序执行。

DO $$
BEGIN
  ALTER TABLE public.api_key ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.api_key FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS apikey_lookup ON public.api_key;
  CREATE POLICY apikey_lookup ON public.api_key
    FOR SELECT
    USING (current_setting('app.apikey', true)::text = '1');
END $$;
