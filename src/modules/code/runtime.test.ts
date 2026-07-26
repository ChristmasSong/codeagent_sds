import assert from 'node:assert/strict';

import { workspaceStatusPollInterval } from '../../lib/code-files';
import {
  actionUrl,
  generateSessionId,
  normalizeAgent,
  previewUrl,
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

// previewUrl
assert.equal(
  previewUrl('https://rt.example.dev', 'u1', 's1'),
  'https://rt.example.dev/preview/u1/s1/'
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

console.log('runtime.test.ts OK');
