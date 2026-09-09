-- 0007_manual · message.status 新增 waiting_approval（06 §1.2 send 分支 B：已提交等待审核）
-- 依据：06 接口文档 §1.2 MessageStatus = sent/draft/failed/waiting_approval（M5-C1 写侧）。
-- 幂等（pg_enum 存在性检查），由 src/migrate.ts 在 drizzle 产物之后按序执行。
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.msg_status'::regtype AND enumlabel = 'waiting_approval'
  ) THEN
    ALTER TYPE public.msg_status ADD VALUE 'waiting_approval';
  END IF;
END $$;
