'use strict';

const Fastify = require('fastify');
const { merge, MergeRequestError } = require('./merge');

const EXAMPLE_REQUEST = {
  base: {
    service: 'payment',
    replicas: 2,
    servers: ['a', 'b', 'c', 'd'],
    limits: { cpu: '500m', mem: '256Mi' },
  },
  patchA: [
    { op: 'remove', path: '/servers/0' },
    { op: 'replace', path: '/replicas', value: 3 },
  ],
  patchB: [
    { op: 'replace', path: '/servers/2', value: 'C' },
    { op: 'add', path: '/servers/1', value: 'b2' },
    { op: 'add', path: '/limits/timeout', value: '30s' },
  ],
};

function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger !== undefined ? opts.logger : { level: process.env.LOG_LEVEL || 'info' },
    bodyLimit: Number(process.env.BODY_LIMIT || 1024 * 1024),
  });

  app.get('/health', async () => ({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  app.get('/', async () => ({
    service: 'config-merge-rehearsal',
    description:
      '配置发布并发修改预演：提交基准文档与 A、B 两组 RFC 6902 补丁（仅 add/remove/replace），返回确定的合并结果或结构化冲突。',
    endpoints: {
      'POST /merge': '三方合并预演。Body: { "base": <any JSON>, "patchA": [...], "patchB": [...] }',
      'GET /health': '健康检查',
    },
    example: EXAMPLE_REQUEST,
  }));

  app.post('/merge', async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !('base' in body)) {
      return reply.code(400).send({
        status: 'error',
        error: {
          code: 'invalid_request',
          message: 'request body must be a JSON object containing "base", "patchA" and "patchB"',
        },
      });
    }
    try {
      const outcome = merge(body.base, body.patchA ?? [], body.patchB ?? []);
      if (outcome.status === 'conflict') return reply.code(409).send(outcome);
      return reply.code(200).send(outcome);
    } catch (err) {
      if (err instanceof MergeRequestError) {
        return reply.code(400).send({
          status: 'error',
          error: { code: 'invalid_patch', message: err.message, ...err.details },
        });
      }
      throw err;
    }
  });

  return app;
}

module.exports = { buildApp, EXAMPLE_REQUEST };
