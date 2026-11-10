import request from 'supertest';

import { getApp, authGet, closeApp } from './helpers';

describe('Auth（验收门：未登录访问业务接口返回 401）', () => {
  let app: ReturnType<typeof getApp> extends Promise<infer T> ? T : never;

  beforeAll(async () => {
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  it('未登录访问业务接口 → 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/products');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('注册 → 201 + token；重复注册 → 409 EMAIL_TAKEN', async () => {
    const email = `reg-${Date.now()}@tradepilot.test`;
    const ok = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'password-123', name: 'Reg Test' });
    expect(ok.status).toBe(201);
    expect(ok.body.token).toBeTruthy();
    expect(ok.body.user.email).toBe(email);
    expect(ok.body.user).not.toHaveProperty('passwordHash');

    const dup = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ email, password: 'password-123', name: 'Reg Test' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('非法请求体 → 422 VALIDATION_ERROR（zod 边界校验）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'not-an-email', password: '' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('错误密码 → 401 INVALID_CREDENTIALS（不区分邮箱/密码错误）', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: 'demo@tradepilot.dev', password: 'definitely-wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
  });

  it('GET /auth/me 带合法 token → 200；伪造 token → 401', async () => {
    const { token } = (
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'demo@tradepilot.dev', password: 'demo123456' })
    ).body;
    const me = await authGet(app, '/api/auth/me', token);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('demo@tradepilot.dev');

    const bad = await authGet(app, '/api/auth/me', 'fake.token.value');
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('INVALID_TOKEN');
  });
});
