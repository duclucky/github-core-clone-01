// The forge's store: one in-memory git object database per repository,
// plus the REST resources (issues, pull requests, labels, comments)
// that live on top of it. Everything is deterministic: ids come from
// counters, timestamps from a logical clock that starts at the
// competition's opening and ticks one second per mutation. No wall
// clock, no randomness anywhere the suite can observe.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const DEFAULT_BRANCH = 'main';

const CLOCK_EPOCH_MS = Date.UTC(2026, 10, 14, 6, 30, 0);

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  comments: Comment[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  userLogin: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Repo {
  owner: string;
  name: string;
  databaseId: number;
  description: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  issuePrCounter: number;
  packCache: Map<string, Buffer>;
  seq: number;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of a raw object: sha1("<type> <size>\0" + bytes). */
export function objectId(type: ObjType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, data]));
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    i = nul + 21;
  }
  return out;
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Git tree sort order: entries by name, directories as if suffixed '/'. */
export function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? `${e.name}/` : e.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const idx = text.indexOf('\n\n');
  const message = idx === -1 ? '' : text.slice(idx + 2);
  return { tree, parents, author, committer, message };
}

export function buildCommit(tree: string, parents: string[], message: string, epochSec: number): Buffer {
  const who = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${who}\ncommitter ${who}\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

export class Store {
  repos = new Map<string, Repo>();
  private nextDb = 1;
  private nextRest = 1;
  private clockSec = 0;
  private nextReq = 1;

  /** Next deterministic timestamp, ISO-8601, one second per mutation. */
  tick(): string {
    const ms = CLOCK_EPOCH_MS + this.clockSec * 1000;
    this.clockSec += 1;
    return new Date(ms).toISOString().replace('.000Z', 'Z');
  }

  /** Current logical epoch seconds (for commit author lines). */
  epochSec(): number {
    return Math.floor(CLOCK_EPOCH_MS / 1000) + this.clockSec;
  }

  nextRequestId(): string {
    const n = this.nextReq;
    this.nextReq += 1;
    return `req-${n.toString(16).padStart(8, '0')}`;
  }

  nextRestId(): number {
    const n = this.nextRest;
    this.nextRest += 1;
    return n;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const now = this.tick();
    const repo: Repo = {
      owner,
      name,
      databaseId: this.nextDb,
      description,
      private: isPrivate,
      createdAt: now,
      updatedAt: now,
      pushedAt: null,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      issuePrCounter: 0,
      packCache: new Map(),
      seq: this.nextDb,
    };
    this.nextDb += 1;
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) {
      if (r.owner === owner) out.push(r);
    }
    out.sort((a, b) => a.databaseId - b.databaseId);
    return out;
  }

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = objectId(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  putBlob(repo: Repo, data: Buffer): string {
    return this.putObject(repo, 'blob', data);
  }

  invalidatePackCache(repo: Repo): void {
    repo.packCache.clear();
  }

  /** Resolve a ref name, branch name, or commit sha to a commit oid. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/i.test(ref)) {
      const o = repo.objects.get(ref.toLowerCase());
      return o && o.type === 'commit' ? ref.toLowerCase() : null;
    }
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    return repo.refs.get(full) ?? null;
  }

  /** Walk commit parents from `oid`, collecting every reachable commit oid. */
  ancestors(repo: Repo, oid: string): Set<string> {
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(cur);
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    }
    return seen;
  }

  /** True when `anc` is `desc` or reachable from it by parent links.
   * Early-exits on first hit: a push's fast-forward check only ever
   * walks one step in a linear history. */
  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const seen = new Set<string>();
    const stack = [desc];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) {
        if (p === anc) return true;
        stack.push(p);
      }
    }
    return false;
  }

  /** Best common ancestor of two commits (the merge-base). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aa = this.ancestors(repo, a);
    const bb = this.ancestors(repo, b);
    const common: string[] = [];
    for (const c of aa) if (bb.has(c)) common.push(c);
    if (common.length === 0) return null;
    // Drop any common ancestor that is an ancestor of another common one.
    const best = common.filter((c) => {
      for (const d of common) {
        if (d !== c && this.isAncestor(repo, c, d)) return false;
      }
      return true;
    });
    return best[0] ?? common[0] ?? null;
  }

  /** All blob paths under a tree, path -> blob oid. */
  flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
    const obj = repo.objects.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else if (e.mode !== '160000') out.set(path, e.oid);
    }
  }

  treeOfCommit(repo: Repo, commitOid: string): string {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return '';
    return parseCommit(obj.data).tree;
  }

  /** Set (or delete, when blobOid is null) one path in a tree, rebuilding parents. */
  setPath(repo: Repo, treeOid: string | null, segments: string[], blobOid: string | null): string {
    const entries: TreeEntry[] = treeOid ? parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0)) : [];
    const [head, ...rest] = segments as [string, ...string[]];
    const idx = entries.findIndex((e) => e.name === head);
    if (rest.length === 0) {
      if (blobOid === null) {
        if (idx !== -1) entries.splice(idx, 1);
      } else if (idx !== -1) {
        entries[idx] = { mode: '100644', name: head, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name: head, oid: blobOid });
      }
    } else {
      const childTree = idx !== -1 && entries[idx]?.mode === '40000' ? entries[idx]?.oid ?? null : null;
      const newChild = this.setPath(repo, childTree, rest, blobOid);
      const childObj = repo.objects.get(newChild);
      const empty = childObj !== undefined && parseTree(childObj.data).length === 0;
      if (empty && blobOid === null) {
        if (idx !== -1) entries.splice(idx, 1);
      } else if (idx !== -1) {
        entries[idx] = { mode: '40000', name: head, oid: newChild };
      } else {
        entries.push({ mode: '40000', name: head, oid: newChild });
      }
    }
    const data = serializeTree(sortTreeEntries(entries));
    return this.putObject(repo, 'tree', data);
  }

  /** Look up one path in a tree: {type, oid} or null. */
  lookupPath(repo: Repo, treeOid: string, segments: string[]): { type: 'blob' | 'tree'; oid: string } | null {
    let cur = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'tree') return null;
      const e = parseTree(obj.data).find((x) => x.name === segments[i]);
      if (!e) return null;
      if (i === segments.length - 1) {
        return e.mode === '40000' ? { type: 'tree', oid: e.oid } : { type: 'blob', oid: e.oid };
      }
      if (e.mode !== '40000') return null;
      cur = e.oid;
    }
    return null;
  }

  /** Diff two trees: per-path {oldOid|null, newOid|null}. */
  diffTrees(repo: Repo, baseTree: string, headTree: string): Array<{ path: string; oldOid: string | null; newOid: string | null }> {
    const base = new Map<string, string>();
    const head = new Map<string, string>();
    if (baseTree !== '') this.flattenTree(repo, baseTree, '', base);
    if (headTree !== '') this.flattenTree(repo, headTree, '', head);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: Array<{ path: string; oldOid: string | null; newOid: string | null }> = [];
    for (const p of [...paths].sort()) {
      const o = base.get(p) ?? null;
      const n = head.get(p) ?? null;
      if (o !== n) out.push({ path: p, oldOid: o, newOid: n });
    }
    return out;
  }

  /** Line counts for a diff entry (multiset line diff, good enough for additions/deletions). */
  lineDiff(repo: Repo, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
    const oldText = oldOid ? (repo.objects.get(oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = newOid ? (repo.objects.get(newOid)?.data.toString('utf8') ?? '') : '';
    const oldLines = oldText === '' ? [] : oldText.split('\n');
    const newLines = newText === '' ? [] : newText.split('\n');
    const counts = new Map<string, number>();
    for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
    let additions = 0;
    for (const l of newLines) {
      const c = counts.get(l) ?? 0;
      if (c > 0) counts.set(l, c - 1);
      else additions += 1;
    }
    let left = 0;
    for (const c of counts.values()) left += c;
    return { additions, deletions: left };
  }

  /** Commits reachable from `tip`, newest first (by generation depth, then oid for determinism). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const gen = new Map<string, number>();
    const order: string[] = [];
    const stack: Array<[string, number]> = [[tip, 0]];
    while (stack.length > 0) {
      const [cur, g] = stack.pop() as [string, number];
      if (seen.has(cur)) continue;
      const obj = repo.objects.get(cur);
      if (!obj || obj.type !== 'commit') continue;
      seen.add(cur);
      gen.set(cur, Math.max(gen.get(cur) ?? 0, g));
      order.push(cur);
      for (const p of parseCommit(obj.data).parents) stack.push([p, g + 1]);
    }
    order.sort((a, b) => (gen.get(a) ?? 0) - (gen.get(b) ?? 0) || (a < b ? -1 : 1));
    return order;
  }
}
