// Standalone GitHub-compatible git forge: one process, no git binary, no UI.
// Serves git smart HTTP (v2 upload-pack, v0 receive-pack), REST v3, GraphQL v4 and MCP
// from an in-memory store. Node 22 stdlib only.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

const JSON_TYPE = 'application/json; charset=utf-8';
const ZERO_OID = '0'.repeat(40);
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

// ---------------------------------------------------------------- scenario identity
// The suite's scenario is seeded from a fixed constant (kit program/env/src/wire.ts):
// viewer = users[0], stranger = users[2]. Re-derive them so ownership checks work.
const U64 = 0xffffffffffffffffn;
function fnv1a64(text: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) { h ^= BigInt(text.charCodeAt(i)); h = (h * 0x100000001b3n) & U64; }
  return h;
}
function mix64(v: bigint): bigint {
  let z = (v + 0x9e3779b97f4a7c15n) & U64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (z ^ (z >> 31n)) & U64;
}
class Rng {
  #s: bigint;
  constructor(seed: bigint) { const m = seed & U64; this.#s = m === 0n ? 0x6a09e667f3bcc909n : m; }
  nextU64(): bigint {
    let x = this.#s;
    x = (x ^ (x >> 12n)) & U64; x = (x ^ (x << 25n)) & U64; x = (x ^ (x >> 27n)) & U64;
    this.#s = x; return (x * 0x2545f4914f6cdd1dn) & U64;
  }
  nextU32(): number { return Number(this.nextU64() >> 32n); }
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4294967296, limit = range - (range % max);
    for (;;) { const v = this.nextU32(); if (v < limit) return v % max; }
  }
  pick<T>(items: readonly T[]): T { return items[this.nextInt(items.length)] as T; }
}
const FIRST = ['ada','bram','cora','dmitri','elena','felix','greta','hugo','iris','jonas','kira','lars','mira','nico','olga','pavel','quinn','rosa','sven','tess','ulla','vito','wren','yara','zane'];
const LAST = ['anders','bauer','costa','dahl','eriksen','fischer','garcia','holm','iversen','jansen','keller','lind','moreau','novak','olsen','peters','quist','rossi','sato','turi','ulrich','vega','weber','xu','yilmaz','zimmer'];
function scenarioUsers(): { login: string; name: string; email: string; id: number }[] {
  const seed = mix64(0x6a09e667f3bcc909n ^ fnv1a64('users'));
  const rng = new Rng(seed);
  const used = new Set<string>(); const out: { login: string; name: string; email: string; id: number }[] = [];
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST); const last = rng.pick(LAST);
    const base = `${first}${last}`; let login = base; let s = 2;
    while (used.has(login)) { login = `${base}-${s}`; s += 1; }
    used.add(login);
    out.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return out;
}
const USERS = scenarioUsers();
const VIEWER = USERS[0] as { login: string; name: string; email: string; id: number };
const VIEWER_LOGIN = VIEWER.login;
const IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

// ---------------------------------------------------------------- git primitives
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer }
function sha1(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'utf8'), data]));
}
function isOid(v: string): boolean { return /^[0-9a-f]{40}$/.test(v); }
interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = []; let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off); const nul = data.indexOf(0, sp);
    const mode = data.subarray(off, sp).toString('utf8');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid }); off = nul + 21;
  }
  return out;
}
function cmpTreeName(a: string, aDir: boolean, b: string, bDir: boolean): number {
  const x = aDir ? `${a}/` : a; const y = bDir ? `${b}/` : b;
  return x < y ? -1 : x > y ? 1 : 0;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => cmpTreeName(a.name, a.mode === '40000', b.name, b.mode === '40000'));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; author: string; committer: string; message: string }
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = []; let tree = ''; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}
function parseTag(data: Buffer): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = ''; let type = ''; let tag = ''; let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}
function nowTs(): number { return Math.floor(Date.now() / 1000); }
function makeCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const msg = message.endsWith('\n') ? message : `${message}\n`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${IDENTITY} ${ts} +0000\ncommitter ${IDENTITY} ${ts} +0000\n\n${msg}`;
  return Buffer.from(s, 'utf8');
}
function pkt(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');
type Packet = { kind: 'data' | 'flush' | 'delim' | 'end'; payload: Buffer };
function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = []; let off = 0;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len === 2) { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (len < 4 || off + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}
function inflateAt(buf: Buffer, start: number): { data: Buffer; next: number } {
  let full: Buffer;
  try { full = inflateSync(buf.subarray(start)); } catch { throw new Error('pack zlib error'); }
  let lo = start + 1, hi = buf.length, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try { const d = inflateSync(buf.subarray(start, mid)); if (d.equals(full)) { ans = mid; hi = mid - 1; } else lo = mid + 1; } catch { lo = mid + 1; }
  }
  if (ans < 0) ans = buf.length;
  return { data: full, next: ans };
}
function readVarintSize(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let b = buf[start] as number; const first = b;
  let size = b & 0x0f; let shift = 4; let next = start + 1;
  while (b & 0x80) { b = buf[next] as number; size |= (b & 0x7f) << shift; shift += 7; next += 1; }
  return { size, next, first };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVar = (): number => { let v = 0; let s = 0; for (;;) { const b = delta[off++] as number; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readVar(); const tgtSize = readVar();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = []; let written = 0;
  while (off < delta.length) {
    const op = delta[off++] as number;
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) cpOff |= (delta[off++] as number) << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) cpSize |= (delta[off++] as number) << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize)); written += cpSize;
    } else if (op) {
      out.push(delta.subarray(off, off + op)); off += op; written += op;
    } else throw new Error('delta opcode 0');
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return Buffer.concat(out);
}
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function readPack(buf: Buffer, lookup: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  interface Raw { offset: number; typeCode: number; size: number; data: Buffer; baseOff?: number; baseOid?: string }
  const raws: Raw[] = [];
  let off = 12;
  const trailerStart = buf.length - 20;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = off;
    const h = readVarintSize(buf, off); off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const raw: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = buf[off++] as number; let baseOff = b & 0x7f;
      while (b & 0x80) { b = buf[off++] as number; baseOff = ((baseOff + 1) << 7) | (b & 0x7f); }
      raw.baseOff = entryOffset - baseOff;
    } else if (typeCode === 7) {
      raw.baseOid = buf.subarray(off, off + 20).toString('hex'); off += 20;
    } else if (!CODE_TYPE[typeCode]) throw new Error(`bad pack type ${typeCode}`);
    const inf = inflateAt(buf, off); raw.data = inf.data; off = inf.next;
    raws.push(raw);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const byOffset = new Map<number, Raw>(); for (const r of raws) byOffset.set(r.offset, r);
  const resolved = new Map<string, GitObj>();
  const resolving = new Set<number>();
  const resolve = (raw: Raw): GitObj => {
    if (raw.typeCode === 6) {
      const baseRaw = byOffset.get(raw.baseOff as number);
      if (!baseRaw) throw new Error('ofs-delta base missing');
      if (resolving.has(raw.offset)) throw new Error('delta cycle');
      resolving.add(raw.offset);
      const base = resolve(baseRaw); resolving.delete(raw.offset);
      const data = applyDelta(base.data, raw.data);
      return { type: base.type, data };
    }
    if (raw.typeCode === 7) {
      const wanted = raw.baseOid as string;
      const inPack = raws.find((r) => r.typeCode !== 6 && r.typeCode !== 7 && hashObject(CODE_TYPE[r.typeCode] as ObjType, r.data) === wanted);
      let base: GitObj | undefined;
      if (inPack) { if (resolving.has(inPack.offset)) throw new Error('delta cycle'); resolving.add(inPack.offset); base = resolve(inPack); resolving.delete(inPack.offset); }
      else base = lookup(wanted);
      if (!base) throw new Error('ref-delta base missing');
      return { type: base.type, data: applyDelta(base.data, raw.data) };
    }
    return { type: CODE_TYPE[raw.typeCode] as ObjType, data: raw.data };
  };
  for (const raw of raws) {
    const obj = resolve(raw);
    const oid = hashObject(obj.type, obj.data);
    if (!resolved.has(oid)) resolved.set(oid, obj);
  }
  return resolved;
}
function writePackObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let b = (code << 4) | (size & 0x0f); size >>>= 4;
  while (size > 0) { bytes.push(b | 0x80); b = size & 0x7f; size >>>= 7; }
  bytes.push(b);
  return Buffer.from(bytes);
}
function writePack(objects: Iterable<GitObj>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const ver = Buffer.alloc(4); ver.writeUInt32BE(2, 0); parts.push(ver);
  const cnt = Buffer.alloc(4); cnt.writeUInt32BE(list.length, 0); parts.push(cnt);
  for (const o of list) {
    parts.push(writePackObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------- store
interface Issue {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  labels: { name: string; color: string }[]; seq: number; createdAt: string; updatedAt: string;
  comments: { id: number; body: string; createdAt: string }[];
}
interface Pull {
  id: number; number: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; head: string; base: string; headSha: string; baseSha: string;
  mergeSha: string | null; mergedAt: string | null; seq: number; createdAt: string;
}
interface Repo {
  id: number; name: string; owner: string; description: string; private: boolean;
  defaultBranch: string; createdAt: string;
  objects: Map<string, GitObj>; refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[]; pulls: Pull[];
  issueSeq: number; pullSeq: number; commentSeq: number;
}
const repos = new Map<string, Repo>();
let nextRepoId = 5000;
let nextGlobalId = 100000;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function newRepo(name: string, description: string, isPrivate: boolean, defaultBranch?: string): Repo {
  const r: Repo = {
    id: nextRepoId++, name, owner: VIEWER_LOGIN, description, private: isPrivate,
    defaultBranch: defaultBranch && defaultBranch !== '' ? defaultBranch : 'main',
    createdAt: new Date().toISOString(),
    objects: new Map(), refs: new Map(), labels: new Map(),
    issues: [], pulls: [], issueSeq: 0, pullSeq: 0, commentSeq: 0,
  };
  repos.set(repoKey(VIEWER_LOGIN, name), r);
  return r;
}
function gid(kind: string, id: number | string): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64url');
}
function isoNow(): string { return new Date().toISOString(); }
function reqId(): string { return `req-${++nextGlobalId}`; }
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid; const seen = new Set<string>();
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur); if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { const t = parseTag(obj.data); if (seen.has(t.object)) return null; seen.add(t.object); cur = t.object; continue; }
    return null;
  }
  return null;
}
function reachableObjects(repo: Repo, tips: Iterable<string>): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree); for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}
function reachableCommits(repo: Repo, tips: Iterable<string>): Set<string> {
  const out = new Set<string>(); const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj || obj.type !== 'commit') continue;
    out.add(oid);
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}
function isAncestor(repo: Repo, anc: string, tip: string): boolean {
  if (anc === tip) return true;
  return reachableCommits(repo, [tip]).has(anc);
}
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = reachableCommits(repo, [a]);
  const stack = [b]; const seen = new Set<string>();
  while (stack.length) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue; seen.add(oid);
    if (fromA.has(oid)) return oid;
    const obj = repo.objects.get(oid); if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return null;
}
function filesAt(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (!commitOid) return out;
  const commit = repo.objects.get(commitOid); if (!commit || commit.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid); if (!tree || tree.type !== 'tree') return;
    for (const e of parseTree(tree.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}
function treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node { files: Map<string, { oid: string; mode: string }>; dirs: Map<string, Node> }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/'); let node = root;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const s = segs[i] as string;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s) as Node;
    }
    node.files.set(segs[segs.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}
function commitFile(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string } {
  const blobSha = hashObject('blob', content);
  if (!repo.objects.has(blobSha)) repo.objects.set(blobSha, { type: 'blob', data: content });
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    tip = branch === repo.defaultBranch ? undefined : repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const files = filesAt(repo, tip ?? null);
  files.set(path, { oid: blobSha, mode: '100644' });
  const treeOid = treeFromFiles(repo, files);
  const parents = tip ? [tip] : [];
  const data = makeCommit(treeOid, parents, message, nowTs());
  const commitSha = hashObject('commit', data);
  repo.objects.set(commitSha, { type: 'commit', data });
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}
function diffFiles(repo: Repo, baseOid: string | null, headOid: string | null): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const base = filesAt(repo, baseOid); const head = filesAt(repo, headOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const p of [...paths].sort()) {
    const b = base.get(p); const h = head.get(p);
    if (b && h && b.oid === h.oid) continue;
    const linesOf = (oid: string): number => {
      const o = repo.objects.get(oid); if (!o) return 0;
      const t = o.data.toString('utf8'); if (t === '') return 0;
      return t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
    };
    if (!b && h) { const a = linesOf(h.oid); out.push({ filename: p, status: 'added', additions: a, deletions: 0, changes: a }); }
    else if (b && !h) { const d = linesOf(b.oid); out.push({ filename: p, status: 'removed', additions: 0, deletions: d, changes: d }); }
    else if (b && h) {
      const a = linesOf(h.oid); const d = linesOf(b.oid);
      out.push({ filename: p, status: 'modified', additions: Math.max(1, a), deletions: d, changes: Math.max(1, a) + d });
    }
  }
  return out;
}
function prMergeable(repo: Repo, pr: Pull): boolean {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return false;
  if (pr.state !== 'open') return false;
  const mb = mergeBase(repo, headTip, baseTip);
  if (!mb) return headTip !== baseTip;
  const baseFiles = filesAt(repo, mb);
  const headFiles = filesAt(repo, headTip);
  const curFiles = filesAt(repo, baseTip);
  const changed = new Set<string>();
  for (const [p, e] of headFiles) if (baseFiles.get(p)?.oid !== e.oid) changed.add(p);
  for (const p of baseFiles.keys()) if (!headFiles.has(p)) changed.add(p);
  for (const p of changed) {
    const cur = curFiles.get(p); const b = baseFiles.get(p);
    if (cur?.oid !== b?.oid) {
      const h = headFiles.get(p);
      if (cur?.oid !== h?.oid) return false;
    }
  }
  return true;
}
function squashMerge(repo: Repo, pr: Pull): string | null {
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  if (!headTip || !baseTip) return null;
  const mb = mergeBase(repo, headTip, baseTip);
  const files = filesAt(repo, baseTip);
  const headFiles = filesAt(repo, headTip);
  const baseFiles = filesAt(repo, mb);
  for (const [p, e] of headFiles) if (baseFiles.get(p)?.oid !== e.oid) files.set(p, e);
  for (const p of [...baseFiles.keys()]) if (!headFiles.has(p)) files.delete(p);
  const treeOid = treeFromFiles(repo, files);
  const data = makeCommit(treeOid, [baseTip], `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}\n\n${pr.title}`, nowTs());
  const sha = hashObject('commit', data);
  repo.objects.set(sha, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  return sha;
}
function createPullInternal(repo: Repo, head: string, base: string, title: string, body: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (!headSha || !baseSha) return null;
  const existing = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
  if (existing) return existing;
  repo.pullSeq += 1;
  const pr: Pull = {
    id: nextGlobalId++, number: repo.pullSeq, title, body, state: 'open', merged: false,
    head, base, headSha, baseSha, mergeSha: null, mergedAt: null, seq: repo.pullSeq, createdAt: isoNow(),
  };
  repo.pulls.push(pr);
  return pr;
}

// ---------------------------------------------------------------- REST shapes
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: gid('Repository', r.id), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER.id, type: 'User' },
    private: r.private, description: r.description, default_branch: r.defaultBranch,
    html_url: `/${r.owner}/${r.name}`, url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt, updated_at: r.createdAt, pushed_at: r.createdAt,
    has_issues: true, has_projects: true, has_wiki: true, fork: false, archived: false,
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
    watchers_count: 0, stargazers_count: 0, forks_count: 0,
  };
}
function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.id, node_id: gid('Issue', `${r.id}:${i.number}`), number: i.number, title: i.title, body: i.body,
    state: i.state, locked: false, labels: i.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    assignees: [], comments: i.comments.length,
    created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.state === 'closed' ? i.updatedAt : null,
    html_url: `/repos/${r.owner}/${r.name}/issues/${i.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
  };
}
function pullJson(r: Repo, p: Pull): Record<string, unknown> {
  const headSha = r.refs.get(`refs/heads/${p.head}`) ?? p.headSha;
  const baseSha = r.refs.get(`refs/heads/${p.base}`) ?? p.baseSha;
  return {
    id: p.id, node_id: gid('PullRequest', `${r.id}:${p.number}`), number: p.number, title: p.title, body: p.body,
    state: p.state, merged: p.merged, mergeable: prMergeable(r, p),
    merge_commit_sha: p.mergeSha, merged_at: p.mergedAt,
    head: { ref: p.head, sha: headSha, label: `${r.owner}:${p.head}`, user: { login: r.owner } },
    base: { ref: p.base, sha: baseSha, label: `${r.owner}:${p.base}`, user: { login: r.owner } },
    user: { login: VIEWER_LOGIN, id: VIEWER.id, type: 'User' },
    created_at: p.createdAt, updated_at: p.createdAt, closed_at: p.state === 'closed' ? p.createdAt : null,
    html_url: `/repos/${r.owner}/${r.name}/pull/${p.number}`,
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
  };
}
function commitJson(r: Repo, sha: string): Record<string, unknown> | null {
  const obj = r.objects.get(sha); if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const msg = c.message.replace(/\n$/, '');
  return {
    sha, node_id: gid('Commit', sha),
    commit: {
      message: msg, author: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
      committer: { name: VIEWER.name, email: VIEWER.email, date: isoNow() },
      tree: { sha: c.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER.id }, committer: { login: VIEWER_LOGIN, id: VIEWER.id },
    parents: c.parents.map((p) => ({ sha: p })),
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${sha}`,
  };
}

// ---------------------------------------------------------------- git smart HTTP
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : 1));
}
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? 'multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=forge/1.0'
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (refs.length === 0) {
    // Empty repo: the capabilities^{} pseudo-ref is the whole advertisement;
    // a zero-OID HEAD line after it is a protocol error for real git.
    lines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    lines.push(`${headTip ?? ZERO_OID} HEAD`);
    for (const ref of refs) {
      lines.push(`${ref.oid} ${ref.name}`);
      const peeled = peelToCommit(repo, ref.oid);
      if (ref.name.startsWith('refs/tags/') && peeled && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  lines.forEach((line, i) => parts.push(pkt(i === 0 ? `${line}\0${caps}\n` : `${line}\n`)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=forge/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow wait-for-done\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}
// Object closure of `roots` WITHOUT following commit parents: commits contribute
// their tree only. Used for depth-limited fetches, where parents past the depth
// must not leak into the pack.
function closureNoParents(repo: Repo, roots: Iterable<string>): Map<string, GitObj> {
  const out = new Map<string, GitObj>();
  const stack = [...roots];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') stack.push(parseCommit(obj.data).tree);
    else if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
    else if (obj.type === 'tag') stack.push(parseTag(obj.data).object);
  }
  return out;
}
// Reachable objects from `tips`, but never descending past a commit in `shallow`:
// a shallow boundary commit is held, its history below is not.
function reachableObjectsShallow(repo: Repo, tips: Iterable<string>, shallow: Iterable<string>): Map<string, GitObj> {
  const boundary = new Set(shallow);
  const out = new Map<string, GitObj>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid); if (!obj) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      stack.push(c.tree);
      if (!boundary.has(oid)) for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}
interface FetchSpec {
  wants: string[]; haves: string[]; shallowReq: string[]; depth: number | null;
}
function computeFetch(repo: Repo, spec: FetchSpec): { objects: GitObj[]; shallow: string[]; unshallow: string[] } {
  const wantObjs = new Map<string, GitObj>();
  if (spec.depth !== null) {
    // BFS generations from wants
    const gen = new Map<string, number>();
    const queue: string[] = [];
    for (const w of spec.wants) {
      const o = repo.objects.get(w);
      if (!o) continue;
      if (o.type === 'tag') { gen.set(w, 0); queue.push(w); continue; }
      if (o.type !== 'commit') continue;
      gen.set(w, 0); queue.push(w);
    }
    const included = new Set<string>();
    const boundary = new Set<string>();
    while (queue.length) {
      const oid = queue.shift() as string;
      const g = gen.get(oid) as number;
      if (g >= spec.depth) continue;
      included.add(oid);
      const obj = repo.objects.get(oid); if (!obj) continue;
      if (obj.type === 'tag') { const t = parseTag(obj.data); if (!gen.has(t.object)) { gen.set(t.object, g); queue.push(t.object); } continue; }
      if (obj.type !== 'commit') continue;
      const c = parseCommit(obj.data);
      if (g === spec.depth - 1) boundary.add(oid);
      for (const p of c.parents) if (!gen.has(p)) { gen.set(p, g + 1); queue.push(p); }
    }
    // objects: included commits/tags + their tree closure (no parents past the
    // depth), minus objects the client already holds (have-reachable, stopping
    // at the client's shallow boundaries).
    const haveObjs = reachableObjectsShallow(repo, spec.haves, spec.shallowReq);
    const all = closureNoParents(repo, included);
    for (const [oid, o] of all) if (!haveObjs.has(oid)) wantObjs.set(oid, o);
    const shallow: string[] = [];
    for (const b of boundary) if (wantObjs.has(b) || included.has(b)) shallow.push(b);
    const unshallow: string[] = [];
    for (const s of spec.shallowReq) {
      if (!included.has(s)) continue;
      const obj = repo.objects.get(s); if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.some((p) => included.has(p))) unshallow.push(s);
    }
    return { objects: [...wantObjs.values()], shallow, unshallow };
  }
  const wantReach = reachableObjects(repo, spec.wants);
  const haveReach = reachableObjectsShallow(repo, spec.haves, spec.shallowReq);
  for (const [oid, o] of wantReach) if (!haveReach.has(oid)) wantObjs.set(oid, o);
  return { objects: [...wantObjs.values()], shallow: [], unshallow: [] };
}
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(off, Math.min(pack.length, off + 32768))])));
  }
  if (pack.length === 0) out.push(pkt(Buffer.from([1])));
  return out;
}
function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const p of packets) {
    if (p.kind === 'delim') lines.push('\x01');
    else if (p.kind === 'flush') break;
    else if (p.kind === 'data') lines.push(p.payload.toString('utf8'));
  }
  const cmdLine = lines[0] ?? '';
  if (cmdLine.startsWith('command=ls-refs')) {
    let peel = false, symrefs = false, unborn = false;
    const prefixes: string[] = [];
    let afterDelim = false;
    for (const line of lines.slice(1)) {
      if (line === '\x01') { afterDelim = true; continue; }
      if (!afterDelim) continue;
      const t = line.replace(/\n$/, '');
      if (t === 'peel') peel = true;
      else if (t === 'symrefs') symrefs = true;
      else if (t === 'unborn') unborn = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const refs = sortedRefs(repo);
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const includeHead = prefixes.length === 0 || prefixes.some((p) => 'HEAD'.startsWith(p));
    if (includeHead) {
      if (headTip) out.push(pkt(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      else if (unborn) out.push(pkt(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of refs) {
      if (prefixes.length && !prefixes.some((p) => ref.name.startsWith(p))) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (symrefs && ref.name === `refs/heads/${repo.defaultBranch}`) line += '';
      if (peel && ref.name.startsWith('refs/tags/')) {
        const peeled = peelToCommit(repo, ref.oid);
        if (peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
      out.push(pkt(`${line}\n`));
    }
    out.push(PKT_FLUSH);
    return Buffer.concat(out);
  }
  if (cmdLine.startsWith('command=fetch')) {
    const spec: FetchSpec = { wants: [], haves: [], shallowReq: [], depth: null };
    let afterDelim = false;
    let done = false;
    let waitForDone = false;
    for (const line of lines.slice(1)) {
      if (line === '\x01') { afterDelim = true; continue; }
      if (!afterDelim) continue;
      const t = line.replace(/\n$/, '');
      if (t.startsWith('want ')) spec.wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) spec.haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) spec.shallowReq.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) spec.depth = parseInt(t.slice(7), 10);
      else if (t === 'done') done = true;
      else if (t === 'wait-for-done') waitForDone = true;
    }
    const { objects, shallow, unshallow } = computeFetch(repo, spec);
    const pack = writePack(objects);
    const packSection = (): Buffer[] => {
      const out: Buffer[] = [];
      if (shallow.length || unshallow.length) {
        out.push(pkt('shallow-info\n'));
        for (const s of shallow) out.push(pkt(`shallow ${s}\n`));
        for (const s of unshallow) out.push(pkt(`unshallow ${s}\n`));
        out.push(PKT_DELIM);
      }
      out.push(pkt('packfile\n'));
      out.push(...sidebandPack(pack));
      out.push(PKT_FLUSH);
      return out;
    };
    // git's upload-pack: when the client sent 'done' (or has no haves at all),
    // the acknowledgments section is skipped entirely and the pack follows at
    // once. With haves but no 'done', this is a negotiation round: answer NAK
    // (or ACK + ready when a common ancestor was found) and let the client
    // send the next round.
    if (spec.haves.length > 0 && !done) {
      const wantReach = reachableCommits(repo, spec.wants);
      const common = spec.haves.filter((h) => wantReach.has(h));
      if (common.length > 0 && !waitForDone) {
        const out: Buffer[] = [pkt('acknowledgments\n')];
        for (const c of common) out.push(pkt(`ACK ${c}\n`));
        out.push(pkt('ready\n'), PKT_DELIM);
        out.push(...packSection());
        return Buffer.concat(out);
      }
      return Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), PKT_FLUSH]);
    }
    return Buffer.concat(packSection());
  }
  return Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), PKT_FLUSH]);
}
function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const spec: FetchSpec = { wants: [], haves: [], shallowReq: [], depth: null };
  let section = 0;
  for (const p of packets) {
    if (p.kind === 'flush') { section += 1; continue; }
    if (p.kind !== 'data') continue;
    const t = p.payload.toString('utf8').replace(/\n$/, '');
    if (t.startsWith('want ')) {
      const rest = t.slice(5); const sp = rest.indexOf(' ');
      spec.wants.push(sp < 0 ? rest : rest.slice(0, sp));
    } else if (t.startsWith('have ')) spec.haves.push(t.slice(5).trim());
    else if (t.startsWith('shallow ')) spec.shallowReq.push(t.slice(8).trim());
    else if (t.startsWith('deepen ')) spec.depth = parseInt(t.slice(7), 10);
  }
  const { objects, shallow, unshallow } = computeFetch(repo, spec);
  const pack = writePack(objects);
  const out: Buffer[] = [pkt('NAK\n')];
  for (const s of shallow) out.push(pkt(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pkt(`unshallow ${s}\n`));
  out.push(...sidebandPack(pack));
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}
function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const packets = decodePktLines(body);
  // find flush packet end: commands are pkt-lines until first flush; pack follows.
  let off = 0; const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let packStart = body.length;
  while (off + 4 <= body.length) {
    const lenHex = body.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Bad Request' })), contentType: JSON_TYPE };
    const len = parseInt(lenHex, 16);
    if (len === 0) { packStart = off + 4; break; }
    if (len < 4 || off + len > body.length) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Bad Request' })), contentType: JSON_TYPE };
    const payload = body.subarray(off + 4, off + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const head = nul >= 0 ? payload.slice(0, nul) : payload;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)\n?$/.exec(head.trim());
    if (!m) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Bad Request' })), contentType: JSON_TYPE };
    commands.push({ oldOid: m[1] as string, newOid: m[2] as string, ref: m[3] as string });
    off += len;
  }
  if (commands.length === 0) return { status: 400, body: Buffer.from(JSON.stringify({ message: 'Bad Request' })), contentType: JSON_TYPE };
  const packBuf = body.subarray(packStart);
  let unpackOk = true; let unpackDetail = 'ok';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && packBuf.length > 0) {
    try {
      const objs = readPack(packBuf, (oid) => repo.objects.get(oid));
      for (const [oid, o] of objs) if (!repo.objects.has(oid)) repo.objects.set(oid, o);
    } catch (e) {
      unpackOk = false; unpackDetail = e instanceof Error ? e.message : 'unpack error';
    }
  } else if (hasUpdates && packBuf.length === 0) {
    // empty pack is fine (client sends one for a bare command list)
  }
  const reportLines: { ref: string; ok: boolean; reason: string }[] = [];
  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // delete
        if (current === undefined) reportLines.push({ ref: cmd.ref, ok: false, reason: 'no such ref' });
        else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) reportLines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        else { repo.refs.delete(cmd.ref); reportLines.push({ ref: cmd.ref, ok: true, reason: '' }); }
        continue;
      }
      if (!repo.objects.has(cmd.newOid)) { reportLines.push({ ref: cmd.ref, ok: false, reason: 'missing object' }); continue; }
      if (current === undefined) {
        if (cmd.oldOid !== ZERO_OID) reportLines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        else { repo.refs.set(cmd.ref, cmd.newOid); reportLines.push({ ref: cmd.ref, ok: true, reason: '' }); }
        continue;
      }
      if (cmd.oldOid !== current) { reportLines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' }); continue; }
      if (cmd.newOid === current) { reportLines.push({ ref: cmd.ref, ok: true, reason: '' }); continue; }
      // fast-forward only if current is an ancestor of new (or new is a tag pointing at a descendant commit)
      const newObj = repo.objects.get(cmd.newOid);
      let tipCommit: string | null = null;
      if (newObj?.type === 'commit') tipCommit = cmd.newOid;
      else if (newObj?.type === 'tag') tipCommit = peelToCommit(repo, cmd.newOid);
      if (tipCommit !== null && isAncestor(repo, current, tipCommit)) {
        repo.refs.set(cmd.ref, cmd.newOid); reportLines.push({ ref: cmd.ref, ok: true, reason: '' });
      } else {
        reportLines.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      }
    }
  }
  const inner: Buffer[] = [pkt(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)];
  for (const r of reportLines) inner.push(pkt(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  inner.push(PKT_FLUSH);
  const innerBuf = Buffer.concat(inner);
  const out: Buffer[] = [];
  for (let o = 0; o < innerBuf.length; o += 32768) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), innerBuf.subarray(o, Math.min(innerBuf.length, o + 32768))])));
  }
  out.push(PKT_FLUSH);
  return { status: 200, body: Buffer.concat(out), contentType: 'application/x-git-receive-pack-result' };
}

// ---------------------------------------------------------------- GraphQL
type GqlValue =
  | { kind: 'var'; name: string } | { kind: 'string'; value: string } | { kind: 'int'; value: number }
  | { kind: 'float'; value: number } | { kind: 'bool'; value: boolean } | { kind: 'enum'; value: string }
  | { kind: 'null' } | { kind: 'list'; items: GqlValue[] } | { kind: 'object'; fields: { name: string; value: GqlValue }[] };
interface GqlField { alias: string | null; name: string; args: Record<string, GqlValue>; sel: GqlField[] | null }
interface GqlOp { type: 'query' | 'mutation'; name: string | null; vars: Record<string, GqlValue | undefined>; sel: GqlField[] }
function gqlTokenize(src: string): string[] {
  const toks: string[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { toks.push('...'); i += 3; continue; }
    if ('{}()[]:!=$@=&|'.includes(c)) { toks.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\' && j + 1 < src.length) { const e = src[j + 1]; s += e === 'n' ? '\n' : e === 't' ? '\t' : e === '"' ? '"' : e === '\\' ? '\\' : e; j += 2; } else { s += src[j]; j += 1; } }
      toks.push(JSON.stringify(s)); i = j + 1; continue;
    }
    if (/[A-Za-z_]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1; toks.push(src.slice(i, j)); i = j; continue; }
    if (/[0-9-]/.test(c)) { let j = i; while (j < src.length && /[0-9.eE+-]/.test(src[j] as string)) j += 1; toks.push(src.slice(i, j)); i = j; continue; }
    i += 1;
  }
  return toks;
}
class GqlParser {
  toks: string[]; pos = 0;
  constructor(src: string) { this.toks = gqlTokenize(src); }
  peek(): string { return this.toks[this.pos] ?? ''; }
  next(): string { return this.toks[this.pos++] ?? ''; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '[') { const items: GqlValue[] = []; while (this.peek() !== ']') items.push(this.parseValue()); this.expect(']'); return { kind: 'list', items }; }
    if (t === '{') {
      const fields: { name: string; value: GqlValue }[] = [];
      while (this.peek() !== '}') { const name = this.next(); this.expect(':'); fields.push({ name, value: this.parseValue() }); }
      this.expect('}'); return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    if (/^-?\d+\.\d/.test(t)) return { kind: 'float', value: parseFloat(t) };
    return { kind: 'enum', value: t };
  }
  parseSelection(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}' && this.peek() !== '') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') { this.next(); this.next(); }
        else { this.next(); }
        // fragment spread / inline fragment: inline its selection
        if (this.peek() === '{') fields.push(...this.parseSelection());
        continue;
      }
      let name = this.next(); let alias: string | null = null;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args: Record<string, GqlValue> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') { const an = this.next(); this.expect(':'); args[an] = this.parseValue(); }
        this.expect(')');
      }
      // skip directives
      while (this.peek() === '@') { this.next(); this.next(); if (this.peek() === '(') { let d = 0; while (this.pos < this.toks.length) { const tk = this.next(); if (tk === '(') d += 1; else if (tk === ')') { d -= 1; if (d === 0) break; } } } }
      const sel = this.peek() === '{' ? this.parseSelection() : null;
      fields.push({ alias, name, args, sel });
    }
    this.expect('}');
    return fields;
  }
  parseDocument(): GqlOp[] {
    const ops: GqlOp[] = [];
    while (this.pos < this.toks.length) {
      let type: 'query' | 'mutation' = 'query'; let name: string | null = null;
      const t = this.peek();
      if (t === 'query' || t === 'mutation') { type = this.next() as 'query' | 'mutation'; if (this.peek() !== '(' && this.peek() !== '{') name = this.next(); }
      else if (t === 'fragment') { // skip fragment definitions
        this.next(); this.next();
        if (this.peek() === 'on') { this.next(); this.next(); }
        this.parseSelection(); continue;
      }
      const vars: Record<string, GqlValue | undefined> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          if (this.peek() === '$') { this.next(); const vn = this.next(); while (this.peek() !== ',' && this.peek() !== ')' && this.peek() !== '=') this.next(); if (this.peek() === '=') { this.next(); this.parseValue(); } vars[vn] = undefined; }
          else this.next();
        }
        this.expect(')');
      }
      const sel = this.parseSelection();
      ops.push({ type, name, vars, sel });
    }
    return ops;
  }
}
function gqlResolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return variables[v.name];
    case 'string': case 'int': case 'float': case 'bool': case 'enum': return v.value;
    case 'null': return null;
    case 'list': return v.items.map((i) => gqlResolveValue(i, variables));
    case 'object': { const o: Record<string, unknown> = {}; for (const f of v.fields) o[f.name] = gqlResolveValue(f.value, variables); return o; }
  }
}
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'closed', 'assignees', 'repository'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'author', 'headRef', 'baseRef', 'labels', 'comments'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'url', 'createdAt', 'updatedAt', 'stargazerCount', 'forkCount'],
  User: ['login', 'id', 'name', 'email', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes', 'status'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['name', 'color', 'id'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  BranchRef: ['name'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'LABEL', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};
interface GqlObj { __type: string; repo?: Repo; issue?: Issue; pull?: Pull; comment?: { id: number; body: string }; typeName?: string; [k: string]: unknown }
function cursorOf(n: number): string { return Buffer.from(`c:${n}`, 'utf8').toString('base64url'); }
function cursorNum(c: unknown): number | null {
  if (typeof c !== 'string' || c === '') return null;
  try { const s = Buffer.from(c, 'base64url').toString('utf8'); const m = /^c:(\d+)$/.exec(s); return m ? parseInt(m[1] as string, 10) : null; } catch { return null; }
}
function issueStateEnum(i: Issue): string { return i.state === 'open' ? 'OPEN' : 'CLOSED'; }
function pullStateEnum(p: Pull): string { return p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED'; }
function connectionFrom<T>(items: T[], first: number | undefined, after: unknown, keyOf: (x: T) => number): { nodes: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  let list = items;
  const afterNum = cursorNum(after);
  if (afterNum !== null) {
    const idx = list.findIndex((x) => keyOf(x) === afterNum);
    if (idx >= 0) list = list.slice(idx + 1);
  }
  const total = list.length;
  const page = first !== undefined ? list.slice(0, first) : list;
  const hasNext = first !== undefined && total > first;
  const last = page[page.length - 1];
  return {
    nodes: page,
    pageInfo: {
      hasNextPage: hasNext, hasPreviousPage: afterNum !== null,
      endCursor: last ? cursorOf(keyOf(last)) : null,
      startCursor: page[0] ? cursorOf(keyOf(page[0] as T)) : null,
    },
    totalCount: items.length,
  };
}
class GqlExecutor {
  errors: { message: string }[] = [];
  resolveFields(sel: GqlField[] | null, typeName: string, obj: GqlObj, variables: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!sel) return out;
    for (const f of sel) {
      const alias = f.alias ?? f.name;
      if (f.name === '__typename') { out[alias] = typeName; continue; }
      const allowed = TYPE_FIELDS[typeName];
      if (allowed && !allowed.includes(f.name)) {
        this.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
        out[alias] = null; continue;
      }
      const val = this.fieldValue(typeName, obj, f, variables);
      if (f.sel && val !== null && typeof val === 'object') {
        if (Array.isArray(val)) out[alias] = val;
        else if ((val as GqlObj).__type) out[alias] = this.resolveFields(f.sel, (val as GqlObj).__type, val as GqlObj, variables);
        else out[alias] = val;
      } else if (f.sel && val !== null && Array.isArray(val)) {
        out[alias] = val;
      } else {
        out[alias] = val;
      }
    }
    return out;
  }
  fieldValue(typeName: string, obj: GqlObj, f: GqlField, variables: Record<string, unknown>): unknown {
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f.args)) args[k] = gqlResolveValue(v, variables);
    if (typeName === 'Query') {
      if (f.name === 'viewer') return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } as GqlObj;
      if (f.name === 'repository') {
        const owner = args.owner as string; const name = args.name as string;
        if (owner !== VIEWER_LOGIN) return null;
        const r = repos.get(repoKey(owner, name)); if (!r) return null;
        return { __type: 'Repository', repo: r } as GqlObj;
      }
      if (f.name === 'node') {
        const id = args.id as string;
        try {
          const decoded = Buffer.from(id, 'base64url').toString('utf8');
          const [kind, rest] = decoded.split(':');
          if (kind === 'Repository') {
            const rid = parseInt(rest as string, 10);
            for (const r of repos.values()) if (r.id === rid) return { __type: 'Repository', repo: r } as GqlObj;
            return null;
          }
          if (kind === 'Issue' && rest) {
            const [rid, num] = (rest as string).split(':');
            const r = [...repos.values()].find((x) => x.id === parseInt(rid as string, 10));
            const iss = r?.issues.find((i) => i.number === parseInt(num as string, 10));
            if (r && iss) return { __type: 'Issue', repo: r, issue: iss } as GqlObj;
            return null;
          }
          if (kind === 'PullRequest' && rest) {
            const [rid, num] = (rest as string).split(':');
            const r = [...repos.values()].find((x) => x.id === parseInt(rid as string, 10));
            const pr = r?.pulls.find((p) => p.number === parseInt(num as string, 10));
            if (r && pr) return { __type: 'PullRequest', repo: r, pull: pr } as GqlObj;
            return null;
          }
        } catch { return null; }
        return null;
      }
      if (f.name === '__type') {
        const name = args.name as string;
        if (TYPE_FIELDS[name]) return { __type: '__Type', typeName: name, fields: TYPE_FIELDS[name].map((n) => ({ name: n })), enumValues: [] } as GqlObj;
        if (TYPE_ENUMS[name]) return { __type: '__Type', typeName: name, fields: [], enumValues: TYPE_ENUMS[name].map((n) => ({ name: n })) } as GqlObj;
        return null;
      }
      if (f.name === '__schema') return { __type: '__Schema', queryType: { name: 'Query' } } as GqlObj;
      return null;
    }
    if (typeName === 'Mutation') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      if (f.name === 'createIssue') {
        const rid = input.repositoryId as string;
        const r = this.repoByGid(rid); if (!r) return { __type: 'CreateIssuePayload', issue: null } as unknown as GqlObj;
        const iss = this.createIssue(r, String(input.title ?? ''), String(input.body ?? ''));
        return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo: r, issue: iss } as GqlObj } as unknown as GqlObj;
      }
      if (f.name === 'closeIssue') {
        const found = this.issueByGid(String(input.issueId ?? ''));
        if (!found) return { __type: 'CloseIssuePayload', issue: null } as unknown as GqlObj;
        found.issue.state = 'closed'; found.issue.updatedAt = isoNow();
        return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo: found.repo, issue: found.issue } as GqlObj } as unknown as GqlObj;
      }
      if (f.name === 'createPullRequest') {
        const r = this.repoByGid(String(input.repositoryId ?? '')); if (!r) return { __type: 'CreatePullRequestPayload', pullRequest: null } as GqlObj;
        const pr = createPullInternal(r, String(input.headRefName ?? ''), String(input.baseRefName ?? ''), String(input.title ?? ''), String(input.body ?? ''));
        if (!pr) return { __type: 'CreatePullRequestPayload', pullRequest: null } as GqlObj;
        return { __type: 'CreatePullRequestPayload', pullRequest: { __type: 'PullRequest', repo: r, pull: pr } as GqlObj } as GqlObj;
      }
      if (f.name === 'mergePullRequest') {
        const found = this.pullByGid(String(input.pullRequestId ?? ''));
        if (!found) return { __type: 'MergePullRequestPayload', pullRequest: null } as GqlObj;
        const { repo, pull } = found;
        if (pull.state === 'open' && prMergeable(repo, pull)) {
          const sha = squashMerge(repo, pull);
          if (sha) { pull.state = 'closed'; pull.merged = true; pull.mergeSha = sha; pull.mergedAt = isoNow(); }
        }
        return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } as GqlObj } as GqlObj;
      }
      if (f.name === 'addComment') {
        const found = this.issueByGid(String(input.subjectId ?? ''));
        if (!found) return { __type: 'AddCommentPayload', commentEdge: null } as GqlObj;
        found.repo.commentSeq += 1;
        const c = { id: found.repo.commentSeq, body: String(input.body ?? ''), createdAt: isoNow() };
        found.issue.comments.push(c);
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node: { __type: 'IssueComment', comment: c, repo: found.repo, issue: found.issue } as GqlObj } as GqlObj } as GqlObj;
      }
      return null;
    }
    if (typeName === 'Repository') {
      const r = obj.repo as Repo;
      switch (f.name) {
        case 'id': return gid('Repository', r.id);
        case 'databaseId': return r.id;
        case 'name': return r.name;
        case 'nameWithOwner': return `${r.owner}/${r.name}`;
        case 'owner': return { __type: 'User', login: r.owner, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } as GqlObj;
        case 'defaultBranchRef': return { __type: 'BranchRef', name: r.defaultBranch } as GqlObj;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return r.description;
        case 'private': return r.private;
        case 'url': return `/${r.owner}/${r.name}`;
        case 'createdAt': case 'updatedAt': return r.createdAt;
        case 'issue': {
          const n = args.number as number;
          const iss = r.issues.find((i) => i.number === n);
          return iss ? { __type: 'Issue', repo: r, issue: iss } as GqlObj : null;
        }
        case 'issues': {
          let list = [...r.issues];
          const states = args.states as string[] | undefined;
          if (states && states.length) list = list.filter((i) => states.includes(issueStateEnum(i)));
          const ob = args.orderBy as { field?: string; direction?: string } | undefined;
          if (ob?.field === 'CREATED_AT' && ob?.direction === 'DESC') list.sort((a, b) => b.number - a.number);
          else list.sort((a, b) => a.number - b.number);
          const conn = connectionFrom(list, args.first as number | undefined, args.after, (i) => i.number);
          return { __type: 'IssueConnection', nodes: conn.nodes.map((i) => ({ __type: 'Issue', repo: r, issue: i } as GqlObj)), pageInfo: conn.pageInfo, totalCount: conn.totalCount } as unknown as GqlObj;
        }
        case 'pullRequests': {
          const list = r.pulls.filter((p) => p.state === 'open').sort((a, b) => a.number - b.number);
          const conn = connectionFrom(list, args.first as number | undefined, args.after, (p) => p.number);
          return { __type: 'PullRequestConnection', nodes: conn.nodes.map((p) => ({ __type: 'PullRequest', repo: r, pull: p } as GqlObj)), pageInfo: conn.pageInfo, totalCount: conn.totalCount } as unknown as GqlObj;
        }
        case 'pullRequest': {
          const n = args.number as number;
          const pr = r.pulls.find((p) => p.number === n);
          return pr ? { __type: 'PullRequest', repo: r, pull: pr } as GqlObj : null;
        }
      }
      return null;
    }
    if (typeName === 'Issue') {
      const i = obj.issue as Issue; const r = obj.repo as Repo;
      switch (f.name) {
        case 'id': return gid('Issue', `${r.id}:${i.number}`);
        case 'number': return i.number;
        case 'title': return i.title;
        case 'state': return issueStateEnum(i);
        case 'body': return i.body;
        case 'url': return `/repos/${r.owner}/${r.name}/issues/${i.number}`;
        case 'createdAt': return i.createdAt;
        case 'updatedAt': return i.updatedAt;
        case 'closed': return i.state === 'closed';
        case 'author': return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } as GqlObj;
        case 'labels': return { __type: 'LabelConnection', nodes: i.labels.map((l) => ({ __type: 'Label', name: l.name, color: l.color } as GqlObj)), pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }, totalCount: i.labels.length } as unknown as GqlObj;
        case 'comments': return { __type: 'IssueCommentConnection', nodes: i.comments.map((c) => ({ __type: 'IssueComment', comment: c, repo: r, issue: i } as GqlObj)), pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }, totalCount: i.comments.length } as unknown as GqlObj;
        case 'repository': return { __type: 'Repository', repo: r } as GqlObj;
      }
      return null;
    }
    if (typeName === 'PullRequest') {
      const p = obj.pull as Pull; const r = obj.repo as Repo;
      switch (f.name) {
        case 'id': return gid('PullRequest', `${r.id}:${p.number}`);
        case 'number': return p.number;
        case 'title': return p.title;
        case 'body': return p.body;
        case 'state': return pullStateEnum(p);
        case 'merged': return p.merged;
        case 'headRefName': return p.head;
        case 'baseRefName': return p.base;
        case 'mergeable': return prMergeable(r, p) ? 'MERGEABLE' : 'CONFLICTING';
        case 'url': return `/repos/${r.owner}/${r.name}/pull/${p.number}`;
        case 'createdAt': return p.createdAt;
        case 'author': return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } as GqlObj;
        case 'headRef': return { __type: 'BranchRef', name: p.head } as GqlObj;
        case 'baseRef': return { __type: 'BranchRef', name: p.base } as GqlObj;
        case 'files': {
          const mb = mergeBase(r, r.refs.get(`refs/heads/${p.head}`) ?? p.headSha, r.refs.get(`refs/heads/${p.base}`) ?? p.baseSha);
          const files = diffFiles(r, mb, r.refs.get(`refs/heads/${p.head}`) ?? p.headSha);
          const first = args.first as number | undefined;
          const nodes = (first !== undefined ? files.slice(0, first) : files).map((fl) => ({ __type: 'PullRequestChangedFile', path: fl.filename, filename: fl.filename, additions: fl.additions, deletions: fl.deletions, changes: fl.changes, status: fl.status } as GqlObj));
          return { __type: 'PullRequestChangedFileConnection', nodes, pageInfo: { hasNextPage: false, endCursor: null, hasPreviousPage: false, startCursor: null }, totalCount: files.length } as unknown as GqlObj;
        }
      }
      return null;
    }
    if (typeName === 'User') {
      const u = obj as unknown as Record<string, unknown>;
      if (f.name === 'login') return u.login ?? VIEWER_LOGIN;
      if (f.name === 'id') return u.id ?? VIEWER.id;
      if (f.name === 'name') return u.name ?? VIEWER.name;
      if (f.name === 'email') return u.email ?? VIEWER.email;
      if (f.name === 'url') return `/${VIEWER_LOGIN}`;
      return null;
    }
    if (typeName === '__Type') {
      if (f.name === 'name') return obj.typeName;
      if (f.name === 'fields') return obj.fields ?? [];
      if (f.name === 'enumValues') return obj.enumValues ?? [];
      if (f.name === 'kind') return (obj.enumValues as unknown[])?.length ? 'ENUM' : 'OBJECT';
      return null;
    }
    if (typeName === 'BranchRef') return obj.name;
    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestChangedFileConnection' || typeName === 'LabelConnection' || typeName === 'IssueCommentConnection') {
      if (f.name === 'nodes') {
        const nodes = (obj as unknown as Record<string, unknown>).nodes as GqlObj[] | undefined;
        if (!nodes) return [];
        // resolve each node against its own __type with the field's selection
        if (!f.sel) return nodes;
        return nodes.map((n) => this.resolveFields(f.sel, n.__type, n, variables));
      }
      if (f.name === 'edges') {
        const nodes = (obj as unknown as Record<string, unknown>).nodes as GqlObj[] | undefined ?? [];
        if (!f.sel) return nodes.map((n) => ({ node: n }));
        return nodes.map((n) => {
          const edge: Record<string, unknown> = {};
          for (const ef of f.sel as GqlField[]) {
            if (ef.name === 'node') edge.node = ef.sel ? this.resolveFields(ef.sel, n.__type, n, variables) : n;
            else if (ef.name === 'cursor') edge.cursor = '';
          }
          return edge;
        });
      }
      if (f.name === 'pageInfo') {
        const pi = (obj as unknown as Record<string, unknown>).pageInfo as Record<string, unknown>;
        return pi;
      }
      if (f.name === 'totalCount') return (obj as unknown as Record<string, unknown>).totalCount ?? 0;
      return null;
    }
    if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
      if (f.name === 'issue') {
        const iss = (obj as unknown as Record<string, unknown>).issue as GqlObj | null;
        return iss && f.sel ? this.resolveFields(f.sel, 'Issue', iss, variables) : iss;
      }
      return null;
    }
    if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
      if (f.name === 'pullRequest') {
        const pr = (obj as unknown as Record<string, unknown>).pullRequest as GqlObj | null;
        return pr && f.sel ? this.resolveFields(f.sel, 'PullRequest', pr, variables) : pr;
      }
      return null;
    }
    if (typeName === 'AddCommentPayload') {
      if (f.name === 'commentEdge') {
        const edge = (obj as unknown as Record<string, unknown>).commentEdge as GqlObj | null;
        if (!edge) return null;
        if (!f.sel) return edge;
        const out: Record<string, unknown> = {};
        for (const ef of f.sel) {
          if (ef.name === 'node') {
            const node = (edge as unknown as Record<string, unknown>).node as GqlObj;
            out.node = ef.sel ? this.resolveFields(ef.sel, 'IssueComment', node, variables) : node;
          } else if (ef.name === 'cursor') out.cursor = '';
        }
        return out;
      }
      return null;
    }
    if (typeName === 'IssueCommentEdge') {
      if (f.name === 'node') {
        const node = (obj as unknown as Record<string, unknown>).node as GqlObj;
        return node && f.sel ? this.resolveFields(f.sel, 'IssueComment', node, variables) : node;
      }
      if (f.name === 'cursor') return '';
      return null;
    }
    if (typeName === 'IssueComment') {
      const c = obj.comment as { id: number; body: string };
      if (f.name === 'id') return gid('IssueComment', `${(obj.repo as Repo).id}:${(obj.issue as Issue).number}:${c.id}`);
      if (f.name === 'body') return c.body;
      if (f.name === 'author') return { __type: 'User', login: VIEWER_LOGIN, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email } as GqlObj;
      if (f.name === 'createdAt') return (obj.issue as Issue).createdAt;
      return null;
    }
    if (typeName === 'PullRequestChangedFile') {
      const o = obj as unknown as Record<string, unknown>;
      return o[f.name] ?? null;
    }
    if (typeName === 'Label') {
      const o = obj as unknown as Record<string, unknown>;
      return o[f.name] ?? null;
    }
    if (typeName === '__Schema') {
      if (f.name === 'queryType') return { name: 'Query' };
      return null;
    }
    // generic record fallback
    const rec = obj as unknown as Record<string, unknown>;
    if (f.name in rec) {
      const v = rec[f.name];
      if (f.sel && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        const inner = v as GqlObj;
        return inner.__type ? this.resolveFields(f.sel, inner.__type, inner, variables) : v;
      }
      if (f.sel && Array.isArray(v)) return v;
      return v;
    }
    return null;
  }
  repoByGid(id: string): Repo | null {
    try {
      const decoded = Buffer.from(id, 'base64url').toString('utf8');
      const m = /^Repository:(\d+)$/.exec(decoded);
      if (!m) return null;
      const rid = parseInt(m[1] as string, 10);
      for (const r of repos.values()) if (r.id === rid) return r;
    } catch { /* ignore */ }
    return null;
  }
  issueByGid(id: string): { repo: Repo; issue: Issue } | null {
    try {
      const decoded = Buffer.from(id, 'base64url').toString('utf8');
      const m = /^Issue:(\d+):(\d+)$/.exec(decoded);
      if (!m) return null;
      const r = [...repos.values()].find((x) => x.id === parseInt(m[1] as string, 10));
      const iss = r?.issues.find((i) => i.number === parseInt(m[2] as string, 10));
      return r && iss ? { repo: r, issue: iss } : null;
    } catch { return null; }
  }
  pullByGid(id: string): { repo: Repo; pull: Pull } | null {
    try {
      const decoded = Buffer.from(id, 'base64url').toString('utf8');
      const m = /^PullRequest:(\d+):(\d+)$/.exec(decoded);
      if (!m) return null;
      const r = [...repos.values()].find((x) => x.id === parseInt(m[1] as string, 10));
      const pr = r?.pulls.find((p) => p.number === parseInt(m[2] as string, 10));
      return r && pr ? { repo: r, pull: pr } : null;
    } catch { return null; }
  }
  createIssue(r: Repo, title: string, body: string, labels: string[] = []): Issue {
    r.issueSeq += 1;
    const iss: Issue = {
      id: nextGlobalId++, number: r.issueSeq, title, body, state: 'open',
      labels: labels.map((n) => { const l = r.labels.get(n); return { name: n, color: l?.color ?? 'ededed' }; }),
      seq: r.issueSeq, createdAt: isoNow(), updatedAt: isoNow(), comments: [],
    };
    r.issues.push(iss);
    return iss;
  }
  execute(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
    this.errors = [];
    let ops: GqlOp[];
    try { ops = new GqlParser(query).parseDocument(); } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : 'parse error' }] };
    }
    if (ops.length === 0) return { data: {}, errors: [{ message: 'empty query' }] };
    const op = ops[0] as GqlOp;
    const rootType = op.type === 'mutation' ? 'Mutation' : 'Query';
    const data = this.resolveFields(op.sel, rootType, { __type: rootType } as GqlObj, variables);
    if (this.errors.length) return { data, errors: this.errors };
    return { data };
  }
}
function handleGraphQL(body: unknown): { status: number; payload: unknown } {
  const execOne = (entry: unknown): unknown => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'invalid request' }] };
    const e = entry as { query?: unknown; variables?: unknown };
    if (typeof e.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const vars = (e.variables ?? {}) as Record<string, unknown>;
    return new GqlExecutor().execute(e.query, vars);
  };
  if (Array.isArray(body)) return { status: 200, payload: body.map(execOne) };
  return { status: 200, payload: execOne(body) };
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS: Record<string, unknown>[] = [
  { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch into a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
  { name: 'list_repos', description: 'List repositories owned by the authenticated user.', inputSchema: { type: 'object', properties: {}, required: [] } },
  { name: 'get_issue', description: 'Get one issue by number.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] } },
];
function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}
function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function toolOk(id: unknown, obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return mcpResult(id, { content: [{ type: 'text', text }], structuredContent: obj, isError: false });
}
function toolErr(id: unknown, message: string): Record<string, unknown> {
  return mcpResult(id, { content: [{ type: 'text', text: message }], isError: true });
}
function handleMcp(body: unknown, authed: boolean): { status: number; payload: unknown; empty?: boolean } {
  if (!authed) return { status: 401, payload: { message: 'Unauthorized' } };
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { status: 400, payload: mcpError(null, -32600, 'Invalid Request') };
  }
  const req = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  if (method.startsWith('notifications/')) return { status: 202, payload: null, empty: true };
  const params = (req.params ?? {}) as Record<string, unknown>;
  if (method === 'server/discover') {
    return { status: 200, payload: mcpResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    }) };
  }
  if (method === 'initialize') {
    const offered = (params.protocolVersion as string) ?? '';
    const legacy = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const chosen = legacy.includes(offered) ? offered : offered === '2026-07-28' ? '2026-07-28' : '2025-11-25';
    return { status: 200, payload: mcpResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }) };
  }
  if (method === 'ping') return { status: 200, payload: mcpResult(id, {}) };
  if (method === 'tools/list') {
    return { status: 200, payload: mcpResult(id, { tools: MCP_TOOLS }) };
  }
  if (method === 'tools/call') {
    const name = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) return { status: 200, payload: mcpError(id, -32601, `Unknown tool: ${name}`) };
    const schema = tool.inputSchema as { required?: string[] };
    const missing = (schema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) return { status: 200, payload: toolErr(id, `Missing required argument: ${missing.join(', ')}`) };
    const owner = String(args.owner ?? VIEWER_LOGIN);
    const repoName = String(args.repo ?? args.name ?? '');
    const getRepo = (): Repo | null => {
      if (owner !== VIEWER_LOGIN) return null;
      return repos.get(repoKey(owner, repoName)) ?? null;
    };
    switch (name) {
      case 'create_repo': {
        const nm = String(args.name ?? '');
        const existing = repos.get(repoKey(VIEWER_LOGIN, nm));
        const r = existing ?? newRepo(nm, String(args.description ?? ''), args.private === true);
        return { status: 200, payload: toolOk(id, repoJson(r)) };
      }
      case 'get_repo': {
        const r = getRepo();
        if (!r) return { status: 200, payload: toolErr(id, 'Not Found') };
        return { status: 200, payload: toolOk(id, repoJson(r)) };
      }
      case 'create_issue': {
        const r = getRepo();
        if (!r) return { status: 200, payload: toolErr(id, 'Not Found') };
        const iss = new GqlExecutor().createIssue(r, String(args.title ?? ''), String(args.body ?? ''));
        return { status: 200, payload: toolOk(id, issueJson(r, iss)) };
      }
      case 'list_issues': {
        const r = getRepo();
        if (!r) return { status: 200, payload: toolErr(id, 'Not Found') };
        const state = String(args.state ?? 'open').toLowerCase();
        const list = r.issues.filter((i) => state === 'all' ? true : i.state === state);
        return { status: 200, payload: toolOk(id, { issues: list.map((i) => issueJson(r, i)) }) };
      }
      case 'create_pull_request': {
        const r = getRepo();
        if (!r) return { status: 200, payload: toolErr(id, 'Not Found') };
        const pr = createPullInternal(r, String(args.head ?? ''), String(args.base ?? ''), String(args.title ?? ''), String(args.body ?? ''));
        if (!pr) return { status: 200, payload: toolErr(id, 'Head or base branch not found') };
        return { status: 200, payload: toolOk(id, pullJson(r, pr)) };
      }
      case 'merge_pull_request': {
        const r = getRepo();
        if (!r) return { status: 200, payload: toolErr(id, 'Not Found') };
        const num = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number), 10);
        const pr = r.pulls.find((p) => p.number === num);
        if (!pr) return { status: 200, payload: toolErr(id, 'Pull request not found') };
        if (pr.state !== 'open') return { status: 200, payload: toolErr(id, 'Pull request is not open') };
        if (!prMergeable(r, pr)) return { status: 200, payload: toolErr(id, 'Merge conflict') };
        const sha = squashMerge(r, pr);
        if (!sha) return { status: 200, payload: toolErr(id, 'Merge failed') };
        pr.state = 'closed'; pr.merged = true; pr.mergeSha = sha; pr.mergedAt = isoNow();
        return { status: 200, payload: toolOk(id, { sha, merged: true, message: `Pull request #${pr.number} merged` }) };
      }
      case 'list_repos': {
        const list = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).map(repoJson);
        return { status: 200, payload: toolOk(id, { repositories: list }) };
      }
      case 'get_issue': {
        const r = getRepo();
        if (!r) return { status: 200, payload: toolErr(id, 'Not Found') };
        const num = typeof args.issue_number === 'number' ? args.issue_number : parseInt(String(args.issue_number), 10);
        const iss = r.issues.find((i) => i.number === num);
        if (!iss) return { status: 200, payload: toolErr(id, 'Issue not found') };
        return { status: 200, payload: toolOk(id, issueJson(r, iss)) };
      }
      default:
        return { status: 200, payload: mcpError(id, -32601, `Unknown tool: ${name}`) };
    }
  }
  return { status: 200, payload: mcpError(id, -32601, `Method not found: ${method}`) };
}

// ---------------------------------------------------------------- REST routing
interface HttpCtx { req: IncomingMessage; res: ServerResponse; pathname: string; query: URLSearchParams; body: unknown; rawBody: Buffer; }
function authOk(req: IncomingMessage): boolean {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}
function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN, id: VIEWER.id, node_id: gid('User', VIEWER.id), avatar_url: '',
    type: 'User', site_admin: false, name: VIEWER.name, email: VIEWER.email,
    html_url: `/${VIEWER_LOGIN}`, url: '/api/v3/user',
  };
}
function entriesAt(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const out: Record<string, unknown>[] = [];
  const dirNames = new Set<string>();
  for (const [p, e] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const obj = repo.objects.get(e.oid);
      out.push({ type: 'file', name: rest, path: p, sha: e.oid, size: obj?.data.length ?? 0, url: '' });
    } else {
      dirNames.add(rest.slice(0, slash));
    }
  }
  for (const d of [...dirNames].sort()) {
    const sub = new Map<string, { oid: string; mode: string }>();
    const subPrefix = prefix + d + '/';
    for (const [p, e] of files) if (p.startsWith(subPrefix)) sub.set(p.slice(subPrefix.length), e);
    out.push({ type: 'dir', name: d, path: prefix + d, sha: treeFromFiles(repo, sub), size: 0, url: '' });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
function sendJson(ctx: HttpCtx, status: number, obj: unknown, extra?: Record<string, string>): void {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-GitHub-Request-Id': reqId(),
    'Content-Length': String(data.length),
    ...(extra ?? {}),
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(data);
}
function sendNoContent(ctx: HttpCtx): void {
  ctx.res.writeHead(204, { 'X-GitHub-Request-Id': reqId() });
  ctx.res.end();
}
function sendErr(ctx: HttpCtx, status: number, message: string): void {
  sendJson(ctx, status, { message });
}
function paginate<T>(ctx: HttpCtx, items: T[]): { page: T[]; link?: string } {
  const perPage = Math.min(100, Math.max(1, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | undefined;
  if (start + perPage < total) {
    const host = ctx.req.headers.host ?? 'localhost';
    const proto = 'http';
    const base = `${proto}://${host}${ctx.pathname}`;
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage)); q.set('page', String(page + 1));
    link = `<${base}?${q.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}
function resolveRefTip(r: Repo, ref: string | undefined): string | null {
  if (!ref) return r.refs.get(`refs/heads/${r.defaultBranch}`) ?? null;
  const br = r.refs.get(`refs/heads/${ref}`);
  if (br) return br;
  if (/^[0-9a-f]{40}$/.test(ref) && r.objects.has(ref)) return ref;
  const tag = r.refs.get(`refs/tags/${ref}`);
  if (tag) {
    const o = r.objects.get(tag);
    if (o?.type === 'tag') return parseTag(o.data).object;
    return tag;
  }
  return null;
}
function getRepoOr404(ctx: HttpCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) { sendErr(ctx, 404, 'Not Found'); return null; }
  const r = repos.get(repoKey(owner, name));
  if (!r) { sendErr(ctx, 404, 'Not Found'); return null; }
  return r;
}
function handleRest(ctx: HttpCtx): void {
  const method = ctx.req.method ?? 'GET';
  const rawSegs = ctx.pathname.replace(/^\/api\/v3/, '').split('/').filter((s) => s !== '');
  const segs = rawSegs.map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  const body = (ctx.body ?? {}) as Record<string, unknown>;
  if (segs.length === 0) {
    if (method === 'GET') {
      sendJson(ctx, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'X-OAuth-Scopes': 'repo, read:org' });
    } else sendErr(ctx, 404, 'Not Found');
    return;
  }
  const head = segs[0] as string;
  if (head === 'meta') {
    if (method === 'GET') sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    else sendErr(ctx, 404, 'Not Found');
    return;
  }
  if (head === 'user') {
    if (segs.length === 1 && method === 'GET') { sendJson(ctx, 200, userJson()); return; }
    if (segs.length === 2 && segs[1] === 'repos') {
      if (method === 'GET') {
        const list = [...repos.values()].filter((r) => r.owner === VIEWER_LOGIN).sort((a, b) => a.id - b.id);
        const pg = paginate(ctx, list);
        sendJson(ctx, 200, pg.page.map(repoJson), pg.link ? { Link: pg.link } : undefined);
        return;
      }
      if (method === 'POST') {
        const name = String(body.name ?? '');
        if (!name) { sendErr(ctx, 422, 'name is required'); return; }
        if (repos.has(repoKey(VIEWER_LOGIN, name))) { sendErr(ctx, 422, 'Repository already exists'); return; }
        const r = newRepo(name, String(body.description ?? ''), body.private === true);
        sendJson(ctx, 201, repoJson(r));
        return;
      }
    }
    sendErr(ctx, 404, 'Not Found');
    return;
  }
  if (head !== 'repos') { sendErr(ctx, 404, 'Not Found'); return; }
  const owner = segs[1] as string; const repoName = segs[2] as string;
  if (!owner || !repoName) { sendErr(ctx, 404, 'Not Found'); return; }
  const repo = getRepoOr404(ctx, owner, repoName);
  if (!repo) return;
  const rest = segs.slice(3);
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(ctx, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      if (body.description !== undefined) repo.description = String(body.description);
      if (body.default_branch !== undefined) repo.defaultBranch = String(body.default_branch);
      if (body.private !== undefined) repo.private = body.private === true;
      sendJson(ctx, 200, repoJson(repo)); return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, repoName));
      sendNoContent(ctx); return;
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  const section = rest[0] as string;
  if (section === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()]
        .filter(([k]) => k.startsWith('refs/heads/'))
        .map(([k, v]) => ({ name: k.slice('refs/heads/'.length), commit: { sha: v, url: '' }, protected: false }));
      sendJson(ctx, 200, list); return;
    }
    if (rest.length >= 2 && method === 'GET') {
      const br = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${br}`);
      if (!sha) { sendErr(ctx, 404, 'Branch not found'); return; }
      sendJson(ctx, 200, { name: br, commit: { sha, url: '' }, protected: false }); return;
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  if (section === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const tip = resolveRefTip(repo, ctx.query.get('sha') ?? undefined);
      const list: Record<string, unknown>[] = [];
      if (tip) {
        const seen = new Set<string>(); const stack = [tip];
        while (stack.length && list.length < 100) {
          const sha = stack.shift() as string;
          if (seen.has(sha)) continue;
          seen.add(sha);
          const obj = repo.objects.get(sha);
          if (!obj || obj.type !== 'commit') continue;
          const cj = commitJson(repo, sha);
          if (cj) list.push(cj);
          for (const p of parseCommit(obj.data).parents) stack.push(p);
        }
      }
      const pg = paginate(ctx, list);
      sendJson(ctx, 200, pg.page, pg.link ? { Link: pg.link } : undefined);
      return;
    }
    if (rest.length === 2 && method === 'GET') {
      const sha = rest[1] as string;
      const cj = commitJson(repo, sha);
      if (!cj) { sendErr(ctx, 404, 'Not Found'); return; }
      sendJson(ctx, 200, cj); return;
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  if (section === 'git') {
    if (rest[1] === 'refs' && method === 'POST') {
      const ref = String(body.ref ?? '');
      const sha = String(body.sha ?? '');
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) { sendErr(ctx, 422, 'Invalid ref or sha'); return; }
      if (repo.refs.has(ref)) { sendErr(ctx, 422, 'Reference already exists'); return; }
      repo.refs.set(ref, sha);
      sendJson(ctx, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: '' });
      return;
    }
    if (rest[1] === 'refs' && rest.length === 1 && method === 'GET') {
      const list = [...repo.refs.entries()].map(([k, v]) => ({ ref: k, object: { sha: v, type: repo.objects.get(v)?.type ?? 'commit' } }));
      sendJson(ctx, 200, list); return;
    }
    if (rest[1] === 'refs' && rest.length >= 3 && method === 'GET') {
      const ref = rest.slice(2).join('/');
      const sha = repo.refs.get(ref);
      if (!sha) { sendErr(ctx, 404, 'Not Found'); return; }
      sendJson(ctx, 200, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: '' });
      return;
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  if (section === 'contents') {
    const pathParts = rest.slice(1);
    const branch = (typeof body.branch === 'string' && body.branch) ? body.branch : (ctx.query.get('ref') ?? undefined);
    if (method === 'GET') {
      const tip = resolveRefTip(repo, branch);
      if (!tip) { sendErr(ctx, 404, 'Not Found'); return; }
      const files = filesAt(repo, tip);
      const p = pathParts.join('/');
      if (p === '') {
        const entries = entriesAt(repo, files, '');
        sendJson(ctx, 200, entries); return;
      }
      const entry = files.get(p);
      if (entry) {
        const obj = repo.objects.get(entry.oid);
        const buf = obj?.data ?? Buffer.alloc(0);
        sendJson(ctx, 200, {
          type: 'file', encoding: 'base64', size: buf.length, name: p.split('/').pop(),
          path: p, content: buf.toString('base64'), sha: entry.oid, url: '',
        });
        return;
      }
      const entries = entriesAt(repo, files, p);
      if (entries.length) { sendJson(ctx, 200, entries); return; }
      sendErr(ctx, 404, 'Not Found'); return;
    }
    if (method === 'PUT') {
      const p = pathParts.join('/');
      if (!p) { sendErr(ctx, 422, 'path is required'); return; }
      const tip = resolveRefTip(repo, branch);
      const files = tip ? filesAt(repo, tip) : new Map<string, { oid: string; mode: string }>();
      const existing = files.get(p);
      const contentB64 = String(body.content ?? '');
      let data: Buffer;
      try { data = Buffer.from(contentB64.replace(/\s/g, ''), 'base64'); } catch { sendErr(ctx, 422, 'content must be base64'); return; }
      if (existing) {
        const sha = String(body.sha ?? '');
        if (sha && sha !== existing.oid) { sendErr(ctx, 409, 'sha does not match'); return; }
      }
      const baseBranch = branch ?? repo.defaultBranch;
      const msg = String(body.message ?? 'update');
      const { commitSha, blobSha } = commitFile(repo, baseBranch, p, data, msg);
      sendJson(ctx, existing ? 200 : 201, {
        content: { name: p.split('/').pop(), path: p, sha: blobSha, size: data.length, encoding: 'base64', content: contentB64, type: 'file' },
        commit: { sha: commitSha, message: msg, author: { name: VIEWER.name, email: VIEWER.email }, committer: { name: VIEWER.name, email: VIEWER.email } },
      });
      return;
    }
    if (method === 'DELETE') {
      const p = pathParts.join('/');
      const tip = resolveRefTip(repo, branch);
      if (!tip) { sendErr(ctx, 404, 'Not Found'); return; }
      const files = filesAt(repo, tip);
      const existing = files.get(p);
      if (!existing) { sendErr(ctx, 404, 'Not Found'); return; }
      const sha = String(body.sha ?? '');
      if (sha && sha !== existing.oid) { sendErr(ctx, 409, 'sha does not match'); return; }
      const msg = String(body.message ?? 'delete');
      const baseBranch = branch ?? repo.defaultBranch;
      const newFiles = new Map(files); newFiles.delete(p);
      const newTree = treeFromFiles(repo, newFiles);
      const commitData = makeCommit(newTree, [tip], msg, nowTs());
      const commitSha = hashObject('commit', commitData);
      repo.objects.set(commitSha, { type: 'commit', data: commitData });
      repo.refs.set(`refs/heads/${baseBranch}`, commitSha);
      sendJson(ctx, 200, { commit: { sha: commitSha, message: msg } });
      return;
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  if (section === 'labels') {
    if (method === 'GET') { sendJson(ctx, 200, [...repo.labels.values()]); return; }
    if (method === 'POST') {
      const name = String(body.name ?? '');
      if (!name) { sendErr(ctx, 422, 'name is required'); return; }
      const label = { name, color: String(body.color ?? 'ededed'), description: String(body.description ?? '') };
      repo.labels.set(name, label);
      sendJson(ctx, 201, label); return;
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  if (section === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let list = [...repo.issues];
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const sort = ctx.query.get('sort');
        const dir = ctx.query.get('direction') ?? 'desc';
        if (sort === 'created') list.sort((a, b) => dir === 'asc' ? a.number - b.number : b.number - a.number);
        const pg = paginate(ctx, list);
        sendJson(ctx, 200, pg.page.map((i) => issueJson(repo, i)), pg.link ? { Link: pg.link } : undefined);
        return;
      }
      if (method === 'POST') {
        const title = String(body.title ?? '');
        if (!title) { sendErr(ctx, 422, 'title is required'); return; }
        const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).map((l) => typeof l === 'string' ? l : String((l as Record<string, unknown>).name ?? '')) : [];
        for (const ln of labelNames) {
          if (!repo.labels.has(ln)) { sendErr(ctx, 422, `Label ${ln} does not exist`); return; }
        }
        const iss = new GqlExecutor().createIssue(repo, title, String(body.body ?? ''), labelNames);
        sendJson(ctx, 201, issueJson(repo, iss));
        return;
      }
    }
    if (rest.length >= 2) {
      const num = parseInt(rest[1] as string, 10);
      const iss = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!iss) { sendErr(ctx, 404, 'Not Found'); return; }
        if (method === 'GET') { sendJson(ctx, 200, issueJson(repo, iss)); return; }
        if (method === 'PATCH') {
          if (body.title !== undefined) iss.title = String(body.title);
          if (body.body !== undefined) iss.body = String(body.body);
          if (body.state !== undefined) iss.state = String(body.state) === 'closed' ? 'closed' : 'open';
          iss.updatedAt = isoNow();
          sendJson(ctx, 200, issueJson(repo, iss)); return;
        }
        sendErr(ctx, 404, 'Not Found'); return;
      }
      if (rest[2] === 'comments') {
        if (!iss) { sendErr(ctx, 404, 'Not Found'); return; }
        if (method === 'GET') {
          const pg = paginate(ctx, iss.comments);
          sendJson(ctx, 200, pg.page, pg.link ? { Link: pg.link } : undefined);
          return;
        }
        if (method === 'POST') {
          const b = String(body.body ?? '');
          if (!b) { sendErr(ctx, 422, 'body is required'); return; }
          repo.commentSeq += 1;
          const c = { id: repo.commentSeq, body: b, createdAt: isoNow() };
          iss.comments.push(c);
          sendJson(ctx, 201, c);
          return;
        }
      }
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  if (section === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') {
        let list = [...repo.pulls];
        const state = ctx.query.get('state') ?? 'open';
        if (state !== 'all') list = list.filter((p) => p.state === state);
        const pg = paginate(ctx, list);
        sendJson(ctx, 200, pg.page.map((p) => pullJson(repo, p)), pg.link ? { Link: pg.link } : undefined);
        return;
      }
      if (method === 'POST') {
        const title = String(body.title ?? '');
        const head = String(body.head ?? '');
        const base = String(body.base ?? repo.defaultBranch);
        if (!title || !head) { sendErr(ctx, 422, 'title and head are required'); return; }
        const pr = createPullInternal(repo, head, base, title, String(body.body ?? ''));
        if (!pr) { sendErr(ctx, 422, 'Head or base branch not found'); return; }
        sendJson(ctx, 201, pullJson(repo, pr));
        return;
      }
    }
    if (rest.length >= 2) {
      const num = parseInt(rest[1] as string, 10);
      const pr = repo.pulls.find((p) => p.number === num);
      if (!pr) { sendErr(ctx, 404, 'Not Found'); return; }
      if (rest.length === 2 && method === 'GET') { sendJson(ctx, 200, pullJson(repo, pr)); return; }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const mb = mergeBase(repo, repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha, repo.refs.get(`refs/heads/${pr.base}`) ?? pr.baseSha);
        const files = diffFiles(repo, mb, repo.refs.get(`refs/heads/${pr.head}`) ?? pr.headSha);
        sendJson(ctx, 200, files.map((f) => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })));
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pr.state !== 'open') { sendErr(ctx, 405, 'Pull request is not open'); return; }
        if (!prMergeable(repo, pr)) { sendErr(ctx, 405, 'Merge conflict'); return; }
        const sha = squashMerge(repo, pr);
        if (!sha) { sendErr(ctx, 409, 'Merge failed'); return; }
        pr.state = 'closed'; pr.merged = true; pr.mergeSha = sha; pr.mergedAt = isoNow();
        sendJson(ctx, 200, { sha, merged: true, message: `Pull request #${pr.number} merged` });
        return;
      }
    }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  sendErr(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- git routing
function handleGit(ctx: HttpCtx, pathParts: string[]): void {
  const method = ctx.req.method ?? 'GET';
  const [owner, repoGit] = pathParts;
  if (!owner || !repoGit || !repoGit.endsWith('.git')) { sendErr(ctx, 404, 'Not Found'); return; }
  const repoName = repoGit.slice(0, -4);
  const repo = owner === VIEWER_LOGIN ? (repos.get(repoKey(owner, repoName)) ?? null) : null;
  if (!repo) {
    if (method === 'GET' && ctx.pathname.endsWith('/info/refs')) { sendErr(ctx, 404, 'Not Found'); return; }
    if (method === 'POST') { sendErr(ctx, 404, 'Not Found'); return; }
    sendErr(ctx, 404, 'Not Found'); return;
  }
  const service = ctx.query.get('service') ?? '';
  if (method === 'GET' && ctx.pathname.endsWith('/info/refs')) {
    if (service === 'git-upload-pack') {
      const isV2 = (ctx.req.headers['git-protocol'] as string | undefined) === 'version=2';
      const body = isV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
      ctx.res.writeHead(200, {
        'Content-Type': `application/x-git-upload-pack-advertisement`,
        'Cache-Control': 'no-cache',
      });
      ctx.res.end(body);
      return;
    }
    if (service === 'git-receive-pack') {
      const body = v0Advertisement(repo, 'git-receive-pack');
      ctx.res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-advertisement', 'Cache-Control': 'no-cache' });
      ctx.res.end(body);
      return;
    }
    sendErr(ctx, 403, 'Forbidden'); return;
  }
  if (method === 'POST' && ctx.pathname.endsWith('/git-upload-pack')) {
    const isV2 = (ctx.req.headers['git-protocol'] as string | undefined) === 'version=2';
    const out = isV2 ? handleUploadPackV2(repo, ctx.rawBody) : handleUploadPackV0(repo, ctx.rawBody);
    ctx.res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'Cache-Control': 'no-cache' });
    ctx.res.end(out);
    return;
  }
  if (method === 'POST' && ctx.pathname.endsWith('/git-receive-pack')) {
    const r = handleReceivePack(repo, ctx.rawBody);
    ctx.res.writeHead(r.status, { 'Content-Type': r.contentType, 'Cache-Control': 'no-cache' });
    ctx.res.end(r.body);
    return;
  }
  sendErr(ctx, 404, 'Not Found');
}

// ---------------------------------------------------------------- server
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let bodyLen = 0;
    req.on('data', (c: Buffer) => { chunks.push(c); bodyLen += c.length; if (bodyLen > 32 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname;
        const query = url.searchParams;
        const ctx: HttpCtx = { req, res, pathname, query, body: undefined, rawBody };
        const isApi = pathname.startsWith('/api/v3') || pathname === '/api/graphql';
        const authed = authOk(req);
        if (pathname === '/healthz' && req.method === 'GET') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (pathname === '/mcp' && req.method === 'POST') {
          let body: unknown = null; let parseOk = true;
          if (rawBody.length > 0) { try { body = JSON.parse(rawBody.toString('utf8')); } catch { parseOk = false; } }
          if (!parseOk) {
            sendJson(ctx, 400, mcpError(null, -32700, 'Parse error'));
            return;
          }
          const r = handleMcp(body, authed);
          if (r.empty) { res.writeHead(202); res.end(); return; }
          sendJson(ctx, r.status, r.payload);
          return;
        }
        if (pathname === '/api/graphql' && req.method === 'POST') {
          if (!authed) { sendErr(ctx, 401, 'Unauthorized'); return; }
          let body: unknown = null;
          try { body = rawBody.length ? JSON.parse(rawBody.toString('utf8')) : {}; } catch { sendErr(ctx, 400, 'Invalid JSON'); return; }
          const r = handleGraphQL(body);
          sendJson(ctx, r.status, r.payload);
          return;
        }
        if (isApi) {
          if (!authed) { sendErr(ctx, 401, 'Unauthorized'); return; }
          const m = req.method ?? 'GET';
          if ((m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') && rawBody.length > 0) {
            try { ctx.body = JSON.parse(rawBody.toString('utf8')); }
            catch { sendErr(ctx, 400, 'Invalid JSON'); return; }
          } else {
            ctx.body = {};
          }
          handleRest(ctx);
          return;
        }
        // git smart HTTP: /{owner}/{repo}.git/...
        const gitParts = pathname.split('/').filter((s) => s !== '');
        if (gitParts.length >= 2 && gitParts[1]?.endsWith('.git')) {
          handleGit(ctx, gitParts);
          return;
        }
        sendErr(ctx, 404, 'Not Found');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': reqId() });
          res.end(JSON.stringify({ message: msg }));
        }
      }
    });
    req.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  });
}
