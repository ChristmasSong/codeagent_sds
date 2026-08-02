import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/core/db';
import { codeSession, storageObject } from '@/config/db/schema';
import type { StorageObjectSummary } from '@/lib/storage-contract';

import { acquireArchiveLock, releaseArchiveLock } from './service';
import {
  acquireStorageMutationLock,
  markStorageObjectsDeleting,
  releaseStorageMutationLock,
  restoreStorageObjects,
  settleStorageDeletion,
  type StorageCleanupScope,
} from './storage';
import { deleteRuntimeArchives } from './storage-runtime';

export interface StorageCleanupResult {
  deletedBytes: number;
  deletedKeys: string[];
  failedKeys: string[];
}

/**
 * Deletes objects from R2 first, then releases the matching ledger bytes.
 * Failed or unconfirmed keys are restored to active state so quota is never
 * released before physical deletion has been confirmed.
 */
export async function executeStorageCleanup(
  userId: string,
  pending: StorageObjectSummary[],
  lockToken: string
): Promise<StorageCleanupResult> {
  const bySession = new Map<string, StorageObjectSummary[]>();
  for (const object of pending) {
    const rows = bySession.get(object.sessionId) || [];
    rows.push(object);
    bySession.set(object.sessionId, rows);
  }

  const result: StorageCleanupResult = {
    deletedBytes: 0,
    deletedKeys: [],
    failedKeys: [],
  };

  for (const [sessionId, objects] of bySession) {
    const keys = [...new Set(objects.map((object) => object.key))];
    const [session] = await db()
      .select({
        runtimeUserId: codeSession.runtimeUserId,
        archiveKey: codeSession.archiveKey,
      })
      .from(codeSession)
      .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)))
      .limit(1);

    if (!session) {
      await restoreStorageObjects({ userId, keys, lockToken });
      result.failedKeys.push(...keys);
      continue;
    }

    let confirmedKeys: string[];
    let failedKeys: string[];
    try {
      const deleted = await deleteRuntimeArchives({
        runtimeUserId: session.runtimeUserId,
        sessionId,
        keys,
      });
      const confirmed = new Set([
        ...(deleted.deletedKeys || []),
        ...(deleted.notFound || []),
      ]);
      confirmedKeys = keys.filter((key) => confirmed.has(key));
      failedKeys = keys.filter((key) => !confirmed.has(key));
    } catch (error) {
      await restoreStorageObjects({ userId, keys, lockToken });
      result.failedKeys.push(...keys);
      continue;
    }

    if (failedKeys.length > 0) {
      await restoreStorageObjects({
        userId,
        keys: failedKeys,
        lockToken,
      });
      result.failedKeys.push(...failedKeys);
    }

    if (confirmedKeys.length === 0) continue;

    if (session.archiveKey && confirmedKeys.includes(session.archiveKey)) {
      await db()
        .update(codeSession)
        .set({
          archiveKey: null,
          archiveDigest: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(codeSession.userId, userId),
            eq(codeSession.id, sessionId),
            inArray(codeSession.archiveKey, confirmedKeys)
          )
        );
    }

    try {
      const settled = await settleStorageDeletion({
        userId,
        keys: confirmedKeys,
        lockToken,
      });
      result.deletedBytes += settled.deletedBytes;
      result.deletedKeys.push(...settled.deletedKeys);
    } catch {
      // The R2 objects are already confirmed absent. Keep these ledger rows in
      // `deleting` so a retry can finish settlement without re-counting quota.
      result.failedKeys.push(...confirmedKeys);
    }
  }

  if (result.failedKeys.length > 0) {
    throw new Error(
      `${result.failedKeys.length} storage object(s) could not be deleted`
    );
  }

  return result;
}

export async function cleanupStorage(input: {
  userId: string;
  scope: StorageCleanupScope;
  objectId?: string;
  sessionId?: string;
}) {
  let sessionId = input.sessionId || '';
  let objectKey = '';
  if (input.scope === 'object' && input.objectId) {
    const [object] = await db()
      .select({
        sessionId: storageObject.sessionId,
        key: storageObject.key,
      })
      .from(storageObject)
      .where(
        and(
          eq(storageObject.userId, input.userId),
          eq(storageObject.id, input.objectId)
        )
      )
      .limit(1);
    if (sessionId && object?.sessionId && object.sessionId !== sessionId) {
      throw new Error('Storage object does not belong to the session');
    }
    sessionId = object?.sessionId || sessionId;
    objectKey = object?.key || '';
    if (!sessionId) throw new Error('Storage object not found');
  }

  const [session] = sessionId
    ? await db()
        .select()
        .from(codeSession)
        .where(
          and(
            eq(codeSession.userId, input.userId),
            eq(codeSession.id, sessionId)
          )
        )
        .limit(1)
    : [];
  if (sessionId && !session) throw new Error('Session not found');
  const archiveLockToken = session ? await acquireArchiveLock(session) : '';
  let lockToken = '';
  try {
    // Lifecycle operations use archive -> storage lock order. Match that order
    // here so cleanup cannot delete an archive during restore or resume.
    lockToken = await acquireStorageMutationLock(input.userId);
    if (session) {
      const [lockedSession] = await db()
        .select()
        .from(codeSession)
        .where(
          and(
            eq(codeSession.userId, input.userId),
            eq(codeSession.id, session.id),
            eq(codeSession.archiveLockToken, archiveLockToken)
          )
        )
        .limit(1);
      if (!lockedSession) {
        throw new Error('Session changed before storage cleanup could start');
      }
      const removesCurrentArchive =
        input.scope === 'session' ||
        (input.scope === 'object' &&
          Boolean(objectKey) &&
          objectKey === lockedSession.archiveKey);
      if (lockedSession.status === 'active' && removesCurrentArchive) {
        throw new Error(
          'The current archive of an active session cannot be deleted'
        );
      }
    }
    const pending = await markStorageObjectsDeleting({
      ...input,
      lockToken,
    });
    return {
      pending,
      cleanup: await executeStorageCleanup(input.userId, pending, lockToken),
    };
  } finally {
    if (lockToken) {
      await releaseStorageMutationLock(input.userId, lockToken).catch(
        () => undefined
      );
    }
    if (session && archiveLockToken) {
      await releaseArchiveLock(session, archiveLockToken).catch(
        () => undefined
      );
    }
  }
}
