import { and, asc, eq, gt, gte, inArray, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  codeSession,
  storageObject,
  storageReservation,
  storageUsage,
  type StorageObject,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';

import {
  acquireStorageMutationLock,
  getCodeStorageSettings,
  releaseStorageMutationLock,
  renewStorageMutationLock,
  StorageConflictError,
  type StorageConfigMap,
} from './storage';
import { listRuntimeArchives } from './storage-runtime';

const RECONCILE_INTERVAL_MS = 6 * 60 * 60_000;
const RECONCILE_LOCK_MS = 10 * 60_000;

function affectedRows(result: any) {
  for (const candidate of [
    result?.rowsAffected,
    result?.rowCount,
    result?.affectedRows,
    result?.changes,
    result?.meta?.changes,
    result?.[0]?.affectedRows,
    result?.[0]?.meta?.changes,
  ]) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

async function ensureUsageRow(userId: string) {
  let [usage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);
  if (usage) return usage;
  try {
    await db().insert(storageUsage).values({ userId });
  } catch {
    // A concurrent first request may have created the singleton user row.
  }
  [usage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);
  if (!usage) throw new Error('Failed to initialize storage reconciliation');
  return usage;
}

function objectKind(key: string, currentKey: string | null) {
  if (key.includes('/temporary/')) return 'temp';
  return key === currentKey ? 'current' : 'snapshot';
}

function expiryForObject(
  kind: 'current' | 'snapshot' | 'temp',
  uploaded: Date,
  retentionDays: number
) {
  if (kind === 'current') return null;
  const ttlMs =
    kind === 'temp' ? 24 * 60 * 60_000 : retentionDays * 24 * 60 * 60_000;
  return new Date(uploaded.getTime() + ttlMs);
}

export async function reconcileUserStorage(
  userId: string,
  configs: StorageConfigMap,
  options: { force?: boolean; lockToken?: string } = {}
) {
  const usage = await ensureUsageRow(userId);
  const now = new Date();
  const freshnessCutoff = new Date(now.getTime() - RECONCILE_INTERVAL_MS);
  const [unfinishedReservation] = await db()
    .select({ id: storageReservation.id })
    .from(storageReservation)
    .where(
      and(
        eq(storageReservation.userId, userId),
        inArray(storageReservation.status, [
          'reserved',
          'reconcile',
          'settling',
          'releasing',
        ])
      )
    )
    .limit(1);
  if (
    !options.force &&
    !unfinishedReservation &&
    usage.reconciledAt &&
    new Date(usage.reconciledAt).getTime() >= freshnessCutoff.getTime()
  ) {
    return { reconciled: false, reason: 'fresh' as const };
  }

  const ownsLock = !options.lockToken;
  const lockToken =
    options.lockToken ||
    (await acquireStorageMutationLock(userId, RECONCILE_LOCK_MS));

  try {
    const heartbeat = () => renewStorageMutationLock(userId, lockToken);
    await heartbeat();
    const settings = getCodeStorageSettings(configs);
    const sessions: Array<typeof codeSession.$inferSelect> = [];
    let sessionCursor = '';
    for (;;) {
      await heartbeat();
      const page = await db()
        .select()
        .from(codeSession)
        .where(
          sessionCursor
            ? and(
                eq(codeSession.userId, userId),
                gt(codeSession.id, sessionCursor)
              )
            : eq(codeSession.userId, userId)
        )
        .orderBy(asc(codeSession.id))
        .limit(500);
      sessions.push(...page);
      if (page.length < 500) break;
      sessionCursor = page[page.length - 1]!.id;
    }
    const managedSessionIds = sessions.map((session) => session.id);
    const physicalKeys = new Set<string>();

    for (const session of sessions) {
      await heartbeat();
      const objects = await listRuntimeArchives({
        runtimeUserId: session.runtimeUserId,
        sessionId: session.id,
      });
      // A remote listing can take long enough for the lease to change hands.
      // Renew again before making any ledger decision from that response.
      await heartbeat();
      for (let index = 0; index < objects.length; index += 1) {
        if (index > 0 && index % 100 === 0) await heartbeat();
        const object = objects[index]!;
        physicalKeys.add(object.key);
        const kind = objectKind(object.key, session.archiveKey);
        const uploaded = new Date(object.uploaded);
        const createdAt = Number.isNaN(uploaded.getTime()) ? now : uploaded;
        const digest = object.customMetadata?.workspaceDigest || null;
        const [existing] = await db()
          .select()
          .from(storageObject)
          .where(eq(storageObject.key, object.key))
          .limit(1);
        if (existing) {
          if (existing.userId !== userId || existing.sessionId !== session.id) {
            throw new Error(
              'Runtime archive key is already owned by another session'
            );
          }
          await db()
            .update(storageObject)
            .set({
              kind,
              status: 'active',
              sizeBytes: object.size,
              digest,
              expiresAt: expiryForObject(
                kind,
                createdAt,
                settings.retentionDays
              ),
              deletedAt: null,
              updatedAt: now,
            })
            .where(eq(storageObject.id, existing.id));
        } else {
          await db()
            .insert(storageObject)
            .values({
              id: getUuid(),
              userId,
              sessionId: session.id,
              key: object.key,
              kind,
              status: 'active',
              sizeBytes: object.size,
              digest,
              expiresAt: expiryForObject(
                kind,
                createdAt,
                settings.retentionDays
              ),
              createdAt,
              updatedAt: now,
            });
        }
      }
    }

    const missing: StorageObject[] = [];
    for (let offset = 0; offset < managedSessionIds.length; offset += 500) {
      await heartbeat();
      const sessionIds = managedSessionIds.slice(offset, offset + 500);
      const ledgerObjects = await db()
        .select()
        .from(storageObject)
        .where(
          and(
            eq(storageObject.userId, userId),
            inArray(storageObject.sessionId, sessionIds)
          )
        );
      missing.push(
        ...ledgerObjects.filter(
          (object: StorageObject) =>
            object.status !== 'deleted' && !physicalKeys.has(object.key)
        )
      );
    }
    for (let offset = 0; offset < missing.length; offset += 200) {
      await heartbeat();
      const ids = missing
        .slice(offset, offset + 200)
        .map((object: StorageObject) => object.id);
      await db()
        .update(storageObject)
        .set({ status: 'deleted', deletedAt: now, updatedAt: now })
        .where(inArray(storageObject.id, ids));
    }

    // Reservations are terminalized only after every managed session has
    // completed its physical scan, including sessions beyond the first page.
    await heartbeat();
    const unfinished = await db()
      .select()
      .from(storageReservation)
      .where(
        and(
          eq(storageReservation.userId, userId),
          inArray(storageReservation.status, [
            'reserved',
            'reconcile',
            'settling',
            'releasing',
          ])
        )
      );
    for (let index = 0; index < unfinished.length; index += 1) {
      if (index > 0 && index % 100 === 0) await heartbeat();
      const reservation = unfinished[index]!;
      let status = reservation.status;
      if (status === 'releasing') {
        status = 'released';
      } else if (
        status === 'reserved' ||
        status === 'reconcile' ||
        status === 'settling'
      ) {
        if (reservation.objectKey && physicalKeys.has(reservation.objectKey)) {
          status = 'settled';
        } else if (new Date(reservation.expiresAt).getTime() <= now.getTime()) {
          status = status === 'reserved' ? 'expired' : 'released';
        }
      }
      if (status === reservation.status) continue;
      await heartbeat();
      await db()
        .update(storageReservation)
        .set({
          status,
          ...(status === 'settled' ? { settledAt: now } : { releasedAt: now }),
          updatedAt: now,
        })
        .where(
          and(
            eq(storageReservation.id, reservation.id),
            eq(storageReservation.status, reservation.status)
          )
        );
    }

    await heartbeat();
    const activeObjects = await db()
      .select()
      .from(storageObject)
      .where(
        and(
          eq(storageObject.userId, userId),
          inArray(storageObject.status, ['active', 'deleting'])
        )
      );
    const usedBytes = activeObjects.reduce(
      (total: number, object: StorageObject) =>
        total + Number(object.sizeBytes),
      0
    );
    const pendingDeleteBytes = activeObjects
      .filter((object: StorageObject) => object.status === 'deleting')
      .reduce(
        (total: number, object: StorageObject) =>
          total + Number(object.sizeBytes),
        0
      );
    const pendingReservations = await db()
      .select({ reservedBytes: storageReservation.reservedBytes })
      .from(storageReservation)
      .where(
        and(
          eq(storageReservation.userId, userId),
          inArray(storageReservation.status, [
            'reserved',
            'reconcile',
            'settling',
            'releasing',
          ])
        )
      );
    const reservedBytes = pendingReservations.reduce(
      (total: number, reservation: { reservedBytes: unknown }) =>
        total + Number(reservation.reservedBytes),
      0
    );
    // This final renewal is the lease validation boundary for the aggregate
    // ledger write. An expired holder cannot publish a reconciled snapshot.
    await heartbeat();
    const ledgerWriteAt = new Date();
    const usageChanged = await db()
      .update(storageUsage)
      .set({
        usedBytes,
        reservedBytes,
        pendingDeleteBytes,
        reconciledAt: ledgerWriteAt,
        version: sql`${storageUsage.version} + 1`,
        updatedAt: ledgerWriteAt,
      })
      .where(
        and(
          eq(storageUsage.userId, userId),
          eq(storageUsage.reconcileLockToken, lockToken),
          gte(storageUsage.reconcileLockExpiresAt, ledgerWriteAt)
        )
      );
    if (affectedRows(usageChanged) !== 1) {
      throw new StorageConflictError('Storage mutation lock was lost');
    }
    return {
      reconciled: true,
      sessions: sessions.length,
      objects: physicalKeys.size,
      usedBytes,
      reservedBytes,
    };
  } finally {
    if (ownsLock) {
      await releaseStorageMutationLock(userId, lockToken).catch(
        () => undefined
      );
    }
  }
}
