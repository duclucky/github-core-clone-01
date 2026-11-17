// REST v3 under /api/v3: repositories, branches, commits, contents,
// labels, issues, comments, pull requests. One store shared with git,
// GraphQL and MCP. All timestamps come from the store's logical clock.

import type { ServerResponse } from 'node:http';
import {
  DEFAULT_BRANCH,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  buildCommit,
  parseCommit,
  parseTree,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import {
  asBool,
  asString,
  gid,
  jsonError,
  paginate,
  parseJsonBody,
  requireAuth,
  sendJson,
  sendNoContent,
  type Ctx,
} from './http.ts';

function repoUrl(ctx: Ctx, repo: Repo): string {
  return `${ctx.baseUrl}/api/v3/repos/${repo.owner}/${repo.name}`;
}

export function repoJson(ctx: Ctx, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.databaseId,
    node_id: gid('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: {
      login: repo.owner,
      id: VIEWER_ID,
      node_id: gid('User', repo.owner),
      avatar_url: '',
      html_url: `${ctx.baseUrl}/${repo.owner}`,
      type: 'User',
      site_admin: false,
    },
    private: repo.private,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: repoUrl(ctx, repo),
    archive_url: `${repoUrl(ctx, repo)}/archive/{archive_format}{/ref}`,
    assignees_url: `${repoUrl(ctx, repo)}/assignees{/user}`,
    blobs_url: `${repoUrl(ctx, repo)}/git/blobs{/sha}`,
    branches_url: `${repoUrl(ctx, repo)}/branches{/branch}`,
    clone_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}.git`,
    git_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    commits_url: `${repoUrl(ctx, repo)}/commits{/sha}`,
    contents_url: `${repoUrl(ctx, repo)}/contents/{+path}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    default_branch: DEFAULT_BRANCH,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function userJson(ctx: Ctx): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: gid('User', VIEWER_LOGIN),
    avatar_url: '',
    gravatar_id: '',
    url: `${ctx.baseUrl}/api/v3/users/${VIEWER_LOGIN}`,
    html_url: `${ctx.baseUrl}/${VIEWER_LOGIN}`,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    type: 'User',
    site_admin: false,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const l = repo.labels.get(name);
  return {
    id: l?.id ?? 0,
    node_id: gid('Label', `${repo.owner}/${repo.name}:${name}`),
    url: `${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: l?.color ?? 'ededed',
    default: false,
    description: l?.description ?? '',
  };
}

function issueJson(ctx: Ctx, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', `${repo.owner}/${repo.name}:${issue.number}`),
    url: `${repoUrl(ctx, repo)}/issues/${issue.number}`,
    repository_url: repoUrl(ctx, repo),
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: { login: issue.userLogin, id: VIEWER_ID, node_id: gid('User', issue.userLogin), type: 'User' },
    labels: issue.labels.map((n) => labelJson(repo, n)),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    author_association: 'OWNER',
    state_reason: issue.state === 'closed' ? 'completed' : null,
  };
}

function pullFiles(ctx: Ctx, repo: Repo, pull: Pull): Array<Record<string, unknown>> {
  const base = ctx.store.mergeBase(repo, pull.headSha, currentBaseSha(repo, pull));
  const baseTree = base ? ctx.store.treeOfCommit(repo, base) : '';
  const headTree = ctx.store.treeOfCommit(repo, pull.headSha);
  const diff = ctx.store.diffTrees(repo, baseTree, headTree);
  return diff.map((d) => {
    const { additions, deletions } = ctx.store.lineDiff(repo, d.oldOid, d.newOid);
    const status = d.oldOid === null ? 'added' : d.newOid === null ? 'removed' : 'modified';
    const add = status === 'modified' && additions === 0 && deletions === 0 ? 1 : additions;
    return {
      sha: d.newOid ?? d.oldOid ?? '',
      filename: d.path,
      status,
      additions: add,
      deletions,
      changes: add + deletions,
      blob_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/blob/${pull.headSha}/${d.path}`,
      raw_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/raw/${pull.headSha}/${d.path}`,
    };
  });
}

function pullJson(ctx: Ctx, repo: Repo, pull: Pull): Record<string, unknown> {
  const files = pullFiles(ctx, repo, pull);
  const additions = files.reduce((s, f) => s + (f['additions'] as number), 0);
  const deletions = files.reduce((s, f) => s + (f['deletions'] as number), 0);
  const mergeable = !prConflict(ctx, repo, pull);
  return {
    id: pull.id,
    node_id: gid('PullRequest', `${repo.owner}/${repo.name}:${pull.number}`),
    url: `${repoUrl(ctx, repo)}/pulls/${pull.number}`,
    html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: pull.userLogin, id: VIEWER_ID, node_id: gid('User', pull.userLogin), type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_by: null,
    draft: false,
    head: {
      label: `${repo.owner}:${pull.headRef}`,
      ref: pull.headRef,
      sha: pull.headSha,
      user: { login: repo.owner, id: VIEWER_ID },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      label: `${repo.owner}:${pull.baseRef}`,
      ref: pull.baseRef,
      sha: pull.baseSha,
      user: { login: repo.owner, id: VIEWER_ID },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    commits: 1,
    additions,
    deletions,
    changed_files: files.length,
    comments: 0,
    review_comments: 0,
  };
}

/** True when head and base both changed the same file differently vs merge-base.
 * The base side is the CURRENT base branch tip, not the sha recorded when
 * the PR was opened: a merge that landed after the PR was created still
 * conflicts with it. */
export function prConflict(ctx: Ctx, repo: Repo, pull: Pull): boolean {
  const base = ctx.store.mergeBase(repo, pull.headSha, currentBaseSha(repo, pull));
  if (base === null) return false;
  const baseTree = ctx.store.treeOfCommit(repo, base);
  const headTree = ctx.store.treeOfCommit(repo, pull.headSha);
  const baseTipTree = ctx.store.treeOfCommit(repo, currentBaseSha(repo, pull));
  const headDiff = ctx.store.diffTrees(repo, baseTree, headTree);
  const baseDiff = ctx.store.diffTrees(repo, baseTree, baseTipTree);
  const baseByPath = new Map(baseDiff.map((d) => [d.path, d]));
  for (const h of headDiff) {
    const b = baseByPath.get(h.path);
    if (b && b.newOid !== h.newOid) return true;
  }
  return false;
}

/** The base branch's current tip (the PR's recorded base sha is only a fallback). */
function currentBaseSha(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

function getRepoOr404(ctx: Ctx, res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    jsonError(ctx, res, 404, 'Not Found');
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (!repo) {
    jsonError(ctx, res, 404, 'Not Found');
    return null;
  }
  return repo;
}

/** Create one commit on `branch` with `treeOid`, parent = branch tip (if any). */
function commitOnBranch(
  ctx: Ctx,
  repo: Repo,
  branch: string,
  treeOid: string,
  message: string,
): string {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip ? [tip] : [];
  const data = buildCommit(treeOid, parents, message, ctx.store.epochSec());
  const oid = ctx.store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.updatedAt = ctx.store.tick();
  ctx.store.invalidatePackCache(repo);
  return oid;
}

export function handleRest(ctx: Ctx, res: ServerResponse): boolean {
  const m = ctx.method;
  const p = ctx.path;

  // API root and meta.
  if (m === 'GET' && (p === '/api/v3' || p === '/api/v3/')) {
    if (!requireAuth(ctx, res)) return true;
    sendJson(ctx, res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (m === 'GET' && p === '/api/v3/meta') {
    if (!requireAuth(ctx, res)) return true;
    sendJson(ctx, res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (m === 'GET' && p === '/api/v3/user') {
    if (!requireAuth(ctx, res)) return true;
    sendJson(ctx, res, 200, userJson(ctx));
    return true;
  }

  // Create / list the viewer's repositories.
  if (p === '/api/v3/user/repos') {
    if (!requireAuth(ctx, res)) return true;
    if (m === 'GET') {
      const repos = ctx.store.listRepos(VIEWER_LOGIN);
      const { page, link } = paginate(ctx, repos);
      sendJson(ctx, res, 200, page.map((r) => repoJson(ctx, r)), link ? { link } : {});
      return true;
    }
    if (m === 'POST') {
      const body = parseJsonBody(ctx, res);
      if (body === null) return true;
      const name = asString(body['name']);
      if (name === '') {
        jsonError(ctx, res, 422, 'name is required');
        return true;
      }
      if (ctx.store.getRepo(VIEWER_LOGIN, name)) {
        jsonError(ctx, res, 422, 'Repository already exists');
        return true;
      }
      const repo = ctx.store.createRepo(
        VIEWER_LOGIN,
        name,
        asString(body['description']),
        asBool(body['private'], false),
      );
      sendJson(ctx, res, 201, repoJson(ctx, repo));
      return true;
    }
    return false;
  }

  // Repository-scoped routes: /api/v3/repos/{owner}/{repo}[...]
  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(p);
  if (repoMatch === null) return false;
  const owner = decodeURIComponent(repoMatch[1] as string);
  const repoName = decodeURIComponent(repoMatch[2] as string);
  const rest = repoMatch[3] ?? '';
  if (!requireAuth(ctx, res)) return true;
  const repo = getRepoOr404(ctx, res, owner, repoName);
  if (repo === null) return true;

  // The repository itself.
  if (rest === '') {
    if (m === 'GET') {
      sendJson(ctx, res, 200, repoJson(ctx, repo));
      return true;
    }
    if (m === 'PATCH') {
      const body = parseJsonBody(ctx, res);
      if (body === null) return true;
      if (typeof body['description'] === 'string') repo.description = body['description'] as string;
      if (typeof body['private'] === 'boolean') repo.private = body['private'] as boolean;
      repo.updatedAt = ctx.store.tick();
      sendJson(ctx, res, 200, repoJson(ctx, repo));
      return true;
    }
    if (m === 'DELETE') {
      ctx.store.deleteRepo(owner, repoName);
      sendNoContent(ctx, res);
      return true;
    }
    return false;
  }

  // Branches.
  if (rest === 'branches' && m === 'GET') {
    const out: Array<Record<string, unknown>> = [];
    for (const [ref, sha] of [...repo.refs.entries()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
    }
    sendJson(ctx, res, 200, out);
    return true;
  }

  // Commits.
  if (rest === 'commits' && m === 'GET') {
    const shaParam = ctx.query.get('sha');
    const tip = shaParam ? ctx.store.resolveRef(repo, shaParam) : repo.refs.get('refs/heads/main');
    if (!tip) {
      sendJson(ctx, res, 200, []);
      return true;
    }
    const commits = ctx.store.commitsFrom(repo, tip);
    const out = commits.map((oid) => {
      const info = parseCommit(repo.objects.get(oid)?.data ?? Buffer.alloc(0));
      return {
        sha: oid,
        commit: {
          message: info.message,
          author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
          committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: repo.createdAt },
        },
        parents: info.parents.map((s) => ({ sha: s })),
        url: `${repoUrl(ctx, repo)}/commits/${oid}`,
        html_url: `${ctx.baseUrl}/${owner}/${repoName}/commit/${oid}`,
      };
    });
    const { page, link } = paginate(ctx, out);
    sendJson(ctx, res, 200, page, link ? { link } : {});
    return true;
  }

  // Create a git ref.
  if (rest === 'git/refs' && m === 'POST') {
    const body = parseJsonBody(ctx, res);
    if (body === null) return true;
    const ref = asString(body['ref']);
    const sha = asString(body['sha']).toLowerCase();
    const obj = repo.objects.get(sha);
    if (!ref.startsWith('refs/') || !obj || obj.type !== 'commit') {
      jsonError(ctx, res, 422, 'Invalid ref or sha');
      return true;
    }
    if (repo.refs.has(ref)) {
      jsonError(ctx, res, 422, 'Reference already exists');
      return true;
    }
    repo.refs.set(ref, sha);
    ctx.store.invalidatePackCache(repo);
    sendJson(ctx, res, 201, { ref, object: { sha, type: 'commit', url: `${repoUrl(ctx, repo)}/git/commits/${sha}` } });
    return true;
  }

  // Contents.
  if (rest === 'contents' || rest.startsWith('contents/')) {
    return handleContents(ctx, res, repo, rest === 'contents' ? '' : rest.slice('contents/'.length));
  }

  // Labels.
  if (rest === 'labels' && m === 'POST') {
    const body = parseJsonBody(ctx, res);
    if (body === null) return true;
    const name = asString(body['name']);
    if (name === '') {
      jsonError(ctx, res, 422, 'name is required');
      return true;
    }
    if (!repo.labels.has(name)) {
      repo.labels.set(name, {
        id: ctx.store.nextRestId(),
        name,
        color: asString(body['color'], 'ededed'),
        description: asString(body['description']),
      });
    }
    sendJson(ctx, res, 201, labelJson(repo, name));
    return true;
  }
  if (rest === 'labels' && m === 'GET') {
    sendJson(ctx, res, 200, [...repo.labels.keys()].map((n) => labelJson(repo, n)));
    return true;
  }

  // Issues.
  if (rest === 'issues' || rest.startsWith('issues/')) {
    return handleIssues(ctx, res, repo, rest);
  }

  // Pull requests.
  if (rest === 'pulls' || rest.startsWith('pulls/')) {
    return handlePulls(ctx, res, repo, rest);
  }

  return false;
}

function handleContents(ctx: Ctx, res: ServerResponse, repo: Repo, path: string): boolean {
  const m = ctx.method;
  const segments = path === '' ? [] : path.split('/').map((s) => decodeURIComponent(s));
  const branch = asString(ctx.query.get('ref') ?? undefined) || undefined;

  const tipFor = (): string | null => {
    if (branch) return ctx.store.resolveRef(repo, branch);
    return repo.refs.get('refs/heads/main') ?? null;
  };

  if (m === 'PUT') {
    const body = parseJsonBody(ctx, res);
    if (body === null) return true;
    const message = asString(body['message']);
    const contentB64 = asString(body['content']);
    if (message === '' || contentB64 === '') {
      jsonError(ctx, res, 422, 'message and content are required');
      return true;
    }
    const bytes = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    const targetBranch = asString(body['branch'], DEFAULT_BRANCH);
    const tip = repo.refs.get(`refs/heads/${targetBranch}`);
    const oldTree = tip ? ctx.store.treeOfCommit(repo, tip) : '';
    const existing = oldTree !== '' ? ctx.store.lookupPath(repo, oldTree, segments) : null;
    const sentSha = asString(body['sha']);
    if (sentSha !== '') {
      if (!existing || existing.type !== 'blob' || existing.oid !== sentSha.toLowerCase()) {
        jsonError(ctx, res, 409, 'sha does not match');
        return true;
      }
    }
    const isCreate = existing === null;
    const blobOid = ctx.store.putBlob(repo, bytes);
    const newTree = ctx.store.setPath(repo, oldTree === '' ? null : oldTree, segments, blobOid);
    const commitOid = commitOnBranch(ctx, repo, targetBranch, newTree, message);
    sendJson(ctx, res, isCreate ? 201 : 200, {
      content: {
        name: segments[segments.length - 1] ?? '',
        path,
        sha: blobOid,
        size: bytes.length,
        encoding: 'base64',
        content: bytes.toString('base64'),
        url: `${repoUrl(ctx, repo)}/contents/${segments.map(encodeURIComponent).join('/')}`,
        html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/blob/${targetBranch}/${path}`,
      },
      commit: { sha: commitOid, message },
    });
    return true;
  }

  if (m === 'GET') {
    const tip = tipFor();
    if (!tip) {
      jsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const treeOid = ctx.store.treeOfCommit(repo, tip);
    if (segments.length === 0) {
      sendJson(ctx, res, 200, dirEntries(ctx, repo, treeOid, ''));
      return true;
    }
    const found = ctx.store.lookupPath(repo, treeOid, segments);
    if (!found) {
      jsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    if (found.type === 'blob') {
      const obj = repo.objects.get(found.oid);
      const bytes = obj?.data ?? Buffer.alloc(0);
      sendJson(ctx, res, 200, {
        type: 'file',
        encoding: 'base64',
        size: bytes.length,
        name: segments[segments.length - 1] ?? '',
        path,
        content: bytes.toString('base64'),
        sha: found.oid,
        url: `${repoUrl(ctx, repo)}/contents/${segments.map(encodeURIComponent).join('/')}`,
        html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/blob/${branch ?? DEFAULT_BRANCH}/${path}`,
      });
      return true;
    }
    sendJson(ctx, res, 200, dirEntries(ctx, repo, found.oid, path));
    return true;
  }

  if (m === 'DELETE') {
    const body = parseJsonBody(ctx, res);
    if (body === null) return true;
    const message = asString(body['message']);
    const targetBranch = asString(body['branch'], DEFAULT_BRANCH);
    const tip = repo.refs.get(`refs/heads/${targetBranch}`);
    if (!tip) {
      jsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const treeOid = ctx.store.treeOfCommit(repo, tip);
    const existing = ctx.store.lookupPath(repo, treeOid, segments);
    if (!existing || existing.type !== 'blob') {
      jsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    const sentSha = asString(body['sha']);
    if (sentSha !== '' && sentSha.toLowerCase() !== existing.oid) {
      jsonError(ctx, res, 409, 'sha does not match');
      return true;
    }
    const newTree = ctx.store.setPath(repo, treeOid, segments, null);
    const commitOid = commitOnBranch(ctx, repo, targetBranch, newTree, message);
    sendJson(ctx, res, 200, { commit: { sha: commitOid } });
    return true;
  }

  return false;
}

function dirEntries(ctx: Ctx, repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  return parseTree(obj.data).map((e) => {
    const isDir = e.mode === '40000';
    const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
      name: e.name,
      path,
      sha: e.oid,
      url: `${repoUrl(ctx, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/tree/${DEFAULT_BRANCH}/${path}`,
    };
  });
}

function handleIssues(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string): boolean {
  const m = ctx.method;
  if (rest === 'issues') {
    if (m === 'POST') {
      const body = parseJsonBody(ctx, res);
      if (body === null) return true;
      const title = asString(body['title']);
      if (title === '') {
        jsonError(ctx, res, 422, 'title is required');
        return true;
      }
      const rawLabels = body['labels'];
      const labelNames: string[] = [];
      if (Array.isArray(rawLabels)) {
        for (const l of rawLabels) {
          const name = typeof l === 'string' ? l : asString((l as Record<string, unknown>)['name']);
          if (!repo.labels.has(name)) {
            jsonError(ctx, res, 422, `Label '${name}' does not exist`);
            return true;
          }
          labelNames.push(name);
        }
      }
      const number = repo.issuePrCounter + 1;
      repo.issuePrCounter = number;
      const now = ctx.store.tick();
      const issue: Issue = {
        id: ctx.store.nextRestId(),
        number,
        title,
        body: asString(body['body']),
        state: 'open',
        labels: labelNames,
        userLogin: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        comments: [],
        seq: number,
      };
      repo.issues.set(number, issue);
      sendJson(ctx, res, 201, issueJson(ctx, repo, issue));
      return true;
    }
    if (m === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      }
      const { page, link } = paginate(ctx, list);
      sendJson(ctx, res, 200, page.map((i) => issueJson(ctx, repo, i)), link ? { link } : {});
      return true;
    }
    return false;
  }

  const issueMatch = /^issues\/(\d+)(?:\/(.*))?$/.exec(rest);
  if (issueMatch === null) return false;
  const number = parseInt(issueMatch[1] as string, 10);
  const tail = issueMatch[2] ?? '';
  const issue = repo.issues.get(number);
  if (!issue) {
    jsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  if (tail === '') {
    if (m === 'GET') {
      sendJson(ctx, res, 200, issueJson(ctx, repo, issue));
      return true;
    }
    if (m === 'PATCH') {
      const body = parseJsonBody(ctx, res);
      if (body === null) return true;
      if (typeof body['title'] === 'string') issue.title = body['title'] as string;
      if (typeof body['body'] === 'string') issue.body = body['body'] as string;
      if (body['state'] === 'open' || body['state'] === 'closed') {
        issue.state = body['state'] as 'open' | 'closed';
        issue.closedAt = issue.state === 'closed' ? ctx.store.tick() : null;
      }
      issue.updatedAt = ctx.store.tick();
      sendJson(ctx, res, 200, issueJson(ctx, repo, issue));
      return true;
    }
    return false;
  }

  if (tail === 'comments') {
    if (m === 'POST') {
      const body = parseJsonBody(ctx, res);
      if (body === null) return true;
      const text = asString(body['body']);
      if (text === '') {
        jsonError(ctx, res, 422, 'body is required');
        return true;
      }
      const now = ctx.store.tick();
      const comment = {
        id: ctx.store.nextRestId(),
        body: text,
        userLogin: VIEWER_LOGIN,
        createdAt: now,
        updatedAt: now,
      };
      issue.comments.push(comment);
      sendJson(ctx, res, 201, {
        id: comment.id,
        node_id: gid('IssueComment', `${repo.owner}/${repo.name}:${number}:${comment.id}`),
        body: comment.body,
        user: { login: VIEWER_LOGIN, id: VIEWER_ID },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
        url: `${repoUrl(ctx, repo)}/issues/${number}/comments/${comment.id}`,
        issue_url: `${repoUrl(ctx, repo)}/issues/${number}`,
      });
      return true;
    }
    if (m === 'GET') {
      sendJson(ctx, res, 200, issue.comments.map((c) => ({
        id: c.id,
        node_id: gid('IssueComment', `${repo.owner}/${repo.name}:${number}:${c.id}`),
        body: c.body,
        user: { login: c.userLogin, id: VIEWER_ID },
        created_at: c.createdAt,
        updated_at: c.updatedAt,
        html_url: `${ctx.baseUrl}/${repo.owner}/${repo.name}/issues/${number}#issuecomment-${c.id}`,
        url: `${repoUrl(ctx, repo)}/issues/${number}/comments/${c.id}`,
        issue_url: `${repoUrl(ctx, repo)}/issues/${number}`,
      })));
      return true;
    }
    return false;
  }

  return false;
}

/** Squash-merge a pull request: one commit on the base branch whose tree is
 * the base tip tree with every head-vs-merge-base change applied. Shared
 * by REST and GraphQL so both surfaces merge identically. */
export function mergePullInStore(
  ctx: Ctx,
  repo: Repo,
  pull: Pull,
): { ok: boolean; sha: string | null; reason?: string } {
  if (pull.merged || pull.state === 'closed') {
    return { ok: false, sha: null, reason: 'already closed' };
  }
  if (prConflict(ctx, repo, pull)) {
    return { ok: false, sha: null, reason: 'conflict' };
  }
  const baseTipSha = currentBaseSha(repo, pull);
  const base = ctx.store.mergeBase(repo, pull.headSha, baseTipSha);
  const baseTree = base ? ctx.store.treeOfCommit(repo, base) : '';
  const headTree = ctx.store.treeOfCommit(repo, pull.headSha);
  const baseTipTree = ctx.store.treeOfCommit(repo, baseTipSha);
  let tree = baseTipTree;
  for (const d of ctx.store.diffTrees(repo, baseTree, headTree)) {
    tree = ctx.store.setPath(repo, tree === '' ? null : tree, d.path.split('/'), d.newOid);
  }
  const tip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const parents = tip ? [tip] : [];
  const data = buildCommit(tree, parents, `Merge pull request #${pull.number} from ${pull.headRef}`, ctx.store.epochSec());
  const commitOid = ctx.store.putObject(repo, 'commit', data);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitOid);
  repo.updatedAt = ctx.store.tick();
  ctx.store.invalidatePackCache(repo);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = ctx.store.tick();
  pull.mergeCommitSha = commitOid;
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha: commitOid };
}

function handlePulls(ctx: Ctx, res: ServerResponse, repo: Repo, rest: string): boolean {
  const m = ctx.method;
  if (rest === 'pulls') {
    if (m === 'POST') {
      const body = parseJsonBody(ctx, res);
      if (body === null) return true;
      const head = asString(body['head']);
      const base = asString(body['base']);
      const title = asString(body['title']);
      const headSha = ctx.store.resolveRef(repo, head);
      const baseSha = ctx.store.resolveRef(repo, base);
      if (head === '' || base === '' || title === '' || headSha === null || baseSha === null) {
        jsonError(ctx, res, 422, 'head and base branches must exist');
        return true;
      }
      for (const p of repo.pulls.values()) {
        if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
          jsonError(ctx, res, 422, 'A pull request already exists');
          return true;
        }
      }
      const number = repo.issuePrCounter + 1;
      repo.issuePrCounter = number;
      const now = ctx.store.tick();
      const pull: Pull = {
        id: ctx.store.nextRestId(),
        number,
        title,
        body: asString(body['body']),
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
      sendJson(ctx, res, 201, pullJson(ctx, repo, pull));
      return true;
    }
    if (m === 'GET') {
      const state = ctx.query.get('state');
      let list = [...repo.pulls.values()];
      if (state === 'all') {
        // keep all
      } else if (state === 'closed') {
        list = list.filter((p) => p.state === 'closed');
      } else {
        list = list.filter((p) => p.state === 'open');
      }
      list.sort((a, b) => b.seq - a.seq);
      const { page, link } = paginate(ctx, list);
      sendJson(ctx, res, 200, page.map((p) => pullJson(ctx, repo, p)), link ? { link } : {});
      return true;
    }
    return false;
  }

  const pullMatch = /^pulls\/(\d+)(?:\/(.*))?$/.exec(rest);
  if (pullMatch === null) return false;
  const number = parseInt(pullMatch[1] as string, 10);
  const tail = pullMatch[2] ?? '';
  const pull = repo.pulls.get(number);
  if (!pull) {
    jsonError(ctx, res, 404, 'Not Found');
    return true;
  }

  if (tail === '' && m === 'GET') {
    sendJson(ctx, res, 200, pullJson(ctx, repo, pull));
    return true;
  }

  if (tail === 'files' && m === 'GET') {
    sendJson(ctx, res, 200, pullFiles(ctx, repo, pull));
    return true;
  }

  if (tail === 'merge' && m === 'PUT') {
    const result = mergePullInStore(ctx, repo, pull);
    if (!result.ok) {
      jsonError(ctx, res, 405, result.reason === 'conflict' ? 'Merge conflict' : 'Pull request is already closed');
      return true;
    }
    sendJson(ctx, res, 200, {
      sha: result.sha,
      merged: true,
      message: `Pull Request successfully merged`,
    });
    return true;
  }

  return false;
}
