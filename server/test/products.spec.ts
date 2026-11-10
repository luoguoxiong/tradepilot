import { getApp, registerUser, authGet, authPost, authPatch, authDelete, closeApp } from './helpers';

describe('Products CRUD（含归属校验）', () => {
  let app: Awaited<ReturnType<typeof getApp>>;

  beforeAll(async () => {
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  it('创建 → 列表 → 修改 → 删除全链路', async () => {
    const { token, email } = await registerUser(app);

    const created = await authPost(app, '/api/products', token, {
      name: 'Carbon Fiber Insoles',
      keywords: ['carbon fiber insoles'],
      sellingPoints: ['Ultralight'],
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;

    const list = await authGet(app, '/api/products', token);
    expect(list.status).toBe(200);
    // 产品列表为小集合，直接返回数组
    expect((list.body as { id: string }[]).some((p) => p.id === id)).toBe(true);

    const patched = await authPatch(app, `/api/products/${id}`, token, { name: 'Carbon Insoles Pro' });
    expect(patched.status).toBe(200);
    expect(patched.body.name).toBe('Carbon Insoles Pro');

    const deleted = await authDelete(app, `/api/products/${id}`, token);
    expect(deleted.status).toBe(204);
    const after = await authGet(app, `/api/products/${id}`, token);
    expect(after.status).toBe(404);
    expect(email).toBeTruthy();
  });

  it('PATCH 空 body → 422；他人产品 → 404（IDOR 防护）', async () => {
    const userA = await registerUser(app);
    const userB = await registerUser(app);

    const empty = await authPatch(app, '/api/products/whatever', userA.token, {});
    expect(empty.status).toBe(422);

    const created = await authPost(app, '/api/products', userA.token, { name: 'A 产品' });
    const stolen = await authGet(app, `/api/products/${created.body.id}`, userB.token);
    expect(stolen.status).toBe(404);
  });
});
