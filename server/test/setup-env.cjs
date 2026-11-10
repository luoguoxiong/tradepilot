// 测试环境变量（config.ts 在首次 getEnv 时读取）
process.env.NODE_ENV = 'test';
process.env.AUTH_RATE_LIMIT_MAX = '1000'; // 测试不受登录限流影响
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-only-secret-for-integration-suite';
process.env.APP_ENCRYPTION_KEY =
  process.env.APP_ENCRYPTION_KEY || 'f'.repeat(64); // 测试固定加密密钥
