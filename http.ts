// Shared HTTP plumbing for the four surfaces: auth, JSON replies,
// request ids, pagination links, and opaque global ids.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

export const JSON_TYPE = 'application/json; charset=utf-8';

export interface Ctx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
  body: Buffer;
  baseUrl: string;
  store: Store;
}

export function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/** Opaque, stable Relay-style global id: base64url of "Kind:key". */
export function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

export function sendJson(
  ctx: Ctx,
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.store.nextRequestId(),
    ...extra,
  });
  res.end(text);
}

export function sendNoContent(ctx: Ctx, res: ServerResponse): void {
  res.writeHead(204, {
    'content-length': 0,
    'x-github-request-id': ctx.store.nextRequestId(),
  });
  res.end();
}

export function sendRaw(
  ctx: Ctx,
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  extra: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.store.nextRequestId(),
    ...extra,
  });
  res.end(body);
}

export function jsonError(ctx: Ctx, res: ServerResponse, status: number, message: string): void {
  sendJson(ctx, res, status, { message });
}

/** The bearer token the env var names, or '' when the env sets none. */
export function shopToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

/**
 * Auth for every surface except /healthz: when a token is configured the
 * request must present exactly `Bearer <token>`; otherwise 401 JSON.
 * Returns true when authorised (and answers 401 itself when not).
 */
export function requireAuth(ctx: Ctx, res: ServerResponse): boolean {
  const token = shopToken();
  if (token === '') return true;
  const auth = ctx.headers.authorization ?? '';
  if (auth === `Bearer ${token}`) return true;
  jsonError(ctx, res, 401, 'Requires authentication');
  return false;
}

/** Parse a JSON body; on failure answer 400 and return null. */
export function parseJsonBody(ctx: Ctx, res: ServerResponse): Record<string, unknown> | null {
  if (ctx.body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    if (Array.isArray(parsed)) return { __array: parsed } as unknown as Record<string, unknown>;
    return {};
  } catch {
    jsonError(ctx, res, 400, 'Problems parsing JSON');
    return null;
  }
}

export function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

export function asBool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Slice one page out of a list and build the GitHub Link header. */
export function paginate<T>(
  ctx: Ctx,
  items: T[],
): { page: T[]; link: string | null } {
  const perPage = Math.max(1, Math.min(100, parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  if (totalPages <= 1) return { page: slice, link: null };
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(ctx.query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `<${ctx.baseUrl}${ctx.path}?${q.toString()}>`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`${urlFor(page + 1)}; rel="next"`);
  if (page > 1) links.push(`${urlFor(page - 1)}; rel="prev"`);
  links.push(`${urlFor(1)}; rel="first"`);
  links.push(`${urlFor(totalPages)}; rel="last"`);
  return { page: slice, link: links.join(', ') };
}
