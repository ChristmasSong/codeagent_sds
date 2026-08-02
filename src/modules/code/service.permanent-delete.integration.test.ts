import assert from 'node:assert/strict';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  codeBillingEvent,
  codeSession,
  storageObject,
  storageReservation,
  storageUsage,
  user,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

import {
  deleteSessionPermanently,
  discardSession,
  getOwnedSession,
  preflightSessionResume,
  resumeArchivedSession,
  toView,
} from './service';
import {
  acquireStorageMutationLock,
  releaseStorageMutationLock,
} from './storage';

const testId = getUuid();
const failedSessionIds = new Set<string>();
const partialFailures = new Map<
  string,
  { deletedKey: string; failedKey: string }
>();
const requests: Array<{ action: string; sessionId: string }> = [];
const originalFetch = globalThis.fetch;
const billingFailureTrigger = 'fail_permanent_delete_billing';
const auditFailureTrigger = 'fail_permanent_delete_audit';

function requestsFor(sessionId: string, ...actions: string[]) {
  return requests.filter(
    (request) =>
      request.sessionId === sessionId && actions.includes(request.action)
  );
}

function errorChainText(error: unknown) {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if (current instanceof Error) messages.push(current.message);
    current =
      typeof current === 'object' && current && 'cause' in current
        ? (current as { cause?: unknown }).cause
        : null;
  }
  return messages.join('\n');
}

async function runtimeBillingEventCount(sessionId: string) {
  const rows = (await db()
    .select({ id: codeBillingEvent.id })
    .from(codeBillingEvent)
    .where(
      and(
        eq(codeBillingEvent.sessionId, sessionId),
        eq(codeBillingEvent.eventType, 'runtime_minutes')
      )
    )) as Array<{ id: string }>;
  return rows.length;
}

function ids(label: string) {
  return {
    userId: `delete-test-user-${label}-${testId}`,
    sessionId: `delete-test-session-${label}-${testId}`,
    runtimeUserId: `delete-test-runtime-${label}-${testId}`,
    reservationId: `delete-test-reservation-${label}-${testId}`,
    objectId: `delete-test-object-${label}-${testId}`,
    key: `integrated-workspaces/delete-test-${label}-${testId}/archives/current.tar.gz`,
  };
}

async function seedCase(input: {
  label: string;
  status: 'active' | 'suspended' | 'ended';
  bytes: number;
  additionalActiveSession?: boolean;
}) {
  const seeded = ids(input.label);
  await db()
    .insert(user)
    .values({
      id: seeded.userId,
      name: `Permanent delete ${input.label}`,
      email: `${seeded.userId}@example.test`,
    });
  await db().insert(codeSession).values({
    id: seeded.sessionId,
    userId: seeded.userId,
    runtimeUserId: seeded.runtimeUserId,
    status: input.status,
    archiveKey: seeded.key,
    lastBilledAt: new Date(),
  });
  if (input.additionalActiveSession) {
    await db()
      .insert(codeSession)
      .values({
        id: `${seeded.sessionId}-other`,
        userId: seeded.userId,
        runtimeUserId: `${seeded.runtimeUserId}-other`,
        status: 'active',
        lastBilledAt: new Date(),
      });
  }
  await db().insert(storageUsage).values({
    userId: seeded.userId,
    usedBytes: input.bytes,
  });
  await db()
    .insert(storageReservation)
    .values({
      id: seeded.reservationId,
      userId: seeded.userId,
      sessionId: seeded.sessionId,
      idempotencyKey: `${seeded.reservationId}-idempotency`,
      requestedBytes: input.bytes,
      actualBytes: input.bytes,
      status: 'settled',
      expiresAt: new Date(Date.now() + 60_000),
      settledAt: new Date(),
    });
  await db().insert(storageObject).values({
    id: seeded.objectId,
    userId: seeded.userId,
    sessionId: seeded.sessionId,
    key: seeded.key,
    kind: 'current',
    status: 'active',
    sizeBytes: input.bytes,
    reservationId: seeded.reservationId,
  });
  return seeded;
}

globalThis.fetch = async (input, init) => {
  const url =
    input instanceof Request ? new URL(input.url) : new URL(String(input));
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[0] || '';
  const sessionId = decodeURIComponent(parts.at(-1) || '');
  requests.push({ action, sessionId });

  if (action === 'destroy') {
    return Response.json({ ok: true, destroyed: true });
  }
  if (action === 'purge') {
    return Response.json({ ok: true, cleared: true });
  }
  if (action === 'archive-delete') {
    const partial = partialFailures.get(sessionId);
    if (partial) {
      const body = JSON.parse(String(init?.body || '{}'));
      const deletingAll = body.scope === 'all';
      return Response.json({
        ok: false,
        scope: deletingAll ? 'all' : 'keys',
        keptKey: null,
        deleted: deletingAll ? [{ key: partial.deletedKey, bytes: 10 }] : [],
        deletedKeys: deletingAll ? [partial.deletedKey] : [],
        deletedBytes: deletingAll ? 10 : 0,
        notFound: [],
        failed: [
          { key: partial.failedKey, error: 'simulated partial failure' },
        ],
      });
    }
    if (failedSessionIds.has(sessionId)) {
      return Response.json({
        ok: false,
        scope: 'all',
        keptKey: null,
        deleted: [],
        deletedKeys: [],
        deletedBytes: 0,
        notFound: [],
        failed: [{ key: `failed-${sessionId}`, error: 'simulated failure' }],
      });
    }
    const body = JSON.parse(String(init?.body || '{}'));
    assert.deepEqual(body, { scope: 'all' });
    return Response.json({
      ok: true,
      scope: 'all',
      keptKey: null,
      deleted: [],
      deletedKeys: [],
      deletedBytes: 0,
      notFound: [],
      failed: [],
    });
  }
  throw new Error(`Unexpected test request: ${url.pathname}`);
};

try {
  const active = await seedCase({
    label: 'active',
    status: 'active',
    bytes: 10,
  });
  const foreign = await seedCase({
    label: 'foreign',
    status: 'ended',
    bytes: 11,
  });
  const requestsBeforeForeignAttempt = requests.length;
  await assert.rejects(
    deleteSessionPermanently(foreign.userId, active.sessionId),
    /Session not found/
  );
  assert.equal(
    requests.length,
    requestsBeforeForeignAttempt,
    'ownership failure must happen before Runtime or R2 calls'
  );

  const activeResult = await deleteSessionPermanently(
    active.userId,
    active.sessionId
  );
  assert.equal(activeResult.deleted, true);
  assert.equal(activeResult.sessionId, active.sessionId);
  assert.equal(activeResult.runtime.attempted, true);
  assert.equal(
    await getOwnedSession(active.userId, active.sessionId),
    undefined
  );
  const [activeUsage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, active.userId))
    .limit(1);
  assert.equal(Number(activeUsage.usedBytes), 0);
  assert.equal(Number(activeUsage.reservedBytes), 0);
  assert.equal(
    requests.some(
      (request) =>
        request.action === 'destroy' && request.sessionId === active.sessionId
    ),
    true,
    'a sole active session must destroy its Runtime container'
  );

  const archived = await seedCase({
    label: 'archived',
    status: 'suspended',
    bytes: 20,
  });
  const archivedResult = await deleteSessionPermanently(
    archived.userId,
    archived.sessionId
  );
  assert.equal(archivedResult.runtime.attempted, true);
  assert.equal(
    archivedResult.runtime.action,
    'destroy',
    'a suspended session must clean up any Runtime container left behind'
  );
  assert.equal(
    requestsFor(archived.sessionId, 'destroy').length,
    1,
    'a suspended session must attempt Runtime cleanup exactly once'
  );

  const ended = await seedCase({
    label: 'ended',
    status: 'ended',
    bytes: 21,
  });
  const endedResult = await deleteSessionPermanently(
    ended.userId,
    ended.sessionId
  );
  assert.equal(endedResult.runtime.attempted, true);
  assert.equal(endedResult.runtime.action, 'destroy');
  assert.equal(
    requestsFor(ended.sessionId, 'destroy').length,
    1,
    'an ended session must also clean up any Runtime container left behind'
  );

  const concurrent = await seedCase({
    label: 'concurrent',
    status: 'active',
    bytes: 30,
    additionalActiveSession: true,
  });
  const concurrentResult = await deleteSessionPermanently(
    concurrent.userId,
    concurrent.sessionId
  );
  assert.equal(concurrentResult.deleted, true);
  assert.equal(
    await getOwnedSession(concurrent.userId, concurrent.sessionId),
    undefined,
    'an independent per-session Runtime can be deleted'
  );
  assert.ok(
    await getOwnedSession(concurrent.userId, `${concurrent.sessionId}-other`),
    'the other active session must remain intact'
  );

  const sharedRuntime = await seedCase({
    label: 'shared-runtime',
    status: 'active',
    bytes: 31,
    additionalActiveSession: true,
  });
  await db()
    .update(codeSession)
    .set({ runtimeUserId: sharedRuntime.runtimeUserId })
    .where(eq(codeSession.id, `${sharedRuntime.sessionId}-other`));
  const sharedRuntimeResult = await deleteSessionPermanently(
    sharedRuntime.userId,
    sharedRuntime.sessionId
  );
  assert.equal(sharedRuntimeResult.deleted, true);
  assert.equal(sharedRuntimeResult.runtime.action, 'purge');
  assert.equal(
    await getOwnedSession(sharedRuntime.userId, sharedRuntime.sessionId),
    undefined,
    'the target session must still be deleted after its workspace is purged'
  );
  assert.ok(
    await getOwnedSession(
      sharedRuntime.userId,
      `${sharedRuntime.sessionId}-other`
    ),
    'the other active session sharing the Runtime must remain intact'
  );
  assert.equal(
    requestsFor(sharedRuntime.sessionId, 'purge').length,
    1,
    'shared Runtime deletion must purge only the target workspace'
  );
  assert.equal(
    requestsFor(sharedRuntime.sessionId, 'destroy').length,
    0,
    'the shared Runtime container itself must not be destroyed'
  );

  const billingFailure = await seedCase({
    label: 'billing-failure',
    status: 'active',
    bytes: 35,
  });
  await db()
    .update(codeSession)
    .set({
      createdAt: new Date(Date.now() - 24 * 60 * 60_000),
      lastBilledAt: new Date(Date.now() - 10 * 60_000),
    })
    .where(eq(codeSession.id, billingFailure.sessionId));
  await db().run(sql.raw(`drop trigger if exists ${billingFailureTrigger}`));
  await db().run(
    sql.raw(`
      create trigger ${billingFailureTrigger}
      before insert on code_billing_event
      when new.session_id = '${billingFailure.sessionId}'
        and new.event_type = 'runtime_minutes'
      begin
        select raise(fail, 'simulated final billing failure');
      end
    `)
  );
  const requestsBeforeBillingFailure = requests.length;
  await assert.rejects(
    deleteSessionPermanently(billingFailure.userId, billingFailure.sessionId),
    (error) => {
      assert.match(errorChainText(error), /simulated final billing failure/);
      return true;
    }
  );
  await db().run(sql.raw(`drop trigger if exists ${billingFailureTrigger}`));
  assert.deepEqual(
    requests.slice(requestsBeforeBillingFailure),
    [],
    'billing failure must happen before Runtime cleanup or R2 deletion'
  );
  const billingPendingSession = await getOwnedSession(
    billingFailure.userId,
    billingFailure.sessionId
  );
  assert.ok(billingPendingSession, 'billing failure must retain the session');
  assert.equal(billingPendingSession.status, 'ended');
  assert.match(billingPendingSession.suspensionReason, /^delete_pending:/);
  assert.equal(toView(billingPendingSession).deletionPending, true);
  const requestsBeforePendingResume = requests.length;
  await assert.rejects(
    preflightSessionResume(billingFailure.userId, billingFailure.sessionId),
    /pending.*deletion|deletion.*pending/i
  );
  await assert.rejects(
    resumeArchivedSession(billingFailure.userId, billingFailure.sessionId),
    /pending.*deletion|deletion.*pending/i
  );
  assert.equal(
    requests.length,
    requestsBeforePendingResume,
    'a deletion-pending session must be rejected before Runtime restore'
  );

  const retryable = await seedCase({
    label: 'retryable',
    status: 'active',
    bytes: 40,
  });
  failedSessionIds.add(retryable.sessionId);
  await assert.rejects(
    deleteSessionPermanently(retryable.userId, retryable.sessionId),
    /could not be deleted/
  );
  const retryablePendingSession = await getOwnedSession(
    retryable.userId,
    retryable.sessionId
  );
  assert.ok(
    retryablePendingSession,
    'an R2 failure must retain the session for retry'
  );
  assert.equal(retryablePendingSession.status, 'ended');
  assert.match(retryablePendingSession.suspensionReason, /^delete_pending:/);
  assert.equal(
    toView(retryablePendingSession).deletionPending,
    true,
    'a failed permanent deletion must remain visibly retryable'
  );
  assert.equal(
    requestsFor(retryable.sessionId, 'destroy', 'purge').length,
    1,
    'Runtime cleanup must finish before the injected R2 failure'
  );
  assert.equal(
    await runtimeBillingEventCount(retryable.sessionId),
    1,
    'the first active deletion attempt must durably record final billing'
  );
  const [retryableObject, retryableUsage] = await Promise.all([
    db()
      .select()
      .from(storageObject)
      .where(
        and(
          eq(storageObject.userId, retryable.userId),
          eq(storageObject.sessionId, retryable.sessionId)
        )
      )
      .limit(1)
      .then((rows: Array<typeof storageObject.$inferSelect>) => rows[0]),
    db()
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.userId, retryable.userId))
      .limit(1)
      .then((rows: Array<typeof storageUsage.$inferSelect>) => rows[0]),
  ]);
  assert.equal(retryableObject?.status, 'active');
  assert.equal(Number(retryableUsage?.usedBytes), 40);
  assert.equal(Number(retryableUsage?.pendingDeleteBytes), 0);

  const runtimeCleanupCountBeforeRetry = requestsFor(
    retryable.sessionId,
    'destroy',
    'purge'
  ).length;
  const billingEventCountBeforeRetry = await runtimeBillingEventCount(
    retryable.sessionId
  );
  failedSessionIds.delete(retryable.sessionId);
  const retried = await deleteSessionPermanently(
    retryable.userId,
    retryable.sessionId
  );
  assert.equal(retried.deleted, true);
  assert.equal(
    await getOwnedSession(retryable.userId, retryable.sessionId),
    undefined
  );
  assert.equal(
    requestsFor(retryable.sessionId, 'destroy', 'purge').length,
    runtimeCleanupCountBeforeRetry,
    'retrying after an R2 failure must not repeat successful Runtime cleanup'
  );
  assert.equal(
    await runtimeBillingEventCount(retryable.sessionId),
    billingEventCountBeforeRetry,
    'retrying after an R2 failure must not create another final billing event'
  );

  const locked = await seedCase({
    label: 'storage-lock',
    status: 'active',
    bytes: 41,
  });
  const heldStorageLock = await acquireStorageMutationLock(locked.userId);
  const requestsBeforeLockConflict = requests.length;
  await assert.rejects(
    deleteSessionPermanently(locked.userId, locked.sessionId),
    /storage operation is already running/i
  );
  assert.equal(
    requests.length,
    requestsBeforeLockConflict,
    'a storage-lock conflict must fail before Runtime destruction'
  );
  await releaseStorageMutationLock(locked.userId, heldStorageLock);
  assert.equal(
    (await deleteSessionPermanently(locked.userId, locked.sessionId)).deleted,
    true
  );

  const partial = await seedCase({
    label: 'partial',
    status: 'ended',
    bytes: 10,
  });
  const partialSnapshotKey = `${partial.key}.snapshot`;
  await db()
    .insert(storageObject)
    .values({
      id: `${partial.objectId}-snapshot`,
      userId: partial.userId,
      sessionId: partial.sessionId,
      key: partialSnapshotKey,
      kind: 'snapshot',
      status: 'active',
      sizeBytes: 15,
    });
  await db()
    .update(storageUsage)
    .set({ usedBytes: 25 })
    .where(eq(storageUsage.userId, partial.userId));
  partialFailures.set(partial.sessionId, {
    deletedKey: partial.key,
    failedKey: partialSnapshotKey,
  });
  await assert.rejects(
    deleteSessionPermanently(partial.userId, partial.sessionId),
    /could not be deleted/
  );
  const [partialSession, partialRows, partialUsage] = await Promise.all([
    getOwnedSession(partial.userId, partial.sessionId),
    db()
      .select()
      .from(storageObject)
      .where(eq(storageObject.sessionId, partial.sessionId)),
    db()
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.userId, partial.userId))
      .limit(1)
      .then((rows: Array<typeof storageUsage.$inferSelect>) => rows[0]),
  ]);
  const typedPartialRows = partialRows as Array<
    typeof storageObject.$inferSelect
  >;
  assert.equal(
    partialSession?.archiveKey,
    null,
    'a physically deleted current archive must not remain as the restore pointer'
  );
  assert.equal(
    typedPartialRows.find((row) => row.key === partial.key)?.status,
    'deleted'
  );
  assert.equal(
    typedPartialRows.find((row) => row.key === partialSnapshotKey)?.status,
    'active'
  );
  assert.equal(Number(partialUsage?.usedBytes), 15);
  assert.equal(Number(partialUsage?.pendingDeleteBytes), 0);
  partialFailures.delete(partial.sessionId);
  assert.equal(
    (await deleteSessionPermanently(partial.userId, partial.sessionId)).deleted,
    true
  );

  const legacyPartial = await seedCase({
    label: 'legacy-partial',
    status: 'ended',
    bytes: 12,
  });
  const legacyUntrackedSnapshotKey = `${legacyPartial.key}.untracked-snapshot`;
  await db()
    .delete(storageObject)
    .where(
      and(
        eq(storageObject.userId, legacyPartial.userId),
        eq(storageObject.sessionId, legacyPartial.sessionId)
      )
    );
  await db()
    .delete(storageReservation)
    .where(
      and(
        eq(storageReservation.userId, legacyPartial.userId),
        eq(storageReservation.sessionId, legacyPartial.sessionId)
      )
    );
  await db()
    .update(storageUsage)
    .set({ usedBytes: 0 })
    .where(eq(storageUsage.userId, legacyPartial.userId));
  partialFailures.set(legacyPartial.sessionId, {
    deletedKey: legacyPartial.key,
    failedKey: legacyUntrackedSnapshotKey,
  });
  await assert.rejects(
    deleteSessionPermanently(legacyPartial.userId, legacyPartial.sessionId),
    /could not be deleted/
  );
  assert.equal(
    (await getOwnedSession(legacyPartial.userId, legacyPartial.sessionId))
      ?.archiveKey,
    null,
    'an untracked legacy archive deleted during a mixed R2 result must not remain as the restore pointer'
  );
  partialFailures.delete(legacyPartial.sessionId);
  assert.equal(
    (
      await deleteSessionPermanently(
        legacyPartial.userId,
        legacyPartial.sessionId
      )
    ).deleted,
    true
  );

  const discarded = await seedCase({
    label: 'discard',
    status: 'active',
    bytes: 50,
  });
  const discardedResult = await discardSession(
    discarded.userId,
    discarded.sessionId
  );
  assert.equal(discardedResult.deleted, true);
  assert.equal(discardedResult.session.status, 'ended');
  assert.equal(discardedResult.session.archiveKey, null);
  assert.equal(
    await getOwnedSession(discarded.userId, discarded.sessionId),
    undefined,
    'discard must reuse permanent cleanup without breaking its session response'
  );

  const interrupted = await seedCase({
    label: 'interrupted',
    status: 'ended',
    bytes: 60,
  });
  await db()
    .delete(storageObject)
    .where(
      and(
        eq(storageObject.userId, interrupted.userId),
        eq(storageObject.sessionId, interrupted.sessionId)
      )
    );
  await db()
    .delete(storageReservation)
    .where(
      and(
        eq(storageReservation.userId, interrupted.userId),
        eq(storageReservation.sessionId, interrupted.sessionId)
      )
    );
  const interruptedResult = await deleteSessionPermanently(
    interrupted.userId,
    interrupted.sessionId
  );
  assert.equal(interruptedResult.deleted, true);
  const [interruptedUsage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, interrupted.userId))
    .limit(1);
  assert.equal(
    Number(interruptedUsage.usedBytes),
    0,
    'a retry must reconcile stale usage after an interrupted D1 finalization'
  );

  const auditFailure = await seedCase({
    label: 'audit-failure',
    status: 'ended',
    bytes: 70,
  });
  await db().run(sql.raw(`drop trigger if exists ${auditFailureTrigger}`));
  await db().run(
    sql.raw(`
      create trigger ${auditFailureTrigger}
      before insert on code_session_event
      when new.event_type = 'session.deleted_permanently'
      begin
        select raise(fail, 'simulated audit failure');
      end
    `)
  );
  const auditFailureResult = await deleteSessionPermanently(
    auditFailure.userId,
    auditFailure.sessionId
  );
  assert.equal(
    auditFailureResult.deleted,
    true,
    'best-effort audit failure must not turn completed deletion into an API error'
  );
  assert.equal(
    await getOwnedSession(auditFailure.userId, auditFailure.sessionId),
    undefined
  );
  await db().run(sql.raw(`drop trigger if exists ${auditFailureTrigger}`));

  console.info('code session permanent deletion integration tests passed');
} finally {
  try {
    await db().run(sql.raw(`drop trigger if exists ${billingFailureTrigger}`));
    await db().run(sql.raw(`drop trigger if exists ${auditFailureTrigger}`));
  } catch {
    // Best-effort test cleanup; the primary failure should remain visible.
  }
  globalThis.fetch = originalFetch;
}
