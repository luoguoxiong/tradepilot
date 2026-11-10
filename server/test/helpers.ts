import { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { createApp } from '../src/create-app';

export interface TestContext {
  app: INestApplication;
  token: string;
  email: string;
}

let appInstance: INestApplication | null = null;

/** 共享测试应用（整个 jest 进程一个实例，减少 BullMQ/Redis 重复连接） */
export async function getApp(): Promise<INestApplication> {
  if (!appInstance) {
    appInstance = await createApp();
    await appInstance.init();
  }
  return appInstance;
}

export async function closeApp(): Promise<void> {
  if (appInstance) {
    await appInstance.close();
    appInstance = null;
  }
}

let seq = 0;

/** 注册一个唯一测试用户并返回 token */
export async function registerUser(app: INestApplication): Promise<{ token: string; email: string }> {
  seq += 1;
  const email = `test-${Date.now()}-${seq}@tradepilot.test`;
  const res = await request(app.getHttpServer())
    .post('/api/auth/register')
    .send({ email, password: 'password-123', name: 'Test User' });
  if (res.status !== 201) {
    throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { token: res.body.token as string, email };
}

export function authGet(app: INestApplication, url: string, token: string) {
  return request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${token}`);
}

export function authPost(app: INestApplication, url: string, token: string, body?: object) {
  return request(app.getHttpServer()).post(url).set('Authorization', `Bearer ${token}`).send(body);
}

export function authPatch(app: INestApplication, url: string, token: string, body?: object) {
  return request(app.getHttpServer()).patch(url).set('Authorization', `Bearer ${token}`).send(body);
}

export function authDelete(app: INestApplication, url: string, token: string) {
  return request(app.getHttpServer()).delete(url).set('Authorization', `Bearer ${token}`);
}
