import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  codeSession,
  storageObject,
  storageUsage,
  user,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

import { acquireArchiveLock, releaseArchiveLock } from './service';
import { cleanupStorage } from './storage-cleanup';
import {
  planStorageGc,
  settleConfirmedStorageGcDeletion,
  sweepStorageGc,
} from './storage-gc';

const testId = getUuid();
const userId = `storage-gc-user-${testId}`;
const runtimeUserId = `storage-gc-runtime-${testId}`;
const sessionId = `storage-gc-session-${testId}`;
const missingSessionId = `storage-gc-missing-${testId}`;
const prefix = `integrated-workspaces/${encodeURIComponent(runtimeUserId)}/${encodeURIComponent(sessionId)}/`;
const orphanPrefix = `integrated-workspaces/${encodeURIComponent(runtimeUserId)}/${encodeURIComponent(missingSessionId)}/`;
const currentKey = `${prefix}archives/current.tar.gz`;
const snapshotKey = `${prefix}archives/snapshot.tar.gz`;
const tempKey = `${prefix}temporary/interrupted.tar.gz`;
const orphanKey = `${orphanPrefix}archives/orphan.tar.gz`;
const oldUploaded = new Date(Date.now() - 30 * 24 * 60 * 60_000);

await db()
  .insert(user)
  .values({
    id: userId,
    name: 'Storage GC integration test',
    email: `${userId}@example.test`,
  });

try {
  await db().insert(codeSession).values({
    id: sessionId,
    userId,
    runtimeUserId,
    title: 'Storage GC session',
    archiveKey: currentKey,
  });
  await db().insert(storageUsage).values({
    userId,
    usedBytes: 185,
  });
  await db()
    .insert(storageObject)
    .values([
      {
        id: getUuid(),
        userId,
        sessionId,
        key: currentKey,
        kind: 'current',
        status: 'active',
        sizeBytes: 100,
        createdAt: oldUploaded,
        updatedAt: oldUploaded,
      },
      {
        id: getUuid(),
        userId,
        sessionId,
        key: snapshotKey,
        kind: 'snapshot',
        status: 'active',
        sizeBytes: 50,
        expiresAt: oldUploaded,
        createdAt: oldUploaded,
        updatedAt: oldUploaded,
      },
      {
        id: getUuid(),
        userId,
        sessionId,
        key: tempKey,
        kind: 'temp',
        status: 'active',
        sizeBytes: 10,
        createdAt: oldUploaded,
        updatedAt: oldUploaded,
      },
      {
        id: getUuid(),
        userId,
        sessionId: missingSessionId,
        key: orphanKey,
        kind: 'snapshot',
        status: 'active',
        sizeBytes: 25,
        createdAt: oldUploaded,
        updatedAt: oldUploaded,
      },
    ]);

  const plan = await planStorageGc({
    objects: [currentKey, snapshotKey, tempKey, orphanKey].map((key) => ({
      key,
      size:
        key === currentKey
          ? 100
          : key === snapshotKey
            ? 50
            : key === tempKey
              ? 10
              : 25,
      uploaded: oldUploaded.toISOString(),
    })),
    configs: { code_storage_retention_days: '7' },
  });
  assert.deepEqual(
    new Map(
      plan.candidates.map((candidate) => [candidate.key, candidate.reason])
    ),
    new Map([
      [snapshotKey, 'snapshot_retention'],
      [tempKey, 'temporary_ttl'],
      [orphanKey, 'orphan_session'],
    ])
  );

  const [session] = await db()
    .select()
    .from(codeSession)
    .where(eq(codeSession.id, sessionId))
    .limit(1);
  assert.ok(session);
  const lifecycleLock = await acquireArchiveLock(session);
  const originalFetch = globalThis.fetch;
  let deleteRequests = 0;
  globalThis.fetch = async () => {
    deleteRequests += 1;
    throw new Error('GC must not reach Runtime while lifecycle lock is held');
  };
  try {
    await assert.rejects(
      cleanupStorage({
        userId,
        sessionId,
        scope: 'snapshots',
      }),
      /archive operation is already running/i
    );
    const lockedSweep = await sweepStorageGc({
      objects: [
        {
          key: snapshotKey,
          size: 50,
          uploaded: oldUploaded.toISOString(),
        },
      ],
      configs: { code_storage_retention_days: '7' },
    });
    assert.deepEqual(lockedSweep.failedKeys, [snapshotKey]);
    assert.equal(
      deleteRequests,
      0,
      'a concurrent archive/restore lifecycle lock must block physical GC'
    );
  } finally {
    globalThis.fetch = originalFetch;
    await releaseArchiveLock(session, lifecycleLock);
  }

  globalThis.fetch = async () => {
    throw new Error('Active current archive cleanup must fail before Runtime');
  };
  try {
    await assert.rejects(
      cleanupStorage({ userId, sessionId, scope: 'session' }),
      /current archive of an active session cannot be deleted/i
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const settled = await settleConfirmedStorageGcDeletion([
    snapshotKey,
    tempKey,
    orphanKey,
  ]);
  assert.equal(settled.confirmed, 3);
  assert.equal(settled.ledgerDeleted, 3);
  assert.equal(settled.deletedBytes, 85);

  const [usage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);
  assert.equal(Number(usage?.usedBytes), 100);
  const deletedRows = await db()
    .select({ status: storageObject.status })
    .from(storageObject)
    .where(inArray(storageObject.key, [snapshotKey, tempKey, orphanKey]));
  assert.ok(deletedRows.every((row) => row.status === 'deleted'));

  await assert.rejects(
    settleConfirmedStorageGcDeletion([currentKey]),
    /current workspace archive/i
  );
  const [current] = await db()
    .select({ status: storageObject.status })
    .from(storageObject)
    .where(eq(storageObject.key, currentKey))
    .limit(1);
  assert.equal(current?.status, 'active');
} finally {
  await db().delete(user).where(eq(user.id, userId));
}

console.log('storage-gc integration tests passed');
