// 测试环境变量（config.ts 在首次 getEnv 时读取）
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_LIMIT_MAX = '1000'; // 测试不受登录限流影响
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-for-integration-suite';
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY || 'f'.repeat(64); // 测试固定加密密钥

// 测试强制走确定性 Mock 路径：把本机 .env 可能注入的真实第三方 Key 置空（dotenv 不覆盖已存在键），
// 保证测试可重复（LLM 评分波动=0）、不烧真实配额；真实 API 路径由 fetch mock 契约测试覆盖。
process.env.LLM_API_KEY = '';
process.env.SERPER_API_KEY = '';
process.env.APOLLO_API_KEY = '';
process.env.CUSTOMS_API_KEY = '';
