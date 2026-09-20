'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { merge, MergeRequestError } = require('../src/merge');
const { buildApp, EXAMPLE_REQUEST } = require('../src/app');

// ---------------------------------------------------------------------------
// 合并引擎
// ---------------------------------------------------------------------------

test('非重叠修改合并：对象键 + 数组元素', () => {
  const out = merge(
    { replicas: 2, mode: 'a', servers: ['x', 'y'] },
    [{ op: 'replace', path: '/replicas', value: 3 }],
    [{ op: 'replace', path: '/mode', value: 'b' }, { op: 'replace', path: '/servers/1', value: 'Y' }]
  );
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.result, { replicas: 3, mode: 'b', servers: ['x', 'Y'] });
});

test('索引漂移重定位：A 删除头部元素，B 按基准索引修改的元素不错位', () => {
  const out = merge(
    { servers: ['a', 'b', 'c', 'd'] },
    [{ op: 'remove', path: '/servers/0' }],
    [{ op: 'replace', path: '/servers/2', value: 'C' }]
  );
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.result.servers, ['b', 'C', 'd']); // 修改落在基准元素 c 上，而非漂移后的 d
});

test('同一插入缝隙按 A 后 B 定序', () => {
  const out = merge(
    { list: ['x', 'y'] },
    [
      { op: 'add', path: '/list/1', value: 'a1' },
      { op: 'add', path: '/list/1', value: 'a2' },
    ],
    [{ op: 'add', path: '/list/1', value: 'b1' }]
  );
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.result.list, ['x', 'a2', 'a1', 'b1', 'y']);
});

test('不同缝隙插入 + 删除同时发生', () => {
  const out = merge(
    { list: ['a', 'b', 'c'] },
    [{ op: 'remove', path: '/list/2' }, { op: 'add', path: '/list/0', value: 'head' }],
    [{ op: 'add', path: '/list/-', value: 'tail' }]
  );
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.result.list, ['head', 'a', 'b', 'tail']);
});

test('双方完全相同的修改被去重', () => {
  const out = merge(
    { replicas: 2, servers: ['a'] },
    [{ op: 'replace', path: '/replicas', value: 3 }, { op: 'add', path: '/servers/-', value: 'b' }],
    [{ op: 'replace', path: '/replicas', value: 3 }, { op: 'add', path: '/servers/-', value: 'b' }]
  );
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.result, { replicas: 3, servers: ['a', 'b'] });
  assert.equal(out.stats.deduplicated, 2);
});

test('replace 冲突：同一路径替换为不同值', () => {
  const out = merge(
    { replicas: 2 },
    [{ op: 'replace', path: '/replicas', value: 3 }],
    [{ op: 'replace', path: '/replicas', value: 5 }]
  );
  assert.equal(out.status, 'conflict');
  assert.equal(out.conflicts.length, 1);
  const c = out.conflicts[0];
  assert.equal(c.type, 'replace_conflict');
  assert.equal(c.basePath, '/replicas');
  assert.equal(c.a.opIndex, 0);
  assert.equal(c.b.opIndex, 0);
  assert.ok(c.reason.length > 0);
});

test('delete_vs_modify：A 删除数组元素，B 修改同一元素', () => {
  const out = merge(
    { servers: ['a', 'b', 'c'] },
    [{ op: 'remove', path: '/servers/1' }],
    [{ op: 'replace', path: '/servers/1', value: 'B' }]
  );
  assert.equal(out.status, 'conflict');
  const c = out.conflicts[0];
  assert.equal(c.type, 'delete_vs_modify');
  assert.equal(c.basePath, '/servers/1');
  assert.match(c.path, /^\/servers\/#\d+$/); // 规范化路径使用元素身份
});

test('delete_vs_modify：A 删除对象子树，B 修改其内部键', () => {
  const out = merge(
    { limits: { cpu: '500m', mem: '256Mi' }, keep: 1 },
    [{ op: 'remove', path: '/limits' }],
    [{ op: 'replace', path: '/limits/cpu', value: '1' }]
  );
  assert.equal(out.status, 'conflict');
  assert.equal(out.conflicts[0].type, 'delete_vs_modify');
  assert.equal(out.conflicts[0].basePath, '/limits');
});

test('add 冲突：双方新增同名键但值不同', () => {
  const out = merge(
    {},
    [{ op: 'add', path: '/mode', value: 'x' }],
    [{ op: 'add', path: '/mode', value: 'y' }]
  );
  assert.equal(out.status, 'conflict');
  assert.equal(out.conflicts[0].type, 'add_conflict');
});

test('replace_vs_modify：A 整体替换数组，B 删除其中元素', () => {
  const out = merge(
    { servers: ['a', 'b'] },
    [{ op: 'replace', path: '/servers', value: ['z'] }],
    [{ op: 'remove', path: '/servers/0' }]
  );
  assert.equal(out.status, 'conflict');
  assert.equal(out.conflicts[0].type, 'replace_vs_modify');
});

test('双方删除同一元素不冲突（幂等去重）', () => {
  const out = merge(
    { servers: ['a', 'b'] },
    [{ op: 'remove', path: '/servers/0' }],
    [{ op: 'remove', path: '/servers/0' }]
  );
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.result.servers, ['b']);
});

test('嵌套路径与顺序补丁（同侧多步操作折叠）', () => {
  const out = merge(
    { a: { b: { c: 1, d: 2 } }, list: [1, 2, 3] },
    [
      { op: 'replace', path: '/a/b/c', value: 10 },
      { op: 'remove', path: '/a/b/d' },
      { op: 'add', path: '/list/0', value: 0 },
      { op: 'replace', path: '/list/0', value: -1 }, // 修改刚插入的元素
    ],
    [{ op: 'add', path: '/a/b/e', value: 5 }]
  );
  assert.equal(out.status, 'merged');
  assert.deepEqual(out.result, { a: { b: { c: 10, e: 5 } }, list: [-1, 1, 2, 3] });
});

test('非法操作（move）被拒绝', () => {
  assert.throws(
    () => merge({}, [{ op: 'move', from: '/a', path: '/b' }], []),
    (err) => err instanceof MergeRequestError && err.details.opIndex === 0
  );
});

test('路径不存在被拒绝并报告 opIndex', () => {
  assert.throws(
    () => merge({ a: 1 }, [], [{ op: 'replace', path: '/nope', value: 1 }]),
    (err) => err instanceof MergeRequestError && err.details.opIndex === 0
  );
});

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

test('GET /health 返回 ok', async () => {
  const app = buildApp({ logger: false });
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  await app.close();
});

test('POST /merge 成功合并示例请求', async () => {
  const app = buildApp({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/merge', payload: EXAMPLE_REQUEST });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'merged');
  assert.deepEqual(body.result.servers, ['b2', 'b', 'C', 'd']); // 索引漂移已重定位
  assert.equal(body.result.replicas, 3);
  assert.equal(body.result.limits.timeout, '30s');
  await app.close();
});

test('POST /merge 冲突返回 409 与结构化冲突', async () => {
  const app = buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST',
    url: '/merge',
    payload: {
      base: { replicas: 2 },
      patchA: [{ op: 'replace', path: '/replicas', value: 3 }],
      patchB: [{ op: 'replace', path: '/replicas', value: 5 }],
    },
  });
  assert.equal(res.statusCode, 409);
  const body = res.json();
  assert.equal(body.status, 'conflict');
  assert.equal(body.conflicts[0].type, 'replace_conflict');
  assert.equal(body.conflicts[0].a.opIndex, 0);
  await app.close();
});

test('POST /merge 非法补丁返回 400', async () => {
  const app = buildApp({ logger: false });
  const res = await app.inject({
    method: 'POST',
    url: '/merge',
    payload: { base: {}, patchA: [{ op: 'copy', from: '/a', path: '/b' }], patchB: [] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, 'invalid_patch');
  await app.close();
});

test('POST /merge 缺少 base 返回 400', async () => {
  const app = buildApp({ logger: false });
  const res = await app.inject({ method: 'POST', url: '/merge', payload: { patchA: [] } });
  assert.equal(res.statusCode, 400);
  await app.close();
});
