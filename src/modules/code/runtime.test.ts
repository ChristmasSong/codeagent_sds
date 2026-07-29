import assert from 'node:assert/strict';

import {
  nextWorkspaceStatusPollState,
  shouldConfirmWorkspaceStatus,
  workspaceStatusPollInterval,
} from '../../lib/code-files';
import { requestRuntimeWithSecret, WorkspaceFilesError } from './files';
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
  assert.deepEqual(resolverFreshFlags, [false, true]);

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
  assert.deepEqual(resolverFreshFlags, [false, true]);

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
