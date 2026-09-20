# config-merge-rehearsal

配置发布系统的并发修改预演服务。客户端提交**基准 JSON 文档**与 **A、B 两组 RFC 6902 补丁**（仅接受 `add` / `remove` / `replace`），服务返回**确定的合并结果**；若双方修改不可调和，则返回**结构化冲突**（含双方操作序号、规范化路径与原因）。

技术栈：Node.js 20+ · Fastify 5 · 纯内存计算（无外部存储，每次请求独立合并）。

## 快速开始

单条启动命令（依赖安装已纳入镜像构建，启动即就绪）：

```bash
docker compose up --build
```

服务地址：**http://localhost:3000**（容器内监听 `0.0.0.0:3000`）。

本地开发（不使用 Docker）：

```bash
npm install && npm start   # 监听 http://localhost:3000
npm test                   # 运行测试
```

## 配置项

均通过环境变量配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LOG_LEVEL` | `info` | Fastify 日志级别（`debug`/`info`/`warn`/`error` 等） |
| `BODY_LIMIT` | `1048576` | 请求体大小上限（字节） |

## API

### `GET /health` — 健康检查

```json
{ "status": "ok", "uptime": 1.5, "timestamp": "2026-09-20T06:24:11.092Z" }
```

### `GET /` — 服务说明与示例请求

### `POST /merge` — 合并预演

请求体：

```json
{
  "base":   { "replicas": 2, "servers": ["a", "b", "c", "d"] },
  "patchA": [ { "op": "remove", "path": "/servers/0" } ],
  "patchB": [ { "op": "replace", "path": "/servers/2", "value": "C" } ]
}
```

- `base`：任意 JSON 文档（对象、数组、标量均可）。
- `patchA` / `patchB`：RFC 6902 操作数组，仅 `add` / `remove` / `replace`；省略时视为空补丁。每组补丁内部按数组顺序依次作用于基准文档。

**200 合并成功**：

```json
{
  "status": "merged",
  "result": { "replicas": 2, "servers": ["b", "c", "d"] },
  "stats": { "receivedA": 1, "receivedB": 1, "effectiveA": 1, "effectiveB": 1, "deduplicated": 0, "applied": 2 }
}
```

**409 冲突**（`conflicts` 按路径排序，顺序确定）：

```json
{
  "status": "conflict",
  "conflicts": [
    {
      "type": "delete_vs_modify",
      "path": "/servers/#2",
      "basePath": "/servers/1",
      "reason": "one side removes this path while the other side modifies it",
      "a": { "opIndex": 0, "op": { "op": "remove", "path": "/servers/1" } },
      "b": { "opIndex": 0, "op": { "op": "replace", "path": "/servers/1", "value": "B2" } }
    }
  ]
}
```

**400 请求/补丁非法**（不支持的操作、路径格式错误、路径不存在、缺少 `value` 等）：

```json
{ "status": "error", "error": { "code": "invalid_patch", "message": "unsupported op \"move\" — only add, remove, replace are accepted", "opIndex": 0, "side": "A" } }
```

## 合并规则

- **基准索引标识原元素**：基准数组的每个元素按其在基准中的索引获得稳定身份。补丁中的数组下标一律先解析为元素身份，因此一方增删造成的**索引漂移会被自动重定位**——例如 A 删除 `servers/0` 后，B 对 `servers/2` 的 `replace` 仍作用于基准元素 `c`，而不是漂移后的 `d`。
- **同一插入缝隙按 A 后 B 定序**：插入位置以“其后第一个基准元素”为锚点（缝隙）。双方插入同一缝隙时，A 的插入（保持 A 内部顺序）整体排在 B 的插入之前；不同缝隙按基准顺序展开。
- **去重**：双方完全相同的修改（同路径同值的 `replace`/`add`、同目标的 `remove`、同缝隙同值的插入）只应用一次；双方删除同一元素不冲突。
- **冲突类型**：
  | `type` | 含义 |
  | --- | --- |
  | `delete_vs_modify` | 一方删除某元素/对象路径（或其祖先），另一方修改该路径或其子孙 |
  | `replace_conflict` | 双方对同一目标 `replace` 为不同值 |
  | `add_conflict` | 双方 `add` 同一对象键但值不同 |
  | `replace_vs_modify` | 一方整体替换某容器（数组/对象），另一方修改其内部 |
- **冲突结构**：每条冲突包含 `type`、`path`（规范化路径，数组元素以 `#<id>` 身份表示）、`basePath`（基准索引视角的 JSON Pointer）、`reason`，以及 `a` / `b` 双方各自的 `opIndex`（补丁中的操作序号，取产生最终效果的那一条）与原始操作 `op`。
- 补丁只接受 `add` / `remove` / `replace`；`move` / `copy` / `test` 及非法路径返回 400。根路径 `""` 支持整体替换，不支持删除根。

## 示例请求

```bash
# 健康检查
curl http://localhost:3000/health

# 合并成功（索引漂移重定位 + 同缝隙定序）
curl -X POST http://localhost:3000/merge \
  -H 'Content-Type: application/json' \
  --data @examples/merge-request.json

# 触发冲突（delete_vs_modify + replace_conflict）
curl -X POST http://localhost:3000/merge \
  -H 'Content-Type: application/json' \
  --data @examples/merge-conflict.json
```

`examples/merge-request.json` 的合并结果为：

```json
{
  "service": "payment",
  "replicas": 3,
  "servers": ["b2", "b", "C", "d"],
  "limits": { "cpu": "500m", "mem": "256Mi", "timeout": "30s" }
}
```

其中 A 删除了 `servers/0`（`a`），B 对基准索引 2 的替换仍正确落在元素 `c` 上，B 在缝隙 1 插入的 `b2` 位于保留元素 `b` 之前。

## 项目结构

```
├── src/
│   ├── merge.js    # 合并引擎：身份标注、补丁规范化、冲突检测、确定性应用
│   ├── app.js      # Fastify 路由（/health、/、/merge）
│   └── server.js   # 启动入口（读取 PORT/HOST 等配置，优雅退出）
├── test/merge.test.js
├── examples/       # 示例请求（合并 / 冲突）
├── Dockerfile
└── docker-compose.yml
```
