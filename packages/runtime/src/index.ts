import { Container } from '@cloudflare/containers';

import {
  archiveCleanupPlan,
  archiveTemporaryPrefix,
  archiveVersionKey,
  archiveVersionsPrefix,
  isSessionArchiveKey,
  isVersionArchiveKey,
  legacyArchiveKey,
  newestArchiveObject,
  sessionArchivePrefix,
  userArchivePrefix,
  type ArchiveCleanupReason,
  type ArchiveObjectLike,
} from './archive-storage';
import {
  deliverOrQueueUsageReport,
  flushPendingUsageReports,
  queueUsageReport,
  type UsageReportPayload,
} from './billing-outbox';
import { resolveProviderUsageReport } from './provider-usage';
import { runStorageGcSchedule } from './storage-gc-scheduler';
import { extractTokenUsage } from './token-usage';

interface Env {
  INTEGRATED_SESSION_CONTAINER: DurableObjectNamespace<IntegratedSessionContainer>;
  WORKSPACE_ARCHIVES: R2Bucket;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_API_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  YUNWU_SYSTEM_ACCESS_TOKEN?: string;
  YUNWU_USER_ID?: string;
  APP_BASE_URL?: string;
  BILLING_USAGE_WEBHOOK_SECRET?: string;
  WORKSPACE_ARCHIVE_HARD_LIMIT_BYTES?: string;
}

interface Manifest {
  ok: boolean;
  session: string;
  exists?: boolean;
  digest?: string | null;
  file_count?: number;
  total_bytes?: number;
  skipped_count?: number;
}

interface RuntimeErrorBody {
  error?: unknown;
  message?: unknown;
  code?: unknown;
  stage?: unknown;
  details?: unknown;
}

class RuntimeOperationError extends Error {
  constructor(
    public status: number,
    public code: string,
    public stage: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'RuntimeOperationError';
  }
}

export class IntegratedSessionContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '10m';

  async onActivityExpired() {
    await this.destroy();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__destroy') {
      await this.destroy();
      return new Response(JSON.stringify({ ok: true, destroyed: true }), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    return super.fetch(request);
  }
}

const gatewayBasePath = '/api/model';
const defaultAnthropicBaseUrl = 'https://api.anthropic.com';
const defaultAnthropicVersion = '2023-06-01';
type Agent = 'claude' | 'codex';

interface UsageReportContext {
  idempotencyKey: string;
  provider: string;
  endpoint: string;
  upstreamStatus: number;
  requestId: string;
  model: string;
  observedAtUnix: number;
}

interface ModelAuthorizationResult {
  authorized: boolean;
  reason?: string;
  message?: string;
  balance?: number;
  requiredBalance?: number;
}

function agentFromUrl(url: URL): Agent {
  return url.searchParams.get('agent') === 'codex' ? 'codex' : 'claude';
}

function modelFromUrl(url: URL): string {
  return (url.searchParams.get('model') || '').trim().slice(0, 160);
}

function withSessionParams(target: URL, agent: Agent, model = ''): URL {
  if (agent === 'codex') target.searchParams.set('agent', agent);
  if (model) target.searchParams.set('model', model);
  return target;
}

function containerHeaders(
  request: Request,
  agent: Agent,
  model = '',
  modelGatewayToken = ''
): Headers {
  const headers = new Headers(request.headers);
  // Runtime-management credentials authorize the Worker, never the tenant
  // container. Provider credentials supplied by a caller must not cross that
  // boundary either.
  headers.delete('x-hicode-runtime-secret');
  headers.delete('x-hicode-billing-secret');
  headers.delete('authorization');
  headers.delete('x-api-key');
  headers.delete('cookie');
  headers.delete('x-codeagent-openai-api-key');
  headers.set('x-codeagent-agent', agent);
  if (model) headers.set('x-codeagent-model', model);
  if (modelGatewayToken) {
    // This is a session-scoped HMAC credential. It cannot authorize another
    // session and is intentionally the only model credential the container
    // receives.
    headers.set('x-codeagent-openai-api-key', modelGatewayToken);
  }
  return headers;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'access-control-allow-headers':
        'authorization,content-type,x-api-key,anthropic-version,anthropic-beta,openai-organization,openai-project,x-hicode-runtime-secret,x-hicode-archive-key',
      ...init.headers,
    },
  });
}

function page(
  origin: string,
  userId = 'demo-user',
  sessionId = 'demo-session'
): Response {
  const safeUserId = encodeURIComponent(userId);
  const safeSessionId = encodeURIComponent(sessionId);
  const appUrl = `${origin}/app/${safeUserId}/${safeSessionId}`;
  return new Response(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Integrated Session MVP</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
    <style>
      * { box-sizing: border-box; }
      html, body { width: 100%; height: 100%; margin: 0; }
      body {
        font: 14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #172033;
        background: #f6f7f9;
      }
      button, input { font: inherit; }
      .app {
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }
      .topbar {
        min-height: 56px;
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border-bottom: 1px solid #dde1e7;
        background: #ffffff;
      }
      .brand {
        font-weight: 700;
        white-space: nowrap;
      }
      .session {
        min-width: 0;
        flex: 1;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .session input {
        width: min(420px, 100%);
        height: 34px;
        border: 1px solid #cfd6df;
        border-radius: 6px;
        padding: 0 10px;
        color: #172033;
        background: #ffffff;
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .actions button, .actions a {
        height: 34px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid #cbd3df;
        border-radius: 6px;
        padding: 0 10px;
        background: #ffffff;
        color: #172033;
        text-decoration: none;
        cursor: pointer;
      }
      .actions button.primary {
        border-color: #275cc8;
        background: #275cc8;
        color: #ffffff;
      }
      .actions button:disabled {
        opacity: .55;
        cursor: wait;
      }
      .status {
        min-width: 172px;
        color: #5a6575;
        font-size: 12px;
        text-align: right;
        white-space: nowrap;
      }
      .workspace {
        min-height: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(340px, 38vw);
      }
      .terminalPane, .previewPane {
        min-width: 0;
        min-height: 0;
      }
      .terminalPane {
        display: grid;
        grid-template-rows: minmax(0, 1fr) auto;
        background: #0b0f17;
      }
      #terminal {
        min-height: 0;
        padding: 10px;
      }
      .logline {
        min-height: 34px;
        padding: 8px 12px;
        border-top: 1px solid #242c3b;
        color: #aeb8c8;
        background: #111722;
        font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .previewPane {
        display: grid;
        grid-template-rows: 34px minmax(0, 1fr);
        border-left: 1px solid #dde1e7;
        background: #ffffff;
      }
      .previewHeader {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 10px;
        border-bottom: 1px solid #dde1e7;
        color: #5a6575;
        font-size: 12px;
      }
      .previewHeader span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      iframe {
        width: 100%;
        height: 100%;
        border: 0;
        background: #ffffff;
      }
      @media (max-width: 980px) {
        .topbar { align-items: stretch; flex-direction: column; }
        .session, .actions { width: 100%; }
        .session input { width: 100%; }
        .status { width: 100%; text-align: left; }
        .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(420px, 60vh) minmax(320px, 40vh); }
        .previewPane { border-left: 0; border-top: 1px solid #dde1e7; }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <div class="brand">CodeAgent Spike 7</div>
        <label class="session">
          <input id="sessionUrl" value="${appUrl}" readonly />
        </label>
        <div class="actions">
          <button id="reconnect" class="primary" type="button">Reconnect</button>
          <button id="health" type="button">Health</button>
          <button id="seed" type="button" disabled title="Use the authenticated app API">Seed</button>
          <button id="archive" type="button" disabled title="Use the authenticated app API">Archive</button>
          <button id="restore" type="button" disabled title="Use the authenticated app API">Restore</button>
          <span title="Use the authenticated application">Preview protected</span>
        </div>
        <div id="status" class="status">idle</div>
      </header>
      <main class="workspace">
        <section class="terminalPane">
          <div id="terminal"></div>
          <div id="logline" class="logline">terminal</div>
        </section>
        <aside class="previewPane">
          <div class="previewHeader"><span>Preview requires an authenticated signed URL</span></div>
          <div class="empty">Open this session from the authenticated application.</div>
        </aside>
      </main>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
    <script>
      (function () {
        var userId = ${JSON.stringify(userId)};
        var sessionId = ${JSON.stringify(sessionId)};
        var terminalPath = "/terminal/" + encodeURIComponent(userId) + "/" + encodeURIComponent(sessionId);
        var socket = null;
        var fitAddon = null;
        var term = null;
        var reconnecting = false;
        var status = document.getElementById("status");
        var logline = document.getElementById("logline");

        function setStatus(text) {
          status.textContent = text;
        }

        function log(text) {
          logline.textContent = text;
        }

        function wsUrl() {
          return window.location.origin.replace(/^http/, "ws") + terminalPath;
        }

        function resize() {
          if (!fitAddon || !term) return;
          fitAddon.fit();
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        }

        async function action(label, path, options) {
          setStatus(label);
          var response = await fetch(path, options || {});
          var payload = await response.json().catch(function () { return { ok: false, error: response.statusText }; });
          if (!response.ok || payload.ok === false) {
            throw new Error(payload.error || JSON.stringify(payload));
          }
          return payload;
        }

        function connect() {
          if (!term) return;
          reconnecting = true;
          if (socket) socket.close();
          socket = new WebSocket(wsUrl());
          socket.binaryType = "arraybuffer";
          socket.addEventListener("open", function () {
            reconnecting = false;
            setStatus("connected");
            log("connected " + sessionId);
            resize();
          });
          socket.addEventListener("message", function (event) {
            if (typeof event.data === "string") {
              term.write(event.data);
            } else {
              term.write(new Uint8Array(event.data));
            }
          });
          socket.addEventListener("close", function () {
            if (!reconnecting) setStatus("closed");
          });
          socket.addEventListener("error", function () {
            setStatus("socket error");
          });
        }

        function wireButton(id, handler) {
          var button = document.getElementById(id);
          button.addEventListener("click", async function () {
            button.disabled = true;
            try {
              await handler();
            } catch (error) {
              setStatus("error");
              log(error.message || String(error));
            } finally {
              button.disabled = false;
            }
          });
        }

        function boot() {
          if (!window.Terminal || !window.FitAddon) {
            setStatus("xterm failed");
            log("xterm asset load failed");
            return;
          }
          term = new Terminal({
            cursorBlink: true,
            convertEol: true,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            fontSize: 13,
            theme: { background: "#0b0f17", foreground: "#d7dde8", cursor: "#ffffff" }
          });
          fitAddon = new FitAddon.FitAddon();
          term.loadAddon(fitAddon);
          term.open(document.getElementById("terminal"));
          term.onData(function (data) {
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "input", data: data }));
            }
          });
          window.addEventListener("resize", resize);
          wireButton("reconnect", async function () {
            setStatus("protected");
            log("Open this session from the authenticated application.");
          });
          wireButton("health", async function () {
            setStatus("protected");
            log("Runtime diagnostics require the authenticated application.");
          });
          resize();
          setStatus("protected");
          log("Open this session from the authenticated application.");
        }

        boot();
      })();
    </script>
  </body>
</html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } }
  );
}

function metadataFileCount(
  metadata: Record<string, string> | undefined
): number {
  const parsed = Number.parseInt(metadata?.fileCount || '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

interface ArchiveDeletedObject {
  key: string;
  bytes: number;
  reason?: ArchiveCleanupReason | 'explicit' | 'all' | 'snapshot';
}

interface ArchiveDeleteFailure {
  key: string;
  error: string;
}

interface ArchiveObjectPage {
  objects: R2Object[];
  truncated: boolean;
  cursor?: string;
}

const archiveManagementPageSize = 1000;
const archiveDeleteKeyLimit = 100;
const integratedWorkspacesPrefix = 'integrated-workspaces/';

function runtimeSecretAuthorized(request: Request, env: Env): boolean {
  return Boolean(
    env.BILLING_USAGE_WEBHOOK_SECRET &&
    request.headers.get('x-hicode-runtime-secret') ===
      env.BILLING_USAGE_WEBHOOK_SECRET
  );
}

const modelGatewayTokenPrefix = 'cgw1_';
const previewTokenLifetimeSeconds = 5 * 60;
const previewTokenClockSkewSeconds = 30;
const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function decodeBase64Url(value: string): ArrayBuffer | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

async function signHmac(secret: string, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    encoder.encode(message)
  );
  return encodeBase64Url(new Uint8Array(signature));
}

async function verifyHmac(
  secret: string,
  message: string,
  encodedSignature: string
): Promise<boolean> {
  const signature = decodeBase64Url(encodedSignature);
  if (!signature || signature.byteLength !== 32) return false;
  return crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    signature,
    encoder.encode(message)
  );
}

function modelGatewayMessage(sessionId: string): string {
  return `model-gateway:v1\0${sessionId}`;
}

async function modelGatewaySessionToken(
  env: Env,
  sessionId: string
): Promise<string> {
  const secret = (env.BILLING_USAGE_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    throw new RuntimeOperationError(
      503,
      'model_gateway_not_configured',
      'model.gateway',
      'Model gateway session authentication is not configured'
    );
  }
  return `${modelGatewayTokenPrefix}${await signHmac(
    secret,
    modelGatewayMessage(sessionId)
  )}`;
}

function modelGatewayCredential(request: Request): string {
  const authorization = request.headers.get('authorization') || '';
  const bearer = authorization.match(/^Bearer\s+(.+)$/i);
  return (bearer?.[1] || request.headers.get('x-api-key') || '').trim();
}

async function modelGatewayAuthorized(
  request: Request,
  env: Env,
  sessionId: string
): Promise<boolean> {
  const secret = (env.BILLING_USAGE_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    throw new RuntimeOperationError(
      503,
      'model_gateway_not_configured',
      'model.gateway',
      'Model gateway session authentication is not configured'
    );
  }
  const credential = modelGatewayCredential(request);
  if (!credential.startsWith(modelGatewayTokenPrefix)) return false;
  return verifyHmac(
    secret,
    modelGatewayMessage(sessionId),
    credential.slice(modelGatewayTokenPrefix.length)
  );
}

function previewMessage(
  userId: string,
  sessionId: string,
  expiresAt: number
): string {
  return `preview:v1\0${userId}\0${sessionId}\0${expiresAt}`;
}

async function previewTokenAuthorized(
  env: Env,
  userId: string,
  sessionId: string,
  token: string
): Promise<boolean> {
  const secret = (env.BILLING_USAGE_WEBHOOK_SECRET || '').trim();
  if (!secret) return false;
  const separator = token.indexOf('.');
  if (separator <= 0 || separator === token.length - 1) return false;
  const expiresText = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  if (!/^\d{1,12}$/.test(expiresText)) return false;
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (
    expiresAt < now - previewTokenClockSkewSeconds ||
    expiresAt > now + previewTokenLifetimeSeconds + previewTokenClockSkewSeconds
  ) {
    return false;
  }
  return verifyHmac(
    secret,
    previewMessage(userId, sessionId, expiresAt),
    signature
  );
}

function requestedArchiveKey(request: Request, url: URL): string {
  return (
    request.headers.get('x-hicode-archive-key') ||
    url.searchParams.get('key') ||
    ''
  ).trim();
}

function requestedTargetArchiveKey(request: Request): string {
  return (request.headers.get('x-hicode-target-archive-key') || '').trim();
}

function archiveObjectSummary(object: R2Object): ArchiveObjectLike {
  return {
    key: object.key,
    size: object.size,
    uploaded: object.uploaded,
    etag: object.etag,
    customMetadata: object.customMetadata,
  };
}

function archiveObjectJson(object: R2Object) {
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    uploaded: object.uploaded.toISOString(),
    customMetadata: object.customMetadata || {},
  };
}

function archiveListLimit(url: URL): number {
  const parsed = Number.parseInt(url.searchParams.get('limit') || '100', 10);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(archiveManagementPageSize, Math.max(1, parsed));
}

function archiveMaxBytes(url: URL, env: Env): number | null {
  const value = url.searchParams.get('maxBytes');
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RuntimeOperationError(
      400,
      'invalid_archive_max_bytes',
      'archive.quota',
      'maxBytes must be a non-negative safe integer'
    );
  }
  const configuredHardLimit = Number(env.WORKSPACE_ARCHIVE_HARD_LIMIT_BYTES);
  const hardLimit =
    Number.isSafeInteger(configuredHardLimit) && configuredHardLimit > 0
      ? configuredHardLimit
      : 2 * 1024 ** 3;
  return Math.min(parsed, hardLimit);
}

function archiveRetentionDays(url: URL): number {
  const parsed = Number.parseInt(
    url.searchParams.get('retentionDays') || '7',
    10
  );
  return Number.isFinite(parsed) ? Math.min(365, Math.max(1, parsed)) : 7;
}

function archiveMaxSnapshots(url: URL): number {
  const parsed = Number.parseInt(
    url.searchParams.get('maxSnapshots') || '2',
    10
  );
  return Number.isFinite(parsed) ? Math.min(50, Math.max(0, parsed)) : 2;
}

async function listArchiveObjectPage(
  bucket: R2Bucket,
  prefix: string,
  options: { cursor?: string; limit?: number } = {}
): Promise<ArchiveObjectPage> {
  const listOptions = {
    prefix,
    limit: options.limit || archiveManagementPageSize,
    include: ['customMetadata'],
    ...(options.cursor ? { cursor: options.cursor } : {}),
  } as R2ListOptions;
  const listed = await bucket.list(listOptions);
  return {
    objects: listed.objects,
    truncated: listed.truncated,
    ...(listed.truncated ? { cursor: listed.cursor } : {}),
  };
}

async function listAllArchiveObjects(
  bucket: R2Bucket,
  prefix: string
): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor = '';
  do {
    const page = await listArchiveObjectPage(bucket, prefix, {
      cursor: cursor || undefined,
      limit: archiveManagementPageSize,
    });
    objects.push(...page.objects);
    cursor = page.cursor || '';
    if (!page.truncated) break;
  } while (cursor);
  return objects;
}

async function resolveCurrentArchiveObject(
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  requestedKey: string,
  versionObjects?: R2Object[]
): Promise<{ object: R2Object | null; requestedKeyMissing: boolean }> {
  if (
    requestedKey &&
    requestedKey !== legacyArchiveKey(userId, sessionId) &&
    !isVersionArchiveKey(userId, sessionId, requestedKey)
  ) {
    throw new RuntimeOperationError(
      400,
      'invalid_archive_key',
      'archive.resolve',
      'Archive key is not a restorable object for the requested session',
      { requestedKey }
    );
  }

  if (requestedKey) {
    const requested = await bucket.head(requestedKey);
    if (requested) {
      return { object: requested, requestedKeyMissing: false };
    }
  }

  const versions =
    versionObjects ||
    (await listAllArchiveObjects(
      bucket,
      archiveVersionsPrefix(userId, sessionId)
    ));
  const newest = newestArchiveObject(versions.map(archiveObjectSummary));
  if (newest) {
    const object = await bucket.head(newest.key);
    if (object) {
      return { object, requestedKeyMissing: Boolean(requestedKey) };
    }
  }

  const legacy = await bucket.head(legacyArchiveKey(userId, sessionId));
  return {
    object: legacy,
    requestedKeyMissing: Boolean(requestedKey),
  };
}

async function deleteArchiveObjects(
  bucket: R2Bucket,
  candidates: Array<{
    object: ArchiveObjectLike;
    reason?: ArchiveDeletedObject['reason'];
  }>
): Promise<{
  deleted: ArchiveDeletedObject[];
  failed: ArchiveDeleteFailure[];
}> {
  const deleted: ArchiveDeletedObject[] = [];
  const failed: ArchiveDeleteFailure[] = [];
  const unique = new Map<
    string,
    {
      object: ArchiveObjectLike;
      reason?: ArchiveDeletedObject['reason'];
    }
  >();
  for (const candidate of candidates) {
    unique.set(candidate.object.key, candidate);
  }

  for (const candidate of unique.values()) {
    let deleteError = '';
    try {
      await bucket.delete(candidate.object.key);
    } catch (error) {
      deleteError = error instanceof Error ? error.message : String(error);
    }
    try {
      const remaining = await bucket.head(candidate.object.key);
      if (!remaining) {
        deleted.push({
          key: candidate.object.key,
          bytes: candidate.object.size,
          ...(candidate.reason ? { reason: candidate.reason } : {}),
        });
        continue;
      }
      failed.push({
        key: candidate.object.key,
        error: deleteError || 'R2 object still exists after deletion',
      });
    } catch (error) {
      failed.push({
        key: candidate.object.key,
        error:
          deleteError ||
          (error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return { deleted, failed };
}

async function cleanupSessionArchives(
  bucket: R2Bucket,
  userId: string,
  sessionId: string,
  currentKey: string,
  versionObjects: R2Object[],
  options: {
    now?: Date;
    retainPrevious?: boolean;
    previousObject?: R2Object | null;
    retentionDays?: number;
    maxSnapshots?: number;
  } = {}
) {
  const preflightFailures: ArchiveDeleteFailure[] = [];
  let temporaryObjects: R2Object[] = [];
  try {
    temporaryObjects = await listAllArchiveObjects(
      bucket,
      archiveTemporaryPrefix(userId, sessionId)
    );
  } catch (error) {
    preflightFailures.push({
      key: archiveTemporaryPrefix(userId, sessionId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const planned = archiveCleanupPlan(
    versionObjects.map(archiveObjectSummary),
    temporaryObjects.map(archiveObjectSummary),
    currentKey,
    {
      now: options.now,
      retainPrevious: options.retainPrevious,
      maxSnapshots: options.maxSnapshots,
      historyTtlMs: (options.retentionDays || 7) * 24 * 60 * 60 * 1000,
    }
  );
  const candidates: Array<{
    object: ArchiveObjectLike;
    reason?: ArchiveDeletedObject['reason'];
  }> = planned.map((candidate) => candidate);

  if (
    options.retainPrevious === false &&
    options.previousObject &&
    options.previousObject.key !== currentKey &&
    isSessionArchiveKey(userId, sessionId, options.previousObject.key)
  ) {
    candidates.push({
      object: archiveObjectSummary(options.previousObject),
      reason: 'replace_current',
    });
  }

  const result = await deleteArchiveObjects(bucket, candidates);
  return {
    deleted: result.deleted,
    failed: [...preflightFailures, ...result.failed],
  };
}

function container(env: Env, userId: string) {
  return env.INTEGRATED_SESSION_CONTAINER.getByName(userId);
}

async function containerJson<T>(
  fetcher: Fetcher,
  target: URL,
  init?: RequestInit
): Promise<T> {
  const response = await fetcher.fetch(new Request(target, init));
  if (!response.ok) {
    throw await containerRequestError(response, target.pathname);
  }
  return response.json<T>();
}

async function containerRequestError(
  response: Response,
  path: string
): Promise<RuntimeOperationError> {
  const text = await response.text();
  let payload: RuntimeErrorBody = {};
  try {
    payload = JSON.parse(text) as RuntimeErrorBody;
  } catch {
    payload = {};
  }
  const message =
    (typeof payload.error === 'string' && payload.error) ||
    (typeof payload.message === 'string' && payload.message) ||
    text ||
    `Container request failed with status ${response.status}`;
  const code =
    typeof payload.code === 'string'
      ? payload.code
      : 'container_request_failed';
  const stage =
    typeof payload.stage === 'string' ? payload.stage : 'container.request';
  const details =
    payload.details && typeof payload.details === 'object'
      ? (payload.details as Record<string, unknown>)
      : {};
  return new RuntimeOperationError(response.status, code, stage, message, {
    ...details,
    path,
  });
}

function runtimeErrorResponse(error: unknown, action: string): Response {
  const structured =
    error instanceof RuntimeOperationError
      ? error
      : new RuntimeOperationError(
          500,
          'runtime_internal_error',
          `runtime.${action}`,
          error instanceof Error ? error.message : String(error)
        );
  console.error(
    JSON.stringify({
      event: 'runtime.operation.failed',
      action,
      status: structured.status,
      code: structured.code,
      stage: structured.stage,
      message: structured.message,
      details: structured.details,
    })
  );
  return json(
    {
      ok: false,
      error: structured.message,
      code: structured.code,
      stage: structured.stage,
      details: structured.details,
    },
    { status: structured.status }
  );
}

async function seed(
  env: Env,
  origin: string,
  userId: string,
  sessionId: string
) {
  const target = new URL(origin);
  target.pathname = `/seed/${encodeURIComponent(sessionId)}`;
  return containerJson<Manifest>(container(env, userId), target, {
    method: 'POST',
  });
}

async function inspect(
  env: Env,
  origin: string,
  userId: string,
  sessionId: string
) {
  const target = new URL(origin);
  target.pathname = `/inspect/${encodeURIComponent(sessionId)}`;
  return containerJson<Manifest>(container(env, userId), target);
}

async function clear(
  env: Env,
  origin: string,
  userId: string,
  sessionId: string,
  agent: Agent,
  model: string
) {
  const target = new URL(origin);
  target.pathname = `/clear/${encodeURIComponent(sessionId)}`;
  withSessionParams(target, agent, model);
  return containerJson<Manifest>(container(env, userId), target, {
    method: 'POST',
  });
}

async function destroyContainer(env: Env, origin: string, userId: string) {
  const target = new URL(origin);
  target.pathname = '/__destroy';
  const response = await container(env, userId).fetch(
    new Request(target, { method: 'POST' })
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : `destroy failed: ${response.status}`
    );
  }
  return payload;
}

async function tmuxStatus(
  env: Env,
  origin: string,
  userId: string,
  sessionId: string,
  agent: Agent,
  model: string
) {
  const target = new URL(origin);
  target.pathname = `/tmux/${encodeURIComponent(sessionId)}`;
  withSessionParams(target, agent, model);
  return containerJson(container(env, userId), target);
}

async function archive(
  env: Env,
  origin: string,
  userId: string,
  sessionId: string,
  currentArchiveKey = '',
  targetArchiveKey = '',
  retainPrevious = true,
  maxBytes: number | null = null,
  retentionDays = 7,
  maxSnapshots = 2
) {
  if (
    targetArchiveKey &&
    !isVersionArchiveKey(userId, sessionId, targetArchiveKey)
  ) {
    throw new RuntimeOperationError(
      400,
      'invalid_target_archive_key',
      'archive.prepare',
      'Target archive key is outside the current session archive namespace'
    );
  }
  const target = new URL(origin);
  target.pathname = `/archive/${encodeURIComponent(sessionId)}`;
  if (maxBytes !== null) {
    target.searchParams.set('maxBytes', String(maxBytes));
  }
  const response = await container(env, userId).fetch(new Request(target));
  if (!response.ok) {
    throw await containerRequestError(response, target.pathname);
  }

  const workspaceDigest = response.headers.get('x-workspace-digest') || '';
  const archiveSha256 = response.headers.get('x-archive-sha256') || '';
  const fileCount = response.headers.get('x-file-count') || '0';
  const totalBytes = response.headers.get('x-workspace-total-bytes') || '0';
  const skippedFileCount = response.headers.get('x-skipped-file-count') || '0';
  const archiveFormat = response.headers.get('x-archive-format') || '2';
  const contentLength = Number(response.headers.get('content-length'));
  if (
    maxBytes !== null &&
    Number.isSafeInteger(contentLength) &&
    contentLength > maxBytes
  ) {
    await response.body?.cancel().catch(() => undefined);
    return json(
      {
        ok: false,
        error: 'Workspace archive exceeds the reserved storage capacity',
        code: 'archive_size_exceeded',
        stage: 'archive.quota',
        details: {
          maxBytes,
          actualBytes: contentLength,
          currentKey: currentArchiveKey || null,
        },
      },
      { status: 413 }
    );
  }
  const currentFileCount = Number.parseInt(fileCount, 10) || 0;
  let versionObjects: R2Object[];
  let resolved: {
    object: R2Object | null;
    requestedKeyMissing: boolean;
  };
  try {
    versionObjects = await listAllArchiveObjects(
      env.WORKSPACE_ARCHIVES,
      archiveVersionsPrefix(userId, sessionId)
    );
    resolved = await resolveCurrentArchiveObject(
      env.WORKSPACE_ARCHIVES,
      userId,
      sessionId,
      currentArchiveKey,
      versionObjects
    );
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const previous = resolved.object;
  const previousFileCount = metadataFileCount(previous?.customMetadata);

  if (previous && previousFileCount > 0 && currentFileCount === 0) {
    await response.body?.cancel().catch(() => undefined);
    return json(
      {
        ok: false,
        error: 'Empty workspace archive was blocked',
        code: 'empty_workspace_archive_blocked',
        stage: 'archive.guard',
        details: {
          currentKey: previous.key,
          previousFileCount,
          currentFileCount,
        },
        key: previous.key,
        currentKey: previous.key,
        previousFileCount,
        workspaceDigest,
        archiveSha256,
        fileCount: currentFileCount,
      },
      { status: 409 }
    );
  }

  const now = new Date();
  if (
    previous &&
    workspaceDigest &&
    previous.customMetadata?.workspaceDigest === workspaceDigest
  ) {
    await response.body?.cancel().catch(() => undefined);
    const cleanup = await cleanupSessionArchives(
      env.WORKSPACE_ARCHIVES,
      userId,
      sessionId,
      previous.key,
      versionObjects,
      {
        now,
        retainPrevious,
        previousObject: previous,
        retentionDays,
        maxSnapshots,
      }
    );
    return json({
      ok: true,
      key: previous.key,
      currentKey: previous.key,
      versionKey: previous.key,
      kind: 'current',
      previousKey: previous.key,
      bytes: previous.size,
      workspaceDigest,
      archiveSha256: previous.customMetadata?.archiveSha256 || archiveSha256,
      fileCount: currentFileCount,
      totalBytes: Number.parseInt(totalBytes, 10) || 0,
      skippedFileCount: Number.parseInt(skippedFileCount, 10) || 0,
      archiveFormat: previous.customMetadata?.archiveFormat || archiveFormat,
      deduplicated: true,
      retainPrevious,
      requestedKeyMissing: resolved.requestedKeyMissing,
      deleted: cleanup.deleted,
      deletedKeys: cleanup.deleted.map((item) => item.key),
      cleanupFailed: cleanup.failed,
    });
  }

  if (!response.body) {
    throw new RuntimeOperationError(
      502,
      'archive_body_missing',
      'archive.upload',
      'Container returned an empty archive response'
    );
  }
  const versionKey =
    targetArchiveKey || archiveVersionKey(userId, sessionId, now);
  if (versionObjects.some((object) => object.key === versionKey)) {
    await response.body.cancel().catch(() => undefined);
    throw new RuntimeOperationError(
      409,
      'target_archive_key_exists',
      'archive.prepare',
      'Target archive key already exists'
    );
  }
  const metadata = {
    userId,
    sessionId,
    workspaceDigest,
    archiveSha256,
    fileCount,
    totalBytes,
    skippedFileCount,
    archiveFormat,
    archivedAt: now.toISOString(),
    versionKey,
  };

  const stored = await env.WORKSPACE_ARCHIVES.put(versionKey, response.body, {
    httpMetadata: { contentType: 'application/gzip' },
    customMetadata: metadata,
  });
  if (maxBytes !== null && stored.size > maxBytes) {
    await env.WORKSPACE_ARCHIVES.delete(versionKey);
    return json(
      {
        ok: false,
        error: 'Workspace archive exceeds the reserved storage capacity',
        code: 'archive_size_exceeded',
        stage: 'archive.quota',
        details: {
          maxBytes,
          actualBytes: stored.size,
          currentKey: previous?.key || null,
        },
      },
      { status: 413 }
    );
  }
  const cleanup = await cleanupSessionArchives(
    env.WORKSPACE_ARCHIVES,
    userId,
    sessionId,
    versionKey,
    [...versionObjects, stored],
    {
      now,
      retainPrevious,
      previousObject: previous,
      retentionDays,
      maxSnapshots,
    }
  );

  return json({
    ok: true,
    key: versionKey,
    currentKey: versionKey,
    versionKey,
    kind: 'current',
    previousKey: previous?.key || null,
    bytes: stored.size,
    workspaceDigest,
    archiveSha256,
    fileCount: currentFileCount,
    totalBytes: Number.parseInt(totalBytes, 10) || 0,
    skippedFileCount: Number.parseInt(skippedFileCount, 10) || 0,
    archiveFormat,
    deduplicated: false,
    retainPrevious,
    requestedKeyMissing: resolved.requestedKeyMissing,
    deleted: cleanup.deleted,
    deletedKeys: cleanup.deleted.map((item) => item.key),
    cleanupFailed: cleanup.failed,
  });
}

async function restore(
  env: Env,
  origin: string,
  userId: string,
  sessionId: string,
  requestedKey = ''
) {
  const resolved = await resolveCurrentArchiveObject(
    env.WORKSPACE_ARCHIVES,
    userId,
    sessionId,
    requestedKey
  );
  if (requestedKey && resolved.requestedKeyMissing) {
    throw new RuntimeOperationError(
      404,
      'archive_not_found',
      'restore.resolve',
      'The requested workspace archive no longer exists',
      { requestedKey }
    );
  }
  const key = resolved.object?.key || '';
  const object = key ? await env.WORKSPACE_ARCHIVES.get(key) : null;
  if (!object) {
    return json(
      {
        ok: false,
        error: 'Workspace archive was not found',
        code: 'archive_not_found',
        stage: 'restore.load',
        details: {
          requestedKey: requestedKey || null,
          legacyKey: legacyArchiveKey(userId, sessionId),
        },
        key: requestedKey || legacyArchiveKey(userId, sessionId),
      },
      { status: 404 }
    );
  }

  const target = new URL(origin);
  target.pathname = `/restore/${encodeURIComponent(sessionId)}`;
  const archiveFormat = object.customMetadata?.archiveFormat || '1';
  const restoreHeaders = new Headers({
    'content-type': 'application/gzip',
    'content-length': String(object.size),
    'x-archive-format': archiveFormat,
  });
  const expectedArchiveSha256 = object.customMetadata?.archiveSha256 || '';
  if (expectedArchiveSha256) {
    restoreHeaders.set('x-expected-archive-sha256', expectedArchiveSha256);
  }
  if (archiveFormat === '2' && object.customMetadata?.workspaceDigest) {
    restoreHeaders.set(
      'x-expected-workspace-digest',
      object.customMetadata.workspaceDigest
    );
  }
  const result = await containerJson<Manifest>(container(env, userId), target, {
    method: 'PUT',
    body: object.body,
    headers: restoreHeaders,
  });

  return json({
    ok: true,
    key,
    objectSize: object.size,
    objectMetadata: object.customMetadata,
    archiveFormat,
    legacyArchive: archiveFormat !== '2',
    requestedKey: requestedKey || null,
    requestedKeyMissing: resolved.requestedKeyMissing,
    fallbackUsed: resolved.requestedKeyMissing,
    restored: result,
  });
}

async function listManagedArchives(
  env: Env,
  userId: string,
  sessionId: string,
  url: URL
) {
  const prefix = sessionId
    ? sessionArchivePrefix(userId, sessionId)
    : userArchivePrefix(userId);
  const page = await listArchiveObjectPage(env.WORKSPACE_ARCHIVES, prefix, {
    cursor: url.searchParams.get('cursor') || undefined,
    limit: archiveListLimit(url),
  });
  return json({
    ok: true,
    prefix,
    objects: page.objects.map(archiveObjectJson),
    truncated: page.truncated,
    ...(page.cursor ? { cursor: page.cursor } : {}),
  });
}

async function archiveStorageStats(env: Env, url: URL) {
  const page = await listArchiveObjectPage(
    env.WORKSPACE_ARCHIVES,
    integratedWorkspacesPrefix,
    {
      cursor: url.searchParams.get('cursor') || undefined,
      limit: archiveListLimit(url),
    }
  );
  return json({
    ok: true,
    prefix: integratedWorkspacesPrefix,
    objects: page.objects.length,
    bytes: page.objects.reduce((total, object) => total + object.size, 0),
    truncated: page.truncated,
    ...(page.cursor ? { cursor: page.cursor } : {}),
  });
}

async function deleteManagedArchives(
  request: Request,
  env: Env,
  userId: string,
  sessionId: string
) {
  let body: {
    keys?: unknown;
    scope?: unknown;
    keepKey?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(
      { ok: false, error: 'invalid_json', code: 'invalid_json' },
      { status: 400 }
    );
  }

  const rawKeys = body.keys;
  const keys = Array.isArray(rawKeys)
    ? rawKeys.filter((key): key is string => typeof key === 'string')
    : [];
  const hasKeysField = rawKeys !== undefined;
  const hasKeys = Array.isArray(rawKeys);
  const hasScopeField = body.scope !== undefined;
  const hasKeepKey = body.keepKey !== undefined;
  const scope =
    body.scope === 'snapshots' || body.scope === 'all' ? body.scope : '';
  if (
    (hasKeysField && !hasKeys) ||
    (Array.isArray(rawKeys) && keys.length !== rawKeys.length) ||
    (hasKeys && keys.length === 0) ||
    (hasKeys && keys.length > archiveDeleteKeyLimit) ||
    (hasKeys && hasScopeField) ||
    (hasKeys && hasKeepKey) ||
    (hasScopeField && !scope) ||
    (scope === 'all' && hasKeepKey) ||
    (hasKeepKey && typeof body.keepKey !== 'string') ||
    (!hasKeys && !scope)
  ) {
    return json(
      {
        ok: false,
        error: 'Provide either valid keys or a supported scope',
        code: 'invalid_archive_delete_request',
        details: { maxKeys: archiveDeleteKeyLimit },
      },
      { status: 400 }
    );
  }

  for (const key of keys) {
    if (!isSessionArchiveKey(userId, sessionId, key)) {
      return json(
        {
          ok: false,
          error: 'Archive key is outside the requested session prefix',
          code: 'invalid_archive_key',
          details: { key },
        },
        { status: 400 }
      );
    }
  }

  let keptKey: string | null = null;
  let notFound: string[] = [];
  let candidates: Array<{
    object: ArchiveObjectLike;
    reason?: ArchiveDeletedObject['reason'];
  }> = [];

  if (hasKeys) {
    const resolved = await Promise.all(
      keys.map(async (key) => ({
        key,
        object: await env.WORKSPACE_ARCHIVES.head(key),
      }))
    );
    notFound = resolved.filter((item) => !item.object).map((item) => item.key);
    candidates = resolved
      .filter(
        (item): item is { key: string; object: R2Object } =>
          item.object !== null
      )
      .map((item) => ({
        object: archiveObjectSummary(item.object),
        reason: 'explicit',
      }));
  } else if (scope === 'all') {
    const objects = await listAllArchiveObjects(
      env.WORKSPACE_ARCHIVES,
      sessionArchivePrefix(userId, sessionId)
    );
    candidates = objects.map((object) => ({
      object: archiveObjectSummary(object),
      reason: 'all',
    }));
  } else {
    const requestedKeepKey =
      typeof body.keepKey === 'string' ? body.keepKey.trim() : '';
    if (
      requestedKeepKey &&
      !isSessionArchiveKey(userId, sessionId, requestedKeepKey)
    ) {
      return json(
        {
          ok: false,
          error: 'Keep key is outside the requested session prefix',
          code: 'invalid_archive_key',
          details: { key: requestedKeepKey },
        },
        { status: 400 }
      );
    }
    const versions = await listAllArchiveObjects(
      env.WORKSPACE_ARCHIVES,
      archiveVersionsPrefix(userId, sessionId)
    );
    const resolved = await resolveCurrentArchiveObject(
      env.WORKSPACE_ARCHIVES,
      userId,
      sessionId,
      requestedKeepKey,
      versions
    );
    keptKey = resolved.object?.key || null;
    const temporary = await listAllArchiveObjects(
      env.WORKSPACE_ARCHIVES,
      archiveTemporaryPrefix(userId, sessionId)
    );
    const legacy = await env.WORKSPACE_ARCHIVES.head(
      legacyArchiveKey(userId, sessionId)
    );
    candidates = [...versions, ...temporary, ...(legacy ? [legacy] : [])]
      .filter((object) => object.key !== keptKey)
      .map((object) => ({
        object: archiveObjectSummary(object),
        reason: 'snapshot',
      }));
  }

  const result = await deleteArchiveObjects(env.WORKSPACE_ARCHIVES, candidates);
  return json({
    ok: result.failed.length === 0,
    scope: scope || 'keys',
    keptKey,
    deleted: result.deleted,
    deletedKeys: result.deleted.map((item) => item.key),
    deletedBytes: result.deleted.reduce((total, item) => total + item.bytes, 0),
    notFound,
    failed: result.failed,
  });
}

function corsResponseHeaders(headers: HeadersInit = {}): Headers {
  const result = new Headers(headers);
  result.set('access-control-allow-origin', '*');
  result.set('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  result.set(
    'access-control-allow-headers',
    'authorization,content-type,x-api-key,anthropic-version,anthropic-beta,openai-organization,openai-project,x-hicode-runtime-secret,x-hicode-archive-key'
  );
  return result;
}

function gatewayError(status: number, message: string, code: string): Response {
  return json(
    {
      type: 'error',
      error: {
        type: code,
        message,
      },
    },
    { status }
  );
}

function apiKeyForGateway(env: Env, gatewayPath: string): string {
  const openAiPath =
    gatewayPath === '/v1/responses' ||
    gatewayPath === '/v1/chat/completions' ||
    /^\/v1\/responses\/[^/]+$/.test(gatewayPath);
  if (openAiPath) return env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || '';
  return env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY || '';
}

function upstreamHeaders(
  request: Request,
  env: Env,
  gatewayPath: string
): Headers {
  const headers = new Headers();
  const apiKey = apiKeyForGateway(env, gatewayPath);
  headers.set('x-api-key', apiKey);
  headers.set('authorization', `Bearer ${apiKey}`);
  if (gatewayPath.startsWith('/v1/messages')) {
    headers.set(
      'anthropic-version',
      request.headers.get('anthropic-version') || defaultAnthropicVersion
    );
  }
  headers.set('user-agent', 'codeagent-spike-integrated-session-mvp/8b');

  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);

  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  const beta = request.headers.get('anthropic-beta');
  if (beta) headers.set('anthropic-beta', beta);

  const organization = request.headers.get('openai-organization');
  if (organization) headers.set('openai-organization', organization);

  const project = request.headers.get('openai-project');
  if (project) headers.set('openai-project', project);

  return headers;
}

function copyUpstreamHeaders(headers: Headers): Headers {
  const result = new Headers();
  for (const name of [
    'content-type',
    'cache-control',
    'anthropic-ratelimit-requests-limit',
    'anthropic-ratelimit-requests-remaining',
    'anthropic-ratelimit-tokens-limit',
    'anthropic-ratelimit-tokens-remaining',
    'x-oneapi-request-id',
    'request-id',
    'retry-after',
  ]) {
    const value = headers.get(name);
    if (value) result.set(name, value);
  }
  return corsResponseHeaders(result);
}

function isAllowedGatewayPath(pathname: string, method: string): boolean {
  if (pathname === '/v1/messages') return method === 'POST';
  if (pathname === '/v1/messages/count_tokens') return method === 'POST';
  if (pathname === '/v1/responses') return method === 'POST';
  if (/^\/v1\/responses\/[^/]+$/.test(pathname)) return method === 'GET';
  if (pathname === '/v1/chat/completions') return method === 'POST';
  if (pathname === '/v1/models') return method === 'GET';
  if (/^\/v1\/models\/[^/]+$/.test(pathname)) return method === 'GET';
  return false;
}

function gatewayContext(url: URL): { gatewayPath: string; sessionId: string } {
  let gatewayPath = url.pathname.slice(gatewayBasePath.length) || '/';
  let sessionId = '';
  const sessionMatch = gatewayPath.match(/^\/session\/([^/]+)(\/.*)$/);
  if (sessionMatch) {
    sessionId = decodeURIComponent(sessionMatch[1]);
    gatewayPath = sessionMatch[2] || '/';
  }
  return { gatewayPath, sessionId };
}

function estimateInputTokens(body: ArrayBuffer): number {
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as {
      messages?: unknown;
      system?: unknown;
    };
    const text = JSON.stringify({
      system: payload.system || '',
      messages: payload.messages || [],
    });
    return Math.max(1, Math.ceil(text.length / 4));
  } catch {
    return Math.max(1, Math.ceil(body.byteLength / 4));
  }
}

function numberValue(value: unknown): number {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(typeof value === 'string' ? value : '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function maxOutputTokens(body: ArrayBuffer): number {
  try {
    const payload = JSON.parse(new TextDecoder().decode(body)) as Record<
      string,
      unknown
    >;
    return numberValue(
      payload.max_tokens ??
        payload.max_output_tokens ??
        payload.max_completion_tokens
    );
  } catch {
    return 0;
  }
}

async function authorizeModelRequest(
  env: Env,
  sessionId: string,
  body: ArrayBuffer,
  authorizationKey: string
): Promise<ModelAuthorizationResult> {
  if (!env.APP_BASE_URL || !env.BILLING_USAGE_WEBHOOK_SECRET) {
    throw new Error('Billing authorization is not configured');
  }

  const target = new URL(env.APP_BASE_URL);
  target.pathname = `/api/code/sessions/${encodeURIComponent(sessionId)}/usage`;
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hicode-billing-secret': env.BILLING_USAGE_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      eventType: 'model_authorize',
      authorizationKey,
      requestedModel: modelFromRequestBody(body),
      estimatedInputTokens: estimateInputTokens(body),
      maxOutputTokens: maxOutputTokens(body),
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    code?: number;
    message?: string;
    data?: Record<string, unknown>;
  } | null;

  if (!response.ok || !payload) {
    throw new Error(
      `Billing authorization unavailable (${response.status || 503})`
    );
  }
  if (payload.code !== 0) {
    return {
      authorized: false,
      reason:
        typeof payload.data?.reason === 'string'
          ? payload.data.reason
          : 'billing_denied',
      message: payload.message || 'Billing authorization denied',
      balance: numberValue(payload.data?.balance),
      requiredBalance: numberValue(payload.data?.requiredBalance),
    };
  }

  return {
    authorized: payload.data?.authorized !== false,
    balance: numberValue(payload.data?.balance),
    requiredBalance: numberValue(payload.data?.requiredBalance),
  };
}

async function handleModelGateway(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  const { gatewayPath, sessionId } = gatewayContext(url);

  if (url.pathname === `${gatewayBasePath}/_health`) {
    return json({
      ok: true,
      runtime: 'real-model-gateway',
      configured: Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY),
      upstreamBaseUrl: env.ANTHROPIC_API_BASE_URL || defaultAnthropicBaseUrl,
      supported: [
        'POST /v1/messages',
        'POST /v1/messages/count_tokens',
        'POST /v1/responses',
        'GET /v1/responses/:response',
        'POST /v1/chat/completions',
        'GET /v1/models',
        'GET /v1/models/:model',
      ],
    });
  }

  if (!sessionId) {
    return gatewayError(
      401,
      'A session-bound model gateway URL is required',
      'codeagent_gateway_session_required'
    );
  }

  try {
    if (!(await modelGatewayAuthorized(request, env, sessionId))) {
      return gatewayError(
        401,
        'Invalid model gateway session credential',
        'codeagent_gateway_unauthorized'
      );
    }
  } catch (error) {
    if (error instanceof RuntimeOperationError) {
      return gatewayError(error.status, error.message, error.code);
    }
    return gatewayError(
      503,
      'Model gateway session authentication is unavailable',
      'codeagent_gateway_unavailable'
    );
  }

  if (!apiKeyForGateway(env, gatewayPath)) {
    return gatewayError(
      503,
      'Missing Worker model API key. Add OPENAI_API_KEY or ANTHROPIC_API_KEY with wrangler secret put.',
      'codeagent_missing_model_api_key'
    );
  }

  if (!isAllowedGatewayPath(gatewayPath, request.method)) {
    return gatewayError(
      404,
      `Unsupported model gateway route: ${request.method} ${gatewayPath}`,
      'codeagent_unsupported_gateway_route'
    );
  }

  const upstream = new URL(
    env.ANTHROPIC_API_BASE_URL || defaultAnthropicBaseUrl
  );
  upstream.pathname = gatewayPath;
  upstream.search = url.search;
  const requestBody =
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.arrayBuffer();

  const usageReportId =
    sessionId && shouldReportUsage(gatewayPath) ? crypto.randomUUID() : '';
  const usageIdempotencyKey = usageReportId
    ? `model:${sessionId}:${usageReportId}`
    : '';
  if (usageIdempotencyKey && requestBody) {
    let authorization: ModelAuthorizationResult;
    try {
      authorization = await authorizeModelRequest(
        env,
        sessionId,
        requestBody,
        usageIdempotencyKey
      );
    } catch (error) {
      return gatewayError(
        503,
        error instanceof Error
          ? error.message
          : 'Billing authorization unavailable',
        'hicode_billing_unavailable'
      );
    }
    if (!authorization.authorized) {
      const status =
        authorization.reason === 'insufficient_credits'
          ? 402
          : authorization.reason === 'session_not_active' ||
              authorization.reason === 'model_mismatch'
            ? 409
            : 503;
      return gatewayError(
        status,
        authorization.message || 'Billing authorization denied',
        `hicode_${authorization.reason || 'billing_denied'}`
      );
    }
  }

  const response = await fetch(upstream, {
    method: request.method,
    headers: upstreamHeaders(request, env, gatewayPath),
    body: requestBody,
    redirect: 'manual',
  });

  if (
    gatewayPath === '/v1/messages/count_tokens' &&
    (response.status === 404 || response.status === 405)
  ) {
    return json(
      { input_tokens: estimateInputTokens(requestBody || new ArrayBuffer(0)) },
      { headers: { 'x-codeagent-token-count-fallback': 'estimated' } }
    );
  }

  const responseInit = {
    status: response.status,
    statusText: response.statusText,
    headers: copyUpstreamHeaders(response.headers),
  };

  const requestId = upstreamRequestId(response.headers);
  if (
    sessionId &&
    shouldReportUsage(gatewayPath) &&
    (response.ok || Boolean(requestId))
  ) {
    const [clientBody, billingBody] = response.body
      ? response.body.tee()
      : [null, null];
    ctx.waitUntil(
      reportUsageFromResponse(billingBody, env, sessionId, {
        idempotencyKey: usageIdempotencyKey,
        provider: upstream.hostname,
        endpoint: gatewayPath,
        upstreamStatus: response.status,
        requestId,
        model: modelFromRequestBody(requestBody),
        observedAtUnix: Math.floor(Date.now() / 1000),
      })
    );
    return new Response(clientBody, responseInit);
  }

  return new Response(response.body, responseInit);
}

function shouldReportUsage(gatewayPath: string): boolean {
  return (
    gatewayPath === '/v1/messages' ||
    gatewayPath === '/v1/responses' ||
    gatewayPath === '/v1/chat/completions'
  );
}

async function reportUsageFromResponse(
  body: ReadableStream | null,
  env: Env,
  sessionId: string,
  report: UsageReportContext
) {
  const text = await new Response(body).text().catch(() => '');
  const usage = extractTokenUsage(text);

  const payload: UsageReportPayload = {
    eventType: 'model_tokens',
    idempotencyKey: report.idempotencyKey,
    provider: report.provider,
    endpoint: report.endpoint,
    upstreamStatus: report.upstreamStatus,
    requestId: report.requestId,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    rawUsage: {
      aggregate: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        cachedInputTokens: usage.cachedInputTokens,
      },
      records: usage.rawUsage.slice(-10),
    },
    metadata: {
      idempotencyKey: report.idempotencyKey,
      provider: report.provider,
      endpoint: report.endpoint,
      upstreamStatus: report.upstreamStatus,
      requestId: report.requestId,
      model: report.model,
      observedAtUnix: report.observedAtUnix,
    },
  };
  let resolved: UsageReportPayload | null = null;
  let resolutionError = 'Provider usage log is not available yet';
  try {
    resolved = await resolveProviderUsageReport(env, payload, {
      attempts: 4,
    });
  } catch (error) {
    resolutionError = error instanceof Error ? error.message : String(error);
  }
  if (!resolved) {
    await queueUsageReport(env, sessionId, payload, {
      lastError: resolutionError,
    });
    console.info('[billing-usage-queued]', {
      sessionId,
      requestId: payload.requestId,
      endpoint: payload.endpoint,
    });
    return;
  }
  await deliverOrQueueUsageReport(env, sessionId, resolved);
}

function modelFromRequestBody(body: ArrayBuffer | undefined) {
  if (!body?.byteLength) return '';
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as {
      model?: unknown;
    };
    return typeof parsed.model === 'string'
      ? parsed.model.trim().slice(0, 160)
      : '';
  } catch {
    return '';
  }
}

function upstreamRequestId(headers: Headers): string {
  return (
    headers.get('x-oneapi-request-id') ||
    headers.get('request-id') ||
    headers.get('x-request-id') ||
    headers.get('anthropic-request-id') ||
    headers.get('openai-request-id') ||
    headers.get('cf-ray') ||
    ''
  ).slice(0, 255);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'access-control-allow-headers':
            'authorization,content-type,x-api-key,anthropic-version,anthropic-beta,openai-organization,openai-project,x-hicode-runtime-secret,x-hicode-archive-key',
        },
      });
    }

    if (url.pathname === '/') {
      return page(
        url.origin,
        url.searchParams.get('user') || 'demo-user',
        url.searchParams.get('session') || 'demo-session'
      );
    }

    const appMatch = url.pathname.match(/^\/app\/([^/]+)\/([^/]+)$/);
    if (appMatch) {
      return page(
        url.origin,
        decodeURIComponent(appMatch[1]),
        decodeURIComponent(appMatch[2])
      );
    }

    if (
      url.pathname === gatewayBasePath ||
      url.pathname.startsWith(`${gatewayBasePath}/`)
    ) {
      return handleModelGateway(request, env, url, ctx);
    }

    if (url.pathname === '/archive-stats') {
      if (!runtimeSecretAuthorized(request, env)) {
        return json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      if (request.method !== 'GET') {
        return json(
          { ok: false, error: 'method_not_allowed' },
          { status: 405 }
        );
      }
      try {
        return await archiveStorageStats(env, url);
      } catch (error) {
        return runtimeErrorResponse(error, 'archive-stats');
      }
    }

    const archiveManagementMatch = url.pathname.match(
      /^\/archive-(list|delete)\/([^/]+)(?:\/([^/]+))?$/
    );
    if (archiveManagementMatch) {
      if (!runtimeSecretAuthorized(request, env)) {
        return json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      const operation = archiveManagementMatch[1];
      try {
        const userId = decodeURIComponent(archiveManagementMatch[2]);
        const sessionId = archiveManagementMatch[3]
          ? decodeURIComponent(archiveManagementMatch[3])
          : '';
        if (operation === 'list') {
          if (request.method !== 'GET') {
            return json(
              { ok: false, error: 'method_not_allowed' },
              { status: 405 }
            );
          }
          return await listManagedArchives(env, userId, sessionId, url);
        }
        if (request.method !== 'POST') {
          return json(
            { ok: false, error: 'method_not_allowed' },
            { status: 405 }
          );
        }
        if (!sessionId) {
          return json({ ok: false, error: 'missing_session' }, { status: 400 });
        }
        return await deleteManagedArchives(request, env, userId, sessionId);
      } catch (error) {
        return runtimeErrorResponse(error, `archive-${operation}`);
      }
    }

    const actionMatch = url.pathname.match(
      /^\/(seed|inspect|archive|restore|clear|destroy|tmux|container-health)\/([^/]+)(?:\/([^/]+))?$/
    );
    if (actionMatch) {
      const action = actionMatch[1];
      const userId = decodeURIComponent(actionMatch[2]);
      const sessionId = actionMatch[3]
        ? decodeURIComponent(actionMatch[3])
        : '';
      const agent = agentFromUrl(url);
      const model = modelFromUrl(url);
      try {
        if (action === 'container-health') {
          if (!runtimeSecretAuthorized(request, env)) {
            return json({ ok: false, error: 'unauthorized' }, { status: 401 });
          }
          if (request.method !== 'GET') {
            return json(
              { ok: false, error: 'method_not_allowed' },
              { status: 405 }
            );
          }
          const target = new URL(url.origin);
          target.pathname = '/health';
          return container(env, userId).fetch(
            new Request(target, {
              method: request.method,
              headers: containerHeaders(request, agent, model),
            })
          );
        }
        if (!sessionId) {
          return json({ ok: false, error: 'missing_session' }, { status: 400 });
        }
        const mutatingAction =
          action === 'seed' ||
          action === 'archive' ||
          action === 'restore' ||
          action === 'clear' ||
          action === 'destroy';
        const readAction = action === 'inspect' || action === 'tmux';
        const protectedAction = mutatingAction || readAction;
        if (protectedAction && !runtimeSecretAuthorized(request, env)) {
          return json({ ok: false, error: 'unauthorized' }, { status: 401 });
        }
        if (
          (mutatingAction && request.method !== 'POST') ||
          (readAction && request.method !== 'GET')
        ) {
          return json(
            { ok: false, error: 'method_not_allowed' },
            { status: 405 }
          );
        }
        if (action === 'seed')
          return json(await seed(env, url.origin, userId, sessionId));
        if (action === 'inspect')
          return json(await inspect(env, url.origin, userId, sessionId));
        if (action === 'clear') {
          let cleared: Manifest | null = null;
          let clearError = '';
          try {
            cleared = await clear(
              env,
              url.origin,
              userId,
              sessionId,
              agent,
              model
            );
          } catch (error) {
            clearError = error instanceof Error ? error.message : String(error);
          }
          const destroyed = await destroyContainer(env, url.origin, userId);
          return json({ ok: true, cleared, clearError, destroyed });
        }
        if (action === 'destroy')
          return json({
            ok: true,
            destroyed: await destroyContainer(env, url.origin, userId),
          });
        if (action === 'tmux')
          return json(
            await tmuxStatus(env, url.origin, userId, sessionId, agent, model)
          );
        if (action === 'archive') {
          const maxBytes = archiveMaxBytes(url, env);
          if (maxBytes === null) {
            throw new RuntimeOperationError(
              400,
              'archive_max_bytes_required',
              'archive.quota',
              'maxBytes is required for workspace archives'
            );
          }
          return await archive(
            env,
            url.origin,
            userId,
            sessionId,
            requestedArchiveKey(request, url),
            requestedTargetArchiveKey(request),
            url.searchParams.get('retainPrevious') !== '0',
            maxBytes,
            archiveRetentionDays(url),
            archiveMaxSnapshots(url)
          );
        }
        if (action === 'restore')
          return await restore(
            env,
            url.origin,
            userId,
            sessionId,
            requestedArchiveKey(request, url)
          );
      } catch (error) {
        return runtimeErrorResponse(error, action);
      }
    }

    const filesMatch = url.pathname.match(
      /^\/files\/([^/]+)\/([^/]+)(?:\/(status|content))?$/
    );
    if (filesMatch) {
      if (!runtimeSecretAuthorized(request, env)) {
        return json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      if (request.method !== 'GET') {
        return json(
          { ok: false, error: 'method_not_allowed' },
          { status: 405 }
        );
      }

      const userId = decodeURIComponent(filesMatch[1]);
      const sessionId = decodeURIComponent(filesMatch[2]);
      const operation = filesMatch[3] || '';
      const target = new URL(request.url);
      target.pathname = `/files/${encodeURIComponent(sessionId)}${operation ? `/${operation}` : ''}`;
      const headers = new Headers();
      headers.set('x-codeagent-user', userId);
      headers.set('x-codeagent-session', sessionId);
      return container(env, userId).fetch(
        new Request(target, {
          method: 'GET',
          headers,
        })
      );
    }

    const terminalMatch = url.pathname.match(/^\/terminal\/([^/]+)\/([^/]+)$/);
    if (terminalMatch) {
      if (!runtimeSecretAuthorized(request, env)) {
        return json({ ok: false, error: 'unauthorized' }, { status: 401 });
      }
      const userId = decodeURIComponent(terminalMatch[1]);
      const sessionId = decodeURIComponent(terminalMatch[2]);
      const agent = agentFromUrl(url);
      const model = modelFromUrl(url);
      const target = new URL(request.url);
      target.pathname = `/terminal/${encodeURIComponent(sessionId)}`;
      target.searchParams.set(
        'base_url',
        `${url.origin}${gatewayBasePath}/session/${encodeURIComponent(sessionId)}`
      );
      withSessionParams(target, agent, model);
      let gatewayToken: string;
      try {
        gatewayToken = await modelGatewaySessionToken(env, sessionId);
      } catch (error) {
        return runtimeErrorResponse(error, 'terminal');
      }
      return container(env, userId).fetch(
        new Request(target, {
          method: request.method,
          headers: containerHeaders(request, agent, model, gatewayToken),
          body: request.body,
        })
      );
    }

    const previewMatch = url.pathname.match(
      /^\/preview\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/
    );
    if (previewMatch) {
      const userId = decodeURIComponent(previewMatch[1]);
      const sessionId = decodeURIComponent(previewMatch[2]);
      const token = previewMatch[3];
      const rest = previewMatch[4] || '';
      if (
        request.method !== 'GET' ||
        !(await previewTokenAuthorized(env, userId, sessionId, token))
      ) {
        return json({ ok: false, error: 'not_found' }, { status: 404 });
      }
      const prefix = `/preview/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(token)}/`;
      if (!url.pathname.endsWith('/') && rest === '') {
        return Response.redirect(`${url.origin}${prefix}${url.search}`, 302);
      }
      const target = new URL(request.url);
      target.pathname = `/preview/${encodeURIComponent(sessionId)}/${rest}`;
      const headers = new Headers();
      headers.set('x-codeagent-user', userId);
      headers.set('x-codeagent-session', sessionId);
      const response = await container(env, userId).fetch(
        new Request(target, {
          method: 'GET',
          headers,
          redirect: request.redirect,
        })
      );
      const responseHeaders = new Headers(response.headers);
      responseHeaders.set('cache-control', 'private, no-store');
      responseHeaders.set('referrer-policy', 'no-referrer');
      responseHeaders.set('x-content-type-options', 'nosniff');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    return json(
      { ok: false, error: 'not_found', path: url.pathname },
      { status: 404 }
    );
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ) {
    ctx.waitUntil(
      flushPendingUsageReports(env, {
        preparePayload: async (payload) => {
          const resolved = await resolveProviderUsageReport(env, payload);
          if (!resolved) {
            throw new Error(
              `Provider usage log is not available yet: ${payload.requestId || 'missing request id'}`
            );
          }
          return resolved;
        },
      })
        .then((result) => {
          if (result.scanned > 0) {
            console.info('[billing-usage-outbox]', result);
          }
        })
        .catch((error) => {
          console.error('[billing-usage-outbox] flush failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        })
    );
    ctx.waitUntil(
      runStorageGcSchedule(env)
        .then((result) => {
          if (result.status !== 'deferred') {
            console.info('[storage-gc]', result);
          }
        })
        .catch((error) => {
          console.error('[storage-gc] schedule failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        })
    );
  },
};
