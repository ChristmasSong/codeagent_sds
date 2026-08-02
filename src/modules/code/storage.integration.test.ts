import assert from 'node:assert/strict';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  codeSession,
  config as configTable,
  storageObject,
  storageReservation,
  storageUsage,
  user,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

import {
  acquireStorageMutationLock,
  holdReservationForReconciliation,
  releaseReservation,
  releaseStorageMutationLock,
  renewStorageMutationLock,
  reserveStorage,
  settleStorage,
} from './storage';
import { reconcileUserStorage } from './storage-reconciliation';

const MIB = 1024 ** 2;
const configs = { code_storage_user_quota_gb: '1' };
const testId = getUuid();
const userId = `storage-test-user-${testId}`;
const firstSessionId = `storage-test-session-a-${testId}`;
const secondSessionId = `storage-test-session-b-${testId}`;
const pagedSessionIds = Array.from(
  { length: 500 },
  (_, index) =>
    `storage-test-session-page-${String(index).padStart(3, '0')}-${testId}`
);
const lastPagedSessionId = pagedSessionIds[pagedSessionIds.length - 1]!;
const firstObjectKey = `workspaces/${userId}/${firstSessionId}/versions/${testId}-a.tar.gz`;
const recoveredObjectKey = `workspaces/${userId}/${secondSessionId}/versions/${testId}-b.tar.gz`;
const pagedObjectKey = `workspaces/${userId}/${lastPagedSessionId}/versions/${testId}-page.tar.gz`;

await db()
  .insert(user)
  .values({
    id: userId,
    name: 'Storage integration test',
    email: `${userId}@example.test`,
  });
await db()
  .insert(codeSession)
  .values([
    {
      id: firstSessionId,
      userId,
      runtimeUserId: userId,
      title: 'Storage test A',
    },
    {
      id: secondSessionId,
      userId,
      runtimeUserId: userId,
      title: 'Storage test B',
    },
  ]);
for (let offset = 0; offset < pagedSessionIds.length; offset += 100) {
  await db()
    .insert(codeSession)
    .values(
      pagedSessionIds.slice(offset, offset + 100).map((sessionId) => ({
        id: sessionId,
        userId,
        runtimeUserId: userId,
        title: 'Storage pagination test',
        archiveKey:
          sessionId === lastPagedSessionId ? pagedObjectKey : undefined,
      }))
    );
}

try {
  const concurrentLocks = await Promise.allSettled([
    acquireStorageMutationLock(userId),
    acquireStorageMutationLock(userId),
  ]);
  const acceptedLocks = concurrentLocks.filter(
    (result) => result.status === 'fulfilled'
  );
  const rejectedLocks = concurrentLocks.filter(
    (result) => result.status === 'rejected'
  );
  assert.equal(
    acceptedLocks.length,
    1,
    'only one concurrent user storage mutation can win'
  );
  assert.equal(rejectedLocks.length, 1, 'the competing lock must fail closed');
  const acceptedLock = acceptedLocks[0];
  assert.equal(acceptedLock.status, 'fulfilled');
  const lockToken = acceptedLock.value;

  try {
    const [leaseBefore] = await db()
      .select({
        expiresAt: storageUsage.reconcileLockExpiresAt,
      })
      .from(storageUsage)
      .where(eq(storageUsage.userId, userId))
      .limit(1);
    await renewStorageMutationLock(userId, lockToken, 60 * 60_000);
    const [leaseAfter] = await db()
      .select({
        expiresAt: storageUsage.reconcileLockExpiresAt,
      })
      .from(storageUsage)
      .where(eq(storageUsage.userId, userId))
      .limit(1);
    assert.ok(
      leaseBefore?.expiresAt &&
        leaseAfter?.expiresAt &&
        new Date(leaseAfter.expiresAt).getTime() >
          new Date(leaseBefore.expiresAt).getTime(),
      'the mutation lease heartbeat must extend an unexpired lease'
    );

    await db()
      .update(storageUsage)
      .set({ reconciledAt: new Date(Date.now() + 60_000) })
      .where(eq(storageUsage.userId, userId));
    const acceptedReservation = await reserveStorage({
      userId,
      sessionId: firstSessionId,
      requestedBytes: 700 * MIB,
      idempotencyKey: `${testId}:reserve-a`,
      configs,
      lockToken,
    });
    const [usageAfterReserve] = await db()
      .select({ reconciledAt: storageUsage.reconciledAt })
      .from(storageUsage)
      .where(eq(storageUsage.userId, userId))
      .limit(1);
    assert.equal(
      usageAfterReserve?.reconciledAt,
      null,
      'reservation and reconciliation invalidation must be atomic'
    );
    await assert.rejects(
      reserveStorage({
        userId,
        sessionId: secondSessionId,
        requestedBytes: 700 * MIB,
        idempotencyKey: `${testId}:reserve-b`,
        configs,
        lockToken,
      }),
      /quota/i
    );
    await releaseReservation(acceptedReservation.reservation.id, lockToken);

    const reservation = await reserveStorage({
      userId,
      sessionId: firstSessionId,
      requestedBytes: 64 * MIB,
      idempotencyKey: `${testId}:reconcile-settle`,
      configs,
      lockToken,
    });
    assert.equal(
      await holdReservationForReconciliation(
        reservation.reservation.id,
        64 * MIB,
        firstObjectKey,
        lockToken
      ),
      true
    );
    await settleStorage({
      reservationId: reservation.reservation.id,
      key: firstObjectKey,
      sizeBytes: 64 * MIB,
      configs,
      lockToken,
    });

    const recoverable = await reserveStorage({
      userId,
      sessionId: secondSessionId,
      requestedBytes: 32 * MIB,
      objectKey: recoveredObjectKey,
      idempotencyKey: `${testId}:recoverable-upload`,
      configs,
      lockToken,
    });
    assert.equal(recoverable.reservation.status, 'reserved');
    await db()
      .update(codeSession)
      .set({ archiveKey: recoveredObjectKey })
      .where(eq(codeSession.id, secondSessionId));

    const pagedReservation = await reserveStorage({
      userId,
      sessionId: lastPagedSessionId,
      requestedBytes: 4 * MIB,
      objectKey: pagedObjectKey,
      idempotencyKey: `${testId}:paged-recoverable-upload`,
      configs,
      lockToken,
    });
    const reconciliationHeldAt = Date.now();
    await holdReservationForReconciliation(
      pagedReservation.reservation.id,
      4 * MIB,
      pagedObjectKey,
      lockToken
    );
    const [heldReservation] = await db()
      .select({ expiresAt: storageReservation.expiresAt })
      .from(storageReservation)
      .where(eq(storageReservation.id, pagedReservation.reservation.id))
      .limit(1);
    const reconciliationGraceMs =
      new Date(heldReservation!.expiresAt).getTime() - reconciliationHeldAt;
    assert.ok(
      reconciliationGraceMs >= 14 * 60_000 &&
        reconciliationGraceMs <= 16 * 60_000,
      'ambiguous uploads should use a bounded reconciliation grace period'
    );
  } finally {
    await releaseStorageMutationLock(userId, lockToken);
  }

  await db()
    .insert(configTable)
    .values({
      name: 'billing_usage_webhook_secret',
      value: `storage-test-secret-${testId}`,
    })
    .onConflictDoUpdate({
      target: configTable.name,
      set: { value: `storage-test-secret-${testId}` },
    });
  const originalFetch = globalThis.fetch;
  let expireLeaseOnNextFetch = true;
  let sawLastPagedSession = false;
  let unfinishedUntilFullScan = false;
  globalThis.fetch = async (input) => {
    const url =
      input instanceof Request ? new URL(input.url) : new URL(String(input));
    const sessionId = decodeURIComponent(
      url.pathname.split('/').filter(Boolean).at(-1) || ''
    );
    if (expireLeaseOnNextFetch) {
      expireLeaseOnNextFetch = false;
      const [lockedUsage] = await db()
        .select({ token: storageUsage.reconcileLockToken })
        .from(storageUsage)
        .where(eq(storageUsage.userId, userId))
        .limit(1);
      await db()
        .update(storageUsage)
        .set({ reconcileLockExpiresAt: new Date(Date.now() - 5 * 60_000) })
        .where(
          and(
            eq(storageUsage.userId, userId),
            eq(storageUsage.reconcileLockToken, lockedUsage?.token || '')
          )
        );
    }
    if (sessionId === lastPagedSessionId) {
      sawLastPagedSession = true;
      const [reservationDuringScan] = await db()
        .select({ status: storageReservation.status })
        .from(storageReservation)
        .where(
          eq(storageReservation.idempotencyKey, `${testId}:recoverable-upload`)
        )
        .limit(1);
      unfinishedUntilFullScan = reservationDuringScan?.status === 'reserved';
    }
    const objects =
      sessionId === firstSessionId
        ? [
            {
              key: firstObjectKey,
              size: 64 * MIB,
              uploaded: new Date().toISOString(),
              customMetadata: { workspaceDigest: `${testId}-a` },
            },
          ]
        : sessionId === secondSessionId
          ? [
              {
                key: recoveredObjectKey,
                size: 32 * MIB,
                uploaded: new Date().toISOString(),
                customMetadata: { workspaceDigest: `${testId}-b` },
              },
            ]
          : sessionId === lastPagedSessionId
            ? [
                {
                  key: pagedObjectKey,
                  size: 4 * MIB,
                  uploaded: new Date().toISOString(),
                  customMetadata: { workspaceDigest: `${testId}-page` },
                },
              ]
            : [];
    return Response.json({ ok: true, objects, truncated: false });
  };
  try {
    await assert.rejects(
      reconcileUserStorage(userId, configs, { force: true }),
      /lock was lost/i,
      'an expired reconciliation holder must stop before writing the ledger'
    );
    const [usageAfterLostLease] = await db()
      .select({ reconciledAt: storageUsage.reconciledAt })
      .from(storageUsage)
      .where(eq(storageUsage.userId, userId))
      .limit(1);
    assert.equal(usageAfterLostLease?.reconciledAt, null);

    await reconcileUserStorage(userId, configs, { force: true });
    assert.equal(
      sawLastPagedSession,
      true,
      'all session pages must be scanned'
    );
    assert.equal(
      unfinishedUntilFullScan,
      true,
      'reservations must remain unfinished until the full physical scan ends'
    );

    const [recoveredReservation, pagedReservation] = await Promise.all([
      db()
        .select()
        .from(storageReservation)
        .where(
          eq(storageReservation.idempotencyKey, `${testId}:recoverable-upload`)
        )
        .limit(1)
        .then((rows: Array<typeof storageReservation.$inferSelect>) => rows[0]),
      db()
        .select()
        .from(storageReservation)
        .where(
          eq(
            storageReservation.idempotencyKey,
            `${testId}:paged-recoverable-upload`
          )
        )
        .limit(1)
        .then((rows: Array<typeof storageReservation.$inferSelect>) => rows[0]),
    ]);
    assert.equal(recoveredReservation?.status, 'settled');
    assert.equal(pagedReservation?.status, 'settled');

    await db()
      .delete(codeSession)
      .where(inArray(codeSession.id, pagedSessionIds));
    const reservationLock = await acquireStorageMutationLock(userId);
    let activeMissingReservationId = '';
    try {
      const expiredMissing = await reserveStorage({
        userId,
        sessionId: firstSessionId,
        requestedBytes: MIB,
        objectKey: `${firstObjectKey}.expired-upload`,
        idempotencyKey: `${testId}:expired-missing-upload`,
        configs,
        lockToken: reservationLock,
      });
      await db()
        .update(storageReservation)
        .set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(storageReservation.id, expiredMissing.reservation.id));
      const activeMissing = await reserveStorage({
        userId,
        sessionId: firstSessionId,
        requestedBytes: MIB,
        objectKey: `${firstObjectKey}.still-uploading`,
        idempotencyKey: `${testId}:active-missing-upload`,
        configs,
        lockToken: reservationLock,
      });
      activeMissingReservationId = activeMissing.reservation.id;
      const [expiredBeforeScan] = await db()
        .select({ status: storageReservation.status })
        .from(storageReservation)
        .where(eq(storageReservation.id, expiredMissing.reservation.id))
        .limit(1);
      assert.equal(
        expiredBeforeScan?.status,
        'reserved',
        'a later reservation must not expire an upload before physical scan'
      );
      await db()
        .update(storageUsage)
        .set({ reconciledAt: new Date() })
        .where(eq(storageUsage.userId, userId));
    } finally {
      await releaseStorageMutationLock(userId, reservationLock);
    }

    await reconcileUserStorage(userId, configs);
    const [activeMissingStatus, expiredMissingStatus] = await Promise.all([
      db()
        .select({ status: storageReservation.status })
        .from(storageReservation)
        .where(
          eq(
            storageReservation.idempotencyKey,
            `${testId}:active-missing-upload`
          )
        )
        .limit(1)
        .then((rows: Array<{ status: string }>) => rows[0]?.status),
      db()
        .select({ status: storageReservation.status })
        .from(storageReservation)
        .where(
          eq(
            storageReservation.idempotencyKey,
            `${testId}:expired-missing-upload`
          )
        )
        .limit(1)
        .then((rows: Array<{ status: string }>) => rows[0]?.status),
    ]);
    assert.equal(activeMissingStatus, 'reserved');
    assert.equal(expiredMissingStatus, 'expired');

    const releaseLock = await acquireStorageMutationLock(userId);
    try {
      await releaseReservation(activeMissingReservationId, releaseLock);
    } finally {
      await releaseStorageMutationLock(userId, releaseLock);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const [finalUsage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);
  const [finalReservation] = await db()
    .select()
    .from(storageReservation)
    .where(
      eq(storageReservation.idempotencyKey, `${testId}:recoverable-upload`)
    )
    .limit(1);
  const [{ activeBytes }] = await db()
    .select({
      activeBytes: sql<number>`coalesce(sum(${storageObject.sizeBytes}), 0)`,
    })
    .from(storageObject)
    .where(
      and(
        eq(storageObject.userId, userId),
        inArray(storageObject.status, ['active', 'deleting'])
      )
    );

  assert.equal(Number(finalUsage.reservedBytes), 0);
  assert.equal(Number(finalUsage.usedBytes), Number(activeBytes));
  assert.equal(finalReservation.status, 'settled');
  assert.equal(Number(finalUsage.usedBytes), 100 * MIB);

  console.log('code storage integration tests passed');
} finally {
  await db()
    .delete(configTable)
    .where(eq(configTable.name, 'billing_usage_webhook_secret'))
    .catch(() => undefined);
  await db()
    .delete(user)
    .where(eq(user.id, userId))
    .catch(() => undefined);
}
