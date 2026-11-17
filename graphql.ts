// GraphQL v4 at /api/graphql: a small lexer + recursive-descent parser
// and an executor for exactly the documents gh and github-mcp-server
// send, plus the introspection probes the suite runs. No directives
// are sent; fragments (named and inline) and aliases are supported.
// Unknown fields answer HTTP 200 with an errors array naming the
// field; an unknown repository resolves to data.repository = null
// with no errors. Same store as REST, git and MCP.

import type { ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  gid,
  jsonError,
  requireAuth,
  sendJson,
  type Ctx,
} from './http.ts';
import { mergePullInStore, prConflict } from './rest.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Tok =
  | { k: 'name'; v: string }
  | { k: 'int'; v: string }
  | { k: 'float'; v: string }
  | { k: 'str'; v: string }
  | { k: 'punct'; v: string }
  | { k: 'spread' }
  | { k: 'eof' };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      out.push({ k: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      out.push({ k: 'punct', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1] as string;
          if (e === 'n') s += '\n';
          else if (e === 't') s += '\t';
          else if (e === 'r') s += '\r';
          else if (e === '"') s += '"';
          else if (e === '\\') s += '\\';
          else if (e === '/') s += '/';
          else if (e === 'u') {
            s += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else s += e;
          j += 2;
        } else {
          s += src[j];
          j += 1;
        }
      }
      out.push({ k: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      let isFloat = false;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] as string)) {
        isFloat = true;
        j += 1;
        while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(src[j] as string)) j += 1;
      }
      out.push(isFloat ? { k: 'float', v: src.slice(i, j) } : { k: 'int', v: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      out.push({ k: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  out.push({ k: 'eof' });
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { k: 'var'; name: string }
  | { k: 'int'; v: number }
  | { k: 'float'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'null' }
  | { k: 'enum'; v: string }
  | { k: 'list'; v: ValueNode[] }
  | { k: 'obj'; v: Array<[string, ValueNode]> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<[string, ValueNode]>;
  sel: SelectionNode[] | null;
}

type SelectionNode =
  | { k: 'field'; f: FieldNode }
  | { k: 'frag'; name: string }
  | { k: 'inline'; type: string | null; sel: SelectionNode[] };

interface OpDef {
  kind: 'query' | 'mutation' | 'subscription';
  name: string | null;
  varDefs: string[];
  sel: SelectionNode[];
}

interface FragDef {
  name: string;
  type: string;
  sel: SelectionNode[];
}

interface Document {
  ops: OpDef[];
  frags: Map<string, FragDef>;
}

class Parser {
  toks: Tok[];
  pos = 0;
  constructor(src: string) {
    this.toks = lex(src);
  }
  peek(): Tok {
    return this.toks[this.pos] as Tok;
  }
  next(): Tok {
    const t = this.toks[this.pos] as Tok;
    if (this.pos < this.toks.length - 1) this.pos += 1;
    return t;
  }
  expectPunct(v: string): void {
    const t = this.next();
    if (t.k !== 'punct' || t.v !== v) throw new Error(`expected ${v}`);
  }
  parseDocument(): Document {
    const ops: OpDef[] = [];
    const frags = new Map<string, FragDef>();
    while (this.peek().k !== 'eof') {
      const t = this.peek();
      if (t.k === 'punct' && t.v === '{') {
        ops.push({ kind: 'query', name: null, varDefs: [], sel: this.parseSelectionSet() });
      } else if (t.k === 'name' && (t.v === 'query' || t.v === 'mutation' || t.v === 'subscription')) {
        const kind = this.next().v as 'query' | 'mutation' | 'subscription';
        let name: string | null = null;
        const nt = this.peek();
        if (nt.k === 'name') name = (this.next() as { v: string }).v;
        const varDefs: string[] = [];
        if (this.peek().k === 'punct' && (this.peek() as { v: string }).v === '(') {
          this.next();
          let depth = 1;
          while (depth > 0) {
            const tk = this.next();
            if (tk.k === 'punct' && tk.v === '(') depth += 1;
            else if (tk.k === 'punct' && tk.v === ')') depth -= 1;
            else if (tk.k === 'name' && depth === 1 && varDefs.length === 0) varDefs.push(tk.v);
            else if (tk.k === 'punct' && tk.v === '$') {
              const vn = this.next();
              if (vn.k === 'name') varDefs.push(vn.v);
            }
            if (tk.k === 'eof') break;
          }
        }
        ops.push({ kind, name, varDefs, sel: this.parseSelectionSet() });
      } else if (t.k === 'name' && t.v === 'fragment') {
        this.next();
        const name = (this.next() as { v: string }).v;
        const on = this.next();
        if (on.k !== 'name' || on.v !== 'on') throw new Error('expected on');
        const type = (this.next() as { v: string }).v;
        frags.set(name, { name, type, sel: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { ops, frags };
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (true) {
      const t = this.peek();
      if (t.k === 'eof') break;
      if (t.k === 'punct' && t.v === '}') {
        this.next();
        break;
      }
      if (t.k === 'spread') {
        this.next();
        const nt = this.peek();
        if (nt.k === 'name' && nt.v === 'on') {
          this.next();
          const type = (this.next() as { v: string }).v;
          out.push({ k: 'inline', type, sel: this.parseSelectionSet() });
        } else if (nt.k === 'name') {
          out.push({ k: 'frag', name: (this.next() as { v: string }).v });
        } else {
          out.push({ k: 'inline', type: null, sel: this.parseSelectionSet() });
        }
        continue;
      }
      if (t.k === 'name') {
        const first = (this.next() as { v: string }).v;
        let alias: string | null = null;
        let name = first;
        const ct = this.peek();
        if (ct.k === 'punct' && ct.v === ':') {
          this.next();
          alias = first;
          name = (this.next() as { v: string }).v;
        }
        const args: Array<[string, ValueNode]> = [];
        if (this.peek().k === 'punct' && (this.peek() as { v: string }).v === '(') {
          this.next();
          while (!(this.peek().k === 'punct' && (this.peek() as { v: string }).v === ')')) {
            const an = this.next();
            if (an.k === 'eof') break;
            if (an.k !== 'name') continue;
            this.expectPunct(':');
            args.push([an.v, this.parseValue()]);
          }
          this.expectPunct(')');
        }
        // Skip directives (@name(args)).
        while (this.peek().k === 'punct' && (this.peek() as { v: string }).v === '@') {
          this.next();
          this.next();
          if (this.peek().k === 'punct' && (this.peek() as { v: string }).v === '(') {
            this.next();
            let depth = 1;
            while (depth > 0) {
              const tk = this.next();
              if (tk.k === 'punct' && tk.v === '(') depth += 1;
              else if (tk.k === 'punct' && tk.v === ')') depth -= 1;
              if (tk.k === 'eof') break;
            }
          }
        }
        let sel: SelectionNode[] | null = null;
        if (this.peek().k === 'punct' && (this.peek() as { v: string }).v === '{') {
          sel = this.parseSelectionSet();
        }
        out.push({ k: 'field', f: { alias, name, args, sel } });
        continue;
      }
      this.next();
    }
    return out;
  }
  parseValue(): ValueNode {
    const t = this.next();
    if (t.k === 'punct' && t.v === '$') {
      return { k: 'var', name: (this.next() as { v: string }).v };
    }
    if (t.k === 'int') return { k: 'int', v: parseInt(t.v, 10) };
    if (t.k === 'float') return { k: 'float', v: parseFloat(t.v) };
    if (t.k === 'str') return { k: 'str', v: t.v };
    if (t.k === 'name') {
      if (t.v === 'true') return { k: 'bool', v: true };
      if (t.v === 'false') return { k: 'bool', v: false };
      if (t.v === 'null') return { k: 'null' };
      return { k: 'enum', v: t.v };
    }
    if (t.k === 'punct' && t.v === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().k === 'punct' && (this.peek() as { v: string }).v === ']')) {
        if (this.peek().k === 'eof') break;
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { k: 'list', v: items };
    }
    if (t.k === 'punct' && t.v === '{') {
      const fields: Array<[string, ValueNode]> = [];
      while (!(this.peek().k === 'punct' && (this.peek() as { v: string }).v === '}')) {
        if (this.peek().k === 'eof') break;
        const n = this.next();
        if (n.k !== 'name') continue;
        this.expectPunct(':');
        fields.push([n.v, this.parseValue()]);
      }
      this.expectPunct('}');
      return { k: 'obj', v: fields };
    }
    return { k: 'null' };
  }
}

function evalValue(node: ValueNode, vars: Record<string, unknown>): unknown {
  switch (node.k) {
    case 'var': return vars[node.name] ?? null;
    case 'int': case 'float': case 'str': case 'bool': return node.v;
    case 'null': return null;
    case 'enum': return node.v;
    case 'list': return node.v.map((x) => evalValue(x, vars));
    case 'obj': {
      const o: Record<string, unknown> = {};
      for (const [k, v] of node.v) o[k] = evalValue(v, vars);
      return o;
    }
  }
}

function argsMap(f: FieldNode, vars: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of f.args) o[k] = evalValue(v, vars);
  return o;
}

// ---------------------------------------------------------------------------
// Schema (field names per type, for unknown-field errors and introspection)
// ---------------------------------------------------------------------------

const SCHEMA: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url', 'avatarUrl'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'stargazerCount', 'primaryLanguage'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments', 'url', 'resourcePath', 'repository'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergedAt', 'mergeCommit', 'files', 'author', 'url', 'createdAt', 'updatedAt', 'closedAt'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentEdge: ['node', 'cursor'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Ref: ['name', 'target', 'prefix'],
  MergeCommit: ['oid'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'mutationType', 'types'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'PULL_REQUEST', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// Runtime values
// ---------------------------------------------------------------------------

type RT =
  | { t: 'Query' }
  | { t: 'Mutation' }
  | { t: 'User'; login: string; id: number }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Issue'; repo: Repo; issue: Issue }
  | { t: 'PullRequest'; repo: Repo; pull: Pull }
  | { t: 'IssueConnection'; repo: Repo; items: Issue[]; page: Issue[]; hasNext: boolean; endCursor: string | null; startCursor: string | null }
  | { t: 'PullRequestConnection'; repo: Repo; items: Pull[]; page: Pull[]; hasNext: boolean; endCursor: string | null; startCursor: string | null }
  | { t: 'IssueCommentConnection'; repo: Repo; issueNumber: number; items: Array<{ id: number; body: string; createdAt: string; updatedAt: string }> }
  | { t: 'LabelConnection'; repo: Repo; items: string[] }
  | { t: 'Ref'; name: string }
  | { t: 'IssueComment'; repo: Repo; issueNumber: number; id: number; body: string; createdAt: string; updatedAt: string }
  | { t: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { t: 'Label'; repo: Repo; name: string }
  | { t: 'MergeCommit'; oid: string }
  | { t: 'Type'; name: string; kind: 'OBJECT' | 'ENUM' }
  | { t: 'Field'; name: string }
  | { t: 'EnumValue'; name: string }
  | { t: 'Schema' }
  | { t: 'Edge'; node: RT; cursor: string }
  | { t: 'Payload'; kind: string; issue?: Issue; repo?: Repo; pull?: Pull; comment?: { id: number; body: string; createdAt: string; updatedAt: string }; issueNumber?: number };

function decodeGid(id: string): { kind: string; key: string } | null {
  try {
    const s = Buffer.from(id, 'base64url').toString('utf8');
    const i = s.indexOf(':');
    if (i === -1) return null;
    return { kind: s.slice(0, i), key: s.slice(i + 1) };
  } catch {
    return null;
  }
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function cursorNum(c: string | null | undefined): number | null {
  if (!c) return null;
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    if (!s.startsWith('cursor:')) return null;
    const n = parseInt(s.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

class Executor {
  ctx: Ctx;
  doc: Document;
  vars: Record<string, unknown>;
  errors: Array<{ message: string }> = [];

  constructor(ctx: Ctx, doc: Document, vars: Record<string, unknown>) {
    this.ctx = ctx;
    this.doc = doc;
    this.vars = vars;
  }

  run(op: OpDef): Record<string, unknown> {
    const root: RT = op.kind === 'mutation' ? { t: 'Mutation' } : { t: 'Query' };
    return this.resolveSelection(root, op.sel);
  }

  resolveSelection(parent: RT, sels: SelectionNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const sel of sels) {
      if (sel.k === 'frag') {
        const frag = this.doc.frags.get(sel.name);
        if (frag) {
          const sub = this.resolveSelection(parent, frag.sel);
          Object.assign(out, sub);
        }
        continue;
      }
      if (sel.k === 'inline') {
        if (sel.type !== null && sel.type !== parent.t && !(parent.t === 'Type' && false)) {
          // Type conditions apply to the runtime type; __Type etc. never match.
          if (parent.t !== sel.type) continue;
        }
        const sub = this.resolveSelection(parent, sel.sel);
        Object.assign(out, sub);
        continue;
      }
      const f = sel.f;
      const key = f.alias ?? f.name;
      const typeName = parent.t;
      const known = SCHEMA[typeName];
      if (known && !known.includes(f.name) && f.name !== '__typename') {
        this.errors.push({ message: `Cannot query field "${f.name}" on type "${typeName}".` });
        out[key] = null;
        continue;
      }
      out[key] = this.resolveField(parent, f);
    }
    return out;
  }

  resolveField(parent: RT, f: FieldNode): unknown {
    const args = argsMap(f, this.vars);
    const sel = f.sel;
    const sub = (v: RT | null): unknown => {
      if (v === null || v === undefined) return null;
      if (sel === null) return scalarOf(v);
      if (Array.isArray(v)) return v;
      return this.resolveSelection(v, sel);
    };

    switch (parent.t) {
      case 'Query': {
        if (f.name === '__typename') return 'Query';
        if (f.name === 'viewer') {
          return sub({ t: 'User', login: VIEWER_LOGIN, id: VIEWER_ID });
        }
        if (f.name === 'repository') {
          const owner = String(args['owner'] ?? '');
          const name = String(args['name'] ?? '');
          if (owner !== VIEWER_LOGIN) return null;
          const repo = this.ctx.store.getRepo(owner, name);
          return sub(repo ? { t: 'Repository', repo } : null);
        }
        if (f.name === 'node') {
          const decoded = decodeGid(String(args['id'] ?? ''));
          if (!decoded) return null;
          return sub(this.nodeFor(decoded));
        }
        if (f.name === '__type') {
          const name = String(args['name'] ?? '');
          if (SCHEMA[name]) return sub({ t: 'Type', name, kind: 'OBJECT' });
          if (ENUM_VALUES[name]) return sub({ t: 'Type', name, kind: 'ENUM' });
          return null;
        }
        if (f.name === '__schema') return sub({ t: 'Schema' });
        return null;
      }
      case 'Mutation': {
        if (f.name === '__typename') return 'Mutation';
        if (f.name === 'createIssue') return this.mutationCreateIssue(args, sel);
        if (f.name === 'closeIssue') return this.mutationCloseIssue(args, sel);
        if (f.name === 'createPullRequest') return this.mutationCreatePullRequest(args, sel);
        if (f.name === 'mergePullRequest') return this.mutationMergePullRequest(args, sel);
        if (f.name === 'addComment') return this.mutationAddComment(args, sel);
        return null;
      }
      case 'User': {
        if (f.name === '__typename') return 'User';
        if (f.name === 'login') return parent.login;
        if (f.name === 'id') return gid('User', parent.login);
        if (f.name === 'name') return parent.login === VIEWER_LOGIN ? VIEWER_NAME : parent.login;
        if (f.name === 'email') return parent.login === VIEWER_LOGIN ? VIEWER_EMAIL : '';
        if (f.name === 'url') return `${this.ctx.baseUrl}/${parent.login}`;
        if (f.name === 'avatarUrl') return '';
        return null;
      }
      case 'Repository': {
        const repo = parent.repo;
        if (f.name === '__typename') return 'Repository';
        if (f.name === 'id') return gid('Repository', `${repo.owner}/${repo.name}`);
        if (f.name === 'databaseId') return repo.databaseId;
        if (f.name === 'name') return repo.name;
        if (f.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
        if (f.name === 'owner') return sub({ t: 'User', login: repo.owner, id: VIEWER_ID });
        if (f.name === 'defaultBranchRef') {
          const tip = repo.refs.get('refs/heads/main');
          return tip ? sub({ t: 'Ref', name: DEFAULT_BRANCH }) : null;
        }
        if (f.name === 'viewerPermission') return 'ADMIN';
        if (f.name === 'hasIssuesEnabled') return true;
        if (f.name === 'description') return repo.description;
        if (f.name === 'url') return `${this.ctx.baseUrl}/${repo.owner}/${repo.name}`;
        if (f.name === 'createdAt') return repo.createdAt;
        if (f.name === 'updatedAt') return repo.updatedAt;
        if (f.name === 'isPrivate') return repo.private;
        if (f.name === 'fork') return false;
        if (f.name === 'stargazerCount') return 0;
        if (f.name === 'primaryLanguage') return null;
        if (f.name === 'issue') {
          const n = Number(args['number'] ?? 0);
          const issue = repo.issues.get(n);
          return sub(issue ? { t: 'Issue', repo, issue } : null);
        }
        if (f.name === 'issues') return sub(this.issuesConnection(repo, args));
        if (f.name === 'pullRequests') return sub(this.pullsConnection(repo, args));
        if (f.name === 'pullRequest') {
          const n = Number(args['number'] ?? 0);
          const pull = repo.pulls.get(n);
          return sub(pull ? { t: 'PullRequest', repo, pull } : null);
        }
        return null;
      }
      case 'Issue': {
        const { issue, repo } = parent;
        if (f.name === '__typename') return 'Issue';
        if (f.name === 'id') return gid('Issue', `${repo.owner}/${repo.name}:${issue.number}`);
        if (f.name === 'number') return issue.number;
        if (f.name === 'title') return issue.title;
        if (f.name === 'state') return issue.state.toUpperCase();
        if (f.name === 'body') return issue.body;
        if (f.name === 'createdAt') return issue.createdAt;
        if (f.name === 'updatedAt') return issue.updatedAt;
        if (f.name === 'closedAt') return issue.closedAt;
        if (f.name === 'author') return sub({ t: 'User', login: issue.userLogin, id: VIEWER_ID });
        if (f.name === 'labels') {
          return sub({ t: 'LabelConnection', repo, items: issue.labels });
        }
        if (f.name === 'comments') {
          return sub({ t: 'IssueCommentConnection', repo, issueNumber: issue.number, items: issue.comments });
        }
        if (f.name === 'url') return `${this.ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`;
        if (f.name === 'resourcePath') return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
        if (f.name === 'repository') return sub({ t: 'Repository', repo });
        return null;
      }
      case 'PullRequest': {
        const { pull, repo } = parent;
        if (f.name === '__typename') return 'PullRequest';
        if (f.name === 'id') return gid('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`);
        if (f.name === 'number') return pull.number;
        if (f.name === 'title') return pull.title;
        if (f.name === 'body') return pull.body;
        if (f.name === 'state') return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        if (f.name === 'merged') return pull.merged;
        if (f.name === 'mergeable') {
          return prConflict(this.ctx, repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
        }
        if (f.name === 'headRefName') return pull.headRef;
        if (f.name === 'baseRefName') return pull.baseRef;
        if (f.name === 'headRef') return sub({ t: 'Ref', name: pull.headRef });
        if (f.name === 'baseRef') return sub({ t: 'Ref', name: pull.baseRef });
        if (f.name === 'mergedAt') return pull.mergedAt;
        if (f.name === 'mergeCommit') {
          return pull.mergeCommitSha ? sub({ t: 'MergeCommit', oid: pull.mergeCommitSha }) : null;
        }
        if (f.name === 'files') {
          const first = Number(args['first'] ?? 100);
          const files = this.pullFiles(repo, pull).slice(0, first);
          const nodes: RT[] = files.map((x) => ({ t: 'PullRequestChangedFile', ...x }));
          return sub({ t: 'PullRequestConnection', repo, items: [], page: [], hasNext: false, endCursor: null, startCursor: null, nodes } as unknown as RT);
        }
        if (f.name === 'author') return sub({ t: 'User', login: pull.userLogin, id: VIEWER_ID });
        if (f.name === 'url') return `${this.ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`;
        if (f.name === 'createdAt') return pull.createdAt;
        if (f.name === 'updatedAt') return pull.updatedAt;
        if (f.name === 'closedAt') return pull.closedAt;
        return null;
      }
      case 'IssueConnection': {
        if (f.name === '__typename') return 'IssueConnection';
        if (f.name === 'nodes') {
          return parent.page.map((i) => (sel ? this.resolveSelection({ t: 'Issue', repo: parent.repo, issue: i }, sel) : i.number));
        }
        if (f.name === 'edges') {
          return parent.page.map((i) => {
            const node: RT = { t: 'Edge', node: { t: 'Issue', repo: parent.repo, issue: i }, cursor: cursorFor(i.number) };
            return sel ? this.resolveSelection(node, sel) : { cursor: cursorFor(i.number) };
          });
        }
        if (f.name === 'pageInfo') {
          return sel ? this.resolveSelection({ t: 'PageInfoShim', hasNext: parent.hasNext, startCursor: parent.startCursor, endCursor: parent.endCursor } as unknown as RT, sel)
            : { hasNextPage: parent.hasNext, endCursor: parent.endCursor, startCursor: parent.startCursor, hasPreviousPage: false };
        }
        if (f.name === 'totalCount') return parent.items.length;
        return null;
      }
      case 'PullRequestConnection': {
        if (f.name === '__typename') return 'PullRequestConnection';
        const nodes = (parent as unknown as { nodes?: RT[] }).nodes;
        if (f.name === 'nodes') {
          const list = nodes ?? parent.page.map((p) => ({ t: 'PullRequest', repo: parent.repo, pull: p }) as RT);
          return list.map((n) => (sel ? this.resolveSelection(n, sel) : null));
        }
        if (f.name === 'edges') {
          const list = nodes ?? parent.page.map((p) => ({ t: 'PullRequest', repo: parent.repo, pull: p }) as RT);
          return list.map((n) => {
            const num = n.t === 'PullRequest' ? n.pull.number : 0;
            const node: RT = { t: 'Edge', node: n, cursor: cursorFor(num) };
            return sel ? this.resolveSelection(node, sel) : { cursor: cursorFor(num) };
          });
        }
        if (f.name === 'pageInfo') {
          return sel ? this.resolveSelection({ t: 'PageInfoShim', hasNext: parent.hasNext, startCursor: parent.startCursor, endCursor: parent.endCursor } as unknown as RT, sel)
            : { hasNextPage: parent.hasNext, endCursor: parent.endCursor, startCursor: parent.startCursor, hasPreviousPage: false };
        }
        if (f.name === 'totalCount') return parent.items.length;
        return null;
      }
      case 'IssueCommentConnection': {
        if (f.name === '__typename') return 'IssueCommentConnection';
        if (f.name === 'nodes') {
          return parent.items.map((c) => (sel ? this.resolveSelection({ t: 'IssueComment', repo: parent.repo, issueNumber: parent.issueNumber, ...c }, sel) : c.body));
        }
        if (f.name === 'edges') {
          return parent.items.map((c) => {
            const node: RT = { t: 'Edge', node: { t: 'IssueComment', repo: parent.repo, issueNumber: parent.issueNumber, ...c }, cursor: cursorFor(c.id) };
            return sel ? this.resolveSelection(node, sel) : { cursor: cursorFor(c.id) };
          });
        }
        if (f.name === 'pageInfo') {
          const last = parent.items[parent.items.length - 1];
          return { hasNextPage: false, hasPreviousPage: false, startCursor: parent.items.length > 0 ? cursorFor(parent.items[0]?.id ?? 0) : null, endCursor: last ? cursorFor(last.id) : null };
        }
        if (f.name === 'totalCount') return parent.items.length;
        return null;
      }
      case 'LabelConnection': {
        if (f.name === '__typename') return 'LabelConnection';
        if (f.name === 'nodes') {
          return parent.items.map((n) => (sel ? this.resolveSelection({ t: 'Label', repo: parent.repo, name: n }, sel) : n));
        }
        if (f.name === 'edges') {
          return parent.items.map((n) => {
            const node: RT = { t: 'Edge', node: { t: 'Label', repo: parent.repo, name: n }, cursor: cursorFor(0) };
            return sel ? this.resolveSelection(node, sel) : { cursor: cursorFor(0) };
          });
        }
        if (f.name === 'pageInfo') {
          return { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
        }
        if (f.name === 'totalCount') return parent.items.length;
        return null;
      }
      case 'Ref': {
        if (f.name === '__typename') return 'Ref';
        if (f.name === 'name') return parent.name;
        if (f.name === 'prefix') return 'refs/heads/';
        if (f.name === 'target') return null;
        return null;
      }
      case 'IssueComment': {
        if (f.name === '__typename') return 'IssueComment';
        if (f.name === 'id') return gid('IssueComment', `${parent.repo.owner}/${parent.repo.name}:${parent.issueNumber}:${parent.id}`);
        if (f.name === 'body') return parent.body;
        if (f.name === 'author') return sub({ t: 'User', login: VIEWER_LOGIN, id: VIEWER_ID });
        if (f.name === 'createdAt') return parent.createdAt;
        if (f.name === 'updatedAt') return parent.updatedAt;
        if (f.name === 'url') return `${this.ctx.baseUrl}/${parent.repo.owner}/${parent.repo.name}/issues/${parent.issueNumber}#issuecomment-${parent.id}`;
        return null;
      }
      case 'PullRequestChangedFile': {
        if (f.name === '__typename') return 'PullRequestChangedFile';
        if (f.name === 'path') return parent.path;
        if (f.name === 'additions') return parent.additions;
        if (f.name === 'deletions') return parent.deletions;
        if (f.name === 'changeType') return parent.changeType;
        return null;
      }
      case 'Label': {
        if (f.name === '__typename') return 'Label';
        if (f.name === 'name') return parent.name;
        if (f.name === 'id') return gid('Label', `${parent.repo.owner}/${parent.repo.name}:${parent.name}`);
        if (f.name === 'color') return parent.repo.labels.get(parent.name)?.color ?? 'ededed';
        if (f.name === 'description') return parent.repo.labels.get(parent.name)?.description ?? '';
        return null;
      }
      case 'MergeCommit': {
        if (f.name === '__typename') return 'MergeCommit';
        if (f.name === 'oid') return parent.oid;
        return null;
      }
      case 'Type': {
        if (f.name === '__typename') return '__Type';
        if (f.name === 'name') return parent.name;
        if (f.name === 'kind') return parent.kind;
        if (f.name === 'description') return null;
        if (f.name === 'fields') {
          const names = SCHEMA[parent.name] ?? [];
          return names.map((n) => (sel ? this.resolveSelection({ t: 'Field', name: n }, sel) : { name: n }));
        }
        if (f.name === 'enumValues') {
          const names = ENUM_VALUES[parent.name] ?? [];
          return names.map((n) => (sel ? this.resolveSelection({ t: 'EnumValue', name: n }, sel) : { name: n }));
        }
        return null;
      }
      case 'Field': {
        if (f.name === '__typename') return '__Field';
        if (f.name === 'name') return parent.name;
        if (f.name === 'description') return null;
        if (f.name === 'type') return null;
        return null;
      }
      case 'EnumValue': {
        if (f.name === '__typename') return '__EnumValue';
        if (f.name === 'name') return parent.name;
        if (f.name === 'description') return null;
        return null;
      }
      case 'Schema': {
        if (f.name === '__typename') return '__Schema';
        if (f.name === 'queryType') return sel ? this.resolveSelection({ t: 'Type', name: 'Query', kind: 'OBJECT' }, sel) : { name: 'Query' };
        if (f.name === 'mutationType') return sel ? this.resolveSelection({ t: 'Type', name: 'Mutation', kind: 'OBJECT' }, sel) : { name: 'Mutation' };
        if (f.name === 'types') {
          return Object.keys(SCHEMA).map((n) => (sel ? this.resolveSelection({ t: 'Type', name: n, kind: 'OBJECT' }, sel) : { name: n }));
        }
        return null;
      }
      case 'Edge': {
        if (f.name === '__typename') return 'Edge';
        if (f.name === 'node') return sub(parent.node);
        if (f.name === 'cursor') return parent.cursor;
        return null;
      }
      case 'Payload': {
        if (f.name === '__typename') return parent.kind;
        if (f.name === 'issue' && parent.issue && parent.repo) {
          return sub({ t: 'Issue', repo: parent.repo, issue: parent.issue });
        }
        if (f.name === 'pullRequest' && parent.pull && parent.repo) {
          return sub({ t: 'PullRequest', repo: parent.repo, pull: parent.pull });
        }
        if (f.name === 'commentEdge' && parent.comment && parent.repo && parent.issueNumber !== undefined) {
          const node: RT = { t: 'IssueComment', repo: parent.repo, issueNumber: parent.issueNumber, ...parent.comment };
          if (!sel) return { node: null };
          const out: Record<string, unknown> = {};
          for (const s of sel) {
            if (s.k === 'field' && s.f.name === 'node') {
              out[s.f.alias ?? 'node'] = s.f.sel ? this.resolveSelection(node, s.f.sel) : null;
            } else if (s.k === 'field' && s.f.name === 'cursor') {
              out[s.f.alias ?? 'cursor'] = cursorFor(parent.comment.id);
            }
          }
          return out;
        }
        if (f.name === 'clientMutationId') return null;
        return null;
      }
      default: {
        // PageInfoShim and anything else: plain field lookup.
        const rec = parent as unknown as Record<string, unknown>;
        if (f.name === 'hasNextPage') return rec['hasNext'] ?? false;
        if (f.name === 'hasPreviousPage') return false;
        if (f.name === 'startCursor') return rec['startCursor'] ?? null;
        if (f.name === 'endCursor') return rec['endCursor'] ?? null;
        if (f.name === '__typename') return 'PageInfo';
        return null;
      }
    }
  }

  nodeFor(decoded: { kind: string; key: string }): RT | null {
    if (decoded.kind === 'Repository') {
      const [owner, name] = decoded.key.split('/');
      if (!owner || !name) return null;
      const repo = this.ctx.store.getRepo(owner, name);
      return repo ? { t: 'Repository', repo } : null;
    }
    if (decoded.kind === 'Issue') {
      const m = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
      if (!m) return null;
      const repo = this.ctx.store.getRepo(m[1] as string, m[2] as string);
      const issue = repo?.issues.get(parseInt(m[3] as string, 10));
      return repo && issue ? { t: 'Issue', repo, issue } : null;
    }
    if (decoded.kind === 'PullRequest') {
      const m = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
      if (!m) return null;
      const repo = this.ctx.store.getRepo(m[1] as string, m[2] as string);
      const pull = repo?.pulls.get(parseInt(m[3] as string, 10));
      return repo && pull ? { t: 'PullRequest', repo, pull } : null;
    }
    if (decoded.kind === 'IssueComment') {
      const m = /^([^/]+)\/([^:]+):(\d+):(\d+)$/.exec(decoded.key);
      if (!m) return null;
      const repo = this.ctx.store.getRepo(m[1] as string, m[2] as string);
      const issue = repo?.issues.get(parseInt(m[3] as string, 10));
      const c = issue?.comments.find((x) => x.id === parseInt(m[4] as string, 10));
      return repo && issue && c ? { t: 'IssueComment', repo, issueNumber: issue.number, ...c } : null;
    }
    return null;
  }

  issuesConnection(repo: Repo, args: Record<string, unknown>): RT {
    const first = Number(args['first'] ?? 100);
    const after = cursorNum(typeof args['after'] === 'string' ? (args['after'] as string) : null);
    const states = Array.isArray(args['states']) ? (args['states'] as unknown[]).map(String) : null;
    const orderBy = (args['orderBy'] as Record<string, unknown> | undefined) ?? undefined;
    let items = [...repo.issues.values()];
    if (states) {
      const want = new Set(states.map((s) => s.toLowerCase()));
      items = items.filter((i) => want.has(i.state));
    }
    const desc = !orderBy || String(orderBy['direction'] ?? 'DESC').toUpperCase() !== 'ASC';
    items.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
    if (after !== null) {
      items = items.filter((i) => (desc ? i.number < after : i.number > after));
    }
    const page = items.slice(0, first);
    const hasNext = items.length > page.length;
    const last = page[page.length - 1];
    const firstItem = page[0];
    return {
      t: 'IssueConnection',
      repo,
      items,
      page,
      hasNext,
      endCursor: last ? cursorFor(last.number) : null,
      startCursor: firstItem ? cursorFor(firstItem.number) : null,
    };
  }

  pullsConnection(repo: Repo, args: Record<string, unknown>): RT {
    const first = Number(args['first'] ?? 100);
    const items = [...repo.pulls.values()].filter((p) => p.state === 'open');
    items.sort((a, b) => b.number - a.number);
    const page = items.slice(0, first);
    return {
      t: 'PullRequestConnection',
      repo,
      items,
      page,
      hasNext: items.length > page.length,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]?.number ?? 0) : null,
      startCursor: page.length > 0 ? cursorFor(page[0]?.number ?? 0) : null,
    };
  }

  pullFiles(repo: Repo, pull: Pull): Array<{ path: string; additions: number; deletions: number; changeType: string }> {
    const baseTipSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const base = this.ctx.store.mergeBase(repo, pull.headSha, baseTipSha);
    const baseTree = base ? this.ctx.store.treeOfCommit(repo, base) : '';
    const headTree = this.ctx.store.treeOfCommit(repo, pull.headSha);
    return this.ctx.store.diffTrees(repo, baseTree, headTree).map((d) => {
      const { additions, deletions } = this.ctx.store.lineDiff(repo, d.oldOid, d.newOid);
      const status = d.oldOid === null ? 'ADDED' : d.newOid === null ? 'DELETED' : 'MODIFIED';
      const add = status === 'MODIFIED' && additions === 0 && deletions === 0 ? 1 : additions;
      return { path: d.path, additions: add, deletions, changeType: status };
    });
  }

  resolveRepoByGid(id: string): Repo | null {
    const decoded = decodeGid(id);
    if (!decoded || decoded.kind !== 'Repository') return null;
    const [owner, name] = decoded.key.split('/');
    if (!owner || !name) return null;
    return this.ctx.store.getRepo(owner, name) ?? null;
  }

  mutationCreateIssue(args: Record<string, unknown>, sel: SelectionNode[] | null): unknown {
    const input = (args['input'] as Record<string, unknown>) ?? {};
    const repo = this.resolveRepoByGid(String(input['repositoryId'] ?? ''));
    if (!repo) {
      this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const title = String(input['title'] ?? '');
    const number = repo.issuePrCounter + 1;
    repo.issuePrCounter = number;
    const now = this.ctx.store.tick();
    const issue: Issue = {
      id: this.ctx.store.nextRestId(),
      number,
      title,
      body: String(input['body'] ?? ''),
      state: 'open',
      labels: [],
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
      seq: number,
    };
    repo.issues.set(number, issue);
    if (!sel) return { issue: null };
    const payload: RT = { t: 'Payload', kind: 'CreateIssuePayload', issue, repo };
    return this.resolveSelection(payload, sel);
  }

  mutationCloseIssue(args: Record<string, unknown>, sel: SelectionNode[] | null): unknown {
    const input = (args['input'] as Record<string, unknown>) ?? {};
    const decoded = decodeGid(String(input['issueId'] ?? ''));
    if (!decoded || decoded.kind !== 'Issue') {
      this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    const m = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
    if (!m) return null;
    const repo = this.ctx.store.getRepo(m[1] as string, m[2] as string);
    const issue = repo?.issues.get(parseInt(m[3] as string, 10));
    if (!repo || !issue) return null;
    issue.state = 'closed';
    issue.closedAt = this.ctx.store.tick();
    issue.updatedAt = this.ctx.store.tick();
    if (!sel) return { issue: null };
    const payload: RT = { t: 'Payload', kind: 'CloseIssuePayload', issue, repo };
    return this.resolveSelection(payload, sel);
  }

  mutationCreatePullRequest(args: Record<string, unknown>, sel: SelectionNode[] | null): unknown {
    const input = (args['input'] as Record<string, unknown>) ?? {};
    const repo = this.resolveRepoByGid(String(input['repositoryId'] ?? ''));
    if (!repo) {
      this.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
      return null;
    }
    const head = String(input['headRefName'] ?? '');
    const base = String(input['baseRefName'] ?? 'main');
    const headSha = this.ctx.store.resolveRef(repo, head);
    const baseSha = this.ctx.store.resolveRef(repo, base);
    if (headSha === null || baseSha === null) {
      this.errors.push({ message: 'Head or base ref does not exist.' });
      return null;
    }
    const number = repo.issuePrCounter + 1;
    repo.issuePrCounter = number;
    const now = this.ctx.store.tick();
    const pull: Pull = {
      id: this.ctx.store.nextRestId(),
      number,
      title: String(input['title'] ?? ''),
      body: String(input['body'] ?? ''),
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      seq: number,
    };
    repo.pulls.set(number, pull);
    if (!sel) return { pullRequest: null };
    const payload: RT = { t: 'Payload', kind: 'CreatePullRequestPayload', pull, repo };
    return this.resolveSelection(payload, sel);
  }

  mutationMergePullRequest(args: Record<string, unknown>, sel: SelectionNode[] | null): unknown {
    const input = (args['input'] as Record<string, unknown>) ?? {};
    const decoded = decodeGid(String(input['pullRequestId'] ?? ''));
    if (!decoded || decoded.kind !== 'PullRequest') {
      this.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
      return null;
    }
    const m = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
    if (!m) return null;
    const repo = this.ctx.store.getRepo(m[1] as string, m[2] as string);
    const pull = repo?.pulls.get(parseInt(m[3] as string, 10));
    if (!repo || !pull) return null;
    const result = mergePullInStore(this.ctx, repo, pull);
    if (!result.ok) {
      this.errors.push({ message: result.reason === 'conflict' ? 'Merge conflict' : 'Pull request is already closed.' });
      return null;
    }
    if (!sel) return { pullRequest: null };
    const payload: RT = { t: 'Payload', kind: 'MergePullRequestPayload', pull, repo };
    return this.resolveSelection(payload, sel);
  }

  mutationAddComment(args: Record<string, unknown>, sel: SelectionNode[] | null): unknown {
    const input = (args['input'] as Record<string, unknown>) ?? {};
    const decoded = decodeGid(String(input['subjectId'] ?? ''));
    if (!decoded || decoded.kind !== 'Issue') {
      this.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
      return null;
    }
    const m = /^([^/]+)\/([^:]+):(\d+)$/.exec(decoded.key);
    if (!m) return null;
    const repo = this.ctx.store.getRepo(m[1] as string, m[2] as string);
    const issue = repo?.issues.get(parseInt(m[3] as string, 10));
    if (!repo || !issue) return null;
    const now = this.ctx.store.tick();
    const comment = {
      id: this.ctx.store.nextRestId(),
      body: String(input['body'] ?? ''),
      userLogin: VIEWER_LOGIN,
      createdAt: now,
      updatedAt: now,
    };
    issue.comments.push(comment);
    if (!sel) return { commentEdge: null };
    const payload: RT = { t: 'Payload', kind: 'AddCommentPayload', comment, repo, issueNumber: issue.number };
    return this.resolveSelection(payload, sel);
  }
}

function scalarOf(v: RT): unknown {
  if (v.t === 'User') return v.login;
  if (v.t === 'Ref') return v.name;
  return null;
}

export function handleGraphql(ctx: Ctx, res: ServerResponse): boolean {
  if (!requireAuth(ctx, res)) return true;
  if (ctx.body.length === 0) {
    jsonError(ctx, res, 400, 'Problems parsing JSON');
    return true;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    jsonError(ctx, res, 400, 'Problems parsing JSON');
    return true;
  }
  const envelopes = Array.isArray(parsed) ? (parsed as unknown[]) : [parsed];
  const results = envelopes.map((env) => executeOne(ctx, env));
  sendJson(ctx, res, 200, Array.isArray(parsed) ? results : results[0]);
  return true;
}

function executeOne(ctx: Ctx, env: unknown): Record<string, unknown> {
  if (env === null || typeof env !== 'object') {
    return { data: null, errors: [{ message: 'Invalid GraphQL request.' }] };
  }
  const { query, variables, operationName } = env as {
    query?: unknown;
    variables?: unknown;
    operationName?: unknown;
  };
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'Must provide query string.' }] };
  }
  let doc: Document;
  try {
    doc = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax Error.' }] };
  }
  const vars = (variables !== null && typeof variables === 'object' && !Array.isArray(variables))
    ? (variables as Record<string, unknown>)
    : {};
  let op: OpDef | undefined;
  if (typeof operationName === 'string') {
    op = doc.ops.find((o) => o.name === operationName);
  }
  if (!op) op = doc.ops[0];
  if (!op) {
    return { data: null, errors: [{ message: 'No operation provided.' }] };
  }
  const ex = new Executor(ctx, doc, vars);
  const data = ex.run(op);
  const out: Record<string, unknown> = { data };
  if (ex.errors.length > 0) out['errors'] = ex.errors;
  return out;
}
