// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, modern era
// (revision 2026-07-28 via server/discover), with a legacy initialize
// handshake answered for completeness. Plain JSON answers only; no SSE.
// Six tools, canonical names and schemas, acting on the same store
// as REST, GraphQL and git. Auth is decided before any tool lookup:
// no token answers 401. Malformed JSON answers HTTP 400 with -32700.

import type { ServerResponse } from 'node:http';
import {
  VIEWER_LOGIN,
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
import { mergePullInStore, repoJson } from './rest.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// The tool list is one frozen literal: two tools/list calls answer the
// same list byte for byte.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the new repository.' },
        name: { type: 'string', description: 'Name of the repository.' },
        description: { type: 'string', description: 'Description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body of the pull request.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'integer', description: 'Number of the pull request.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const ALIASES: Record<string, string> = {
  createrepository: 'create_repo',
  repocreate: 'create_repo',
  reposcreate: 'create_repo',
  repositorycreate: 'create_repo',
  getrepository: 'get_repo',
  repoget: 'get_repo',
  reposget: 'get_repo',
  repositoryget: 'get_repo',
  issuecreate: 'create_issue',
  issuescreate: 'create_issue',
  issueslist: 'list_issues',
  issuelist: 'list_issues',
  pullrequestcreate: 'create_pull_request',
  pullscreate: 'create_pull_request',
  createpr: 'create_pull_request',
  prcreate: 'create_pull_request',
  pullrequestmerge: 'merge_pull_request',
  pullsmerge: 'merge_pull_request',
  mergepr: 'merge_pull_request',
  prmerge: 'merge_pull_request',
};

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function canonicalTool(name: string): string | null {
  const n = norm(name);
  for (const t of TOOLS) {
    if (norm(t.name) === n) return t.name;
    if (n.endsWith(norm(t.name))) return t.name;
  }
  return ALIASES[n] ?? null;
}

function toolResult(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return {
    content: [{ type: 'text', text }],
    structuredContent: obj,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function issueObj(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((n) => ({ name: n })),
    user: { login: issue.userLogin },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObj(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    user: { login: pull.userLogin },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function getRepoArg(ctx: Ctx, args: Record<string, unknown>): Repo | null {
  const owner = typeof args['owner'] === 'string' ? (args['owner'] as string) : VIEWER_LOGIN;
  const name = typeof args['repo'] === 'string' ? (args['repo'] as string) : '';
  if (name === '') return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

function callTool(ctx: Ctx, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = canonicalTool(name);
  if (tool === null) {
    return { __rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
  }
  const str = (k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '');
  const missing = (ks: string[]): string | null => {
    for (const k of ks) {
      if (args[k] === undefined || args[k] === null || args[k] === '') return k;
    }
    return null;
  };

  if (tool === 'create_repo') {
    const miss = missing(['name']);
    if (miss) return toolError(`Missing required argument: ${miss}`);
    const owner = str('owner') || VIEWER_LOGIN;
    const repoName = str('name');
    if (ctx.store.getRepo(owner, repoName)) return toolError('Repository already exists');
    const repo = ctx.store.createRepo(
      owner,
      repoName,
      str('description'),
      args['private'] === true,
    );
    return toolResult(repoJson(ctx, repo));
  }

  if (tool === 'get_repo') {
    const miss = missing(['owner', 'repo']);
    if (miss) return toolError(`Missing required argument: ${miss}`);
    const repo = getRepoArg(ctx, args);
    if (!repo) return toolError('Not Found');
    return toolResult(repoJson(ctx, repo));
  }

  if (tool === 'create_issue') {
    const miss = missing(['owner', 'repo', 'title']);
    if (miss) return toolError(`Missing required argument: ${miss}`);
    const repo = getRepoArg(ctx, args);
    if (!repo) return toolError('Not Found');
    const number = repo.issuePrCounter + 1;
    repo.issuePrCounter = number;
    const now = ctx.store.tick();
    const issue: Issue = {
      id: ctx.store.nextRestId(),
      number,
      title: str('title'),
      body: str('body'),
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
    return toolResult(issueObj(ctx, repo, issue));
  }

  if (tool === 'list_issues') {
    const miss = missing(['owner', 'repo']);
    if (miss) return toolError(`Missing required argument: ${miss}`);
    const repo = getRepoArg(ctx, args);
    if (!repo) return toolError('Not Found');
    const state = str('state') || 'open';
    let list = [...repo.issues.values()];
    if (state !== 'all') list = list.filter((i) => i.state === state);
    list.sort((a, b) => b.number - a.number);
    const items = list.map((i) => issueObj(ctx, repo, i));
    return toolResult({ issues: items });
  }

  if (tool === 'create_pull_request') {
    const miss = missing(['owner', 'repo', 'title', 'head', 'base']);
    if (miss) return toolError(`Missing required argument: ${miss}`);
    const repo = getRepoArg(ctx, args);
    if (!repo) return toolError('Not Found');
    const head = str('head');
    const base = str('base');
    const headSha = ctx.store.resolveRef(repo, head);
    const baseSha = ctx.store.resolveRef(repo, base);
    if (headSha === null || baseSha === null) return toolError('Head or base ref does not exist');
    const number = repo.issuePrCounter + 1;
    repo.issuePrCounter = number;
    const now = ctx.store.tick();
    const pull: Pull = {
      id: ctx.store.nextRestId(),
      number,
      title: str('title'),
      body: str('body'),
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
    return toolResult(pullObj(ctx, repo, pull));
  }

  if (tool === 'merge_pull_request') {
    const miss = missing(['owner', 'repo', 'pull_number']);
    if (miss) return toolError(`Missing required argument: ${miss}`);
    const repo = getRepoArg(ctx, args);
    if (!repo) return toolError('Not Found');
    const raw = args['pull_number'];
    const number = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
    const pull = repo.pulls.get(number);
    if (!pull) return toolError('Not Found');
    const result = mergePullInStore(ctx, repo, pull);
    if (!result.ok) {
      return toolError(result.reason === 'conflict' ? 'Merge conflict' : 'Pull request is already closed');
    }
    return toolResult(pullObj(ctx, repo, pull));
  }

  return { __rpcError: { code: -32601, message: `Unknown tool: ${name}` } };
}

export function handleMcp(ctx: Ctx, res: ServerResponse): boolean {
  // Auth is decided before any tool lookup: no token answers 401.
  if (!requireAuth(ctx, res)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    sendJson(ctx, res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return true;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    sendJson(ctx, res, 400, {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    return true;
  }
  const req = parsed as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const id = req['id'] ?? null;
  const method = typeof req['method'] === 'string' ? req['method'] : '';
  const params = (req['params'] !== null && typeof req['params'] === 'object' && !Array.isArray(req['params']))
    ? (req['params'] as Record<string, unknown>)
    : {};

  // A notification (no id) gets no JSON-RPC reply.
  if (req['id'] === undefined) {
    res.writeHead(202, { 'x-github-request-id': ctx.store.nextRequestId() });
    res.end();
    return true;
  }

  const result = (r: unknown): void => {
    sendJson(ctx, res, 200, { jsonrpc: '2.0', id, result: r });
  };
  const rpcError = (code: number, message: string, data?: unknown): void => {
    const err: Record<string, unknown> = { code, message };
    if (data !== undefined) err['data'] = data;
    sendJson(ctx, res, 200, { jsonrpc: '2.0', id, error: err });
  };

  if (method === 'server/discover') {
    result({
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
    return true;
  }

  if (method === 'initialize') {
    const offered = typeof params['protocolVersion'] === 'string' ? (params['protocolVersion'] as string) : '2025-11-25';
    result({
      protocolVersion: offered,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return true;
  }

  if (method === 'ping') {
    result({});
    return true;
  }

  if (method === 'tools/list') {
    result({ tools: TOOLS });
    return true;
  }

  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? (params['name'] as string) : '';
    const args = (params['arguments'] !== null && typeof params['arguments'] === 'object' && !Array.isArray(params['arguments']))
      ? (params['arguments'] as Record<string, unknown>)
      : {};
    if (name === '') {
      rpcError(-32602, 'Missing tool name');
      return true;
    }
    const out = callTool(ctx, name, args);
    const rpcErr = (out as Record<string, unknown>)['__rpcError'] as { code: number; message: string } | undefined;
    if (rpcErr) {
      rpcError(rpcErr.code, rpcErr.message);
      return true;
    }
    result(out);
    return true;
  }

  rpcError(-32601, `Method not found: ${method}`);
  return true;
}

// Keep the jsonError import used for the 400 path above via requireAuth.
void jsonError;
