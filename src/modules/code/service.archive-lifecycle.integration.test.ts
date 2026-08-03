import assert from 'node:assert/strict';
import { and, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { envConfigs } from '@/config';
import {
  codeSession,
  storageObject,
  storageReservation,
  storageUsage,
  user,
  type StorageObject,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

import {
  archiveSession,
  restoreSession,
  resumeArchivedSession,
} from './service';

const testId = getUuid();
const userId = `archive-lifecycle-user-${testId}`;
const sessionId = `archive-lifecycle-session-${testId}`;
const runtimeUserId = `archive-lifecycle-runtime-${testId}`;
const keyPrefix = `integrated-workspaces/${runtimeUserId}/${sessionId}/archives`;
const deletedKey = `${keyPrefix}/confirmed-deleted.tar.gz`;
const notFoundKey = `${keyPrefix}/confirmed-missing.tar.gz`;
const failedKey = `${keyPrefix}/delete-failed-current.tar.gz`;
const cleanupCandidateKeys = [deletedKey, notFoundKey, failedKey];
const deletedBytes = 20;
const notFoundBytes = 10;
const failedBytes = 30;
const newBytes = 40;
const newDigest = `archive-lifecycle-digest-${testId}`;
const originalFetch = globalThis.fetch;
const originalRuntimeBaseUrl = envConfigs.runtime_base_url;
const originalRuntimeSecret = envConfigs.billing_usage_webhook_secret;
const physicalKeys = new Set([deletedKey, failedKey]);
const operationOrder: string[] = [];
let newKey = '';
let restoreRequests = 0;
let expectEndedDuringRestore = false;

function requestDetails(input: RequestInfo | URL, init?: RequestInit) {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  return {
    action: url.pathname.split('/').filter(Boolean)[0] || '',
    headers: new Headers(init?.headers || request?.headers),
    method: init?.method || request?.method || 'GET',
    url,
  };
}

await db()
  .insert(user)
  .values({
    id: userId,
    name: 'Archive lifecycle integration test',
    email: `${userId}@example.test`,
  });
await db()
  .insert(codeSession)
  .values({
    id: sessionId,
    userId,
    runtimeUserId,
    status: 'active',
    title: 'Archive lifecycle integration test',
    archiveKey: failedKey,
    archiveDigest: `old-digest-${testId}`,
  });
await db()
  .insert(storageUsage)
  .values({
    userId,
    usedBytes: deletedBytes + notFoundBytes + failedBytes,
    quotaOverrideBytes: 10 * 1024 * 1024,
    reconciledAt: new Date(),
  });
await db()
  .insert(storageObject)
  .values([
    {
      id: `archive-lifecycle-deleted-${testId}`,
      userId,
      sessionId,
      key: deletedKey,
      kind: 'snapshot',
      status: 'active',
      sizeBytes: deletedBytes,
    },
    {
      id: `archive-lifecycle-not-found-${testId}`,
      userId,
      sessionId,
      key: notFoundKey,
      kind: 'snapshot',
      status: 'active',
      sizeBytes: notFoundBytes,
    },
    {
      id: `archive-lifecycle-failed-${testId}`,
      userId,
      sessionId,
      key: failedKey,
      kind: 'current',
      status: 'active',
      sizeBytes: failedBytes,
    },
  ]);

envConfigs.runtime_base_url = 'https://runtime.archive-lifecycle.test';
envConfigs.billing_usage_webhook_secret = 'archive-lifecycle-test-secret';

globalThis.fetch = async (input, init) => {
  const request = requestDetails(input, init);
  const parts = request.url.pathname.split('/').filter(Boolean);
  const requestedSessionId = decodeURIComponent(parts.at(-1) || '');
  assert.equal(requestedSessionId, sessionId);

  if (request.action === 'inspect') {
    assert.equal(request.method, 'GET');
    operationOrder.push('inspect');
    return Response.json({
      ok: true,
      exists: true,
      total_bytes: 4096,
      file_count: 1,
    });
  }

  if (request.action === 'archive') {
    assert.equal(request.method, 'POST');
    assert.equal(request.url.searchParams.get('deferCleanup'), '1');
    assert.equal(
      request.url.searchParams.get('maxWorkspaceBytes'),
      String(2 * 1024 ** 3),
      'the Runtime must receive the uncompressed workspace limit separately'
    );
    assert.equal(
      request.url.searchParams.get('maxBytes'),
      String(4096 + 1024 * 1024),
      'the Runtime archive limit must match the reserved R2 bytes'
    );
    newKey = request.headers.get('x-hicode-target-archive-key') || '';
    assert.match(newKey, /\/archives\/[^/]+\.tar\.gz$/);
    physicalKeys.add(newKey);
    operationOrder.push('archive-uploaded');
    return Response.json({
      ok: true,
      key: newKey,
      currentKey: newKey,
      versionKey: newKey,
      bytes: newBytes,
      files: 1,
      workspaceDigest: newDigest,
      archiveSha256: `archive-sha256-${testId}`,
      deduplicated: false,
      cleanupCandidateKeys,
    });
  }

  if (request.action === 'archive-delete') {
    assert.equal(request.method, 'POST');
    const body = JSON.parse(String(init?.body || '{}')) as { keys?: string[] };
    assert.deepEqual(body.keys, cleanupCandidateKeys);

    const [sessionAtDelete] = await db()
      .select({ archiveKey: codeSession.archiveKey })
      .from(codeSession)
      .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)))
      .limit(1);
    assert.equal(
      sessionAtDelete?.archiveKey,
      newKey,
      'the archive pointer must be CAS-updated before physical cleanup starts'
    );
    const [newLedgerAtDelete] = await db()
      .select({ id: storageObject.id })
      .from(storageObject)
      .where(eq(storageObject.key, newKey))
      .limit(1);
    assert.equal(
      newLedgerAtDelete,
      undefined,
      'ledger settlement must happen after physical cleanup is confirmed'
    );

    physicalKeys.delete(deletedKey);
    operationOrder.push('cleanup-after-pointer-cas');
    return Response.json({
      ok: false,
      scope: 'keys',
      keptKey: newKey,
      deleted: [{ key: deletedKey, bytes: deletedBytes }],
      deletedKeys: [deletedKey],
      deletedBytes,
      notFound: [notFoundKey],
      failed: [{ key: failedKey, error: 'simulated cleanup failure' }],
    });
  }

  if (request.action === 'restore') {
    assert.equal(request.method, 'POST');
    const restoreKey = request.headers.get('x-hicode-archive-key') || '';
    assert.equal(restoreKey, newKey);
    assert.equal(
      physicalKeys.has(restoreKey),
      true,
      'the new archive pointer must still identify a durable object'
    );
    const [sessionAtRestore] = await db()
      .select({ status: codeSession.status })
      .from(codeSession)
      .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)))
      .limit(1);
    assert.equal(
      sessionAtRestore?.status,
      expectEndedDuringRestore ? 'ended' : 'active',
      'resume must finish restoring before it exposes the session as active'
    );
    restoreRequests += 1;
    operationOrder.push('restore-new-pointer');
    return Response.json({
      ok: true,
      key: restoreKey,
      workspaceDigest: newDigest,
    });
  }

  throw new Error(`Unexpected Runtime request: ${request.url.pathname}`);
};

try {
  const archived = await archiveSession(userId, sessionId);
  assert.equal(archived.session.archiveKey, newKey);
  assert.equal(archived.session.archiveDigest, newDigest);
  assert.deepEqual(operationOrder, [
    'inspect',
    'archive-uploaded',
    'cleanup-after-pointer-cas',
  ]);
  assert.deepEqual(
    new Set((archived.archive.deletedKeys as string[]) || []),
    new Set([deletedKey, notFoundKey]),
    'only confirmed deleted/notFound keys may be settled from the ledger'
  );
  assert.deepEqual(
    (archived.archive.cleanupFailed as Array<{ key: string }>).map(
      (item) => item.key
    ),
    [failedKey]
  );

  const ledger = (await db()
    .select()
    .from(storageObject)
    .where(
      and(
        eq(storageObject.userId, userId),
        eq(storageObject.sessionId, sessionId)
      )
    )) as StorageObject[];
  const ledgerByKey = new Map<string, StorageObject>(
    ledger.map((object) => [object.key, object])
  );
  assert.equal(ledgerByKey.get(deletedKey)?.status, 'deleted');
  assert.equal(ledgerByKey.get(notFoundKey)?.status, 'deleted');
  assert.equal(ledgerByKey.get(failedKey)?.status, 'active');
  assert.equal(ledgerByKey.get(failedKey)?.kind, 'snapshot');
  assert.equal(ledgerByKey.get(newKey)?.status, 'active');
  assert.equal(ledgerByKey.get(newKey)?.kind, 'current');
  assert.equal(Number(ledgerByKey.get(newKey)?.sizeBytes), newBytes);

  const [usage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);
  assert.equal(
    Number(usage.usedBytes),
    failedBytes + newBytes,
    'the failed old object must remain charged after partial cleanup'
  );
  assert.equal(Number(usage.reservedBytes), 0);

  const [reservation] = await db()
    .select()
    .from(storageReservation)
    .where(
      and(
        eq(storageReservation.userId, userId),
        eq(storageReservation.sessionId, sessionId)
      )
    )
    .limit(1);
  assert.equal(reservation.status, 'settled');
  assert.equal(reservation.objectKey, newKey);
  assert.equal(Number(reservation.actualBytes), newBytes);

  const restored = await restoreSession(userId, sessionId);
  assert.equal(restored.restoreIntegrity.state, 'verified');
  assert.equal(restoreRequests, 1);
  assert.deepEqual(operationOrder, [
    'inspect',
    'archive-uploaded',
    'cleanup-after-pointer-cas',
    'restore-new-pointer',
  ]);

  const [failedAfterRestore] = await db()
    .select()
    .from(storageObject)
    .where(eq(storageObject.key, failedKey))
    .limit(1);
  assert.equal(failedAfterRestore.status, 'active');

  await db()
    .update(codeSession)
    .set({
      status: 'ended',
      suspensionReason: '',
      endedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)));
  expectEndedDuringRestore = true;
  const resumed = await resumeArchivedSession(userId, sessionId);
  assert.equal(resumed.session.status, 'active');
  assert.equal(resumed.restorePending, false);
  assert.equal(resumed.restoreIntegrity.state, 'verified');
  assert.equal(restoreRequests, 2);
  console.info('code session archive lifecycle integration tests passed');
} finally {
  globalThis.fetch = originalFetch;
  envConfigs.runtime_base_url = originalRuntimeBaseUrl;
  envConfigs.billing_usage_webhook_secret = originalRuntimeSecret;
  await db()
    .delete(user)
    .where(eq(user.id, userId))
    .catch(() => undefined);
}
