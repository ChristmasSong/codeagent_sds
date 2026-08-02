import { and, inArray } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  codeSession,
  storageObject,
  type StorageObject,
} from '@/config/db/schema';

import { acquireArchiveLock, releaseArchiveLock } from './service';
import {
  acquireStorageMutationLock,
  getCodeStorageSettings,
  releaseStorageMutationLock,
  settleStorageDeletion,
  type StorageConfigMap,
} from './storage';
import {
  deleteRuntimeArchives,
  type RuntimeArchiveObject,
} from './storage-runtime';

export const STORAGE_GC_ORPHAN_GRACE_MS = 24 * 60 * 60_000;
export const STORAGE_GC_TEMP_TTL_MS = 24 * 60 * 60_000;
const QUERY_BATCH_SIZE = 200;

export type StorageGcReason =
  | 'orphan_session'
  | 'stale_unpointed'
  | 'temporary_ttl'
  | 'snapshot_retention';

export interface ParsedManagedArchiveKey {
  runtimeUserId: string;
  sessionId: string;
  relativeKey: string;
}

export interface StorageGcCandidate {
  key: string;
  size: number;
  uploaded: string;
  runtimeUserId: string;
  sessionId: string;
  reason: StorageGcReason;
}

interface StorageGcSession {
  id: string;
  userId: string;
  runtimeUserId: string;
  archiveKey: string | null;
}

interface StorageGcLedgerObject {
  key: string;
  userId: string;
  sessionId: string;
  kind: string;
  status: string;
  expiresAt?: Date | null;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function batches<T>(values: T[], size = QUERY_BATCH_SIZE) {
  const pages: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    pages.push(values.slice(offset, offset + size));
  }
  return pages;
}

function safeDecode(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

/**
 * Parses only known managed R2 layouts. Unknown layouts are left untouched so
 * a malformed request cannot broaden deletion scope. The canonical legacy
 * `workspace.tar.gz` key is recognized and handled with pointer grace below.
 */
export function parseManagedArchiveKey(
  key: string
): ParsedManagedArchiveKey | null {
  const parts = key.split('/');
  if (
    parts.length < 4 ||
    parts[0] !== 'integrated-workspaces' ||
    !parts[1] ||
    !parts[2]
  ) {
    return null;
  }
  const runtimeUserId = safeDecode(parts[1]);
  const sessionId = safeDecode(parts[2]);
  const relativeKey = parts.slice(3).join('/');
  if (!runtimeUserId || !sessionId || !relativeKey) return null;
  const knownLayout =
    relativeKey === 'workspace.tar.gz' ||
    /^archives\/[^/]+\.tar\.gz$/.test(relativeKey) ||
    /^temporary\/[^/]+$/.test(relativeKey);
  if (!knownLayout) return null;
  return { runtimeUserId, sessionId, relativeKey };
}

function uploadedAt(object: RuntimeArchiveObject) {
  const uploaded = new Date(object.uploaded);
  return Number.isNaN(uploaded.getTime()) ? null : uploaded;
}

function isTemporaryKey(relativeKey: string) {
  return /^temporary\/[^/]+$/.test(relativeKey);
}

function isVersionKey(relativeKey: string) {
  return /^archives\/[^/]+\.tar\.gz$/.test(relativeKey);
}

/**
 * Pure classification boundary used by both the database planner and tests.
 * The code-session archive pointer is authoritative. A recent non-deleted
 * ledger entry marked current receives a short fallback grace while an archive
 * pointer may still be settling, but cannot protect stale discard objects
 * forever.
 */
export function classifyStorageGcObject(input: {
  object: RuntimeArchiveObject;
  parsed: ParsedManagedArchiveKey;
  session?: StorageGcSession;
  ledger?: StorageGcLedgerObject;
  retentionDays: number;
  now?: Date;
}): StorageGcCandidate | null {
  const now = input.now || new Date();
  const uploaded = uploadedAt(input.object);
  if (!uploaded) return null;
  const ageMs = now.getTime() - uploaded.getTime();
  if (ageMs < 0) return null;

  const sessionMatches =
    input.session &&
    input.session.id === input.parsed.sessionId &&
    input.session.runtimeUserId === input.parsed.runtimeUserId;
  if (!sessionMatches) {
    if (ageMs < STORAGE_GC_ORPHAN_GRACE_MS) return null;
    return {
      key: input.object.key,
      size: input.object.size,
      uploaded: uploaded.toISOString(),
      runtimeUserId: input.parsed.runtimeUserId,
      sessionId: input.parsed.sessionId,
      reason: 'orphan_session',
    };
  }

  if (input.session?.archiveKey === input.object.key) return null;

  const ledgerCurrent =
    input.ledger?.kind === 'current' &&
    input.ledger.status !== 'deleted' &&
    input.ledger.sessionId === input.parsed.sessionId;
  if (ledgerCurrent && ageMs < STORAGE_GC_ORPHAN_GRACE_MS) return null;
  if (
    ageMs >= STORAGE_GC_ORPHAN_GRACE_MS &&
    (ledgerCurrent || input.parsed.relativeKey === 'workspace.tar.gz')
  ) {
    return {
      key: input.object.key,
      size: input.object.size,
      uploaded: uploaded.toISOString(),
      runtimeUserId: input.parsed.runtimeUserId,
      sessionId: input.parsed.sessionId,
      reason: 'stale_unpointed',
    };
  }

  let reason: StorageGcReason | null = null;
  if (
    isTemporaryKey(input.parsed.relativeKey) &&
    ageMs >= STORAGE_GC_TEMP_TTL_MS
  ) {
    reason = 'temporary_ttl';
  } else if (
    isVersionKey(input.parsed.relativeKey) &&
    input.ledger?.kind === 'snapshot' &&
    input.ledger.status !== 'deleted'
  ) {
    // A current object may be old when it is first demoted to a snapshot.
    // Its ledger expiry starts at demotion time and is authoritative over the
    // original R2 upload timestamp.
    if (
      input.ledger.expiresAt &&
      input.ledger.expiresAt.getTime() <= now.getTime()
    ) {
      reason = 'snapshot_retention';
    }
  } else if (
    isVersionKey(input.parsed.relativeKey) &&
    ageMs >= Math.max(1, input.retentionDays) * 24 * 60 * 60_000
  ) {
    // Untracked physical snapshots fall back to their R2 upload age.
    reason = 'snapshot_retention';
  }
  if (!reason) return null;

  return {
    key: input.object.key,
    size: input.object.size,
    uploaded: uploaded.toISOString(),
    runtimeUserId: input.parsed.runtimeUserId,
    sessionId: input.parsed.sessionId,
    reason,
  };
}

export async function planStorageGc(input: {
  objects: RuntimeArchiveObject[];
  configs: StorageConfigMap;
  now?: Date;
}) {
  const physicalObjects = [
    ...new Map(input.objects.map((object) => [object.key, object])).values(),
  ];
  const parsedObjects = physicalObjects
    .map((object) => ({
      object,
      parsed: parseManagedArchiveKey(object.key),
    }))
    .filter(
      (
        item
      ): item is {
        object: RuntimeArchiveObject;
        parsed: ParsedManagedArchiveKey;
      } => Boolean(item.parsed)
    );

  const sessions = new Map<string, StorageGcSession>();
  const sessionIds = unique(
    parsedObjects.map(({ parsed }) => parsed.sessionId)
  );
  for (const ids of batches(sessionIds)) {
    const rows = await db()
      .select({
        id: codeSession.id,
        userId: codeSession.userId,
        runtimeUserId: codeSession.runtimeUserId,
        archiveKey: codeSession.archiveKey,
      })
      .from(codeSession)
      .where(inArray(codeSession.id, ids));
    for (const row of rows) sessions.set(row.id, row);
  }

  const ledger = new Map<string, StorageGcLedgerObject>();
  const keys = unique(parsedObjects.map(({ object }) => object.key));
  for (const pageKeys of batches(keys)) {
    const rows = await db()
      .select({
        key: storageObject.key,
        userId: storageObject.userId,
        sessionId: storageObject.sessionId,
        kind: storageObject.kind,
        status: storageObject.status,
        expiresAt: storageObject.expiresAt,
      })
      .from(storageObject)
      .where(inArray(storageObject.key, pageKeys));
    for (const row of rows) ledger.set(row.key, row);
  }

  const { retentionDays } = getCodeStorageSettings(input.configs);
  const candidates = parsedObjects
    .map(({ object, parsed }) =>
      classifyStorageGcObject({
        object,
        parsed,
        session: sessions.get(parsed.sessionId),
        ledger: ledger.get(object.key),
        retentionDays,
        now: input.now,
      })
    )
    .filter((candidate): candidate is StorageGcCandidate => Boolean(candidate));

  return {
    scanned: physicalObjects.length,
    managed: parsedObjects.length,
    candidates,
  };
}

async function settleConfirmedStorageGcDeletionForUser(input: {
  userId: string;
  keys: string[];
  lockToken: string;
}) {
  const keys = unique(input.keys);
  if (keys.length === 0) {
    return { ledgerDeleted: 0, deletedBytes: 0 };
  }
  const rows = await db()
    .select()
    .from(storageObject)
    .where(
      and(
        inArray(storageObject.key, keys),
        inArray(storageObject.userId, [input.userId])
      )
    );
  const activeRows = rows.filter(
    (row) => row.status === 'active' || row.status === 'deleting'
  );
  const settled = await settleStorageDeletion({
    userId: input.userId,
    keys: activeRows.map((row) => row.key),
    lockToken: input.lockToken,
  });
  const remaining = rows.filter(
    (row) =>
      row.status !== 'active' &&
      row.status !== 'deleting' &&
      row.status !== 'deleted'
  );
  if (remaining.length > 0) {
    const now = new Date();
    await db()
      .update(storageObject)
      .set({ status: 'deleted', deletedAt: now, updatedAt: now })
      .where(
        and(
          inArray(
            storageObject.id,
            remaining.map((row) => row.id)
          ),
          inArray(storageObject.status, ['pending', 'failed'])
        )
      );
  }
  return {
    ledgerDeleted: settled.deletedKeys.length + remaining.length,
    deletedBytes: settled.deletedBytes,
  };
}

/**
 * Settles the logical ledger only for keys that Runtime has physically
 * deleted and then confirmed absent with R2 HEAD.
 */
export async function settleConfirmedStorageGcDeletion(keys: string[]) {
  const confirmedKeys = unique(
    keys.filter((key) => Boolean(parseManagedArchiveKey(key)))
  );
  if (confirmedKeys.length === 0) {
    return { confirmed: 0, ledgerDeleted: 0, deletedBytes: 0 };
  }

  const currentRows = await db()
    .select({ key: codeSession.archiveKey })
    .from(codeSession)
    .where(inArray(codeSession.archiveKey, confirmedKeys));
  const currentKeys = new Set(
    currentRows
      .map((row) => row.key)
      .filter((key): key is string => Boolean(key))
  );
  if (currentKeys.size > 0) {
    throw new Error(
      `Refusing to settle ${currentKeys.size} current workspace archive(s)`
    );
  }

  const ledgerRows: StorageObject[] = [];
  for (const pageKeys of batches(confirmedKeys)) {
    ledgerRows.push(
      ...(await db()
        .select()
        .from(storageObject)
        .where(inArray(storageObject.key, pageKeys)))
    );
  }
  const rowsByUser = new Map<string, StorageObject[]>();
  for (const row of ledgerRows) {
    if (row.status === 'deleted') continue;
    const rows = rowsByUser.get(row.userId) || [];
    rows.push(row);
    rowsByUser.set(row.userId, rows);
  }

  let ledgerDeleted = 0;
  let deletedBytes = 0;
  for (const [userId, rows] of rowsByUser) {
    const lockToken = await acquireStorageMutationLock(userId);
    try {
      const settled = await settleConfirmedStorageGcDeletionForUser({
        userId,
        keys: rows.map((row) => row.key),
        lockToken,
      });
      ledgerDeleted += settled.ledgerDeleted;
      deletedBytes += settled.deletedBytes;
    } finally {
      await releaseStorageMutationLock(userId, lockToken).catch(
        () => undefined
      );
    }
  }

  return {
    confirmed: confirmedKeys.length,
    ledgerDeleted,
    deletedBytes,
  };
}

/**
 * Revalidates and deletes one scheduled page while holding the same archive
 * and user-storage locks used by archive, restore, cleanup, and permanent
 * deletion. Runtime verifies physical absence before a key is settled.
 */
export async function sweepStorageGc(input: {
  objects: RuntimeArchiveObject[];
  configs: StorageConfigMap;
  now?: Date;
}) {
  const plan = await planStorageGc(input);
  const objectsByKey = new Map(
    input.objects.map((object) => [object.key, object])
  );
  const groups = new Map<string, StorageGcCandidate[]>();
  for (const candidate of plan.candidates) {
    const groupKey = `${candidate.runtimeUserId}\0${candidate.sessionId}`;
    const rows = groups.get(groupKey) || [];
    rows.push(candidate);
    groups.set(groupKey, rows);
  }

  const deletedKeys: string[] = [];
  const failedKeys: string[] = [];
  const skippedKeys: string[] = [];

  for (const candidates of groups.values()) {
    const first = candidates[0]!;
    const candidateKeys = new Set(candidates.map((candidate) => candidate.key));
    const [session] = await db()
      .select()
      .from(codeSession)
      .where(
        and(
          inArray(codeSession.id, [first.sessionId]),
          inArray(codeSession.runtimeUserId, [first.runtimeUserId])
        )
      )
      .limit(1);

    let archiveLockToken = '';
    let storageLockToken = '';
    try {
      if (session) {
        archiveLockToken = await acquireArchiveLock(session);
        storageLockToken = await acquireStorageMutationLock(session.userId);
      }

      const freshPlan = await planStorageGc({
        objects: candidates
          .map((candidate) => objectsByKey.get(candidate.key))
          .filter((object): object is RuntimeArchiveObject => Boolean(object)),
        configs: input.configs,
        now: input.now,
      });
      const approved = freshPlan.candidates.filter((candidate) =>
        candidateKeys.has(candidate.key)
      );
      const approvedKeys = approved.map((candidate) => candidate.key);
      skippedKeys.push(
        ...candidates
          .map((candidate) => candidate.key)
          .filter((key) => !approvedKeys.includes(key))
      );
      if (approved.length === 0) continue;

      const physical = await deleteRuntimeArchives({
        runtimeUserId: first.runtimeUserId,
        sessionId: first.sessionId,
        keys: approvedKeys,
      });
      const confirmed = new Set([
        ...(physical.deletedKeys || []),
        ...(physical.notFound || []),
      ]);
      const groupDeleted = approvedKeys.filter((key) => confirmed.has(key));
      const groupFailed = approvedKeys.filter((key) => !confirmed.has(key));

      if (session && storageLockToken && groupDeleted.length > 0) {
        await settleConfirmedStorageGcDeletionForUser({
          userId: session.userId,
          keys: groupDeleted,
          lockToken: storageLockToken,
        });
      } else if (groupDeleted.length > 0) {
        await settleConfirmedStorageGcDeletion(groupDeleted);
      }
      deletedKeys.push(...groupDeleted);
      failedKeys.push(...groupFailed);
    } catch {
      failedKeys.push(...candidates.map((candidate) => candidate.key));
    } finally {
      if (storageLockToken && session) {
        await releaseStorageMutationLock(
          session.userId,
          storageLockToken
        ).catch(() => undefined);
      }
      if (archiveLockToken && session) {
        await releaseArchiveLock(session, archiveLockToken).catch(
          () => undefined
        );
      }
    }
  }

  return {
    ...plan,
    deletedKeys: unique(deletedKeys),
    failedKeys: unique(failedKeys).filter((key) => !deletedKeys.includes(key)),
    skippedKeys: unique(skippedKeys),
  };
}
