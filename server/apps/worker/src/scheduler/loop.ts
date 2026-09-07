/**
 * 扫描循环基座（后端技术方案 04 §3.1）：setInterval + 串行 tick（上一轮未完不重叠）。
 * start() 返回 stop 函数（clearInterval + 等待在跑 tick 结束），供优雅停机调用。
 */
import type { Logger } from 'pino';

export function startLoop(
  name: string,
  intervalMs: number,
  tick: () => Promise<unknown>,
  logger: Logger,
): () => Promise<void> {
  let running = false;
  let stopping = false;
  let done: (() => void) | null = null;

  const timer = setInterval(() => {
    if (running || stopping) {
      return;
    }
    running = true;
    void tick().catch((err: unknown) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, `${name} 扫描失败`);
    }).finally(() => {
      running = false;
      if (stopping && done) {
        done();
      }
    });
  }, intervalMs);
  // 首轮立即执行
  void tick().catch((err: unknown) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, `${name} 首轮扫描失败`);
  });

  return async () => {
    stopping = true;
    clearInterval(timer);
    if (running) {
      await new Promise<void>((resolve) => {
        done = resolve;
      });
    }
  };
}
