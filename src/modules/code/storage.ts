import { and, asc, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  codeSession,
  storageDailyMetric,
  storageObject,
  storagePlatformUsage,
  storageReservation,
  storageUsage,
  user,
  type StorageObject,
  type StorageReservation,
  type StorageUsage,
} from '@/config/db/schema';
import { getUuid } from '@/lib/hash';
import type {
  AdminStorageResponse,
  StorageObjectKind,
  StorageObjectSummary,
  UserStorageResponse,
} from '@/lib/storage-contract';

export const GIB = 1024 ** 3;
const DEFAULT_RESERVATION_TTL_MS = 15 * 60_000;
const DEFAULT_STORAGE_MUTATION_LOCK_MS = 30 * 60_000;
const RECONCILIATION_GRACE_MS = 15 * 60_000;
const PLATFORM_USAGE_ID = 'global';
const R2_STANDARD_STORAGE_USD_PER_GB_MONTH = 0.015;
const R2_CLASS_A_USD_PER_MILLION = 4.5;
const R2_CLASS_B_USD_PER_MILLION = 0.36;

export type StorageConfigMap = Record<string, string | undefined>;

export interface CodeStorageSettings {
  userQuotaBytes: number;
  workspaceQuotaBytes: number;
  platformCapacityBytes: number;
  monthlyBudgetUsd: number;
  retentionDays: number;
  maxSnapshotsPerSession: number;
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(positiveNumber(value, fallback)));
}

export function getCodeStorageSettings(
  configs: StorageConfigMap
): CodeStorageSettings {
  const userQuotaGb = positiveNumber(configs.code_storage_user_quota_gb, 1);
  return {
    userQuotaBytes: Math.floor(userQuotaGb * GIB),
    workspaceQuotaBytes: Math.floor(
      positiveNumber(configs.code_storage_workspace_quota_gb, 2) * GIB
    ),
    platformCapacityBytes: Math.floor(
      positiveNumber(configs.code_storage_platform_capacity_gb, 1000) * GIB
    ),
    monthlyBudgetUsd: positiveNumber(
      configs.code_storage_monthly_budget_usd,
      100
    ),
    retentionDays: positiveInteger(configs.code_storage_retention_days, 7),
    maxSnapshotsPerSession: positiveInteger(
      configs.code_storage_max_snapshots_per_session,
      2
    ),
  };
}

function bytes(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return parsed;
}

export interface ReservationDecision {
  allowed: boolean;
  netReservedBytes: number;
  projectedBytes: number;
  availableBytes: number;
}

export function calculateReservationDecision(input: {
  usedBytes: number;
  reservedBytes: number;
  requestedBytes: number;
  replaceableBytes?: number;
  limitBytes: number;
}): ReservationDecision {
  const usedBytes = bytes(input.usedBytes, 'usedBytes');
  const reservedBytes = bytes(input.reservedBytes, 'reservedBytes');
  const requestedBytes = bytes(input.requestedBytes, 'requestedBytes');
  const replaceableBytes = Math.min(
    usedBytes,
    bytes(input.replaceableBytes ?? 0, 'replaceableBytes')
  );
  const limitBytes = bytes(input.limitBytes, 'limitBytes');
  const netReservedBytes = Math.max(0, requestedBytes - replaceableBytes);
  const projectedBytes = usedBytes + reservedBytes + netReservedBytes;
  return {
    allowed: projectedBytes <= limitBytes,
    netReservedBytes,
    projectedBytes,
    availableBytes: Math.max(0, limitBytes - usedBytes - reservedBytes),
  };
}

export function calculateSettlementDecision(input: {
  usedBytes: number;
  reservedBytes: number;
  reservationBytes: number;
  actualBytes: number;
  deletedBytes?: number;
  limitBytes: number;
}) {
  const usedBytes = bytes(input.usedBytes, 'usedBytes');
  const reservedBytes = bytes(input.reservedBytes, 'reservedBytes');
  const reservationBytes = Math.min(
    reservedBytes,
    bytes(input.reservationBytes, 'reservationBytes')
  );
  const actualBytes = bytes(input.actualBytes, 'actualBytes');
  const deletedBytes = Math.min(
    usedBytes,
    bytes(input.deletedBytes ?? 0, 'deletedBytes')
  );
  const nextUsedBytes = Math.max(0, usedBytes - deletedBytes + actualBytes);
  const nextReservedBytes = Math.max(0, reservedBytes - reservationBytes);
  return {
    allowed: nextUsedBytes + nextReservedBytes <= input.limitBytes,
    nextUsedBytes,
    nextReservedBytes,
    projectedBytes: nextUsedBytes + nextReservedBytes,
  };
}

export class StorageQuotaExceededError extends Error {
  readonly code = 'storage_quota_exceeded';

  constructor(
    message: string,
    public details: Record<string, number>
  ) {
    super(message);
    this.name = 'StorageQuotaExceededError';
  }
}

export class WorkspaceQuotaExceededError extends Error {
  readonly code = 'workspace_quota_exceeded';

  constructor(
    public workspaceBytes: number,
    public limitBytes: number
  ) {
    super('Workspace exceeds the configured size limit');
    this.name = 'WorkspaceQuotaExceededError';
  }
}

export class StorageConflictError extends Error {
  readonly code = 'storage_conflict';

  constructor(message = 'Storage state changed concurrently') {
    super(message);
    this.name = 'StorageConflictError';
  }
}

export function assertWorkspaceWithinQuota(
  workspaceBytes: number,
  configs: StorageConfigMap
) {
  const actual = bytes(workspaceBytes, 'workspaceBytes');
  const limit = getCodeStorageSettings(configs).workspaceQuotaBytes;
  if (actual > limit) throw new WorkspaceQuotaExceededError(actual, limit);
  return { allowed: true as const, workspaceBytes: actual, limitBytes: limit };
}

function dateKey(value = new Date()) {
  return value.toISOString().slice(0, 10);
}

function iso(value: Date | string | number | null | undefined) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function forUpdate<T>(query: T): T {
  const candidate = query as T & { for?: (mode: 'update') => T };
  return typeof candidate.for === 'function' ? candidate.for('update') : query;
}

function affectedRows(result: any): number | null {
  const candidates = [
    result?.rowsAffected,
    result?.rowCount,
    result?.affectedRows,
    result?.changes,
    result?.meta?.changes,
    result?.[0]?.affectedRows,
    result?.[0]?.changes,
    result?.[0]?.meta?.changes,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
}

function objectSummary(row: StorageObject): StorageObjectSummary {
  return {
    id: row.id,
    sessionId: row.sessionId,
    kind: row.kind as StorageObjectKind,
    key: row.key,
    sizeBytes: Number(row.sizeBytes),
    digest: row.digest || null,
    status: row.status === 'deleting' ? 'deleting' : row.status,
    createdAt: iso(row.createdAt) || new Date(0).toISOString(),
    expiresAt: iso(row.expiresAt),
  };
}

async function ensureUsageRow(tx: any, userId: string): Promise<StorageUsage> {
  let [row] = await forUpdate(
    tx
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.userId, userId))
      .limit(1)
  );
  if (row) return row;

  try {
    await tx.insert(storageUsage).values({ userId });
  } catch (error) {
    [row] = await forUpdate(
      tx
        .select()
        .from(storageUsage)
        .where(eq(storageUsage.userId, userId))
        .limit(1)
    );
    if (!row) throw error;
    return row;
  }

  [row] = await forUpdate(
    tx
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.userId, userId))
      .limit(1)
  );
  if (!row) throw new Error('Failed to create storage usage row');
  return row;
}

export async function acquireStorageMutationLock(
  userId: string,
  ttlMs = DEFAULT_STORAGE_MUTATION_LOCK_MS
) {
  const database = db();
  const usage = await ensureUsageRow(database, userId);
  const token = getUuid();
  const now = new Date();
  const changed = await database
    .update(storageUsage)
    .set({
      reconcileLockToken: token,
      reconcileLockExpiresAt: new Date(now.getTime() + Math.max(60_000, ttlMs)),
      version: usage.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(storageUsage.userId, userId),
        eq(storageUsage.version, usage.version),
        or(
          eq(storageUsage.reconcileLockToken, ''),
          lt(storageUsage.reconcileLockExpiresAt, now)
        )
      )
    );
  if (affectedRows(changed) !== 1) {
    throw new StorageConflictError(
      'Another storage operation is already running; retry shortly'
    );
  }
  return token;
}

export async function releaseStorageMutationLock(
  userId: string,
  token: string
) {
  const changed = await db()
    .update(storageUsage)
    .set({
      reconcileLockToken: '',
      reconcileLockExpiresAt: null,
      version: sql`${storageUsage.version} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(storageUsage.userId, userId),
        eq(storageUsage.reconcileLockToken, token)
      )
    );
  return affectedRows(changed) === 1;
}

export async function renewStorageMutationLock(
  userId: string,
  token: string,
  ttlMs = DEFAULT_STORAGE_MUTATION_LOCK_MS
) {
  if (!token.trim()) throw new Error('Storage mutation lock is required');
  const now = new Date();
  const changed = await db()
    .update(storageUsage)
    .set({
      reconcileLockExpiresAt: new Date(now.getTime() + Math.max(60_000, ttlMs)),
      updatedAt: now,
    })
    .where(
      and(
        eq(storageUsage.userId, userId),
        eq(storageUsage.reconcileLockToken, token),
        gte(storageUsage.reconcileLockExpiresAt, now)
      )
    );
  if (affectedRows(changed) !== 1) {
    throw new StorageConflictError('Storage mutation lock was lost');
  }
  return true;
}

function storageMutationLockCondition(
  userId: string,
  token: string,
  now = new Date()
) {
  if (!token.trim()) throw new Error('Storage mutation lock is required');
  return and(
    eq(storageUsage.userId, userId),
    eq(storageUsage.reconcileLockToken, token),
    gte(storageUsage.reconcileLockExpiresAt, now)
  );
}

async function ensurePlatformUsageRow(tx: any) {
  let [row] = await forUpdate(
    tx
      .select()
      .from(storagePlatformUsage)
      .where(eq(storagePlatformUsage.id, PLATFORM_USAGE_ID))
      .limit(1)
  );
  if (row) return row;
  try {
    await tx.insert(storagePlatformUsage).values({ id: PLATFORM_USAGE_ID });
  } catch (error) {
    [row] = await forUpdate(
      tx
        .select()
        .from(storagePlatformUsage)
        .where(eq(storagePlatformUsage.id, PLATFORM_USAGE_ID))
        .limit(1)
    );
    if (!row) throw error;
    return row;
  }
  [row] = await forUpdate(
    tx
      .select()
      .from(storagePlatformUsage)
      .where(eq(storagePlatformUsage.id, PLATFORM_USAGE_ID))
      .limit(1)
  );
  if (!row) throw new Error('Failed to create platform storage usage row');
  return row;
}

async function updateDailyMetric(
  tx: any,
  input: {
    userId: string;
    storedBytes: number;
    uploadedBytes?: number;
    deletedBytes?: number;
    archiveCount?: number;
    deleteCount?: number;
    classAOperations?: number;
    classBOperations?: number;
    now?: Date;
  }
) {
  const metricDate = dateKey(input.now);
  const [existing] = await tx
    .select()
    .from(storageDailyMetric)
    .where(
      and(
        eq(storageDailyMetric.userId, input.userId),
        eq(storageDailyMetric.metricDate, metricDate)
      )
    )
    .limit(1);
  const increments = {
    uploadedBytes: input.uploadedBytes ?? 0,
    deletedBytes: input.deletedBytes ?? 0,
    archiveCount: input.archiveCount ?? 0,
    deleteCount: input.deleteCount ?? 0,
    classAOperations: input.classAOperations ?? 0,
    classBOperations: input.classBOperations ?? 0,
  };
  if (existing) {
    await tx
      .update(storageDailyMetric)
      .set({
        storedBytes: input.storedBytes,
        uploadedBytes:
          Number(existing.uploadedBytes) + increments.uploadedBytes,
        deletedBytes: Number(existing.deletedBytes) + increments.deletedBytes,
        archiveCount: existing.archiveCount + increments.archiveCount,
        deleteCount: existing.deleteCount + increments.deleteCount,
        classAOperations:
          existing.classAOperations + increments.classAOperations,
        classBOperations:
          existing.classBOperations + increments.classBOperations,
        updatedAt: input.now || new Date(),
      })
      .where(eq(storageDailyMetric.id, existing.id));
    return;
  }
  await tx.insert(storageDailyMetric).values({
    id: getUuid(),
    metricDate,
    userId: input.userId,
    storedBytes: input.storedBytes,
    ...increments,
  });
}

export async function reserveStorage(input: {
  userId: string;
  sessionId: string;
  requestedBytes: number;
  objectKey?: string | null;
  replaceableBytes?: number;
  replaceObjectId?: string;
  idempotencyKey: string;
  configs: StorageConfigMap;
  lockToken: string;
  ttlMs?: number;
}) {
  const requestedBytes = bytes(input.requestedBytes, 'requestedBytes');
  const replaceableBytes = bytes(
    input.replaceableBytes ?? 0,
    'replaceableBytes'
  );
  if (!input.idempotencyKey.trim()) {
    throw new Error('idempotencyKey is required');
  }
  const settings = getCodeStorageSettings(input.configs);
  const now = new Date();

  return db().transaction(async (tx: any) => {
    const [existing] = await tx
      .select()
      .from(storageReservation)
      .where(eq(storageReservation.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing) {
      if (
        existing.userId !== input.userId ||
        existing.sessionId !== input.sessionId
      ) {
        throw new Error('Storage idempotency key belongs to another request');
      }
      return {
        reservation: existing,
        idempotent: true,
        limitBytes: settings.userQuotaBytes,
      };
    }

    const usage = await ensureUsageRow(tx, input.userId);
    let verifiedReplaceableBytes = Math.min(
      replaceableBytes,
      Number(usage.usedBytes)
    );
    if (input.replaceObjectId) {
      const [replaceObject] = await tx
        .select()
        .from(storageObject)
        .where(
          and(
            eq(storageObject.id, input.replaceObjectId),
            eq(storageObject.userId, input.userId),
            eq(storageObject.sessionId, input.sessionId),
            or(
              eq(storageObject.status, 'active'),
              eq(storageObject.status, 'deleting')
            )
          )
        )
        .limit(1);
      if (!replaceObject)
        throw new Error('Replaceable storage object not found');
      verifiedReplaceableBytes = Math.min(
        verifiedReplaceableBytes || Number(replaceObject.sizeBytes),
        Number(replaceObject.sizeBytes)
      );
    }

    const limitBytes =
      usage.quotaOverrideBytes === null
        ? settings.userQuotaBytes
        : Number(usage.quotaOverrideBytes);
    const decision = calculateReservationDecision({
      usedBytes: Number(usage.usedBytes),
      reservedBytes: Number(usage.reservedBytes),
      requestedBytes,
      replaceableBytes: verifiedReplaceableBytes,
      limitBytes,
    });
    if (!decision.allowed) {
      throw new StorageQuotaExceededError('Storage quota exceeded', {
        usedBytes: Number(usage.usedBytes),
        reservedBytes: Number(usage.reservedBytes),
        requestedBytes,
        replaceableBytes: verifiedReplaceableBytes,
        limitBytes,
        projectedBytes: decision.projectedBytes,
      });
    }
    const reservation: typeof storageReservation.$inferInsert = {
      id: getUuid(),
      userId: input.userId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestedBytes,
      replaceableBytes: verifiedReplaceableBytes,
      reservedBytes: decision.netReservedBytes,
      replaceObjectId: input.replaceObjectId || null,
      objectKey: input.objectKey?.trim() || null,
      status: 'reserved',
      expiresAt: new Date(
        now.getTime() +
          Math.max(30_000, input.ttlMs ?? DEFAULT_RESERVATION_TTL_MS)
      ),
      createdAt: now,
      updatedAt: now,
    };

    const changed = await tx
      .update(storageUsage)
      .set({
        reservedBytes: Number(usage.reservedBytes) + decision.netReservedBytes,
        reconciledAt: null,
        version: usage.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageUsage.userId, input.userId),
          eq(storageUsage.version, usage.version),
          eq(storageUsage.reconcileLockToken, input.lockToken),
          gte(storageUsage.reconcileLockExpiresAt, now),
          sql`${storageUsage.usedBytes} + ${storageUsage.reservedBytes} + ${decision.netReservedBytes} <= ${limitBytes}`
        )
      );
    if (affectedRows(changed) !== 1) {
      throw new StorageQuotaExceededError(
        'Storage quota changed during reservation',
        {
          usedBytes: Number(usage.usedBytes),
          reservedBytes: Number(usage.reservedBytes),
          requestedBytes,
          replaceableBytes: verifiedReplaceableBytes,
          limitBytes,
          projectedBytes: decision.projectedBytes,
        }
      );
    }

    try {
      await tx.insert(storageReservation).values(reservation);
    } catch (error) {
      await tx
        .update(storageUsage)
        .set({
          reservedBytes: sql`case when ${storageUsage.reservedBytes} >= ${decision.netReservedBytes} then ${storageUsage.reservedBytes} - ${decision.netReservedBytes} else 0 end`,
          version: sql`${storageUsage.version} + 1`,
          updatedAt: now,
        })
        .where(storageMutationLockCondition(input.userId, input.lockToken));
      throw error;
    }
    return {
      reservation,
      idempotent: false,
      limitBytes,
      projectedBytes: decision.projectedBytes,
    };
  });
}

export async function releaseReservation(
  reservationId: string,
  lockToken: string,
  reason: 'released' | 'expired' = 'released'
) {
  return db().transaction(async (tx: any) => {
    const [reservation] = await forUpdate(
      tx
        .select()
        .from(storageReservation)
        .where(eq(storageReservation.id, reservationId))
        .limit(1)
    );
    if (!reservation || reservation.status !== 'reserved') {
      return reservation || null;
    }
    await ensureUsageRow(tx, reservation.userId);
    const now = new Date();
    const claimed = await tx
      .update(storageReservation)
      .set({
        status: 'releasing',
        updatedAt: now,
      })
      .where(
        and(
          eq(storageReservation.id, reservation.id),
          eq(storageReservation.status, 'reserved')
        )
      );
    if (affectedRows(claimed) !== 1) {
      const [current] = await tx
        .select()
        .from(storageReservation)
        .where(eq(storageReservation.id, reservation.id))
        .limit(1);
      return current || null;
    }
    const usageChanged = await tx
      .update(storageUsage)
      .set({
        reservedBytes: sql`case when ${storageUsage.reservedBytes} >= ${reservation.reservedBytes} then ${storageUsage.reservedBytes} - ${reservation.reservedBytes} else 0 end`,
        version: sql`${storageUsage.version} + 1`,
        updatedAt: now,
      })
      .where(storageMutationLockCondition(reservation.userId, lockToken));
    if (affectedRows(usageChanged) !== 1) {
      await tx
        .update(storageReservation)
        .set({ status: 'reserved', updatedAt: now })
        .where(
          and(
            eq(storageReservation.id, reservation.id),
            eq(storageReservation.status, 'releasing')
          )
        );
      throw new StorageConflictError('Storage mutation lock was lost');
    }
    const completed = await tx
      .update(storageReservation)
      .set({
        status: reason,
        releasedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageReservation.id, reservation.id),
          eq(storageReservation.status, 'releasing')
        )
      );
    if (affectedRows(completed) !== 1) {
      throw new StorageConflictError(
        'Storage reservation release was interrupted'
      );
    }
    return { ...reservation, status: reason, releasedAt: now };
  });
}

export async function holdReservationForReconciliation(
  reservationId: string,
  actualBytes: number,
  objectKey: string | null,
  lockToken: string
) {
  const now = new Date();
  const database = db();
  const [reservation] = await database
    .select()
    .from(storageReservation)
    .where(eq(storageReservation.id, reservationId))
    .limit(1);
  if (!reservation) throw new Error('Storage reservation not found');
  const changed = await database
    .update(storageReservation)
    .set({
      status: 'reconcile',
      actualBytes: bytes(actualBytes, 'actualBytes'),
      objectKey: objectKey?.trim() || null,
      expiresAt: new Date(now.getTime() + RECONCILIATION_GRACE_MS),
      updatedAt: now,
    })
    .where(
      and(
        eq(storageReservation.id, reservationId),
        inArray(storageReservation.status, [
          'reserved',
          'settling',
          'reconcile',
        ])
      )
    );
  if (affectedRows(changed) !== 1) return false;
  const usageChanged = await database
    .update(storageUsage)
    .set({
      reconciledAt: null,
      version: sql`${storageUsage.version} + 1`,
      updatedAt: now,
    })
    .where(storageMutationLockCondition(reservation.userId, lockToken));
  if (affectedRows(usageChanged) !== 1) {
    throw new StorageConflictError('Storage mutation lock was lost');
  }
  return true;
}

export async function getCurrentObject(userId: string, sessionId: string) {
  const [row] = await db()
    .select()
    .from(storageObject)
    .where(
      and(
        eq(storageObject.userId, userId),
        eq(storageObject.sessionId, sessionId),
        eq(storageObject.kind, 'current'),
        or(
          eq(storageObject.status, 'active'),
          eq(storageObject.status, 'deleting')
        )
      )
    )
    .orderBy(desc(storageObject.createdAt))
    .limit(1);
  return row || null;
}

export async function settleStorage(input: {
  reservationId: string;
  key: string;
  sizeBytes: number;
  digest?: string | null;
  kind?: StorageObjectKind;
  deletedKeys?: string[];
  expiresAt?: Date | null;
  configs: StorageConfigMap;
  lockToken: string;
}) {
  const actualBytes = bytes(input.sizeBytes, 'sizeBytes');
  const key = input.key.trim();
  if (!key) throw new Error('Storage object key is required');
  const settings = getCodeStorageSettings(input.configs);

  return db().transaction(async (tx: any) => {
    const [reservation] = await forUpdate(
      tx
        .select()
        .from(storageReservation)
        .where(eq(storageReservation.id, input.reservationId))
        .limit(1)
    );
    if (!reservation) throw new Error('Storage reservation not found');

    if (reservation.status === 'settled') {
      const [existing] = await tx
        .select()
        .from(storageObject)
        .where(eq(storageObject.reservationId, reservation.id))
        .limit(1);
      return { reservation, object: existing || null, idempotent: true };
    }
    if (
      reservation.status !== 'reserved' &&
      reservation.status !== 'reconcile'
    ) {
      throw new Error(`Storage reservation is ${reservation.status}`);
    }

    const usage = await ensureUsageRow(tx, reservation.userId);
    const deletedKeys = [...new Set(input.deletedKeys || [])].filter(
      (deletedKey) => deletedKey !== key
    );
    const deletedObjects =
      deletedKeys.length === 0
        ? []
        : await forUpdate(
            tx
              .select()
              .from(storageObject)
              .where(
                and(
                  eq(storageObject.userId, reservation.userId),
                  eq(storageObject.sessionId, reservation.sessionId),
                  inArray(storageObject.key, deletedKeys),
                  or(
                    eq(storageObject.status, 'active'),
                    eq(storageObject.status, 'deleting')
                  )
                )
              )
          );
    const deletedBytes = deletedObjects.reduce(
      (total: number, row: StorageObject) => total + Number(row.sizeBytes),
      0
    );
    const pendingDeletedBytes = deletedObjects
      .filter((row: StorageObject) => row.status === 'deleting')
      .reduce(
        (total: number, row: StorageObject) => total + Number(row.sizeBytes),
        0
      );
    const limitBytes =
      usage.quotaOverrideBytes === null
        ? settings.userQuotaBytes
        : Number(usage.quotaOverrideBytes);
    const decision = calculateSettlementDecision({
      usedBytes: Number(usage.usedBytes),
      reservedBytes: Number(usage.reservedBytes),
      reservationBytes: Number(reservation.reservedBytes),
      actualBytes,
      deletedBytes,
      limitBytes,
    });
    if (!decision.allowed) {
      throw new StorageQuotaExceededError(
        'Storage quota exceeded during settlement',
        {
          usedBytes: Number(usage.usedBytes),
          reservedBytes: Number(usage.reservedBytes),
          requestedBytes: actualBytes,
          replaceableBytes: deletedBytes,
          limitBytes,
          projectedBytes: decision.projectedBytes,
        }
      );
    }

    const now = new Date();
    const claimed = await tx
      .update(storageReservation)
      .set({ status: 'settling', actualBytes, updatedAt: now })
      .where(
        and(
          eq(storageReservation.id, reservation.id),
          inArray(storageReservation.status, ['reserved', 'reconcile'])
        )
      );
    if (affectedRows(claimed) !== 1) {
      throw new StorageConflictError('Storage reservation was already claimed');
    }
    const usageChanged = await tx
      .update(storageUsage)
      .set({
        usedBytes: decision.nextUsedBytes,
        reservedBytes: decision.nextReservedBytes,
        pendingDeleteBytes: Math.max(
          0,
          Number(usage.pendingDeleteBytes) - pendingDeletedBytes
        ),
        version: usage.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageUsage.userId, reservation.userId),
          eq(storageUsage.version, usage.version),
          eq(storageUsage.reconcileLockToken, input.lockToken),
          gte(storageUsage.reconcileLockExpiresAt, now),
          sql`${decision.nextUsedBytes} + ${decision.nextReservedBytes} <= ${limitBytes}`
        )
      );
    if (affectedRows(usageChanged) !== 1) {
      await tx
        .update(storageReservation)
        .set({
          status: reservation.status,
          actualBytes: reservation.actualBytes,
          updatedAt: now,
        })
        .where(
          and(
            eq(storageReservation.id, reservation.id),
            eq(storageReservation.status, 'settling')
          )
        );
      throw new StorageConflictError();
    }

    if (deletedObjects.length > 0) {
      await tx
        .update(storageObject)
        .set({ status: 'deleted', deletedAt: now, updatedAt: now })
        .where(
          inArray(
            storageObject.id,
            deletedObjects.map((row: StorageObject) => row.id)
          )
        );
    }
    if ((input.kind || 'current') === 'current') {
      await tx
        .update(storageObject)
        .set({
          kind: 'snapshot',
          expiresAt: new Date(
            now.getTime() + settings.retentionDays * 86_400_000
          ),
          updatedAt: now,
        })
        .where(
          and(
            eq(storageObject.userId, reservation.userId),
            eq(storageObject.sessionId, reservation.sessionId),
            eq(storageObject.kind, 'current'),
            eq(storageObject.status, 'active')
          )
        );
    }

    const object: typeof storageObject.$inferInsert = {
      id: getUuid(),
      userId: reservation.userId,
      sessionId: reservation.sessionId,
      key,
      kind: input.kind || 'current',
      status: 'active',
      sizeBytes: actualBytes,
      digest: input.digest || null,
      reservationId: reservation.id,
      expiresAt: input.expiresAt || null,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(storageObject).values(object);
    const completed = await tx
      .update(storageReservation)
      .set({
        status: 'settled',
        actualBytes,
        settledAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageReservation.id, reservation.id),
          eq(storageReservation.status, 'settling')
        )
      );
    if (affectedRows(completed) !== 1) {
      throw new StorageConflictError(
        'Storage reservation settlement was interrupted'
      );
    }
    try {
      await updateDailyMetric(tx, {
        userId: reservation.userId,
        storedBytes: decision.nextUsedBytes,
        uploadedBytes: actualBytes,
        deletedBytes,
        archiveCount: 1,
        deleteCount: deletedObjects.length,
        classAOperations: 1 + deletedObjects.length,
        now,
      });
    } catch (error) {
      console.warn('[storage-metric] settlement metric update failed', {
        reservationId: reservation.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      reservation: {
        ...reservation,
        status: 'settled',
        actualBytes,
        settledAt: now,
      },
      object,
      deletedKeys: deletedObjects.map((row: StorageObject) => row.key),
      usage: {
        usedBytes: decision.nextUsedBytes,
        reservedBytes: decision.nextReservedBytes,
        limitBytes,
      },
      idempotent: false,
    };
  });
}

export async function recordRuntimeArchiveResult(input: {
  reservationId: string;
  key: string;
  sizeBytes: number;
  digest?: string | null;
  deduplicated?: boolean;
  deletedKeys?: string[];
  configs: StorageConfigMap;
  lockToken: string;
}) {
  if (input.deduplicated) {
    const [reservation] = await db()
      .select({
        userId: storageReservation.userId,
        sessionId: storageReservation.sessionId,
      })
      .from(storageReservation)
      .where(eq(storageReservation.id, input.reservationId))
      .limit(1);
    if (!reservation) throw new Error('Storage reservation not found');
    const [existing] = await db()
      .select()
      .from(storageObject)
      .where(
        and(
          eq(storageObject.key, input.key),
          eq(storageObject.userId, reservation.userId),
          eq(storageObject.sessionId, reservation.sessionId)
        )
      )
      .limit(1);
    if (existing) {
      if (input.deletedKeys && input.deletedKeys.length > 0) {
        await settleStorageDeletion({
          userId: existing.userId,
          keys: input.deletedKeys,
          lockToken: input.lockToken,
        });
      }
      await releaseReservation(input.reservationId, input.lockToken);
      return { object: existing, deduplicated: true };
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await settleStorage({
        reservationId: input.reservationId,
        key: input.key,
        sizeBytes: input.sizeBytes,
        digest: input.digest,
        kind: 'current',
        deletedKeys: input.deletedKeys,
        configs: input.configs,
        lockToken: input.lockToken,
      });
    } catch (error) {
      if (!(error instanceof StorageConflictError) || attempt === 2) {
        throw error;
      }
    }
  }
  throw new StorageConflictError();
}

export type StorageCleanupScope =
  | 'object'
  | 'snapshots'
  | 'all-snapshots'
  | 'session';

export async function markStorageObjectsDeleting(input: {
  userId: string;
  scope: StorageCleanupScope;
  objectId?: string;
  sessionId?: string;
  lockToken: string;
}) {
  return db().transaction(async (tx: any) => {
    const conditions = [
      eq(storageObject.userId, input.userId),
      or(
        eq(storageObject.status, 'active'),
        eq(storageObject.status, 'deleting')
      ),
    ];
    if (input.scope === 'object') {
      if (!input.objectId) throw new Error('objectId is required');
      conditions.push(eq(storageObject.id, input.objectId));
      conditions.push(eq(storageObject.kind, 'snapshot'));
    } else if (input.scope === 'session') {
      if (!input.sessionId) throw new Error('sessionId is required');
      conditions.push(eq(storageObject.sessionId, input.sessionId));
    } else {
      conditions.push(eq(storageObject.kind, 'snapshot'));
      if (input.scope === 'snapshots') {
        if (!input.sessionId) throw new Error('sessionId is required');
        conditions.push(eq(storageObject.sessionId, input.sessionId));
      }
    }

    const rows = await forUpdate(
      tx
        .select()
        .from(storageObject)
        .where(and(...conditions))
    );
    if (rows.length === 0) return [];

    const usage = await ensureUsageRow(tx, input.userId);
    const activeRows = rows.filter(
      (row: StorageObject) => row.status === 'active'
    );
    const pendingBytes = activeRows.reduce(
      (total: number, row: StorageObject) => total + Number(row.sizeBytes),
      0
    );
    const now = new Date();
    if (activeRows.length > 0) {
      await tx
        .update(storageObject)
        .set({ status: 'deleting', updatedAt: now })
        .where(
          inArray(
            storageObject.id,
            activeRows.map((row: StorageObject) => row.id)
          )
        );
    }
    const usageChanged = await tx
      .update(storageUsage)
      .set({
        pendingDeleteBytes: Number(usage.pendingDeleteBytes) + pendingBytes,
        version: usage.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageUsage.userId, input.userId),
          eq(storageUsage.version, usage.version),
          eq(storageUsage.reconcileLockToken, input.lockToken),
          gte(storageUsage.reconcileLockExpiresAt, now)
        )
      );
    if (affectedRows(usageChanged) !== 1) {
      if (activeRows.length > 0) {
        await tx
          .update(storageObject)
          .set({ status: 'active', updatedAt: now })
          .where(
            inArray(
              storageObject.id,
              activeRows.map((row: StorageObject) => row.id)
            )
          );
      }
      throw new StorageConflictError('Storage mutation lock was lost');
    }
    return rows.map(objectSummary);
  });
}

export async function restoreStorageObjects(input: {
  userId: string;
  keys: string[];
  lockToken: string;
}) {
  const keys = [...new Set(input.keys)];
  if (keys.length === 0) return 0;
  return db().transaction(async (tx: any) => {
    const rows = await forUpdate(
      tx
        .select()
        .from(storageObject)
        .where(
          and(
            eq(storageObject.userId, input.userId),
            eq(storageObject.status, 'deleting'),
            inArray(storageObject.key, keys)
          )
        )
    );
    if (rows.length === 0) return 0;
    const restoredBytes = rows.reduce(
      (total: number, row: StorageObject) => total + Number(row.sizeBytes),
      0
    );
    const usage = await ensureUsageRow(tx, input.userId);
    const now = new Date();
    await tx
      .update(storageObject)
      .set({ status: 'active', updatedAt: now })
      .where(
        inArray(
          storageObject.id,
          rows.map((row: StorageObject) => row.id)
        )
      );
    const usageChanged = await tx
      .update(storageUsage)
      .set({
        pendingDeleteBytes: Math.max(
          0,
          Number(usage.pendingDeleteBytes) - restoredBytes
        ),
        version: usage.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageUsage.userId, input.userId),
          eq(storageUsage.version, usage.version),
          eq(storageUsage.reconcileLockToken, input.lockToken),
          gte(storageUsage.reconcileLockExpiresAt, now)
        )
      );
    if (affectedRows(usageChanged) !== 1) {
      throw new StorageConflictError('Storage mutation lock was lost');
    }
    return restoredBytes;
  });
}

export async function settleStorageDeletion(input: {
  userId: string;
  keys: string[];
  lockToken: string;
}) {
  const keys = [...new Set(input.keys)];
  if (keys.length === 0) return { deletedBytes: 0, deletedKeys: [] };
  return db().transaction(async (tx: any) => {
    const rows = await forUpdate(
      tx
        .select()
        .from(storageObject)
        .where(
          and(
            eq(storageObject.userId, input.userId),
            inArray(storageObject.key, keys),
            or(
              eq(storageObject.status, 'active'),
              eq(storageObject.status, 'deleting')
            )
          )
        )
    );
    if (rows.length === 0) return { deletedBytes: 0, deletedKeys: [] };
    const deletedBytes = rows.reduce(
      (total: number, row: StorageObject) => total + Number(row.sizeBytes),
      0
    );
    const pendingBytes = rows
      .filter((row: StorageObject) => row.status === 'deleting')
      .reduce(
        (total: number, row: StorageObject) => total + Number(row.sizeBytes),
        0
      );
    const usage = await ensureUsageRow(tx, input.userId);
    const now = new Date();
    const nextUsedBytes = Math.max(0, Number(usage.usedBytes) - deletedBytes);
    await tx
      .update(storageObject)
      .set({ status: 'deleted', deletedAt: now, updatedAt: now })
      .where(
        inArray(
          storageObject.id,
          rows.map((row: StorageObject) => row.id)
        )
      );
    const usageChanged = await tx
      .update(storageUsage)
      .set({
        usedBytes: nextUsedBytes,
        pendingDeleteBytes: Math.max(
          0,
          Number(usage.pendingDeleteBytes) - pendingBytes
        ),
        version: usage.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageUsage.userId, input.userId),
          eq(storageUsage.version, usage.version),
          eq(storageUsage.reconcileLockToken, input.lockToken),
          gte(storageUsage.reconcileLockExpiresAt, now)
        )
      );
    if (affectedRows(usageChanged) !== 1) {
      throw new StorageConflictError('Storage mutation lock was lost');
    }
    await updateDailyMetric(tx, {
      userId: input.userId,
      storedBytes: nextUsedBytes,
      deletedBytes,
      deleteCount: rows.length,
      classAOperations: rows.length,
      now,
    });
    return {
      deletedBytes,
      deletedKeys: rows.map((row: StorageObject) => row.key),
    };
  });
}

export async function getUsage(userId: string, configs: StorageConfigMap) {
  const settings = getCodeStorageSettings(configs);
  const [usage] = await db()
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.userId, userId))
    .limit(1);
  const objects = await db()
    .select()
    .from(storageObject)
    .where(
      and(
        eq(storageObject.userId, userId),
        or(
          eq(storageObject.status, 'active'),
          eq(storageObject.status, 'deleting')
        )
      )
    );
  const currentBytes = objects
    .filter((row: StorageObject) => row.kind === 'current')
    .reduce(
      (total: number, row: StorageObject) => total + Number(row.sizeBytes),
      0
    );
  const snapshotBytes = objects
    .filter((row: StorageObject) => row.kind === 'snapshot')
    .reduce(
      (total: number, row: StorageObject) => total + Number(row.sizeBytes),
      0
    );
  return {
    usedBytes: Number(usage?.usedBytes ?? 0),
    reservedBytes: Number(usage?.reservedBytes ?? 0),
    limitBytes:
      usage?.quotaOverrideBytes === null ||
      usage?.quotaOverrideBytes === undefined
        ? settings.userQuotaBytes
        : Number(usage.quotaOverrideBytes),
    currentBytes,
    snapshotBytes,
    pendingDeleteBytes: Number(usage?.pendingDeleteBytes ?? 0),
  };
}

export async function getUserStorage(
  userId: string,
  configs: StorageConfigMap
): Promise<UserStorageResponse> {
  const [quota, objects, sessions] = await Promise.all([
    getUsage(userId, configs),
    db()
      .select()
      .from(storageObject)
      .where(
        and(
          eq(storageObject.userId, userId),
          or(
            eq(storageObject.status, 'active'),
            eq(storageObject.status, 'deleting')
          )
        )
      )
      .orderBy(desc(storageObject.createdAt)),
    db().select().from(codeSession).where(eq(codeSession.userId, userId)),
  ]);
  const sessionById = new Map<string, (typeof sessions)[number]>(
    sessions.map((row: (typeof sessions)[number]) => [row.id, row])
  );
  const grouped = new Map<string, StorageObject[]>();
  for (const object of objects) {
    const group = grouped.get(object.sessionId) || [];
    group.push(object);
    grouped.set(object.sessionId, group);
  }
  return {
    quota,
    sessions: [...grouped.entries()].map(([sessionId, rows]) => {
      const current =
        rows.find(
          (row) => row.kind === 'current' && row.status !== 'deleting'
        ) ||
        rows.find((row) => row.kind === 'current') ||
        null;
      const snapshots = rows
        .filter((row) => row.kind === 'snapshot')
        .map(objectSummary);
      return {
        id: sessionId,
        title: sessionById.get(sessionId)?.title || sessionId,
        status: sessionById.get(sessionId)?.status,
        totalBytes: rows.reduce(
          (total, row) => total + Number(row.sizeBytes),
          0
        ),
        current: current ? objectSummary(current) : null,
        snapshots,
      };
    }),
  };
}

export async function getAdminStorageMetrics(
  configs: StorageConfigMap,
  options: { days?: number; top?: number; physicalObjectCount?: number } = {}
): Promise<AdminStorageResponse> {
  const settings = getCodeStorageSettings(configs);
  const days = Math.min(90, Math.max(1, options.days ?? 30));
  const top = Math.min(100, Math.max(1, options.top ?? 10));
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - days + 1);
  const cutoffKey = dateKey(cutoff);
  const month = dateKey().slice(0, 7);
  const monthStart = `${month}-01`;

  const [platform, usageRows, objectRows, metricRows, profileRows] =
    await Promise.all([
      db()
        .select()
        .from(storagePlatformUsage)
        .where(eq(storagePlatformUsage.id, PLATFORM_USAGE_ID))
        .limit(1),
      db().select().from(storageUsage).orderBy(desc(storageUsage.usedBytes)),
      db()
        .select()
        .from(storageObject)
        .where(
          or(
            eq(storageObject.status, 'active'),
            eq(storageObject.status, 'deleting')
          )
        ),
      db()
        .select()
        .from(storageDailyMetric)
        .where(gte(storageDailyMetric.metricDate, cutoffKey))
        .orderBy(asc(storageDailyMetric.metricDate)),
      db()
        .select({ id: user.id, email: user.email, name: user.name })
        .from(user),
    ]);
  const platformUsage = platform[0];
  const logicalUsedBytes = usageRows.reduce(
    (total: number, row: StorageUsage) => total + Number(row.usedBytes),
    0
  );
  const usedBytes = platformUsage?.observedAt
    ? Number(platformUsage.observedBytes)
    : logicalUsedBytes;
  const reservedBytes = usageRows.reduce(
    (total: number, row: StorageUsage) => total + Number(row.reservedBytes),
    0
  );
  const pendingDeleteBytes = usageRows.reduce(
    (total: number, row: StorageUsage) =>
      total + Number(row.pendingDeleteBytes),
    0
  );
  const kindBytes = (kind: string) =>
    objectRows
      .filter((row: StorageObject) => row.kind === kind)
      .reduce(
        (total: number, row: StorageObject) => total + Number(row.sizeBytes),
        0
      );
  const profileById = new Map<string, (typeof profileRows)[number]>(
    profileRows.map((row: (typeof profileRows)[number]) => [row.id, row])
  );
  const objectCounts = new Map<
    string,
    { sessions: Set<string>; count: number }
  >();
  for (const row of objectRows) {
    const entry = objectCounts.get(row.userId) || {
      sessions: new Set<string>(),
      count: 0,
    };
    entry.sessions.add(row.sessionId);
    entry.count += 1;
    objectCounts.set(row.userId, entry);
  }

  const byDate = new Map<
    string,
    {
      usedBytes: number;
      addedBytes: number;
      deletedBytes: number;
      classA: number;
      classB: number;
    }
  >();
  for (const row of metricRows) {
    const point = byDate.get(row.metricDate) || {
      usedBytes: 0,
      addedBytes: 0,
      deletedBytes: 0,
      classA: 0,
      classB: 0,
    };
    point.usedBytes += Number(row.storedBytes);
    point.addedBytes += Number(row.uploadedBytes);
    point.deletedBytes += Number(row.deletedBytes);
    point.classA += row.classAOperations;
    point.classB += row.classBOperations;
    byDate.set(row.metricDate, point);
  }
  const monthMetrics = metricRows.filter(
    (row: any) => row.metricDate >= monthStart
  );
  const gbDays = monthMetrics.reduce(
    (total: number, row: any) => total + Number(row.storedBytes) / GIB,
    0
  );
  const daysInMonth = new Date(
    Number(month.slice(0, 4)),
    Number(month.slice(5, 7)),
    0
  ).getDate();
  // This is a budget guard, not an invoice. Project the current physical
  // footprint across a full month so newly discovered legacy objects are
  // included immediately instead of waiting for daily ledger samples.
  const storageCostUsd =
    (usedBytes / GIB) * R2_STANDARD_STORAGE_USD_PER_GB_MONTH;
  const classA = monthMetrics.reduce(
    (total: number, row: any) => total + row.classAOperations,
    0
  );
  const classB = monthMetrics.reduce(
    (total: number, row: any) => total + row.classBOperations,
    0
  );
  const operationCostUsd =
    (classA / 1_000_000) * R2_CLASS_A_USD_PER_MILLION +
    (classB / 1_000_000) * R2_CLASS_B_USD_PER_MILLION;
  const estimatedCostUsd = storageCostUsd + operationCostUsd;

  return {
    summary: {
      usedBytes,
      reservedBytes,
      limitBytes: settings.platformCapacityBytes,
      currentBytes: kindBytes('current'),
      snapshotBytes: kindBytes('snapshot'),
      tempBytes: kindBytes('temp'),
      pendingDeleteBytes,
      userCount: usageRows.filter(
        (row: StorageUsage) =>
          Number(row.usedBytes) > 0 || Number(row.reservedBytes) > 0
      ).length,
      sessionCount: new Set(
        objectRows.map((row: StorageObject) => row.sessionId)
      ).size,
      objectCount:
        options.physicalObjectCount ??
        (platformUsage?.observedAt
          ? Number(platformUsage.observedObjects)
          : objectRows.length),
      updatedAt: iso(platformUsage?.observedAt || platformUsage?.updatedAt),
    },
    budget: {
      month,
      monthlyBudgetUsd: settings.monthlyBudgetUsd,
      estimatedCostUsd,
      storageCostUsd,
      operationCostUsd,
      gbDays,
      percentUsed:
        settings.monthlyBudgetUsd > 0
          ? (estimatedCostUsd / settings.monthlyBudgetUsd) * 100
          : 0,
    },
    trend: [...byDate.entries()].map(([date, point]) => ({
      date,
      usedBytes: point.usedBytes,
      addedBytes: point.addedBytes,
      deletedBytes: point.deletedBytes,
      estimatedCostUsd:
        (point.usedBytes / GIB / daysInMonth) *
          R2_STANDARD_STORAGE_USD_PER_GB_MONTH +
        (point.classA / 1_000_000) * R2_CLASS_A_USD_PER_MILLION +
        (point.classB / 1_000_000) * R2_CLASS_B_USD_PER_MILLION,
    })),
    topUsers: usageRows.slice(0, top).map((row: StorageUsage) => ({
      userId: row.userId,
      email: profileById.get(row.userId)?.email || null,
      name: profileById.get(row.userId)?.name || null,
      usedBytes: Number(row.usedBytes),
      reservedBytes: Number(row.reservedBytes),
      sessionCount: objectCounts.get(row.userId)?.sessions.size || 0,
      objectCount: objectCounts.get(row.userId)?.count || 0,
    })),
  };
}

export async function reconcilePlatformStorageBytes(
  actualBytes: number,
  actualObjects = 0
) {
  const physicalBytes = bytes(actualBytes, 'actualBytes');
  const physicalObjects = bytes(actualObjects, 'actualObjects');
  return db().transaction(async (tx: any) => {
    const platformUsage = await ensurePlatformUsageRow(tx);
    const now = new Date();
    await tx
      .update(storagePlatformUsage)
      .set({
        observedBytes: physicalBytes,
        observedObjects: physicalObjects,
        observedAt: now,
        version: platformUsage.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storagePlatformUsage.id, PLATFORM_USAGE_ID),
          eq(storagePlatformUsage.version, platformUsage.version)
        )
      );
    return {
      usedBytes: physicalBytes,
      objectCount: physicalObjects,
      updatedAt: now,
    };
  });
}

export async function listSnapshotPruneCandidates(
  userId: string,
  sessionId: string,
  configs: StorageConfigMap,
  now = new Date()
) {
  const settings = getCodeStorageSettings(configs);
  const rows = await db()
    .select()
    .from(storageObject)
    .where(
      and(
        eq(storageObject.userId, userId),
        eq(storageObject.sessionId, sessionId),
        eq(storageObject.kind, 'snapshot'),
        eq(storageObject.status, 'active')
      )
    )
    .orderBy(desc(storageObject.createdAt));
  return rows
    .filter(
      (row: StorageObject, index: number) =>
        index >= settings.maxSnapshotsPerSession ||
        (row.expiresAt !== null &&
          new Date(row.expiresAt).getTime() <= now.getTime())
    )
    .map(objectSummary);
}
