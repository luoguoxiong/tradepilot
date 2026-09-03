import './polyfill.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { config } from './config.js';
import { registerRoutes } from './routes.js';

const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });

await app.register(cors, { origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] });

app.setErrorHandler((err, _req, reply) => {
  console.error('[server] 未捕获错误:', err);
  reply.code(200).send({ code: 500, message: err.message?.slice(0, 300) || '服务器内部错误', data: null });
});

registerRoutes(app);

app.listen({ port: config.port, host: '127.0.0.1' })
  .then(() => console.log(`[server] TradePilot 后端已启动: http://localhost:${config.port}`))
  .catch((e) => {
    console.error('[server] 启动失败:', e);
    process.exit(1);
  });
