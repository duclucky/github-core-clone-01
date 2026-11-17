// Git smart HTTP: upload-pack (protocol v2 and v0) and receive-pack (v0),
// implemented from scratch on node:zlib and node:crypto. No git binary.
//
// Wire rules (from the kit's git-client.ts, the spec):
// - pkt-line: 4 lowercase hex chars of length (payload + 4); 0000 flush,
//   0001 delim, 0002 response-end. Max packet 65520 bytes.
// - v0 advertisements open with "# service=git-upload-pack" /
//   "# service=git-receive-pack", then a flush, then ref lines.
// - v2 advertisement opens with "version 2".
// - receive-pack advertises report-status, side-band-64k, delete-refs;
//   its report is pkt-framed inside band-1 sideband packets.
// - Every update must fast-forward; a non-fast-forward ref is refused
//   with the exact reason "non-fast-forward" and does not move.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  objectId,
  parseCommit,
  parseTree,
  type GitObject,
  type ObjType,
  type Repo,
  type Store,
} from './store.ts';

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, payload]);
}

export type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Parse pkt-lines until the buffer ends or a malformed header appears. */
export function parsePktLines(buf: Buffer): PktItem[] {
  const out: PktItem[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const hex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'end' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'data', data: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}

function pktText(items: PktItem[]): string {
  let s = '';
  for (const it of items) if (it.kind === 'data') s += it.data.toString('utf8');
  return s;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_COMMIT = 1;
const TYPE_TREE = 2;
const TYPE_BLOB = 3;
const TYPE_TAG = 4;
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

function typeCode(t: ObjType): number {
  if (t === 'commit') return TYPE_COMMIT;
  if (t === 'tree') return TYPE_TREE;
  if (t === 'blob') return TYPE_BLOB;
  return TYPE_TAG;
}

function typeName(code: number): ObjType | null {
  if (code === TYPE_COMMIT) return 'commit';
  if (code === TYPE_TREE) return 'tree';
  if (code === TYPE_BLOB) return 'blob';
  if (code === TYPE_TAG) return 'tag';
  return null;
}

function encodeEntryHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (size & 0x0f) | (type << 4);
  size >>>= 4;
  if (size > 0) b |= 0x80;
  bytes.push(b);
  while (size > 0) {
    b = size & 0x7f;
    size >>>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}

/** Build a plain-object pack (no deltas), entries in oid order. */
export function buildPack(objects: GitObject[]): Buffer {
  const sorted = objects.slice().sort((a, b) => {
    const oa = objectId(a.type, a.data);
    const ob = objectId(b.type, b.data);
    return oa < ob ? -1 : oa > ob ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  parts.push(head);
  for (const o of sorted) {
    parts.push(encodeEntryHeader(typeCode(o.type), o.data.length));
    parts.push(deflateSync(o.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

interface RawEntry {
  offset: number;
  type: number;
  baseOffset?: number;
  baseOid?: string;
  data?: Buffer;
  oid?: string;
}

function readVarint(buf: Buffer, i: number): { value: number; next: number } {
  let value = buf[i] ?? 0;
  let next = i + 1;
  while ((buf[next - 1] ?? 0) & 0x80) {
    value = ((value + 1) << 7) | (buf[next] & 0x7f);
    next += 1;
  }
  return { value, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    while (i < delta.length) {
      const b = delta[i] as number;
      i += 1;
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const dstSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i] as number;
    i += 1;
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          off |= (delta[i] as number) << (bit * 8);
          i += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          size |= (delta[i] as number) << (bit * 8);
          i += 1;
        }
      }
      if (size === 0) size = 0x10000;
      if (off + size > base.length) throw new Error('delta copy out of range');
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op > 0) {
      if (i + op > delta.length) throw new Error('delta insert out of range');
      out.push(delta.subarray(i, i + op));
      i += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (total !== dstSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

/** Parse a packfile, resolving ofs/ref deltas against the pack and the repo store. */
export function parsePack(buf: Buffer, repo: Repo): GitObject[] {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const raw: RawEntry[] = [];
  let off = 12;
  for (let n = 0; n < count; n += 1) {
    const start = off;
    let b = buf[off] as number;
    off += 1;
    const type = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) {
      b = buf[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const entry: RawEntry = { offset: start, type };
    if (type === TYPE_OFS_DELTA) {
      const r = readVarint(buf, off);
      off = r.next;
      entry.baseOffset = start - r.value;
    } else if (type === TYPE_REF_DELTA) {
      entry.baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    // Inflate: inflateSync with {info:true} reports bytes consumed.
    const rest = buf.subarray(off);
    const { buffer, engine } = inflateSync(rest, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    entry.data = buffer;
    off += engine.bytesWritten;
    void size;
    raw.push(entry);
  }
  // Resolve entries.
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const resolved: GitObject[] = [];
  const storeLookup = (oid: string): GitObject | undefined => {
    return byOid.get(oid) ?? repo.objects.get(oid);
  };
  let progress = true;
  const pending = new Set<number>(raw.map((_, i) => i));
  while (pending.size > 0 && progress) {
    progress = false;
    for (const i of [...pending]) {
      const e = raw[i] as RawEntry;
      const t = typeName(e.type);
      if (t !== null) {
        const data = e.data as Buffer;
        const obj: GitObject = { type: t, data };
        const oid = objectId(t, data);
        e.oid = oid;
        byOffset.set(e.offset, obj);
        byOid.set(oid, obj);
        resolved.push(obj);
        pending.delete(i);
        progress = true;
      } else if (e.type === TYPE_OFS_DELTA || e.type === TYPE_REF_DELTA) {
        let base: GitObject | undefined;
        if (e.type === TYPE_OFS_DELTA) base = byOffset.get(e.baseOffset as number);
        else base = storeLookup(e.baseOid as string);
        if (base !== undefined) {
          const data = applyDelta(base.data, e.data as Buffer);
          const obj: GitObject = { type: base.type, data };
          const oid = objectId(base.type, data);
          e.oid = oid;
          byOffset.set(e.offset, obj);
          byOid.set(oid, obj);
          resolved.push(obj);
          pending.delete(i);
          progress = true;
        }
      }
    }
  }
  if (pending.size > 0) throw new Error('unresolvable delta in pack');
  return resolved;
}

// ---------------------------------------------------------------------------
// Reachability / object selection for fetch
// ---------------------------------------------------------------------------

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

function reachableFrom(repo: Repo, commits: string[], includeParents: boolean): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack: string[] = [];
  const seenCommits = new Set<string>();
  for (const c of commits) stack.push(c);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seenCommits.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      seenCommits.add(oid);
      out.set(oid, obj);
      const info = parseCommit(obj.data);
      addTree(repo, info.tree, out);
      if (includeParents) for (const p of info.parents) stack.push(p);
    } else if (obj.type === 'tag') {
      out.set(oid, obj);
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) stack.push(m[1] as string);
    } else {
      out.set(oid, obj);
    }
  }
  return out;
}

function addTree(repo: Repo, treeOid: string, out: Map<string, GitObject>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree' || out.has(treeOid)) return;
  out.set(treeOid, obj);
  for (const e of parseTree(obj.data)) {
    if (e.mode === '40000') addTree(repo, e.oid, out);
    else if (e.mode !== '160000') {
      const child = repo.objects.get(e.oid);
      if (child) out.set(e.oid, child);
    }
  }
}

export function selectFetch(
  repo: Repo,
  wants: string[],
  haves: string[],
  clientShallow: string[],
  depth: number | null,
): FetchSelection {
  const shallowSet = new Set(clientShallow);
  // Excluded = closure(haves minus shallow boundaries) + the boundaries themselves.
  const haveNonShallow = haves.filter((h) => !shallowSet.has(h));
  const excluded = reachableFrom(repo, haveNonShallow, true);
  for (const s of shallowSet) excluded.set(s, repo.objects.get(s) as GitObject);

  // Included commits: BFS from wants, generation-limited when depth is set.
  const included = new Set<string>();
  const queue: Array<[string, number]> = wants.map((w) => [w, 1] as [string, number]);
  const seenQ = new Set<string>();
  while (queue.length > 0) {
    const [cur, gen] = queue.shift() as [string, number];
    if (seenQ.has(cur)) continue;
    seenQ.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) queue.push([m[1] as string, gen]);
      included.add(cur);
      continue;
    }
    if (obj.type !== 'commit') {
      included.add(cur);
      continue;
    }
    included.add(cur);
    if (depth === null || gen < depth) {
      for (const p of parseCommit(obj.data).parents) queue.push([p, gen + 1]);
    }
  }

  const sent = new Map<string, GitObject>();
  for (const c of included) {
    const got = reachableFrom(repo, [c], false);
    for (const [oid, o] of got) {
      if (!excluded.has(oid)) sent.set(oid, o);
    }
  }
  // Tag wants: include the tag object itself.
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag' && !excluded.has(w)) sent.set(w, obj);
  }

  // Shallow boundaries of the answer: included commits with a parent not included.
  const shallow: string[] = [];
  for (const c of included) {
    const obj = repo.objects.get(c);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.length > 0 && parents.some((p) => !included.has(p))) shallow.push(c);
  }
  shallow.sort();
  // Unshallow: client boundaries now fully included.
  const unshallow: string[] = [];
  for (const s of shallowSet) {
    const obj = repo.objects.get(s);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.every((p) => included.has(p))) unshallow.push(s);
  }
  unshallow.sort();
  return { objects: [...sent.values()], shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function refLines(repo: Repo): Array<{ oid: string; name: string; peeled?: string }> {
  const out: Array<{ oid: string; name: string; peeled?: string }> = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const obj = repo.objects.get(oid);
    let peeled: string | undefined;
    if (obj && obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})$/m.exec(text);
      if (m) peeled = m[1];
    }
    out.push({ oid, name, peeled });
  }
  return out;
}

export function v0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps =
    service === 'upload-pack'
      ? 'side-band-64k thin-pack ofs-delta shallow symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine(`# service=git-${service}\n`), PKT_FLUSH];
  const refs = refLines(repo);
  const headOid = repo.refs.get('refs/heads/main') ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pktLine(`${r.oid} ${r.name}\n`));
      if (r.peeled) parts.push(pktLine(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const slice = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    // A zero-length pack still needs no packets; the section ends with flush.
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleLsRefs(repo: Repo, body: Buffer): Buffer {
  const items = parsePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const it of items) {
    if (it.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (it.kind !== 'data') continue;
    const line = it.data.toString('utf8').trim();
    if (!pastDelim) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const headOid = repo.refs.get('refs/heads/main');
  const refs = refLines(repo);
  const matchPrefix = (name: string): boolean => {
    if (prefixes.length === 0) return true;
    return prefixes.some((p) => name.startsWith(p));
  };
  if (headOid && matchPrefix('HEAD')) {
    parts.push(pktLine(`${headOid} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  } else if (!headOid && unborn) {
    parts.push(pktLine('unborn HEAD symref-target:refs/heads/main\n'));
  }
  for (const r of refs) {
    if (!matchPrefix(r.name)) continue;
    let line = `${r.oid} ${r.name}`;
    if (peel && r.peeled) line += ` peeled:${r.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV2(repo: Repo, body: Buffer, store: Store): Buffer {
  const items = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let pastDelim = false;
  for (const it of items) {
    if (it.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (it.kind !== 'data' || !pastDelim) continue;
    const line = it.data.toString('utf8').trim();
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10) || null;
  }
  const cacheKey = `v2|${wants.join(',')}|${haves.join(',')}|${shallows.join(',')}|${depth ?? ''}`;
  const cached = repo.packCache.get(cacheKey);
  let pack: Buffer;
  let shallow: string[];
  let unshallow: string[];
  if (cached) {
    pack = cached;
    shallow = [];
    unshallow = [];
    // Shallow lines are recomputed cheaply from the same selection; the pack
    // bytes are the expensive part and they are what the cache holds. The
    // selection itself is also needed for shallow-info, so recompute it
    // only when shallow info exists.
    const sel = selectFetch(repo, wants, haves, shallows, depth);
    shallow = sel.shallow;
    unshallow = sel.unshallow;
  } else {
    const sel = selectFetch(repo, wants, haves, shallows, depth);
    pack = buildPack(sel.objects);
    shallow = sel.shallow;
    unshallow = sel.unshallow;
    repo.packCache.set(cacheKey, pack);
  }
  void store;
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(PKT_DELIM);
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  // Two sections separated by a flush: wants, then haves + done.
  const items = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const it of items) {
    if (it.kind === 'flush') {
      section = 1;
      continue;
    }
    if (it.kind !== 'data') continue;
    const line = it.data.toString('utf8').trim();
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
      else if (line.startsWith('shallow ')) shallows.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10) || null;
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const cacheKey = `v0|${wants.join(',')}|${haves.join(',')}|${shallows.join(',')}|${depth ?? ''}`;
  let pack = repo.packCache.get(cacheKey);
  let shallow: string[] = [];
  let unshallow: string[] = [];
  const sel = selectFetch(repo, wants, haves, shallows, depth);
  shallow = sel.shallow;
  unshallow = sel.unshallow;
  if (!pack) {
    pack = buildPack(sel.objects);
    repo.packCache.set(cacheKey, pack);
  }
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer, store: Store): Buffer {
  // Split commands (pkt-lines) from the raw pack at the first flush.
  let flushAt = -1;
  let i = 0;
  while (i + 4 <= body.length) {
    const hex = body.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(hex)) break;
    const len = parseInt(hex, 16);
    if (len === 0) {
      flushAt = i;
      break;
    }
    if (len < 4 || i + len > body.length) break;
    i += len;
  }
  const cmdBuf = flushAt === -1 ? body : body.subarray(0, flushAt);
  const packBuf = flushAt === -1 ? Buffer.alloc(0) : body.subarray(flushAt + 4);
  const items = parsePktLines(cmdBuf);
  const commands: PushCommand[] = [];
  for (const it of items) {
    if (it.kind !== 'data') continue;
    let line = it.data.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    const parts = line.trim().split(' ');
    if (parts.length >= 3) {
      commands.push({
        oldOid: (parts[0] as string).toLowerCase(),
        newOid: (parts[1] as string).toLowerCase(),
        ref: parts[2] as string,
      });
    }
  }

  const report: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  let unpackOk = true;
  let unpackErr = '';
  if (packBuf.length > 0) {
    try {
      const objects = parsePack(packBuf, repo);
      for (const o of objects) {
        const oid = objectId(o.type, o.data);
        if (!repo.objects.has(oid)) repo.objects.set(oid, o);
      }
    } catch (err) {
      unpackOk = false;
      unpackErr = err instanceof Error ? err.message : String(err);
    }
  }

  if (unpackOk) {
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current !== undefined && current === cmd.oldOid) {
          repo.refs.delete(cmd.ref);
          report.push({ ref: cmd.ref, ok: true });
        } else {
          report.push({ ref: cmd.ref, ok: false, reason: 'failed to delete' });
        }
      } else if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
        } else if (!repo.objects.has(cmd.newOid)) {
          report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          report.push({ ref: cmd.ref, ok: true });
        }
      } else {
        // Update: must fast-forward.
        if (current === undefined || current !== cmd.oldOid) {
          report.push({ ref: cmd.ref, ok: false, reason: 'stale old value' });
        } else if (cmd.newOid === cmd.oldOid) {
          report.push({ ref: cmd.ref, ok: true });
        } else if (!repo.objects.has(cmd.newOid)) {
          report.push({ ref: cmd.ref, ok: false, reason: 'object not found' });
        } else if (cmd.ref.startsWith('refs/tags/')) {
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        } else if (store.isAncestor(repo, cmd.oldOid, cmd.newOid)) {
          repo.refs.set(cmd.ref, cmd.newOid);
          report.push({ ref: cmd.ref, ok: true });
        } else {
          report.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        }
      }
    }
    repo.pushedAt = store.tick();
    store.invalidatePackCache(repo);
  }

  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackErr}\n`));
  if (unpackOk) {
    for (const r of report) {
      inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`));
    }
  }
  inner.push(PKT_FLUSH);
  const innerBuf = Buffer.concat(inner);
  const outer: Buffer[] = [];
  const CHUNK = 65515;
  for (let j = 0; j < innerBuf.length; j += CHUNK) {
    const slice = innerBuf.subarray(j, Math.min(innerBuf.length, j + CHUNK));
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  outer.push(PKT_FLUSH);
  return Buffer.concat(outer);
}
