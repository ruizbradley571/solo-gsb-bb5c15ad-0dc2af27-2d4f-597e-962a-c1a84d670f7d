'use strict';

/**
 * 并发补丁合并引擎。
 *
 * 思路：
 * 1. 给基准文档的每个数组元素分配稳定身份 id（与基准数组索引一一对应，见 ctx.idOrigin）。
 * 2. A、B 两组补丁分别在带身份标注的基准副本上按 RFC 6902 语义顺序执行，
 *    再通过结构化 diff 提取“规范化变更”——数组位置一律用元素身份 id 表示，
 *    因此天然不受增删造成的索引漂移影响。
 * 3. 对双方规范化变更做路径前缀匹配，识别冲突；无冲突时按确定顺序应用：
 *    数组插入按“缝隙”（插入锚点 = 其后第一个基准元素）分组，同一缝隙内 A 的插入在前、B 的在后。
 */

/** 带身份标注的数组节点：items 元素携带基准身份 id */
class Arr {
  constructor(items) {
    this.items = items; // [{ id, value }]
  }
}

class MergeRequestError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MergeRequestError';
    this.statusCode = 400;
    this.details = details;
  }
}

const isObj = (x) =>
  x !== null && typeof x === 'object' && !Array.isArray(x) && !(x instanceof Arr);

const clone = (x) => structuredClone(x);

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr || bArr) {
    if (!aArr || !bArr || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => k in b && deepEqual(a[k], b[k]));
}

// ---------------------------------------------------------------------------
// JSON Pointer（RFC 6901）
// ---------------------------------------------------------------------------

function parsePointer(path, opIndex, side) {
  if (typeof path !== 'string') {
    throw new MergeRequestError('patch op requires a string "path"', { opIndex, side });
  }
  if (path === '') return [];
  if (!path.startsWith('/')) {
    throw new MergeRequestError(`invalid JSON pointer: ${path}`, { opIndex, side, path });
  }
  return path
    .split('/')
    .slice(1)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

const escSeg = (s) => s.replace(/~/g, '~0').replace(/\//g, '~1');

// ---------------------------------------------------------------------------
// 标注 / 复制 / 去标注
// ---------------------------------------------------------------------------

function annotate(node, ctx) {
  if (Array.isArray(node)) {
    return new Arr(
      node.map((v, i) => {
        const id = ctx.nextId++;
        ctx.idOrigin.set(id, i); // id -> 基准数组索引
        return { id, value: annotate(v, ctx) };
      })
    );
  }
  if (isObj(node)) {
    const o = {};
    for (const k of Object.keys(node)) o[k] = annotate(node[k], ctx);
    return o;
  }
  return node;
}

function copyAnnotated(node) {
  if (node instanceof Arr) {
    return new Arr(node.items.map((it) => ({ id: it.id, value: copyAnnotated(it.value) })));
  }
  if (Array.isArray(node)) return node.map(copyAnnotated);
  if (isObj(node)) {
    const o = {};
    for (const k of Object.keys(node)) o[k] = copyAnnotated(node[k]);
    return o;
  }
  return node;
}

function deannotate(node) {
  if (node instanceof Arr) return node.items.map((it) => deannotate(it.value));
  if (Array.isArray(node)) return node.map(deannotate);
  if (isObj(node)) {
    const o = {};
    for (const k of Object.keys(node)) o[k] = deannotate(node[k]);
    return o;
  }
  return node;
}

// ---------------------------------------------------------------------------
// 单条补丁操作的应用（作用于标注结构；插入/替换内容保持为纯 JSON）
// ---------------------------------------------------------------------------

function parseIndex(seg, length, allowDash, opIndex, side, path) {
  if (seg === '-') {
    if (allowDash) return length;
    throw new MergeRequestError('"-" is only valid as the last segment of an add path', {
      opIndex, side, path,
    });
  }
  if (!/^\d+$/.test(seg)) {
    throw new MergeRequestError(`invalid array index: ${seg}`, { opIndex, side, path });
  }
  return Number(seg);
}

function descend(node, seg, opIndex, side, path) {
  if (node instanceof Arr) {
    const i = parseIndex(seg, node.items.length, false, opIndex, side, path);
    if (i >= node.items.length) {
      throw new MergeRequestError(`array index out of bounds: ${seg}`, { opIndex, side, path });
    }
    return node.items[i].value;
  }
  if (Array.isArray(node)) {
    const i = parseIndex(seg, node.length, false, opIndex, side, path);
    if (i >= node.length) {
      throw new MergeRequestError(`array index out of bounds: ${seg}`, { opIndex, side, path });
    }
    return node[i];
  }
  if (isObj(node)) {
    if (!(seg in node)) {
      throw new MergeRequestError(`path not found: ${seg}`, { opIndex, side, path });
    }
    return node[seg];
  }
  throw new MergeRequestError(`cannot descend into a primitive value at: ${seg}`, {
    opIndex, side, path,
  });
}

function applyOp(work, rawOp, opIndex, side, ctx) {
  const segs = parsePointer(rawOp.path, opIndex, side);
  if (segs.length === 0) {
    if (rawOp.op === 'remove') {
      throw new MergeRequestError('removing the document root is not supported', {
        opIndex, side, path: rawOp.path,
      });
    }
    return clone(rawOp.value); // add/replace 作用于根 == 整体替换
  }
  let parent = work;
  for (let i = 0; i < segs.length - 1; i++) {
    parent = descend(parent, segs[i], opIndex, side, rawOp.path);
  }
  const last = segs[segs.length - 1];

  if (parent instanceof Arr) {
    const items = parent.items;
    if (rawOp.op === 'add') {
      const i = parseIndex(last, items.length, true, opIndex, side, rawOp.path);
      if (i > items.length) {
        throw new MergeRequestError(`array index out of bounds: ${last}`, { opIndex, side, path: rawOp.path });
      }
      items.splice(i, 0, { id: ctx.nextId++, value: clone(rawOp.value) });
    } else {
      const i = parseIndex(last, items.length, false, opIndex, side, rawOp.path);
      if (i >= items.length) {
        throw new MergeRequestError(`array index out of bounds: ${last}`, { opIndex, side, path: rawOp.path });
      }
      if (rawOp.op === 'remove') items.splice(i, 1);
      else items[i] = { id: items[i].id, value: clone(rawOp.value) }; // 保留元素身份
    }
    return work;
  }

  if (Array.isArray(parent)) {
    if (rawOp.op === 'add') {
      const i = parseIndex(last, parent.length, true, opIndex, side, rawOp.path);
      if (i > parent.length) {
        throw new MergeRequestError(`array index out of bounds: ${last}`, { opIndex, side, path: rawOp.path });
      }
      parent.splice(i, 0, clone(rawOp.value));
    } else {
      const i = parseIndex(last, parent.length, false, opIndex, side, rawOp.path);
      if (i >= parent.length) {
        throw new MergeRequestError(`array index out of bounds: ${last}`, { opIndex, side, path: rawOp.path });
      }
      if (rawOp.op === 'remove') parent.splice(i, 1);
      else parent[i] = clone(rawOp.value);
    }
    return work;
  }

  if (isObj(parent)) {
    if (rawOp.op === 'add') {
      parent[last] = clone(rawOp.value); // RFC 6902：add 到已存在的键等价于替换
    } else if (rawOp.op === 'remove') {
      if (!(last in parent)) {
        throw new MergeRequestError(`path not found: ${last}`, { opIndex, side, path: rawOp.path });
      }
      delete parent[last];
    } else {
      if (!(last in parent)) {
        throw new MergeRequestError(`path not found: ${last}`, { opIndex, side, path: rawOp.path });
      }
      parent[last] = clone(rawOp.value);
    }
    return work;
  }

  throw new MergeRequestError('cannot apply op at the given path', { opIndex, side, path: rawOp.path });
}

// ---------------------------------------------------------------------------
// 结构化 diff：基准身份视角下的规范化变更
//   change = { kind: 'remove'|'replace'|'add'|'insert', segs, value?, before?, insertId? }
//   segs 元素：{ t:'key', k } | { t:'elem', id }
//   insert 的 segs 为数组（容器）路径，before 为锚点元素 id（null 表示末尾）
// ---------------------------------------------------------------------------

const keySeg = (k) => ({ t: 'key', k });
const elemSeg = (id) => ({ t: 'elem', id });

function diff(b, n, segs, out) {
  if (b instanceof Arr) {
    if (n instanceof Arr) {
      diffArr(b, n, segs, out);
    } else {
      out.push({ kind: 'replace', segs, value: clone(deannotate(n)) });
    }
    return;
  }
  if (Array.isArray(b)) {
    if (!deepEqual(b, n)) out.push({ kind: 'replace', segs, value: clone(deannotate(n)) });
    return;
  }
  if (isObj(b)) {
    if (!isObj(n)) {
      out.push({ kind: 'replace', segs, value: clone(deannotate(n)) });
      return;
    }
    for (const k of Object.keys(b)) {
      if (!(k in n)) out.push({ kind: 'remove', segs: [...segs, keySeg(k)] });
    }
    for (const k of Object.keys(n)) {
      if (!(k in b)) {
        out.push({ kind: 'add', segs: [...segs, keySeg(k)], value: clone(deannotate(n[k])) });
      } else {
        diff(b[k], n[k], [...segs, keySeg(k)], out);
      }
    }
    return;
  }
  if (!deepEqual(b, n)) out.push({ kind: 'replace', segs, value: clone(deannotate(n)) });
}

function diffArr(b, n, segs, out) {
  const baseById = new Map(b.items.map((it) => [it.id, it]));
  const nIds = new Set(n.items.map((it) => it.id));
  for (const it of b.items) {
    if (!nIds.has(it.id)) out.push({ kind: 'remove', segs: [...segs, elemSeg(it.id)] });
  }
  for (let i = 0; i < n.items.length; i++) {
    const it = n.items[i];
    if (!baseById.has(it.id)) {
      // 插入缝隙：锚定其后第一个基准元素；没有则为末尾缝隙
      let before = null;
      for (let j = i + 1; j < n.items.length; j++) {
        if (baseById.has(n.items[j].id)) {
          before = n.items[j].id;
          break;
        }
      }
      out.push({ kind: 'insert', segs, before, insertId: it.id, value: clone(deannotate(it.value)) });
    } else {
      diff(baseById.get(it.id).value, it.value, [...segs, elemSeg(it.id)], out);
    }
  }
}

// ---------------------------------------------------------------------------
// 补丁规范化：顺序执行 + 最终 diff + 操作序号溯源
// ---------------------------------------------------------------------------

const ALLOWED_OPS = new Set(['add', 'remove', 'replace']);

function validateOp(op, i, side) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) {
    throw new MergeRequestError(`patch ${side}[${i}] must be an object`, { opIndex: i, side });
  }
  if (!ALLOWED_OPS.has(op.op)) {
    throw new MergeRequestError(
      `unsupported op ${JSON.stringify(op.op)} — only add, remove, replace are accepted`,
      { opIndex: i, side, op: op.op }
    );
  }
  if (typeof op.path !== 'string') {
    throw new MergeRequestError('patch op requires a string "path"', { opIndex: i, side });
  }
  if (op.op !== 'remove' && !('value' in op)) {
    throw new MergeRequestError(`op "${op.op}" requires a "value"`, { opIndex: i, side });
  }
}

const pathStr = (segs) => segs.map((s) => (s.t === 'key' ? `k:${s.k}` : `e:${s.id}`)).join('/');

function normalizePatch(baseAnn, patch, side, ctx) {
  let work = copyAnnotated(baseAnn);
  const provPath = new Map(); // pathStr -> Map(kind -> opIndex)
  const provInsert = new Map(); // insertId -> opIndex

  for (let i = 0; i < patch.length; i++) {
    validateOp(patch[i], i, side);
    const before = copyAnnotated(work);
    work = applyOp(work, patch[i], i, side, ctx);
    const changes = [];
    diff(before, work, [], changes);
    for (const ch of changes) {
      if (ch.kind === 'insert') {
        provInsert.set(ch.insertId, i);
      } else {
        const p = pathStr(ch.segs);
        if (!provPath.has(p)) provPath.set(p, new Map());
        provPath.get(p).set(ch.kind, i);
      }
    }
  }

  const finalChanges = [];
  diff(baseAnn, work, [], finalChanges);
  for (const ch of finalChanges) {
    let idx;
    if (ch.kind === 'insert') {
      idx = provInsert.get(ch.insertId);
    } else {
      const m = provPath.get(pathStr(ch.segs));
      idx = m && m.get(ch.kind);
      if (idx === undefined && m) idx = Math.max(...m.values());
    }
    ch.opIndex = idx ?? 0;
    ch.side = side;
    ch.raw = patch[ch.opIndex];
  }
  return finalChanges;
}

// ---------------------------------------------------------------------------
// 冲突检测
// ---------------------------------------------------------------------------

function pathRelation(a, b) {
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m; i++) {
    const x = a[i];
    const y = b[i];
    if (x.t !== y.t) return 'none';
    if (x.t === 'key' && x.k !== y.k) return 'none';
    if (x.t === 'elem' && x.id !== y.id) return 'none';
  }
  if (a.length === b.length) return 'equal';
  return a.length < b.length ? 'a-parent' : 'b-parent';
}

/**
 * 返回 null（兼容）| { drop }（去重/吸收，丢弃 target）| { conflict: {...} }
 */
function conflictBetween(a, b) {
  const rel = pathRelation(a.segs, b.segs);
  if (rel === 'none') return null;

  if (rel === 'equal') {
    const kinds = `${a.kind}+${b.kind}`;
    switch (kinds) {
      case 'remove+remove':
        return { drop: b };
      case 'replace+replace':
        return deepEqual(a.value, b.value)
          ? { drop: b }
          : mkConflict('replace_conflict', a, b, a.segs,
              'both sides replace the same target with different values');
      case 'add+add':
        return deepEqual(a.value, b.value)
          ? { drop: b }
          : mkConflict('add_conflict', a, b, a.segs,
              'both sides add the same key with different values');
      case 'insert+insert':
        // 同一插入缝隙：按 A 后 B 定序，二者都保留；完全相同的插入去重
        return a.before === b.before && deepEqual(a.value, b.value) ? { drop: b } : null;
      case 'remove+replace':
      case 'replace+remove':
      case 'remove+add':
      case 'add+remove':
        return mkConflict('delete_vs_modify', a, b, a.segs,
          'one side removes this path while the other side modifies it');
      case 'remove+insert':
      case 'insert+remove':
        return mkConflict('delete_vs_modify', a, b, a.segs,
          'one side removes the array while the other side inserts into it');
      case 'replace+insert':
      case 'insert+replace':
        return mkConflict('replace_vs_modify', a, b, a.segs,
          'one side replaces the array while the other side inserts into it');
      default:
        return mkConflict('replace_vs_modify', a, b, a.segs,
          'conflicting operations on the same path');
    }
  }

  const up = rel === 'a-parent' ? a : b;
  const down = rel === 'a-parent' ? b : a;
  if (up.kind === 'remove') {
    if (down.kind === 'remove') return { drop: down }; // 祖先删除已覆盖
    return mkConflict('delete_vs_modify', up, down, up.segs,
      'one side removes an ancestor of a path the other side modifies');
  }
  if (up.kind === 'replace') {
    return mkConflict('replace_vs_modify', up, down, up.segs,
      'one side replaces a container while the other side modifies its content');
  }
  if (up.kind === 'add') {
    return mkConflict('add_conflict', up, down, up.segs,
      'concurrent modification under an added key');
  }
  return null; // insert 不影响既有元素
}

function mkConflict(type, x, y, segs, reason) {
  return { conflict: { type, segs, reason, x, y } };
}

// ---------------------------------------------------------------------------
// 合并应用（无冲突时）
// ---------------------------------------------------------------------------

function navigate(node, segs) {
  for (const s of segs) {
    if (s.t === 'elem') {
      const idx = node.items.findIndex((it) => it.id === s.id);
      node = node.items[idx].value;
    } else {
      node = node[s.k];
    }
  }
  return node;
}

function applyChange(work, ch, ctx) {
  if (ch.kind === 'insert') {
    const arr = navigate(work, ch.segs);
    let idx = arr.items.length;
    if (ch.before !== null) {
      const found = arr.items.findIndex((it) => it.id === ch.before);
      if (found !== -1) idx = found;
    }
    arr.items.splice(idx, 0, { id: ctx.nextId++, value: clone(ch.value) });
    return work;
  }
  if (ch.segs.length === 0) return clone(ch.value); // 根替换
  const parent = navigate(work, ch.segs.slice(0, -1));
  const last = ch.segs[ch.segs.length - 1];
  if (last.t === 'elem') {
    const idx = parent.items.findIndex((it) => it.id === last.id);
    if (idx === -1) return work; // 防御：目标已不存在
    if (ch.kind === 'remove') parent.items.splice(idx, 1);
    else parent.items[idx] = { id: last.id, value: clone(ch.value) };
  } else {
    if (ch.kind === 'remove') delete parent[last.k];
    else parent[last.k] = clone(ch.value);
  }
  return work;
}

// ---------------------------------------------------------------------------
// 输出路径
// ---------------------------------------------------------------------------

function normPointer(segs) {
  if (segs.length === 0) return '';
  return '/' + segs.map((s) => (s.t === 'key' ? escSeg(s.k) : `#${s.id}`)).join('/');
}

function basePointer(segs, ctx) {
  if (segs.length === 0) return '';
  return (
    '/' +
    segs
      .map((s) => {
        if (s.t === 'key') return escSeg(s.k);
        const idx = ctx.idOrigin.get(s.id);
        return idx === undefined ? `#${s.id}` : String(idx);
      })
      .join('/')
  );
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function merge(base, patchA, patchB) {
  if (!Array.isArray(patchA) || !Array.isArray(patchB)) {
    throw new MergeRequestError('patchA and patchB must be arrays of RFC 6902 operations');
  }
  const ctx = { nextId: 1, idOrigin: new Map() };
  const baseAnn = annotate(base, ctx);

  const changesA = normalizePatch(baseAnn, patchA, 'A', ctx);
  const changesB = normalizePatch(baseAnn, patchB, 'B', ctx);

  const conflicts = [];
  const drops = new Set();
  for (const a of changesA) {
    for (const b of changesB) {
      const r = conflictBetween(a, b);
      if (!r) continue;
      if (r.drop) drops.add(r.drop);
      else conflicts.push(r.conflict);
    }
  }

  if (conflicts.length > 0) {
    const out = conflicts.map((c) => {
      const [first, second] = c.x.side === 'A' ? [c.x, c.y] : [c.y, c.x];
      return {
        type: c.type,
        path: normPointer(c.segs),
        basePath: basePointer(c.segs, ctx),
        reason: c.reason,
        a: { opIndex: first.opIndex, op: first.raw },
        b: { opIndex: second.opIndex, op: second.raw },
      };
    });
    out.sort((x, y) =>
      x.path < y.path ? -1 : x.path > y.path ? 1 : x.type < y.type ? -1 : x.type > y.type ? 1 : 0
    );
    return { status: 'conflict', conflicts: out };
  }

  const liveA = changesA.filter((c) => !drops.has(c));
  const liveB = changesB.filter((c) => !drops.has(c));
  const all = [...liveA, ...liveB]; // A 在前 B 在后：同缝隙插入即按此定序

  let work = copyAnnotated(baseAnn);
  // 顺序：插入（锚点需先解析）→ 新增/替换 → 删除（最后，保证身份可解析）
  for (const ch of all.filter((c) => c.kind === 'insert')) work = applyChange(work, ch, ctx);
  for (const ch of all.filter((c) => c.kind === 'add' || c.kind === 'replace')) {
    work = applyChange(work, ch, ctx);
  }
  for (const ch of all.filter((c) => c.kind === 'remove')) work = applyChange(work, ch, ctx);

  return {
    status: 'merged',
    result: deannotate(work),
    stats: {
      receivedA: patchA.length,
      receivedB: patchB.length,
      effectiveA: changesA.length,
      effectiveB: changesB.length,
      deduplicated: drops.size,
      applied: liveA.length + liveB.length,
    },
  };
}

module.exports = { merge, MergeRequestError };
