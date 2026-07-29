import { envConfigs } from '@/config';
import { getAllConfigs } from '@/modules/config/service';

const MAX_RUNTIME_PAGES = 100;

export interface RuntimeArchiveObject {
  key: string;
  size: number;
  etag?: string;
  uploaded: string;
  customMetadata?: Record<string, string>;
}

export interface RuntimeArchivePage {
  objects: RuntimeArchiveObject[];
  truncated: boolean;
  cursor?: string;
}

export interface RuntimeArchiveDeleteResult {
  ok: boolean;
  scope: 'keys' | 'snapshots' | 'all';
  keptKey: string | null;
  deleted: Array<{ key: string; bytes: number; reason?: string }>;
  deletedKeys: string[];
  deletedBytes: number;
  notFound: string[];
  failed: Array<{ key: string; error: string }>;
}

export class StorageRuntimeError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string
  ) {
    super(message);
    this.name = 'StorageRuntimeError';
  }
}

function runtimeUrl(path: string) {
  const base = envConfigs.runtime_base_url.replace(/\/+$/, '');
  return new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
}

async function runtimeSecret(fresh = false) {
  const configs = await getAllConfigs({ fresh });
  const value = (
    configs.billing_usage_webhook_secret ||
    envConfigs.billing_usage_webhook_secret ||
    ''
  ).trim();
  if (!value) {
    throw new StorageRuntimeError(
      'Runtime storage management is not configured',
      503,
      'runtime_not_configured'
    );
  }
  return value;
}

async function requestRuntimeStorage<T>(
  url: URL,
  init: Omit<RequestInit, 'headers'> & { headers?: HeadersInit } = {},
  options: { acceptPartial?: boolean } = {}
): Promise<T> {
  const request = async (secret: string) => {
    const headers = new Headers(init.headers);
    headers.set('x-hicode-runtime-secret', secret);
    return fetch(url, {
      ...init,
      headers,
      signal: init.signal || AbortSignal.timeout(30_000),
    });
  };

  let response = await request(await runtimeSecret());
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    response = await request(await runtimeSecret(true));
  }

  const payload = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    code?: string;
  } & T;
  const validPayload =
    payload.ok === true || (options.acceptPartial && payload.ok === false);
  if (!response.ok || !validPayload) {
    throw new StorageRuntimeError(
      payload.error || response.statusText || 'Runtime storage request failed',
      response.status,
      payload.code || 'runtime_storage_request_failed'
    );
  }
  return payload;
}

export async function listRuntimeArchives(input: {
  runtimeUserId: string;
  sessionId?: string;
}): Promise<RuntimeArchiveObject[]> {
  const objects: RuntimeArchiveObject[] = [];
  let cursor = '';

  for (let page = 0; page < MAX_RUNTIME_PAGES; page += 1) {
    const result = await listRuntimeArchivePage({
      ...input,
      cursor: cursor || undefined,
      limit: 1000,
    });
    objects.push(...(result.objects || []));
    if (!result.truncated || !result.cursor) return objects;
    cursor = result.cursor;
  }

  throw new StorageRuntimeError(
    'Runtime archive listing exceeded the page limit',
    502,
    'runtime_archive_page_limit'
  );
}

/**
 * Fetches one Runtime-managed archive page. Callers performing platform jobs
 * can persist the opaque cursor and avoid restarting a full user scan.
 */
export async function listRuntimeArchivePage(input: {
  runtimeUserId: string;
  sessionId?: string;
  cursor?: string;
  limit?: number;
}): Promise<RuntimeArchivePage> {
  const path = [
    'archive-list',
    encodeURIComponent(input.runtimeUserId),
    input.sessionId ? encodeURIComponent(input.sessionId) : '',
  ]
    .filter(Boolean)
    .join('/');
  const url = runtimeUrl(`/${path}`);
  const limit = Math.min(1000, Math.max(1, Math.floor(input.limit || 100)));
  url.searchParams.set('limit', String(limit));
  if (input.cursor) url.searchParams.set('cursor', input.cursor);
  return requestRuntimeStorage<RuntimeArchivePage>(url);
}

export async function deleteRuntimeArchives(input: {
  runtimeUserId: string;
  sessionId: string;
  keys?: string[];
  scope?: 'snapshots' | 'all';
  keepKey?: string;
}) {
  const url = runtimeUrl(
    `/archive-delete/${encodeURIComponent(input.runtimeUserId)}/${encodeURIComponent(input.sessionId)}`
  );
  return requestRuntimeStorage<RuntimeArchiveDeleteResult>(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        input.keys
          ? { keys: input.keys }
          : { scope: input.scope, keepKey: input.keepKey }
      ),
    },
    { acceptPartial: true }
  );
}

/**
 * Deletes a platform batch while retaining Runtime's user/session prefix
 * boundary. The Runtime endpoint accepts at most 100 explicit keys per call.
 */
export async function deleteRuntimeArchiveObjects(
  objects: Array<{
    runtimeUserId: string;
    sessionId: string;
    key: string;
  }>
) {
  const grouped = new Map<
    string,
    {
      runtimeUserId: string;
      sessionId: string;
      keys: string[];
    }
  >();
  for (const object of objects) {
    const groupKey = `${object.runtimeUserId}\0${object.sessionId}`;
    const group = grouped.get(groupKey) || {
      runtimeUserId: object.runtimeUserId,
      sessionId: object.sessionId,
      keys: [],
    };
    if (!group.keys.includes(object.key)) group.keys.push(object.key);
    grouped.set(groupKey, group);
  }

  const results: RuntimeArchiveDeleteResult[] = [];
  for (const group of grouped.values()) {
    for (let offset = 0; offset < group.keys.length; offset += 100) {
      results.push(
        await deleteRuntimeArchives({
          runtimeUserId: group.runtimeUserId,
          sessionId: group.sessionId,
          keys: group.keys.slice(offset, offset + 100),
        })
      );
    }
  }
  return results;
}

export async function getRuntimeArchiveStats() {
  let cursor = '';
  let objects = 0;
  let bytes = 0;

  for (let page = 0; page < MAX_RUNTIME_PAGES; page += 1) {
    const url = runtimeUrl('/archive-stats');
    url.searchParams.set('limit', '1000');
    if (cursor) url.searchParams.set('cursor', cursor);
    const result = await requestRuntimeStorage<{
      objects: number;
      bytes: number;
      truncated: boolean;
      cursor?: string;
    }>(url);
    objects += Number(result.objects || 0);
    bytes += Number(result.bytes || 0);
    if (!result.truncated || !result.cursor) {
      return { objects, bytes };
    }
    cursor = result.cursor;
  }

  throw new StorageRuntimeError(
    'Runtime archive statistics exceeded the page limit',
    502,
    'runtime_archive_page_limit'
  );
}
