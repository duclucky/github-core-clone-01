// The HTTP server: one process, one in-memory store, four surfaces.
// Routing: /healthz (no auth), git smart HTTP at /{owner}/{repo}.git,
// REST v3 under /api/v3, GraphQL at /api/graphql, MCP at /mcp.
// Anything else answers 404 JSON, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, VIEWER_LOGIN } from './store.ts';
import {
  jsonError,
  pathOf,
  queryOf,
  requireAuth,
  sendJson,
  sendRaw,
  type Ctx,
} from './http.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleFetchV0,
  handleFetchV2,
  handleLsRefs,
  handleReceivePack,
  v0Advertisement,
  v2Advertisement,
} from './git.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function gitRoute(ctx: Ctx, res: ServerResponse): boolean {
  const m = ctx.method;
  const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(ctx.path);
  if (match === null) return false;
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const tail = match[3] as string;
  if (!requireAuth(ctx, res)) return true;
  const repo = ctx.store.getRepo(owner, repoName);
  if (tail === 'info/refs' && m === 'GET') {
    const service = ctx.query.get('service') ?? '';
    if (!repo) {
      jsonError(ctx, res, 404, 'Not Found');
      return true;
    }
    if (service === 'git-upload-pack') {
      const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
      sendRaw(
        ctx,
        res,
        200,
        'application/x-git-upload-pack-advertisement',
        v2 ? v2Advertisement() : v0Advertisement(repo, 'upload-pack'),
      );
      return true;
    }
    if (service === 'git-receive-pack') {
      sendRaw(ctx, res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, 'receive-pack'));
      return true;
    }
    jsonError(ctx, res, 404, 'Not Found');
    return true;
  }
  if (!repo) {
    jsonError(ctx, res, 404, 'Not Found');
    return true;
  }
  if (tail === 'git-upload-pack' && m === 'POST') {
    try {
      const v2 = (ctx.headers['git-protocol'] ?? '') === 'version=2';
      const text = ctx.body.toString('utf8');
      if (v2 && text.includes('command=ls-refs')) {
        sendRaw(ctx, res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, ctx.body));
      } else if (v2) {
        sendRaw(ctx, res, 200, 'application/x-git-upload-pack-result', handleFetchV2(repo, ctx.body, ctx.store));
      } else {
        sendRaw(ctx, res, 200, 'application/x-git-upload-pack-result', handleFetchV0(repo, ctx.body));
      }
    } catch {
      jsonError(ctx, res, 400, 'Bad request');
    }
    return true;
  }
  if (tail === 'git-receive-pack' && m === 'POST') {
    try {
      sendRaw(ctx, res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, ctx.body, ctx.store));
    } catch {
      jsonError(ctx, res, 400, 'Bad request');
    }
    return true;
  }
  return false;
}

export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const body = await readBody(req);
        const path = pathOf(req);
        const host = req.headers.host ?? '127.0.0.1';
        const ctx: Ctx = {
          method: req.method ?? 'GET',
          path,
          query: queryOf(req),
          headers: req.headers,
          body,
          baseUrl: `http://${host}`,
          store,
        };

        if (ctx.method === 'GET' && path === '/healthz') {
          sendJson(ctx, res, 200, { ok: true });
          return;
        }

        if (gitRoute(ctx, res)) return;

        if (path === '/api/graphql' && ctx.method === 'POST') {
          handleGraphql(ctx, res);
          return;
        }
        if (path === '/mcp' && ctx.method === 'POST') {
          handleMcp(ctx, res);
          return;
        }
        if (path === '/api/v3' || path === '/api/v3/' || path.startsWith('/api/v3/')) {
          if (handleRest(ctx, res)) return;
        }

        // Unknown route: 404 JSON, never HTML. Auth is not required to
        // learn a route does not exist.
        void VIEWER_LOGIN;
        jsonError(ctx, res, 404, 'Not Found');
      } catch {
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end('{"message":"Internal Server Error"}\n');
        } catch {
          // Socket already gone.
        }
      }
    })();
  });
}
