import { createHmac } from 'node:crypto';

const baseUrl = (
  process.argv[2] ||
  'https://codeagent-spike-integrated-session-mvp.eric-wuyu1352.workers.dev'
).replace(/\/$/, '');
const userId = 'demo-user';
const sessionId = `integrated-${Date.now()}`;
const runtimeSecret = (
  process.env.BILLING_USAGE_WEBHOOK_SECRET ||
  process.env.RUNTIME_SECRET ||
  ''
).trim();
if (!runtimeSecret) {
  throw new Error(
    'BILLING_USAGE_WEBHOOK_SECRET (or RUNTIME_SECRET) is required'
  );
}

function authorizedHeaders(headers = {}) {
  return {
    ...headers,
    'x-hicode-runtime-secret': runtimeSecret,
  };
}

function signedPreviewPrefix() {
  const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
  const message = `preview:v1\0${userId}\0${sessionId}\0${expiresAt}`;
  const signature = createHmac('sha256', runtimeSecret)
    .update(message)
    .digest('base64url');
  const token = `${expiresAt}.${signature}`;
  return `/preview/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(token)}/`;
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: authorizedHeaders(options.headers),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(text);
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(JSON.stringify(payload, null, 2));
  }
  return payload;
}

async function requestText(path) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: authorizedHeaders(),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${response.status} ${text}`);
  }
  return text;
}

async function requestError(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: authorizedHeaders(options.headers),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `expected JSON failure response: status=${response.status} body=${text.slice(0, 500)}`
    );
  }
  if (response.ok || payload.ok !== false) {
    throw new Error(`expected request failure: ${JSON.stringify(payload)}`);
  }
  return { status: response.status, payload };
}

async function requestRejectedJson(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: authorizedHeaders(options.headers),
    signal: AbortSignal.timeout(120000),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `expected JSON rejection: status=${response.status} body=${text.slice(0, 500)}`
    );
  }
  if (response.ok) {
    throw new Error(`expected request rejection: ${JSON.stringify(payload)}`);
  }
  return { status: response.status, payload };
}

const health = await requestJson(`/container-health/${userId}`);
if (!health.git || !health.tmux || !health.claude)
  throw new Error(JSON.stringify(health));

const appHtml = await requestText(`/app/${userId}/${sessionId}`);
if (!appHtml.includes('CodeAgent Spike 7')) throw new Error(appHtml);
if (!appHtml.includes('xterm@5.3.0')) throw new Error(appHtml);
if (!appHtml.includes('var terminalPath = "/terminal/"'))
  throw new Error(appHtml);
if (!appHtml.includes(`var userId = "${userId}"`)) throw new Error(appHtml);
if (!appHtml.includes(`var sessionId = "${sessionId}"`))
  throw new Error(appHtml);

const seeded = await requestJson(`/seed/${userId}/${sessionId}`, {
  method: 'POST',
});
const unsignedPreview = await requestError(`/preview/${userId}/${sessionId}/`);
if (unsignedPreview.status !== 404) {
  throw new Error(JSON.stringify(unsignedPreview, null, 2));
}

const previewPrefix = signedPreviewPrefix();
const previewHtml = await requestText(previewPrefix);
if (!previewHtml.includes('Integrated Preview')) throw new Error(previewHtml);

const previewStyles = await requestText(`${previewPrefix}assets/style.css`);
if (!previewStyles.includes('font-family: system-ui')) {
  throw new Error(previewStyles);
}

const previewApi = await requestJson(`${previewPrefix}api/session`);
if (previewApi.userId !== userId || previewApi.sessionId !== sessionId) {
  throw new Error(JSON.stringify(previewApi, null, 2));
}

const gatewayWithoutSession = await requestRejectedJson('/api/model/v1/models');
if (
  gatewayWithoutSession.status !== 401 ||
  gatewayWithoutSession.payload.error?.type !==
    'codeagent_gateway_session_required'
) {
  throw new Error(JSON.stringify(gatewayWithoutSession, null, 2));
}

const gatewayWithoutToken = await requestRejectedJson(
  `/api/model/session/${encodeURIComponent(sessionId)}/v1/models`
);
if (
  gatewayWithoutToken.status !== 401 ||
  gatewayWithoutToken.payload.error?.type !== 'codeagent_gateway_unauthorized'
) {
  throw new Error(JSON.stringify(gatewayWithoutToken, null, 2));
}

const targetArchiveKey = `integrated-workspaces/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}/archives/smoke-${encodeURIComponent(sessionId)}.tar.gz`;
const archived = await requestJson(
  `/archive/${userId}/${sessionId}?maxBytes=${2 * 1024 ** 3}`,
  {
    method: 'POST',
    headers: { 'x-hicode-target-archive-key': targetArchiveKey },
  }
);
if (archived.archiveFormat !== '2') {
  throw new Error(`unexpected archive format: ${JSON.stringify(archived)}`);
}
if (archived.key !== targetArchiveKey) {
  throw new Error(`unexpected archive key: ${JSON.stringify(archived)}`);
}
const blockedRestore = await requestError(`/restore/${userId}/${sessionId}`, {
  method: 'POST',
});
if (
  blockedRestore.status !== 409 ||
  blockedRestore.payload.code !== 'active_workspace_restore_blocked' ||
  blockedRestore.payload.stage !== 'restore.guard'
) {
  throw new Error(JSON.stringify(blockedRestore, null, 2));
}
const afterBlockedRestore = await requestJson(
  `/inspect/${userId}/${sessionId}`
);
if (afterBlockedRestore.digest !== seeded.digest) {
  throw new Error('blocked restore changed the active workspace');
}
const cleared = await requestJson(`/clear/${userId}/${sessionId}`, {
  method: 'POST',
});
if (cleared.cleared?.exists !== false) {
  throw new Error(JSON.stringify(cleared, null, 2));
}
const restored = await requestJson(`/restore/${userId}/${sessionId}`, {
  method: 'POST',
});
const after = await requestJson(`/inspect/${userId}/${sessionId}`);
if (seeded.digest !== after.digest) {
  throw new Error(
    `digest mismatch before=${seeded.digest} after=${after.digest}`
  );
}

const previewAfterRestore = await requestText(previewPrefix);
if (!previewAfterRestore.includes('Integrated Preview'))
  throw new Error(previewAfterRestore);

console.log('Remote runtime archive smoke test passed');
console.log(`session: ${sessionId}`);
console.log(`archive: ${archived.key}`);
console.log(`digest: ${after.digest}`);
console.log(`restoredObjectSize: ${restored.objectSize}`);
