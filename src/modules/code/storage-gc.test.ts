import assert from 'node:assert/strict';

import {
  classifyStorageGcObject,
  parseManagedArchiveKey,
  STORAGE_GC_ORPHAN_GRACE_MS,
  STORAGE_GC_TEMP_TTL_MS,
} from './storage-gc';

const now = new Date('2026-07-28T12:00:00.000Z');
const runtimeUserId = 'runtime/user';
const sessionId = 'session-1';
const prefix = `integrated-workspaces/${encodeURIComponent(runtimeUserId)}/${encodeURIComponent(sessionId)}/`;

function physical(relativeKey: string, ageMs: number) {
  return {
    key: `${prefix}${relativeKey}`,
    size: 1024,
    uploaded: new Date(now.getTime() - ageMs).toISOString(),
  };
}

function classify(
  relativeKey: string,
  ageMs: number,
  options: {
    session?: {
      id: string;
      userId: string;
      runtimeUserId: string;
      archiveKey: string | null;
    };
    ledger?: {
      key: string;
      userId: string;
      sessionId: string;
      kind: string;
      status: string;
      expiresAt?: Date | null;
    };
    retentionDays?: number;
  } = {}
) {
  const object = physical(relativeKey, ageMs);
  const parsed = parseManagedArchiveKey(object.key);
  assert.ok(parsed);
  return classifyStorageGcObject({
    object,
    parsed,
    session: options.session,
    ledger: options.ledger,
    retentionDays: options.retentionDays || 7,
    now,
  });
}

assert.equal(parseManagedArchiveKey('unmanaged/object.tar.gz'), null);
assert.equal(
  parseManagedArchiveKey('integrated-workspaces/bad%ZZ/session/archive.tar.gz'),
  null
);
assert.equal(
  parseManagedArchiveKey(
    'integrated-workspaces/runtime-1/session-1/unknown/object.bin'
  ),
  null,
  'unknown managed-prefix layouts must be preserved'
);
assert.deepEqual(parseManagedArchiveKey(`${prefix}archives/a.tar.gz`), {
  runtimeUserId,
  sessionId,
  relativeKey: 'archives/a.tar.gz',
});

assert.equal(
  classify('archives/orphan-new.tar.gz', STORAGE_GC_ORPHAN_GRACE_MS - 1)
    ?.reason,
  undefined,
  'new missing-session objects must receive the orphan grace period'
);
assert.equal(
  classify('archives/orphan-old.tar.gz', STORAGE_GC_ORPHAN_GRACE_MS)?.reason,
  'orphan_session'
);

const oldCurrent = physical('archives/current.tar.gz', 90 * 24 * 60 * 60_000);
assert.equal(
  classifyStorageGcObject({
    object: oldCurrent,
    parsed: parseManagedArchiveKey(oldCurrent.key)!,
    session: {
      id: sessionId,
      userId: 'user-1',
      runtimeUserId,
      archiveKey: oldCurrent.key,
    },
    retentionDays: 7,
    now,
  }),
  null,
  'the authoritative current archive must never be removed by TTL'
);

assert.equal(
  classify('workspace.tar.gz', STORAGE_GC_ORPHAN_GRACE_MS - 1, {
    session: {
      id: sessionId,
      userId: 'user-1',
      runtimeUserId,
      archiveKey: null,
    },
  }),
  null,
  'an unpointed legacy object receives the pointer-settlement grace period'
);
assert.equal(
  classify('workspace.tar.gz', STORAGE_GC_ORPHAN_GRACE_MS, {
    session: {
      id: sessionId,
      userId: 'user-1',
      runtimeUserId,
      archiveKey: null,
    },
  })?.reason,
  'stale_unpointed',
  'a stale unpointed legacy object must not leak forever'
);

const session = {
  id: sessionId,
  userId: 'user-1',
  runtimeUserId,
  archiveKey: `${prefix}archives/current.tar.gz`,
};
assert.equal(
  classify('temporary/upload.tar.gz', STORAGE_GC_TEMP_TTL_MS - 1, {
    session,
  }),
  null
);
assert.equal(
  classify('temporary/upload.tar.gz', STORAGE_GC_TEMP_TTL_MS, { session })
    ?.reason,
  'temporary_ttl'
);
assert.equal(
  classify('archives/snapshot.tar.gz', 7 * 24 * 60 * 60_000 - 1, {
    session,
  }),
  null
);
assert.equal(
  classify('archives/snapshot.tar.gz', 7 * 24 * 60 * 60_000, {
    session,
  })?.reason,
  'snapshot_retention'
);
assert.equal(
  classify('archives/newly-demoted.tar.gz', 90 * 24 * 60 * 60_000, {
    session,
    ledger: {
      key: `${prefix}archives/newly-demoted.tar.gz`,
      userId: 'user-1',
      sessionId,
      kind: 'snapshot',
      status: 'active',
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60_000),
    },
  }),
  null,
  'a long-lived current archive must honor its new ledger expiry after demotion'
);
assert.equal(
  classify('archives/expired-ledger-snapshot.tar.gz', 90 * 24 * 60 * 60_000, {
    session,
    ledger: {
      key: `${prefix}archives/expired-ledger-snapshot.tar.gz`,
      userId: 'user-1',
      sessionId,
      kind: 'snapshot',
      status: 'active',
      expiresAt: now,
    },
  })?.reason,
  'snapshot_retention'
);

const ledgerProtected = physical(
  'archives/ledger-current.tar.gz',
  STORAGE_GC_ORPHAN_GRACE_MS - 1
);
assert.equal(
  classifyStorageGcObject({
    object: ledgerProtected,
    parsed: parseManagedArchiveKey(ledgerProtected.key)!,
    session,
    ledger: {
      key: ledgerProtected.key,
      userId: 'user-1',
      sessionId,
      kind: 'current',
      status: 'active',
    },
    retentionDays: 7,
    now,
  }),
  null,
  'a recent ledger current row is protected while its pointer may be settling'
);

const staleLedgerCurrent = physical(
  'archives/stale-ledger-current.tar.gz',
  STORAGE_GC_ORPHAN_GRACE_MS
);
assert.equal(
  classifyStorageGcObject({
    object: staleLedgerCurrent,
    parsed: parseManagedArchiveKey(staleLedgerCurrent.key)!,
    session,
    ledger: {
      key: staleLedgerCurrent.key,
      userId: 'user-1',
      sessionId,
      kind: 'current',
      status: 'active',
    },
    retentionDays: 7,
    now,
  })?.reason,
  'stale_unpointed',
  'a stale ledger current row cannot override a different session pointer'
);

console.log('storage-gc classification tests passed');
