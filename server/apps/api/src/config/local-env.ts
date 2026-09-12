import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 本地开发便利（09 §4）：从当前文件目录逐级上溯查找仓库根的 `.env`
 * （server/.env），把其中缺失的键补齐到 `process.env`。
 *
 * 约束：
 * - 仅填充尚不存在的键，**不覆盖** k8s / CI / shell 已注入的变量；
 * - 找不到 `.env` 时静默跳过（生产镜像不携带该文件）；
 * - 只由进程入口（main.ts）调用，测试与库代码不受影响。
 */
export function loadLocalDotEnv(): void {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      applyDotEnvFile(candidate);
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** 极简 .env 解析：`KEY=VALUE` / `export KEY=VALUE`，支持引号与行内注释。 */
function applyDotEnvFile(filePath: string): void {
  for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match === null) continue;
    const [, key, raw = ''] = match;
    if (key === undefined || process.env[key] !== undefined) continue;
    let value = raw.trim();
    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(' #');
      if (commentAt !== -1) value = value.slice(0, commentAt).trim();
    }
    process.env[key] = value;
  }
}
