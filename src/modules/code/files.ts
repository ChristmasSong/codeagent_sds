import { envConfigs } from '@/config';
import type {
  WorkspaceDirectoryResult,
  WorkspaceFileContentResult,
  WorkspaceFilePreviewKind,
  WorkspaceStatusResult,
} from '@/lib/code-files';

import { workspaceFilesUrl } from './runtime';
import { getOwnedSession } from './service';

interface RuntimeDirectoryPayload {
  ok?: boolean;
  exists?: boolean;
  path?: string;
  entries?: WorkspaceDirectoryResult['entries'];
  truncated?: boolean;
  error?: string;
}

interface RuntimeStatusPayload {
  ok?: boolean;
  exists?: boolean;
  digest?: string | null;
  entryCount?: number;
  truncated?: boolean;
  error?: string;
}

interface RuntimeFileContentPayload {
  ok?: boolean;
  exists?: boolean;
  path?: string;
  name?: string;
  size?: number;
  mtime?: string;
  mimeType?: string;
  kind?: WorkspaceFilePreviewKind;
  encoding?: string | null;
  etag?: string;
  previewable?: boolean;
  rawAvailable?: boolean;
  tooLarge?: boolean;
  truncated?: boolean;
  content?: string;
  error?: string;
}

const RUNTIME_FILES_TIMEOUT_MS = 15_000;
const RUNTIME_FILE_STREAM_TIMEOUT_MS = 60_000;
const RUNTIME_JSON_RESPONSE_LIMIT = 8 * 1024 * 1024;
const RAW_PREVIEW_LIMITS: Partial<Record<WorkspaceFilePreviewKind, number>> = {
  image: 10 * 1024 * 1024,
  pdf: 20 * 1024 * 1024,
  html: 1024 * 1024,
  svg: 1024 * 1024,
};
const FORWARDED_RAW_HEADERS = [
  'cache-control',
  'content-disposition',
  'content-length',
  'content-security-policy',
  'content-type',
  'etag',
  'x-content-type-options',
  'x-file-mtime',
  'x-file-path',
  'x-file-preview-kind',
  'x-file-size',
] as const;

export type WorkspaceRuntimeSecretResolver = (options?: {
  fresh?: boolean;
}) => Promise<string | null | undefined>;

export class WorkspaceFilesError extends Error {
  constructor(
    message: string,
    public status = 500
  ) {
    super(message);
    this.name = 'WorkspaceFilesError';
  }
}

function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const path = value;
  if (path.length > 1024 || path.includes('\0') || path.startsWith('/')) {
    throw new WorkspaceFilesError('invalid_path', 400);
  }
  return path;
}

function runtimeError(error: unknown): WorkspaceFilesError {
  if (error instanceof WorkspaceFilesError) return error;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return new WorkspaceFilesError('runtime_timeout', 504);
  }
  return new WorkspaceFilesError('runtime_unavailable', 502);
}

function runtimePayloadError(
  error: string | undefined,
  status: number
): WorkspaceFilesError {
  const code = error || 'runtime_request_failed';
  const knownStatus: Record<string, number> = {
    file_not_available: 404,
    file_read_failed: 502,
    file_too_large: 413,
    invalid_path: 400,
    not_a_file: 400,
    unsupported_file: 415,
  };
  return new WorkspaceFilesError(
    Object.hasOwn(knownStatus, code) ? code : 'runtime_request_failed',
    knownStatus[code] || (status >= 400 && status < 500 ? status : 502)
  );
}

async function readRuntimeJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') || '';
  const declaredLength = response.headers.get('content-length');
  const contentLength =
    declaredLength == null ? Number.NaN : Number.parseInt(declaredLength, 10);
  if (
    !contentType.toLowerCase().startsWith('application/json') ||
    (Number.isFinite(contentLength) &&
      (contentLength < 0 || contentLength > RUNTIME_JSON_RESPONSE_LIMIT))
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkspaceFilesError('invalid_runtime_response', 502);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new WorkspaceFilesError('invalid_runtime_response', 502);
  }
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalLength += value.byteLength;
    if (totalLength > RUNTIME_JSON_RESPONSE_LIMIT) {
      await reader.cancel().catch(() => undefined);
      throw new WorkspaceFilesError('invalid_runtime_response', 502);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    ) as T;
  } catch {
    throw new WorkspaceFilesError('invalid_runtime_response', 502);
  }
}

async function runtimeSecret(
  resolveSecret: WorkspaceRuntimeSecretResolver,
  fresh = false
): Promise<string> {
  let secret = (await resolveSecret({ fresh }))?.trim() || '';
  // A warm isolate can cache "not configured" before an admin saves the key.
  if (!secret && !fresh) {
    secret = (await resolveSecret({ fresh: true }))?.trim() || '';
  }
  if (!secret) throw new WorkspaceFilesError('runtime_not_configured', 503);
  return secret;
}

export async function requestRuntimeWithSecret(
  url: string,
  resolveSecret: WorkspaceRuntimeSecretResolver,
  timeoutMs: number,
  headers?: HeadersInit
): Promise<Response> {
  const request = async (secret: string) => {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('x-hicode-runtime-secret', secret);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: requestHeaders,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw runtimeError(error);
    }
  };

  let response = await request(await runtimeSecret(resolveSecret));
  if (response.status !== 401) return response;

  // The Runtime uses 401 specifically for a stale/mismatched shared secret.
  await response.body?.cancel().catch(() => undefined);
  response = await request(await runtimeSecret(resolveSecret, true));
  if (response.status === 401) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkspaceFilesError('runtime_not_configured', 503);
  }
  return response;
}

async function runtimeFilesRequest<T>(
  url: string,
  resolveSecret: WorkspaceRuntimeSecretResolver
): Promise<T> {
  let payload: T & {
    ok?: boolean;
    error?: string;
  };
  const response = await requestRuntimeWithSecret(
    url,
    resolveSecret,
    RUNTIME_FILES_TIMEOUT_MS,
    { accept: 'application/json' }
  );
  try {
    payload = await readRuntimeJson<T & { ok?: boolean; error?: string }>(
      response
    );
  } catch (error) {
    throw runtimeError(error);
  }
  if (!response.ok || payload.ok === false) {
    throw runtimePayloadError(payload.error, response.status);
  }
  return payload;
}

async function runtimeFileResponse(
  url: string,
  resolveSecret: WorkspaceRuntimeSecretResolver
): Promise<Response> {
  const response = await requestRuntimeWithSecret(
    url,
    resolveSecret,
    RUNTIME_FILE_STREAM_TIMEOUT_MS
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
    };
    throw runtimePayloadError(payload.error, response.status);
  }
  return response;
}

async function ownedActiveSession(userId: string, sessionId: string) {
  const session = await getOwnedSession(userId, sessionId);
  if (!session) throw new WorkspaceFilesError('session_not_found', 404);
  return session;
}

function contentUrl(
  runtimeBase: string,
  runtimeUserId: string,
  sessionId: string,
  path: string,
  raw = false
) {
  const url = new URL(
    workspaceFilesUrl(runtimeBase, runtimeUserId, sessionId, 'content')
  );
  url.searchParams.set('path', path);
  if (raw) url.searchParams.set('raw', 'true');
  return url;
}

function validRawContentType(kind: WorkspaceFilePreviewKind, value: string) {
  const contentType = value.toLowerCase().split(';', 1)[0].trim();
  if (kind === 'image') {
    return contentType.startsWith('image/') && contentType !== 'image/svg+xml';
  }
  if (kind === 'pdf') return contentType === 'application/pdf';
  if (kind === 'html') return contentType === 'text/html';
  if (kind === 'svg') return contentType === 'image/svg+xml';
  return false;
}

export async function listWorkspaceDirectory(
  userId: string,
  sessionId: string,
  requestedPath: unknown,
  showHidden: boolean,
  resolveSecret: WorkspaceRuntimeSecretResolver
): Promise<WorkspaceDirectoryResult> {
  const session = await ownedActiveSession(userId, sessionId);
  const path = normalizeWorkspacePath(requestedPath);
  if (session.status !== 'active') {
    return {
      sessionStatus: session.status,
      exists: false,
      path,
      entries: [],
      truncated: false,
    };
  }

  const url = new URL(
    workspaceFilesUrl(
      envConfigs.runtime_base_url,
      session.runtimeUserId,
      session.id
    )
  );
  if (path) url.searchParams.set('path', path);
  if (showHidden) url.searchParams.set('showHidden', 'true');
  const payload = await runtimeFilesRequest<RuntimeDirectoryPayload>(
    url.toString(),
    resolveSecret
  );
  return {
    sessionStatus: session.status,
    exists: payload.exists === true,
    path: typeof payload.path === 'string' ? payload.path : path,
    entries: Array.isArray(payload.entries) ? payload.entries : [],
    truncated: payload.truncated === true,
  };
}

export async function getWorkspaceStatus(
  userId: string,
  sessionId: string,
  showHidden: boolean,
  resolveSecret: WorkspaceRuntimeSecretResolver
): Promise<WorkspaceStatusResult> {
  const session = await ownedActiveSession(userId, sessionId);
  if (session.status !== 'active') {
    return {
      sessionStatus: session.status,
      exists: false,
      digest: null,
      entryCount: 0,
      truncated: false,
    };
  }

  const url = new URL(
    workspaceFilesUrl(
      envConfigs.runtime_base_url,
      session.runtimeUserId,
      session.id,
      'status'
    )
  );
  if (showHidden) url.searchParams.set('showHidden', 'true');
  const payload = await runtimeFilesRequest<RuntimeStatusPayload>(
    url.toString(),
    resolveSecret
  );
  return {
    sessionStatus: session.status,
    exists: payload.exists === true,
    digest: typeof payload.digest === 'string' ? payload.digest : null,
    entryCount: typeof payload.entryCount === 'number' ? payload.entryCount : 0,
    truncated: payload.truncated === true,
  };
}

export async function getWorkspaceFileContent(
  userId: string,
  sessionId: string,
  requestedPath: unknown,
  resolveSecret: WorkspaceRuntimeSecretResolver
): Promise<WorkspaceFileContentResult> {
  const session = await ownedActiveSession(userId, sessionId);
  const path = normalizeWorkspacePath(requestedPath);
  if (!path) throw new WorkspaceFilesError('invalid_path', 400);
  if (session.status !== 'active') {
    throw new WorkspaceFilesError('session_not_active', 409);
  }

  const payload = await runtimeFilesRequest<RuntimeFileContentPayload>(
    contentUrl(
      envConfigs.runtime_base_url,
      session.runtimeUserId,
      session.id,
      path
    ).toString(),
    resolveSecret
  );
  const kind = payload.kind || 'binary';
  return {
    sessionStatus: session.status,
    exists: payload.exists === true,
    path: typeof payload.path === 'string' ? payload.path : path,
    name:
      typeof payload.name === 'string'
        ? payload.name
        : path.split('/').at(-1) || path,
    size: typeof payload.size === 'number' ? payload.size : 0,
    mtime: typeof payload.mtime === 'string' ? payload.mtime : '',
    mimeType:
      typeof payload.mimeType === 'string'
        ? payload.mimeType
        : 'application/octet-stream',
    kind,
    encoding: payload.encoding === 'utf-8' ? 'utf-8' : null,
    etag: typeof payload.etag === 'string' ? payload.etag : '',
    previewable: payload.previewable === true,
    rawAvailable: payload.rawAvailable === true,
    tooLarge: payload.tooLarge === true,
    truncated: payload.truncated === true,
    ...(typeof payload.content === 'string'
      ? { content: payload.content }
      : {}),
  };
}

export async function getWorkspaceFileRawResponse(
  userId: string,
  sessionId: string,
  requestedPath: unknown,
  resolveSecret: WorkspaceRuntimeSecretResolver
): Promise<Response> {
  const session = await ownedActiveSession(userId, sessionId);
  const path = normalizeWorkspacePath(requestedPath);
  if (!path) throw new WorkspaceFilesError('invalid_path', 400);
  if (session.status !== 'active') {
    throw new WorkspaceFilesError('session_not_active', 409);
  }

  const response = await runtimeFileResponse(
    contentUrl(
      envConfigs.runtime_base_url,
      session.runtimeUserId,
      session.id,
      path,
      true
    ).toString(),
    resolveSecret
  );
  const kind = response.headers.get(
    'x-file-preview-kind'
  ) as WorkspaceFilePreviewKind | null;
  const contentType = response.headers.get('content-type') || '';
  const rawLimit = kind ? RAW_PREVIEW_LIMITS[kind] : undefined;
  const rawLength = response.headers.get('content-length');
  const contentLength =
    rawLength == null ? Number.NaN : Number.parseInt(rawLength, 10);
  if (
    !kind ||
    !rawLimit ||
    !Number.isFinite(contentLength) ||
    contentLength < 0 ||
    contentLength > rawLimit ||
    !validRawContentType(kind, contentType)
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new WorkspaceFilesError('invalid_runtime_file_response', 502);
  }

  const headers = new Headers();
  for (const name of FORWARDED_RAW_HEADERS) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  if (kind === 'html' || kind === 'svg') {
    headers.set(
      'content-security-policy',
      "sandbox; default-src 'none'; img-src data: blob:; " +
        "style-src 'unsafe-inline'; font-src data:"
    );
  }
  return new Response(response.body, {
    status: 200,
    headers,
  });
}
