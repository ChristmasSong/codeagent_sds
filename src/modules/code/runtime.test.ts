import assert from 'node:assert/strict';

import {
  nextWorkspaceStatusPollState,
  shouldConfirmWorkspaceStatus,
  workspaceStatusPollInterval,
} from '../../lib/code-files';
import {
  assertSameOriginRequest,
  buildWorkspaceUploadHeaders,
  createWorkspaceDownloadResponse,
  requestRuntimeWithSecret,
  WorkspaceFilesError,
  workspaceRuntimePayloadError,
} from './files';
import { signedPreviewUrl } from './preview-access';
import {
  actionUrl,
  generateSessionId,
  normalizeAgent,
  sanitizeUserId,
  shouldRestoreWorkspace,
  terminalHttpUrl,
  terminalWsUrl,
  workspaceFilesUrl,
} from './runtime';

// sanitizeUserId
assert.equal(sanitizeUserId('User_123!@#'), 'user-123');
assert.equal(sanitizeUserId('  --Ab--  '), 'ab');
assert.equal(sanitizeUserId(''), 'user');
assert.equal(sanitizeUserId('已经abc'), 'abc');

// normalizeAgent
assert.equal(normalizeAgent('codex'), 'codex');
assert.equal(normalizeAgent('claude'), 'claude');
assert.equal(normalizeAgent('unknown'), 'claude');

// Workspace restore decisions must never overwrite an active workspace merely
// because an R2 checkpoint exists.
assert.equal(
  shouldRestoreWorkspace({
    archiveKey: 'workspace.tar.gz',
    status: 'active',
    workspaceExists: true,
  }),
  false
);
assert.equal(
  shouldRestoreWorkspace({
    archiveKey: 'workspace.tar.gz',
    status: 'active',
    workspaceExists: false,
  }),
  true
);
assert.equal(
  shouldRestoreWorkspace({
    archiveKey: 'workspace.tar.gz',
    status: 'active',
    workspaceExists: true,
    restorePending: true,
  }),
  true
);
assert.equal(
  shouldRestoreWorkspace({
    archiveKey: 'workspace.tar.gz',
    status: 'suspended',
    workspaceExists: false,
  }),
  false
);

// generateSessionId
const a = generateSessionId();
const b = generateSessionId();
assert.match(a, /^[a-z0-9-]+$/);
assert.notEqual(a, b);

// terminalWsUrl
assert.equal(
  terminalHttpUrl('https://rt.example.dev', 'u1', 's1'),
  'https://rt.example.dev/terminal/u1/s1'
);
assert.equal(
  terminalHttpUrl('https://rt.example.dev', 'u1', 's1', 'codex', 'm1'),
  'https://rt.example.dev/terminal/u1/s1?agent=codex&model=m1'
);
assert.equal(
  terminalWsUrl('https://rt.example.dev', 'u1', 's1'),
  'wss://rt.example.dev/terminal/u1/s1'
);
assert.equal(
  terminalWsUrl('http://localhost:8787', 'u1', 's1'),
  'ws://localhost:8787/terminal/u1/s1'
);
assert.equal(
  terminalWsUrl('https://rt.example.dev', 'u1', 's1', 'codex'),
  'wss://rt.example.dev/terminal/u1/s1?agent=codex'
);
assert.equal(
  terminalWsUrl('https://rt.example.dev', 'u1', 's1', 'claude', 'm1'),
  'wss://rt.example.dev/terminal/u1/s1?model=m1'
);
assert.equal(
  terminalWsUrl('https://rt.example.dev', 'u1', 's1', 'codex', 'm1'),
  'wss://rt.example.dev/terminal/u1/s1?agent=codex&model=m1'
);

// actionUrl
assert.equal(
  actionUrl('https://rt.example.dev', 'container-health', 'u1'),
  'https://rt.example.dev/container-health/u1'
);
assert.equal(
  actionUrl('https://rt.example.dev', 'archive', 'u1', 's1'),
  'https://rt.example.dev/archive/u1/s1'
);
assert.equal(
  actionUrl('https://rt.example.dev', 'clear', 'u1', 's1', 'codex'),
  'https://rt.example.dev/clear/u1/s1?agent=codex'
);
assert.equal(
  actionUrl('https://rt.example.dev', 'clear', 'u1', 's1', 'codex', 'm1'),
  'https://rt.example.dev/clear/u1/s1?agent=codex&model=m1'
);

const signedPreview = await signedPreviewUrl({
  runtimeBaseUrl: 'https://rt.example.dev/',
  runtimeUserId: 'u 1',
  sessionId: 's/1',
  secret: 'preview-test-secret',
  now: 1_700_000_000_000,
});
assert.equal(signedPreview.expiresAt, 1_700_000_300);
assert.match(
  signedPreview.url,
  /^https:\/\/rt\.example\.dev\/preview\/u%201\/s%2F1\/1700000300\.[A-Za-z0-9_-]{43}\/$/
);

// workspaceFilesUrl
assert.equal(
  workspaceFilesUrl('https://rt.example.dev', 'u1', 's1'),
  'https://rt.example.dev/files/u1/s1'
);
assert.equal(
  workspaceFilesUrl('https://rt.example.dev/', 'u 1', 's/1', 'status'),
  'https://rt.example.dev/files/u%201/s%2F1/status'
);
assert.equal(
  workspaceFilesUrl('https://rt.example.dev/', 'u 1', 's/1', 'content'),
  'https://rt.example.dev/files/u%201/s%2F1/content'
);
assert.equal(
  workspaceFilesUrl('https://rt.example.dev/', 'u 1', 's/1', 'upload'),
  'https://rt.example.dev/files/u%201/s%2F1/upload'
);
assert.equal(
  workspaceFilesUrl('https://rt.example.dev/', 'u 1', 's/1', 'download-all'),
  'https://rt.example.dev/files/u%201/s%2F1/download-all'
);

// Browser writes must be same-origin. Origin is validated as a serialized
// origin, not merely parsed and compared, so values with paths are rejected.
assert.doesNotThrow(() =>
  assertSameOriginRequest(
    new Request('https://app.example.test/api/code/sessions/s1/files', {
      headers: { origin: 'https://app.example.test' },
    })
  )
);
for (const origin of [
  null,
  'null',
  'https://evil.example.test',
  'https://app.example.test/path',
]) {
  const headers = origin == null ? undefined : { origin };
  assert.throws(
    () =>
      assertSameOriginRequest(
        new Request('https://app.example.test/api/code/sessions/s1/files', {
          headers,
        })
      ),
    (error: unknown) =>
      error instanceof WorkspaceFilesError &&
      error.message === 'invalid_origin' &&
      error.status === 403
  );
}

// Only file metadata and optimistic-concurrency headers cross the trust
// boundary. Browser attempts to set internal secrets/quotas are discarded.
const uploadHeaders = buildWorkspaceUploadHeaders(
  {
    authorization: 'Bearer browser-token',
    'content-length': '12',
    'content-type': 'text/plain',
    cookie: 'session=secret',
    'if-none-match': '*',
    'x-hicode-runtime-secret': 'attacker-secret',
    'x-workspace-max-bytes': '1',
  },
  2_147_483_648
);
assert.equal(uploadHeaders.get('accept'), 'application/json');
assert.equal(uploadHeaders.get('content-length'), '12');
assert.equal(uploadHeaders.get('content-type'), 'text/plain');
assert.equal(uploadHeaders.get('if-none-match'), '*');
assert.equal(uploadHeaders.get('x-workspace-max-bytes'), '2147483648');
assert.equal(uploadHeaders.get('authorization'), null);
assert.equal(uploadHeaders.get('cookie'), null);
assert.equal(uploadHeaders.get('x-hicode-runtime-secret'), null);

// Structured Runtime errors use `code`; the human message must not replace
// the stable client-facing error or influence its status mapping.
const unsupportedUploadError = workspaceRuntimePayloadError(
  {
    code: 'unsupported_file_type',
    error: 'This human-readable message may change',
  },
  500
);
assert.equal(unsupportedUploadError.message, 'unsupported_file_type');
assert.equal(unsupportedUploadError.status, 415);
const busyTransferError = workspaceRuntimePayloadError(
  { code: 'workspace_transfer_busy' },
  500
);
assert.equal(busyTransferError.message, 'workspace_transfer_busy');
assert.equal(busyTransferError.status, 429);
const legacyPathError = workspaceRuntimePayloadError(
  { error: 'invalid_path' },
  400
);
assert.equal(legacyPathError.message, 'invalid_path');
assert.equal(legacyPathError.status, 400);

// ZIP responses are streamed through with a minimal, defensive header set.
const zipStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array([80, 75, 5, 6]));
    controller.close();
  },
});
const zipResponse = await createWorkspaceDownloadResponse(
  new Response(zipStream, {
    headers: {
      'content-disposition': `attachment; filename="workspace.zip"`,
      'content-type': 'application/zip',
      'x-runtime-internal': 'do-not-forward',
    },
  })
);
assert.equal(zipResponse.headers.get('content-type'), 'application/zip');
assert.equal(
  zipResponse.headers.get('content-disposition'),
  `attachment; filename="workspace.zip"`
);
assert.equal(zipResponse.headers.get('content-length'), null);
assert.equal(zipResponse.headers.get('cache-control'), 'private, no-store');
assert.equal(zipResponse.headers.get('x-content-type-options'), 'nosniff');
assert.equal(zipResponse.headers.get('x-runtime-internal'), null);
await zipResponse.body?.cancel();

const invalidZipHeaders: HeadersInit[] = [
  {
    'content-disposition': 'inline',
    'content-type': 'application/zip',
  },
  {
    'content-disposition': 'attachment; filename="workspace.zip"',
    'content-type': 'application/octet-stream',
  },
  {
    'content-disposition': 'attachment; filename="workspace.zip"',
    'content-length': '-1',
    'content-type': 'application/zip',
  },
];
for (const headers of invalidZipHeaders) {
  await assert.rejects(
    createWorkspaceDownloadResponse(
      new Response(new Uint8Array([80, 75]), { headers })
    ),
    (error: unknown) =>
      error instanceof WorkspaceFilesError &&
      error.message === 'invalid_runtime_download_response' &&
      error.status === 502
  );
}

// Workspace scans back off while the digest stays stable.
assert.equal(workspaceStatusPollInterval(0), 15_000);
assert.equal(workspaceStatusPollInterval(1), 15_000);
assert.equal(workspaceStatusPollInterval(2), 30_000);
assert.equal(workspaceStatusPollInterval(4), 30_000);
assert.equal(workspaceStatusPollInterval(5), 60_000);
assert.equal(workspaceStatusPollInterval(9), 60_000);
assert.equal(workspaceStatusPollInterval(10), 120_000);

// Poll backoff belongs to one session and resets for another session.
const sessionAFirstCheck = nextWorkspaceStatusPollState(
  undefined,
  'session-a',
  {
    sessionStatus: 'active',
    exists: true,
    digest: 'digest-1',
  }
);
assert.deepEqual(sessionAFirstCheck, {
  sessionId: 'session-a',
  sessionStatus: 'active',
  exists: true,
  digest: 'digest-1',
  stableChecks: 0,
});
const sessionAStableCheck = nextWorkspaceStatusPollState(
  sessionAFirstCheck,
  'session-a',
  {
    sessionStatus: 'active',
    exists: true,
    digest: 'digest-1',
  }
);
assert.equal(sessionAStableCheck.stableChecks, 1);
assert.deepEqual(
  nextWorkspaceStatusPollState(sessionAStableCheck, 'session-b', {
    sessionStatus: 'active',
    exists: true,
    digest: 'digest-1',
  }),
  {
    sessionId: 'session-b',
    sessionStatus: 'active',
    exists: true,
    digest: 'digest-1',
    stableChecks: 0,
  }
);
assert.equal(
  nextWorkspaceStatusPollState(sessionAStableCheck, 'session-a', {
    sessionStatus: 'active',
    exists: true,
    digest: 'digest-2',
  }).stableChecks,
  0
);

// Lifecycle changes reset the backoff even when both states have a null digest.
const inactiveWorkspaceCheck = nextWorkspaceStatusPollState(
  {
    sessionId: 'session-a',
    sessionStatus: 'active',
    exists: true,
    digest: null,
    stableChecks: 10,
  },
  'session-a',
  {
    sessionStatus: 'suspended',
    exists: false,
    digest: null,
  }
);
assert.equal(inactiveWorkspaceCheck.stableChecks, 0);
assert.equal(
  nextWorkspaceStatusPollState(inactiveWorkspaceCheck, 'session-a', {
    sessionStatus: 'active',
    exists: true,
    digest: null,
  }).stableChecks,
  0
);

// Re-enabling the panel and switching sessions both require a confirmation
// request, even when React Query still holds fresh cached data.
assert.equal(
  shouldConfirmWorkspaceStatus(
    { sessionId: 'session-a', enabled: false },
    { sessionId: 'session-a', enabled: true }
  ),
  true
);
assert.equal(
  shouldConfirmWorkspaceStatus(
    { sessionId: 'session-a', enabled: true },
    { sessionId: 'session-b', enabled: true }
  ),
  true
);
assert.equal(
  shouldConfirmWorkspaceStatus(
    { sessionId: 'session-a', enabled: true },
    { sessionId: 'session-a', enabled: true }
  ),
  false
);
assert.equal(
  shouldConfirmWorkspaceStatus(
    { sessionId: 'session-a', enabled: true },
    { sessionId: 'session-a', enabled: false }
  ),
  false
);

// Runtime authentication retries exactly once with a fresh configuration
// value when a warm isolate still has the previous shared secret cached.
const originalRuntimeFetch = globalThis.fetch;
try {
  const requestedSecrets: Array<string | null> = [];
  const resolverFreshFlags: Array<boolean | undefined> = [];
  globalThis.fetch = (async (_input, init) => {
    const secret = new Headers(init?.headers).get('x-hicode-runtime-secret');
    requestedSecrets.push(secret);
    return new Response(secret === 'fresh-secret' ? 'ok' : 'unauthorized', {
      status: secret === 'fresh-secret' ? 200 : 401,
    });
  }) as typeof fetch;

  const rotatedResponse = await requestRuntimeWithSecret(
    'https://runtime.example.test/files',
    async (options) => {
      resolverFreshFlags.push(options?.fresh);
      return options?.fresh ? 'fresh-secret' : 'cached-secret';
    },
    1_000
  );
  assert.equal(rotatedResponse.status, 200);
  assert.deepEqual(requestedSecrets, ['cached-secret', 'fresh-secret']);
  assert.deepEqual([...resolverFreshFlags], [false, true]);

  requestedSecrets.length = 0;
  resolverFreshFlags.length = 0;
  const initiallyMissingResponse = await requestRuntimeWithSecret(
    'https://runtime.example.test/files',
    async (options) => {
      resolverFreshFlags.push(options?.fresh);
      return options?.fresh ? 'fresh-secret' : '';
    },
    1_000
  );
  assert.equal(initiallyMissingResponse.status, 200);
  assert.deepEqual(requestedSecrets, ['fresh-secret']);
  assert.deepEqual([...resolverFreshFlags], [false, true]);

  // Streamed bodies are sent by reference with Node's duplex mode. A fresh
  // secret is resolved before the first byte, because the stream is not
  // replayable and must never be buffered just to retry authentication.
  requestedSecrets.length = 0;
  resolverFreshFlags.length = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hello'));
      controller.close();
    },
  });
  let uploadInit: (RequestInit & { duplex?: 'half' }) | undefined;
  globalThis.fetch = (async (_input, init) => {
    uploadInit = init as RequestInit & { duplex?: 'half' };
    return Response.json({ ok: true });
  }) as typeof fetch;
  const streamedResponse = await requestRuntimeWithSecret(
    'https://runtime.example.test/files/u1/s1/upload?path=hello.txt',
    async (options) => {
      resolverFreshFlags.push(options?.fresh);
      return 'fresh-secret';
    },
    1_000,
    {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body,
    }
  );
  assert.equal(streamedResponse.status, 200);
  assert.equal(uploadInit?.method, 'PUT');
  assert.equal(uploadInit?.body, body);
  assert.equal(uploadInit?.duplex, 'half');
  assert.equal(
    new Headers(uploadInit?.headers).get('x-hicode-runtime-secret'),
    'fresh-secret'
  );
  assert.deepEqual([...resolverFreshFlags], [true]);

  resolverFreshFlags.length = 0;
  let streamedUnauthorizedRequests = 0;
  globalThis.fetch = (async () => {
    streamedUnauthorizedRequests += 1;
    return new Response('unauthorized', { status: 401 });
  }) as typeof fetch;
  await assert.rejects(
    requestRuntimeWithSecret(
      'https://runtime.example.test/files/u1/s1/upload?path=hello.txt',
      async (options) => {
        resolverFreshFlags.push(options?.fresh);
        return 'still-wrong';
      },
      1_000,
      {
        method: 'PUT',
        body: new ReadableStream<Uint8Array>(),
      }
    ),
    (error: unknown) =>
      error instanceof WorkspaceFilesError &&
      error.message === 'runtime_not_configured' &&
      error.status === 503
  );
  assert.equal(streamedUnauthorizedRequests, 1);
  assert.deepEqual([...resolverFreshFlags], [true]);

  let rejectedRequests = 0;
  globalThis.fetch = (async () => {
    rejectedRequests += 1;
    return new Response('unauthorized', { status: 401 });
  }) as typeof fetch;
  await assert.rejects(
    requestRuntimeWithSecret(
      'https://runtime.example.test/files',
      async (options) => (options?.fresh ? 'fresh-secret' : 'cached-secret'),
      1_000
    ),
    (error: unknown) =>
      error instanceof WorkspaceFilesError &&
      error.message === 'runtime_not_configured' &&
      error.status === 503
  );
  assert.equal(rejectedRequests, 2);
} finally {
  globalThis.fetch = originalRuntimeFetch;
}

console.log('runtime.test.ts OK');
