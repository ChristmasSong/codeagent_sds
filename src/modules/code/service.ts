import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  or,
} from 'drizzle-orm';

import { db } from '@/core/db';
import { envConfigs } from '@/config';
import {
  codeSession,
  codeSessionEvent,
  storageObject,
  storageReservation,
  storageUsage,
  type CodeSession,
  type NewCodeSession,
} from '@/config/db/schema';
import { getAllConfigs } from '@/modules/config/service';
import {
  getBalance,
  getHistory,
  grantForNewUser,
} from '@/modules/credits/service';
import { getUuid } from '@/lib/hash';

import { getCodeBillingSettings, settleSessionRuntimeUsage } from './billing';
import {
  getCodeModelForBilling,
  getEnabledCodeModel,
  hasConfiguredModelTokenCosts,
  type CodeModelView,
} from './models';
import {
  actionUrl,
  generateSessionId,
  normalizeAgent,
  sanitizeUserId,
  type CodeSessionAgent,
} from './runtime';
import {
  acquireStorageMutationLock,
  assertWorkspaceWithinQuota,
  getCodeStorageSettings,
  getUserStorage,
  holdReservationForReconciliation,
  markStorageObjectsDeleting,
  recordRuntimeArchiveResult,
  releaseReservation,
  releaseStorageMutationLock,
  renewStorageMutationLock,
  reserveStorage,
  restoreStorageObjects,
  settleStorageDeletion,
  StorageConflictError,
  StorageQuotaExceededError,
} from './storage';
import { reconcileUserStorage } from './storage-reconciliation';
import { deleteRuntimeArchives } from './storage-runtime';

export type CodeSessionStatus = 'active' | 'suspended' | 'ended' | 'error';
export type { CodeSessionAgent };

export interface CodeSessionView {
  id: string;
  agent: CodeSessionAgent;
  model: string;
  runtimeUserId: string;
  status: CodeSessionStatus;
  title: string;
  archiveKey: string | null;
  archiveDigest: string | null;
  suspensionReason: string;
  lastActiveAt: string;
  endedAt: string | null;
  createdAt: string;
}

export type CodeSessionStartErrorReason =
  | 'insufficient_credits'
  | 'model_costs_not_configured';

export class CodeSessionStartError extends Error {
  constructor(
    public reason: CodeSessionStartErrorReason,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'CodeSessionStartError';
  }
}

export class RuntimeRequestError extends Error {
  constructor(
    public status: number,
    public code: string,
    public stage: string,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'RuntimeRequestError';
  }
}

export interface RuntimeActionResult {
  ok?: boolean;
  [key: string]: unknown;
}

interface ArchiveStatus {
  state: 'saved';
  savedAt: string;
  digest: string;
  key: string;
  eventKind: string;
  recordedEvent: boolean;
  bytes?: number;
  files?: number;
}

interface RestoreIntegrity {
  state: 'verified' | 'reconciled' | 'mismatch' | 'unknown' | 'untracked';
  expectedDigest: string;
  restoredDigest: string;
}

type CodeSessionEventSeverity = 'info' | 'warn' | 'error';
type CodeSessionEventSource = 'app' | 'browser' | 'runtime';

interface RecordCodeSessionEventInput {
  userId: string;
  sessionId: string;
  runtimeUserId?: string;
  agent?: unknown;
  model?: string;
  eventType: string;
  severity?: CodeSessionEventSeverity;
  source?: CodeSessionEventSource;
  message?: string;
  metadata?: Record<string, unknown>;
}

function maxActiveSessions() {
  const parsed = Number.parseInt(
    envConfigs.code_max_active_sessions || '1',
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function idleSuspendMinutes() {
  const parsed = Number.parseInt(
    envConfigs.code_session_idle_suspend_minutes || '30',
    10
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function idleReaperBatchSize() {
  return 20;
}

function asIso(value: Date | string | number | null | undefined) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function dateValue(value: Date | string | number | null | undefined) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sessionRuntimeUserId(userId: string, sessionId: string) {
  return `${sanitizeUserId(userId)}-${sessionId}`;
}

export function toView(row: CodeSession): CodeSessionView {
  return {
    id: row.id,
    agent: normalizeAgent(row.agent),
    model: row.model || '',
    runtimeUserId: row.runtimeUserId,
    status: row.status as CodeSessionStatus,
    title: row.title,
    archiveKey: row.archiveKey,
    archiveDigest: row.archiveDigest,
    suspensionReason: row.suspensionReason || '',
    lastActiveAt: asIso(row.lastActiveAt) || new Date().toISOString(),
    endedAt: asIso(row.endedAt),
    createdAt: asIso(row.createdAt) || new Date().toISOString(),
  };
}

export async function listSessions(userId: string): Promise<CodeSessionView[]> {
  const rows = await db()
    .select()
    .from(codeSession)
    .where(
      and(eq(codeSession.userId, userId), eq(codeSession.status, 'active'))
    )
    .orderBy(desc(codeSession.lastActiveAt))
    .limit(10);
  return rows.map(toView);
}

export async function listArchivedSessions(
  userId: string
): Promise<CodeSessionView[]> {
  const rows = await db()
    .select()
    .from(codeSession)
    .where(
      and(
        eq(codeSession.userId, userId),
        or(
          eq(codeSession.status, 'suspended'),
          eq(codeSession.status, 'ended')
        ),
        isNotNull(codeSession.archiveKey)
      )
    )
    .orderBy(desc(codeSession.lastActiveAt))
    .limit(20);
  return rows.map(toView);
}

export async function getOrCreateActiveSession(
  userId: string
): Promise<CodeSessionView> {
  const [existing] = await db()
    .select()
    .from(codeSession)
    .where(
      and(eq(codeSession.userId, userId), eq(codeSession.status, 'active'))
    )
    .orderBy(desc(codeSession.lastActiveAt))
    .limit(1);

  if (existing) {
    return touchSession(userId, existing.id);
  }

  return createSession(userId);
}

export async function createSession(
  userId: string,
  agent?: unknown,
  model?: unknown
): Promise<CodeSessionView> {
  const normalizedAgent = normalizeAgent(agent);
  const selectedModel = await getEnabledCodeModel(normalizedAgent, model);
  await ensureCanStartBillableSession(userId, selectedModel);

  const activeRows = await db()
    .select({ id: codeSession.id })
    .from(codeSession)
    .where(
      and(eq(codeSession.userId, userId), eq(codeSession.status, 'active'))
    )
    .limit(maxActiveSessions());

  if (activeRows.length >= maxActiveSessions()) {
    throw new Error('Active session limit reached');
  }

  const now = new Date();
  const sessionId = generateSessionId();
  const row: NewCodeSession = {
    id: sessionId,
    agent: normalizedAgent,
    model: selectedModel.model,
    userId,
    runtimeUserId: sessionRuntimeUserId(userId, sessionId),
    status: 'active',
    title: '',
    suspensionReason: '',
    lastBilledAt: now,
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await db().insert(codeSession).values(row);
  const created = await getOwnedSession(userId, row.id);
  if (!created) throw new Error('Failed to create code session');
  await recordCodeSessionEvent({
    userId,
    sessionId: created.id,
    runtimeUserId: created.runtimeUserId,
    agent: created.agent,
    model: created.model,
    eventType: 'session.created',
    message: 'Session created',
    metadata: { status: created.status },
  });
  return toView(created);
}

export async function preflightSessionStart(
  userId: string,
  agent?: unknown,
  model?: unknown
) {
  const selectedModel = await getEnabledCodeModel(agent, model);
  await ensureCanStartBillableSession(userId, selectedModel);
  return {
    agent: selectedModel.agent,
    model: selectedModel.model,
    ready: true,
  };
}

export async function getOwnedSession(userId: string, sessionId: string) {
  const [row] = await db()
    .select()
    .from(codeSession)
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)))
    .limit(1);
  return row;
}

export async function touchSession(
  userId: string,
  sessionId: string
): Promise<CodeSessionView> {
  const now = new Date();
  await db()
    .update(codeSession)
    .set({ lastActiveAt: now, updatedAt: now })
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)));

  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  return toView(row);
}

async function markSessionError(userId: string, sessionId: string) {
  const now = new Date();
  await db()
    .update(codeSession)
    .set({ status: 'error', updatedAt: now })
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)));
}

async function markSessionEnded(
  userId: string,
  sessionId: string,
  archive?: RuntimeActionResult | null,
  endedAt?: Date
): Promise<CodeSessionView> {
  const now = endedAt || new Date();
  await db()
    .update(codeSession)
    .set({
      status: 'ended',
      suspensionReason: '',
      endedAt: now,
      lastActiveAt: now,
      updatedAt: now,
      archiveKey: typeof archive?.key === 'string' ? archive.key : undefined,
      archiveDigest: digestFromArchive(archive),
    })
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)));

  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  return toView(row);
}

async function markSessionDiscarded(
  userId: string,
  sessionId: string,
  endedAt?: Date
): Promise<CodeSessionView> {
  const now = endedAt || new Date();
  await db()
    .update(codeSession)
    .set({
      status: 'ended',
      suspensionReason: '',
      endedAt: now,
      lastActiveAt: now,
      updatedAt: now,
      archiveKey: null,
      archiveDigest: null,
    })
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)));

  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  return toView(row);
}

async function markSessionSuspended(
  userId: string,
  sessionId: string,
  archive?: RuntimeActionResult | null,
  suspendedAt?: Date,
  suspensionReason = ''
): Promise<CodeSessionView> {
  const now = suspendedAt || new Date();
  await db()
    .update(codeSession)
    .set({
      status: 'suspended',
      suspensionReason,
      lastActiveAt: now,
      updatedAt: now,
      archiveKey: typeof archive?.key === 'string' ? archive.key : undefined,
      archiveDigest: digestFromArchive(archive),
    })
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)));

  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  return toView(row);
}

export async function recordArchive(
  userId: string,
  sessionId: string,
  archive: RuntimeActionResult
): Promise<CodeSessionView> {
  const now = new Date();
  await db()
    .update(codeSession)
    .set({
      archiveKey: typeof archive.key === 'string' ? archive.key : undefined,
      archiveDigest: digestFromArchive(archive),
      lastActiveAt: now,
      updatedAt: now,
    })
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)));

  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  return toView(row);
}

function digestFromArchive(archive?: RuntimeActionResult | null) {
  const digest =
    archive?.workspaceDigest || archive?.archiveSha256 || archive?.digest;
  return typeof digest === 'string' ? digest : undefined;
}

function objectField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function digestFromRestore(restore?: RuntimeActionResult | null) {
  const directDigest = digestFromArchive(restore);
  if (directDigest) return directDigest;

  const restored = objectField(restore, 'restored');
  const restoredDigest = digestFromArchive(
    restored as RuntimeActionResult | undefined
  );
  if (restoredDigest) return restoredDigest;

  const workspace = objectField(restore, 'workspace');
  const workspaceDigest = stringField(workspace, 'digest');
  if (workspaceDigest) return workspaceDigest;

  const objectMetadata = objectField(restore, 'objectMetadata');
  const metadataDigest = stringField(objectMetadata, 'workspaceDigest');
  return metadataDigest || undefined;
}

export async function recordCodeSessionEvent({
  userId,
  sessionId,
  runtimeUserId = '',
  agent,
  model = '',
  eventType,
  severity = 'info',
  source = 'app',
  message = '',
  metadata = {},
}: RecordCodeSessionEventInput) {
  const normalizedAgent = normalizeAgent(agent);
  const event = {
    id: generateEventId(),
    userId,
    sessionId,
    runtimeUserId,
    agent: normalizedAgent,
    model,
    eventType: safeString(eventType, 96),
    severity,
    source,
    message: safeString(message, 500),
    metadata: serializeMetadata(metadata),
    createdAt: new Date(),
  };

  console.info('[code-session-event]', event);

  try {
    await db().insert(codeSessionEvent).values(event);
  } catch (error) {
    console.warn('[code-session-event-failed]', {
      sessionId,
      eventType: event.eventType,
      message: (error as Error).message,
    });
  }
}

export async function recordClientSessionEvent(
  userId: string,
  sessionId: string,
  input: Record<string, unknown>
) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');

  const eventType =
    typeof input.eventType === 'string' &&
    input.eventType.startsWith('terminal.')
      ? input.eventType
      : 'terminal.client';
  const severity =
    input.severity === 'warn' || input.severity === 'error'
      ? input.severity
      : 'info';
  const metadata =
    input.metadata && typeof input.metadata === 'object'
      ? (input.metadata as Record<string, unknown>)
      : {};

  await recordCodeSessionEvent({
    userId,
    sessionId,
    runtimeUserId: row.runtimeUserId,
    agent: row.agent,
    model: row.model,
    eventType,
    severity,
    source: 'browser',
    message: typeof input.message === 'string' ? input.message : '',
    metadata,
  });

  if (row.status === 'active') {
    const now = new Date();
    await db()
      .update(codeSession)
      .set({ lastActiveAt: now, updatedAt: now })
      .where(
        and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId))
      );
  }

  return { ok: true };
}

export async function listSessionEvents(
  userId: string,
  sessionId: string,
  limit = 100
) {
  const rows = await db()
    .select()
    .from(codeSessionEvent)
    .where(
      and(
        eq(codeSessionEvent.userId, userId),
        eq(codeSessionEvent.sessionId, sessionId)
      )
    )
    .orderBy(desc(codeSessionEvent.createdAt))
    .limit(Math.min(Math.max(limit, 1), 200));

  return rows.map((row: any) => ({
    ...row,
    createdAt: asIso(row.createdAt),
  }));
}

function generateEventId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `evt-${Date.now().toString(36)}`;
}

function safeString(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function serializeMetadata(metadata: Record<string, unknown>) {
  try {
    const json = JSON.stringify(sanitizeMetadata(metadata));
    return json.length > 4000 ? json.slice(0, 4000) : json;
  } catch {
    return '';
  }
}

function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return safeString(value, 500);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= 3) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>
    )) {
      if (
        /^(apiKey|accessToken|refreshToken|idToken|password|secret|authorization|cookie)$/i.test(
          key
        )
      ) {
        output[key] = '[redacted]';
        continue;
      }
      output[safeString(key, 80)] = sanitizeMetadata(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

function pickRuntimeFields(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of [
    'ok',
    'exists',
    'state',
    'status',
    'agent',
    'model',
    'workspace',
    'runtimeUserId',
    'sessionId',
    'key',
    'versionKey',
    'archiveSha256',
    'workspaceDigest',
    'digest',
    'files',
    'fileCount',
    'previousFileCount',
    'bytes',
    'durationSeconds',
    'chargedCredits',
    'code',
    'stage',
    'details',
    'archiveFormat',
    'legacyArchive',
    'skippedFileCount',
  ]) {
    if (record[key] !== undefined) output[key] = record[key];
  }
  return output;
}

function runtimeErrorMetadata(error: unknown): Record<string, unknown> {
  if (!(error instanceof RuntimeRequestError)) return {};
  return {
    status: error.status,
    code: error.code,
    stage: error.stage,
    details: error.details,
  };
}

function archiveMetadata(archive?: RuntimeActionResult | null) {
  if (!archive) return {};
  return {
    key: typeof archive.key === 'string' ? archive.key : '',
    versionKey:
      typeof archive.versionKey === 'string' ? archive.versionKey : '',
    digest: digestFromArchive(archive) || '',
    bytes:
      typeof archive.bytes === 'number'
        ? archive.bytes
        : typeof archive.size === 'number'
          ? archive.size
          : undefined,
    files:
      typeof archive.files === 'number'
        ? archive.files
        : typeof archive.fileCount === 'number'
          ? archive.fileCount
          : undefined,
  };
}

function archiveStatusFromResult(
  session: CodeSessionView,
  archive: RuntimeActionResult,
  eventKind: string | null
): ArchiveStatus {
  const metadata = archiveMetadata(archive);
  return {
    state: 'saved',
    savedAt: session.lastActiveAt,
    digest:
      (typeof metadata.digest === 'string' ? metadata.digest : '') ||
      session.archiveDigest ||
      '',
    key:
      (typeof metadata.key === 'string' ? metadata.key : '') ||
      session.archiveKey ||
      '',
    eventKind: eventKind || 'unchanged',
    recordedEvent: Boolean(eventKind),
    bytes: typeof metadata.bytes === 'number' ? metadata.bytes : undefined,
    files: typeof metadata.files === 'number' ? metadata.files : undefined,
  };
}

function archiveEventKind(
  row: CodeSession,
  archive?: RuntimeActionResult | null
) {
  const digest = digestFromArchive(archive);
  if (!row.archiveKey) return 'first';
  if (digest && digest !== row.archiveDigest) return 'digest_changed';
  return null;
}

function restoreIntegrityFromResult(
  row: CodeSession,
  restore?: RuntimeActionResult | null
): RestoreIntegrity {
  const expectedDigest = row.archiveDigest || '';
  const restoredDigest = digestFromRestore(restore) || '';
  if (!expectedDigest) {
    return { state: 'untracked', expectedDigest, restoredDigest };
  }
  if (!restoredDigest) {
    return { state: 'unknown', expectedDigest, restoredDigest };
  }
  if (restoredDigest !== expectedDigest) {
    return { state: 'mismatch', expectedDigest, restoredDigest };
  }
  return { state: 'verified', expectedDigest, restoredDigest };
}

function booleanField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'boolean' ? value : undefined;
}

function stringField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return '';
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : '';
}

function numberField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return 0;
  const value = Number((payload as Record<string, unknown>)[field]);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function stringArrayField(payload: unknown, field: string) {
  if (!payload || typeof payload !== 'object') return [];
  const value = (payload as Record<string, unknown>)[field];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

interface RuntimeJsonOptions {
  archiveKey?: string | null;
  targetArchiveKey?: string;
  retainPrevious?: boolean;
  maxBytes?: number;
  retentionDays?: number;
  maxSnapshots?: number;
}

const RUNTIME_ACTION_TIMEOUT_MS = 10 * 60_000;

async function runtimeActionSecret(action: string, fresh = false) {
  const configs = await getAllConfigs({ fresh });
  const secret = (
    configs.billing_usage_webhook_secret ||
    envConfigs.billing_usage_webhook_secret ||
    ''
  ).trim();
  if (!secret) {
    throw new RuntimeRequestError(
      503,
      'runtime_storage_not_configured',
      `runtime.${action}`,
      'Runtime storage management is not configured'
    );
  }
  return secret;
}

async function runtimeJson(
  action: string,
  runtimeUserId: string,
  sessionId?: string,
  method: 'GET' | 'POST' = 'GET',
  agent?: CodeSessionAgent,
  model?: string,
  options: RuntimeJsonOptions = {}
): Promise<RuntimeActionResult> {
  const url = new URL(
    actionUrl(
      envConfigs.runtime_base_url,
      action,
      runtimeUserId,
      sessionId,
      agent,
      model
    )
  );
  if (options.retainPrevious !== undefined) {
    url.searchParams.set('retainPrevious', options.retainPrevious ? '1' : '0');
  }
  if (options.maxBytes !== undefined) {
    url.searchParams.set('maxBytes', String(options.maxBytes));
  }
  if (options.retentionDays !== undefined) {
    url.searchParams.set('retentionDays', String(options.retentionDays));
  }
  if (options.maxSnapshots !== undefined) {
    url.searchParams.set('maxSnapshots', String(options.maxSnapshots));
  }
  const headers = new Headers();
  if (options.archiveKey) {
    headers.set('x-hicode-archive-key', options.archiveKey);
  }
  if (options.targetArchiveKey) {
    headers.set('x-hicode-target-archive-key', options.targetArchiveKey);
  }
  const protectedAction =
    action === 'seed' ||
    action === 'inspect' ||
    action === 'archive' ||
    action === 'restore' ||
    action === 'clear' ||
    action === 'destroy' ||
    action === 'tmux' ||
    action === 'container-health';
  if (protectedAction) {
    headers.set('x-hicode-runtime-secret', await runtimeActionSecret(action));
  }
  const request = () =>
    fetch(url, {
      method,
      headers,
      signal: AbortSignal.timeout(RUNTIME_ACTION_TIMEOUT_MS),
    });
  let res = await request();
  if (protectedAction && res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    headers.set(
      'x-hicode-runtime-secret',
      await runtimeActionSecret(action, true)
    );
    res = await request();
  }
  const payload = await res.json().catch(() => ({}));

  if (!res.ok || payload?.ok === false) {
    const message =
      typeof payload?.error === 'string'
        ? payload.error
        : res.statusText || 'Runtime request failed';
    const code =
      typeof payload?.code === 'string'
        ? payload.code
        : 'runtime_request_failed';
    const stage =
      typeof payload?.stage === 'string' ? payload.stage : `runtime.${action}`;
    const details =
      payload?.details && typeof payload.details === 'object'
        ? (payload.details as Record<string, unknown>)
        : {};
    throw new RuntimeRequestError(
      res.status,
      code,
      stage,
      `[${stage}] ${message}`,
      details
    );
  }

  return payload;
}

export async function health(userId: string, sessionId: string) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  try {
    const health = await runtimeJson(
      'container-health',
      row.runtimeUserId,
      sessionId,
      'GET',
      normalizeAgent(row.agent),
      row.model
    );
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.health',
      message: 'Runtime health checked',
      metadata: pickRuntimeFields(health),
    });
    return health;
  } catch (error) {
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.health.failed',
      severity: 'warn',
      message: (error as Error).message,
      metadata: runtimeErrorMetadata(error),
    });
    throw error;
  }
}

export async function inspectSession(userId: string, sessionId: string) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  if (row.status !== 'active') {
    return { session: toView(row), tmuxStatus: null, workspace: null };
  }

  const agent = normalizeAgent(row.agent);
  try {
    const [tmuxStatus, workspace] = await Promise.all([
      runtimeJson(
        'tmux',
        row.runtimeUserId,
        sessionId,
        'GET',
        agent,
        row.model
      ),
      runtimeJson(
        'inspect',
        row.runtimeUserId,
        sessionId,
        'GET',
        agent,
        row.model
      ),
    ]);
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.inspect',
      message: 'Runtime inspected',
      metadata: {
        tmuxExists: booleanField(tmuxStatus, 'exists'),
        workspaceExists: booleanField(workspace, 'exists'),
        tmuxState: stringField(tmuxStatus, 'state'),
        workspacePath: stringField(workspace, 'workspace'),
      },
    });

    return { session: toView(row), tmuxStatus, workspace };
  } catch (error) {
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.inspect.failed',
      severity: 'warn',
      message: (error as Error).message,
      metadata: runtimeErrorMetadata(error),
    });
    throw error;
  }
}

function workspaceTotalBytes(workspace: RuntimeActionResult) {
  const reported =
    numberField(workspace, 'total_bytes') ||
    numberField(workspace, 'totalBytes');
  if (reported > 0) return reported;
  const files = workspace.files;
  if (!Array.isArray(files)) return 0;
  return files.reduce((total, item) => {
    if (!item || typeof item !== 'object') return total;
    return total + numberField(item, 'size');
  }, 0);
}

function archiveReservationCeiling(workspaceBytes: number, fileCount: number) {
  const tarOverhead = Math.max(1024 * 1024, fileCount * 1024);
  return workspaceBytes + tarOverhead;
}

function targetArchiveKey(
  runtimeUserId: string,
  sessionId: string,
  requestId: string
) {
  return `integrated-workspaces/${encodeURIComponent(runtimeUserId)}/${encodeURIComponent(sessionId)}/archives/${encodeURIComponent(requestId)}.tar.gz`;
}

function affectedRowCount(result: any) {
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

async function withStorageMutationHeartbeat<T>(
  userId: string,
  lockToken: string,
  execute: () => Promise<T>
): Promise<T> {
  let heartbeatError: unknown = null;
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeat = async () => {
    if (heartbeatError) throw heartbeatError;
    if (!heartbeatInFlight) {
      heartbeatInFlight = renewStorageMutationLock(userId, lockToken)
        .then(() => undefined)
        .catch((error) => {
          heartbeatError = error;
        })
        .finally(() => {
          heartbeatInFlight = null;
        });
    }
    await heartbeatInFlight;
    if (heartbeatError) throw heartbeatError;
  };

  await heartbeat();
  const timer = setInterval(() => {
    void heartbeat().catch(() => undefined);
  }, 60_000);
  try {
    const result = await execute();
    await heartbeat();
    return result;
  } finally {
    clearInterval(timer);
  }
}

export async function acquireArchiveLock(row: CodeSession) {
  const token = getUuid();
  const now = new Date();
  const changed = await db()
    .update(codeSession)
    .set({
      archiveLockToken: token,
      archiveLockExpiresAt: new Date(now.getTime() + 30 * 60_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(codeSession.userId, row.userId),
        eq(codeSession.id, row.id),
        or(
          eq(codeSession.archiveLockToken, ''),
          lt(codeSession.archiveLockExpiresAt, now)
        )
      )
    );
  if (affectedRowCount(changed) !== 1) {
    throw new StorageConflictError(
      'Another archive operation is already running for this session'
    );
  }
  return token;
}

export async function releaseArchiveLock(row: CodeSession, token: string) {
  await db()
    .update(codeSession)
    .set({
      archiveLockToken: '',
      archiveLockExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(codeSession.userId, row.userId),
        eq(codeSession.id, row.id),
        eq(codeSession.archiveLockToken, token)
      )
    );
}

async function archiveRuntimeWithQuotaLocked(
  row: CodeSession,
  preferHistory: boolean,
  storageLockToken: string
): Promise<RuntimeActionResult> {
  const configs = await getAllConfigs();
  const storageSettings = getCodeStorageSettings(configs);
  await reconcileUserStorage(row.userId, configs, {
    lockToken: storageLockToken,
  });
  const workspace = await runtimeJson(
    'inspect',
    row.runtimeUserId,
    row.id,
    'GET',
    normalizeAgent(row.agent),
    row.model
  );
  const workspaceBytes = workspaceTotalBytes(workspace);
  assertWorkspaceWithinQuota(workspaceBytes, configs);
  const fileCount =
    numberField(workspace, 'file_count') || numberField(workspace, 'fileCount');
  const requestedCeiling = archiveReservationCeiling(workspaceBytes, fileCount);

  const attempt = async (retainPrevious: boolean) => {
    const storage = await getUserStorage(row.userId, configs);
    const sessionBytes =
      storage.sessions.find((session) => session.id === row.id)?.totalBytes ??
      0;
    const replaceableBytes = retainPrevious ? 0 : sessionBytes;
    const availableForArchive = Math.max(
      0,
      storage.quota.limitBytes -
        storage.quota.usedBytes -
        storage.quota.reservedBytes +
        replaceableBytes
    );
    const requestedBytes = Math.min(requestedCeiling, availableForArchive);
    if (requestedBytes <= 0) {
      throw new StorageQuotaExceededError('Storage quota exceeded', {
        usedBytes: storage.quota.usedBytes,
        reservedBytes: storage.quota.reservedBytes,
        requestedBytes: requestedCeiling,
        replaceableBytes,
        limitBytes: storage.quota.limitBytes,
        projectedBytes:
          storage.quota.usedBytes +
          storage.quota.reservedBytes +
          requestedCeiling -
          replaceableBytes,
      });
    }
    const requestId = getUuid();
    const targetKey = targetArchiveKey(row.runtimeUserId, row.id, requestId);
    const reservationResult = await reserveStorage({
      userId: row.userId,
      sessionId: row.id,
      requestedBytes,
      replaceableBytes,
      objectKey: targetKey,
      idempotencyKey: `archive:${row.id}:${requestId}`,
      configs,
      lockToken: storageLockToken,
    });
    const reservationId = reservationResult.reservation.id;

    let archive: RuntimeActionResult;
    try {
      archive = await runtimeJson(
        'archive',
        row.runtimeUserId,
        row.id,
        'POST',
        normalizeAgent(row.agent),
        row.model,
        {
          archiveKey: row.archiveKey,
          targetArchiveKey: targetKey,
          retainPrevious,
          maxBytes: requestedBytes,
          retentionDays: storageSettings.retentionDays,
          maxSnapshots: storageSettings.maxSnapshotsPerSession,
        }
      );
    } catch (error) {
      if (
        error instanceof RuntimeRequestError &&
        error.code === 'archive_size_exceeded'
      ) {
        // The Runtime deletes an oversized object before returning this
        // structured response, so this failure is not ambiguous.
        await releaseReservation(reservationId, storageLockToken).catch(
          () => undefined
        );
        throw error;
      }
      // The Worker may have completed the R2 PUT even when this request timed
      // out or its response was lost. Keep the session-scoped target charged
      // until a physical reconciliation proves whether it exists.
      await holdReservationForReconciliation(
        reservationId,
        requestedBytes,
        targetKey,
        storageLockToken
      ).catch(() => undefined);
      throw error;
    }

    const key =
      stringField(archive, 'currentKey') || stringField(archive, 'key');
    const sizeBytes =
      numberField(archive, 'bytes') || numberField(archive, 'size');
    if (!key || sizeBytes <= 0) {
      await holdReservationForReconciliation(
        reservationId,
        requestedBytes,
        null,
        storageLockToken
      );
      throw new Error('Runtime returned invalid archive metadata');
    }
    const deduplicated = booleanField(archive, 'deduplicated') === true;
    if (!deduplicated) {
      const held = await holdReservationForReconciliation(
        reservationId,
        sizeBytes,
        key,
        storageLockToken
      );
      if (!held) {
        throw new StorageConflictError(
          'Uploaded archive could not be recorded for reconciliation'
        );
      }
    }
    try {
      await recordRuntimeArchiveResult({
        reservationId,
        key,
        sizeBytes,
        digest:
          stringField(archive, 'workspaceDigest') ||
          stringField(archive, 'archiveSha256') ||
          null,
        deduplicated,
        deletedKeys: stringArrayField(archive, 'deletedKeys'),
        configs,
        lockToken: storageLockToken,
      });
      return archive;
    } catch (error) {
      // The R2 write may already be durable. Keep its net reservation charged
      // for reconciliation instead of releasing quota and creating an
      // unaccounted orphan.
      await holdReservationForReconciliation(
        reservationId,
        sizeBytes,
        key,
        storageLockToken
      );
      throw error;
    }
  };

  const initialStorage = await getUserStorage(row.userId, configs);
  const usageRatio =
    initialStorage.quota.limitBytes > 0
      ? (initialStorage.quota.usedBytes + initialStorage.quota.reservedBytes) /
        initialStorage.quota.limitBytes
      : 1;
  const retainPrevious = preferHistory && usageRatio < 0.9;

  try {
    return await attempt(retainPrevious);
  } catch (error) {
    if (
      retainPrevious &&
      (error instanceof StorageQuotaExceededError ||
        (error instanceof RuntimeRequestError &&
          error.code === 'archive_size_exceeded'))
    ) {
      return attempt(false);
    }
    throw error;
  }
}

async function beginArchiveRuntimeWithQuota(
  row: CodeSession,
  preferHistory = true
): Promise<{
  archive: RuntimeActionResult;
  lockToken: string;
  storageLockToken: string;
}> {
  const lockToken = await acquireArchiveLock(row);
  let storageLockToken = '';
  try {
    storageLockToken = await acquireStorageMutationLock(row.userId);
    const archive = await withStorageMutationHeartbeat(
      row.userId,
      storageLockToken,
      () => archiveRuntimeWithQuotaLocked(row, preferHistory, storageLockToken)
    );
    const key =
      stringField(archive, 'currentKey') || stringField(archive, 'key');
    const changed = await db()
      .update(codeSession)
      .set({
        archiveKey: key,
        archiveDigest: digestFromArchive(archive),
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(codeSession.userId, row.userId),
          eq(codeSession.id, row.id),
          eq(codeSession.archiveLockToken, lockToken)
        )
      );
    if (affectedRowCount(changed) !== 1) {
      throw new StorageConflictError(
        'Archive pointer could not be updated safely'
      );
    }
    return { archive, lockToken, storageLockToken };
  } catch (error) {
    if (storageLockToken) {
      await releaseStorageMutationLock(row.userId, storageLockToken).catch(
        () => undefined
      );
    }
    await releaseArchiveLock(row, lockToken).catch(() => undefined);
    throw error;
  }
}

export async function archiveSession(userId: string, sessionId: string) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  if (row.status !== 'active') throw new Error('Session is not active');

  let lockToken = '';
  let storageLockToken = '';
  try {
    const operation = await beginArchiveRuntimeWithQuota(row);
    lockToken = operation.lockToken;
    storageLockToken = operation.storageLockToken;
    const archive = operation.archive;
    const eventKind = archiveEventKind(row, archive);
    const current = await getOwnedSession(userId, sessionId);
    if (!current) throw new Error('Session not found');
    const session = toView(current);
    const archiveStatus = archiveStatusFromResult(session, archive, eventKind);
    if (eventKind) {
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.archive',
        message:
          eventKind === 'first'
            ? 'Workspace archived for the first time'
            : 'Workspace archive digest changed',
        metadata: {
          ...archiveMetadata(archive),
          eventKind,
          previousArchiveKey: row.archiveKey || '',
          previousDigest: row.archiveDigest || '',
        },
      });
    }

    return { session, archive, archiveStatus };
  } catch (error) {
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.archive.failed',
      severity: 'warn',
      message: (error as Error).message,
      metadata: runtimeErrorMetadata(error),
    });
    throw error;
  } finally {
    if (storageLockToken) {
      await releaseStorageMutationLock(userId, storageLockToken).catch(
        () => undefined
      );
    }
    if (lockToken) {
      await releaseArchiveLock(row, lockToken).catch(() => undefined);
    }
  }
}

export async function restoreSession(userId: string, sessionId: string) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  if (row.status !== 'active') throw new Error('Session is not active');

  const archiveLockToken = await acquireArchiveLock(row);
  try {
    const restore = await runtimeJson(
      'restore',
      row.runtimeUserId,
      sessionId,
      'POST',
      normalizeAgent(row.agent),
      row.model,
      { archiveKey: row.archiveKey }
    );
    let restoreIntegrity = restoreIntegrityFromResult(row, restore);
    const legacyArchive = booleanField(restore, 'legacyArchive') === true;
    if (
      restoreIntegrity.state === 'mismatch' &&
      legacyArchive &&
      restoreIntegrity.restoredDigest
    ) {
      await db()
        .update(codeSession)
        .set({
          archiveDigest: restoreIntegrity.restoredDigest,
          updatedAt: new Date(),
        })
        .where(
          and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId))
        );
      restoreIntegrity = { ...restoreIntegrity, state: 'reconciled' };
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.restore.integrity_reconciled',
        severity: 'warn',
        message: 'Legacy archive digest reconciled after verified extraction',
        metadata: {
          restoreIntegrity,
          restore: pickRuntimeFields(restore),
        },
      });
    }
    if (restoreIntegrity.state === 'mismatch') {
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.restore.integrity_failed',
        severity: 'error',
        message: 'Restored workspace digest mismatch',
        metadata: {
          restoreIntegrity,
          restore: pickRuntimeFields(restore),
        },
      });
      throw new Error('Restored workspace digest mismatch');
    }

    const session = await touchSession(userId, sessionId);
    if (restoreIntegrity.state === 'unknown') {
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.restore.integrity_unknown',
        severity: 'warn',
        message: 'Restored workspace digest was not reported',
        metadata: {
          restoreIntegrity,
          restore: pickRuntimeFields(restore),
        },
      });
    }
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.restore',
      message: 'Workspace restored',
      metadata: {
        ...pickRuntimeFields(restore),
        restoreIntegrity,
      },
    });

    return { session, restore, restoreIntegrity };
  } catch (error) {
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.restore.failed',
      severity: 'warn',
      message: (error as Error).message,
      metadata: runtimeErrorMetadata(error),
    });
    throw error;
  } finally {
    await releaseArchiveLock(row, archiveLockToken).catch(() => undefined);
  }
}

export async function resumeArchivedSession(userId: string, sessionId: string) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  if (row.status !== 'ended' && row.status !== 'suspended') {
    throw new Error('Session is not restorable');
  }
  if (!row.archiveKey) throw new Error('Archived workspace not found');

  const archiveLockToken = await acquireArchiveLock(row);
  try {
    const model = await getCodeModelForBilling(row.agent, row.model);
    await ensureCanStartBillableSession(userId, model || undefined);

    const activeRows = await db()
      .select({ id: codeSession.id })
      .from(codeSession)
      .where(
        and(eq(codeSession.userId, userId), eq(codeSession.status, 'active'))
      )
      .limit(maxActiveSessions());

    if (activeRows.length >= maxActiveSessions()) {
      throw new Error('Suspend or end the current session before restoring');
    }

    const now = new Date();
    const changed = await db()
      .update(codeSession)
      .set({
        status: 'active',
        suspensionReason: '',
        endedAt: null,
        lastBilledAt: now,
        lastActiveAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(codeSession.userId, userId),
          eq(codeSession.id, sessionId),
          eq(codeSession.archiveLockToken, archiveLockToken)
        )
      );
    if (affectedRowCount(changed) !== 1) {
      throw new StorageConflictError(
        'Session could not be resumed under the lifecycle lock'
      );
    }

    const resumed = await getOwnedSession(userId, sessionId);
    if (!resumed) throw new Error('Session not found');

    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: resumed.runtimeUserId,
      agent: resumed.agent,
      model: resumed.model,
      eventType: 'session.resumed',
      message: 'Archived session resumed',
      metadata: {
        archiveKey: row.archiveKey,
        archiveDigest: row.archiveDigest || '',
        previousStatus: row.status,
        previousEndedAt: asIso(row.endedAt),
      },
    });

    return { session: toView(resumed), restorePending: true };
  } finally {
    await releaseArchiveLock(row, archiveLockToken).catch(() => undefined);
  }
}

export async function preflightSessionResume(
  userId: string,
  sessionId: string
) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  if (row.status !== 'ended' && row.status !== 'suspended') {
    throw new Error('Session is not restorable');
  }
  if (!row.archiveKey) throw new Error('Archived workspace not found');

  const model = await getCodeModelForBilling(row.agent, row.model);
  await ensureCanStartBillableSession(userId, model || undefined);
  return { ready: true, sessionId: row.id };
}

export async function suspendSession(userId: string, sessionId: string) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  return suspendSessionRow(row, { reason: 'manual' });
}

async function destroyRuntimeForPermanentDelete(row: CodeSession) {
  if (row.status !== 'active') {
    return {
      attempted: false,
      skippedReason: 'session_not_active',
      result: null,
    };
  }

  const activeRows = await db()
    .select({ id: codeSession.id })
    .from(codeSession)
    .where(
      and(
        eq(codeSession.userId, row.userId),
        eq(codeSession.runtimeUserId, row.runtimeUserId),
        eq(codeSession.status, 'active')
      )
    )
    .limit(2);
  if (activeRows.some((active: { id: string }) => active.id !== row.id)) {
    throw new StorageConflictError(
      'Another active session exists; the shared Runtime container cannot be deleted safely'
    );
  }

  const result = await runtimeJson(
    'destroy',
    row.runtimeUserId,
    row.id,
    'POST',
    normalizeAgent(row.agent),
    row.model
  );
  return {
    attempted: true,
    skippedReason: null,
    result: pickRuntimeFields(result),
  };
}

async function finalizePermanentSessionDeletion(
  row: CodeSession,
  storageLockToken: string
) {
  // Cloudflare D1 does not provide a rollback-capable interactive transaction.
  // Renew and validate the lease before any hard deletes. If a later statement
  // is interrupted, the session row is deliberately deleted last so retry can
  // finish ledger reconciliation without touching R2 again.
  await renewStorageMutationLock(row.userId, storageLockToken);
  return db().transaction(async (tx: any) => {
    const [lockedUsage] = await tx
      .select()
      .from(storageUsage)
      .where(
        and(
          eq(storageUsage.userId, row.userId),
          eq(storageUsage.reconcileLockToken, storageLockToken)
        )
      )
      .limit(1);
    if (
      !lockedUsage ||
      !lockedUsage.reconcileLockExpiresAt ||
      new Date(lockedUsage.reconcileLockExpiresAt).getTime() < Date.now()
    ) {
      throw new StorageConflictError('Storage mutation lock was lost');
    }

    await tx
      .delete(storageObject)
      .where(
        and(
          eq(storageObject.userId, row.userId),
          eq(storageObject.sessionId, row.id)
        )
      );
    await tx
      .delete(storageReservation)
      .where(
        and(
          eq(storageReservation.userId, row.userId),
          eq(storageReservation.sessionId, row.id)
        )
      );

    const remainingObjects = await tx
      .select({
        sizeBytes: storageObject.sizeBytes,
        status: storageObject.status,
      })
      .from(storageObject)
      .where(
        and(
          eq(storageObject.userId, row.userId),
          inArray(storageObject.status, ['active', 'deleting'])
        )
      );
    const remainingReservations = await tx
      .select({ reservedBytes: storageReservation.reservedBytes })
      .from(storageReservation)
      .where(
        and(
          eq(storageReservation.userId, row.userId),
          inArray(storageReservation.status, [
            'reserved',
            'reconcile',
            'settling',
            'releasing',
          ])
        )
      );
    const [usage] = await tx
      .select()
      .from(storageUsage)
      .where(eq(storageUsage.userId, row.userId))
      .limit(1);
    if (!usage) throw new StorageConflictError('Storage usage row is missing');

    const usedBytes = remainingObjects.reduce(
      (total: number, object: { sizeBytes: unknown }) =>
        total + Number(object.sizeBytes),
      0
    );
    const pendingDeleteBytes = remainingObjects
      .filter((object: { status: string }) => object.status === 'deleting')
      .reduce(
        (total: number, object: { sizeBytes: unknown }) =>
          total + Number(object.sizeBytes),
        0
      );
    const reservedBytes = remainingReservations.reduce(
      (total: number, reservation: { reservedBytes: unknown }) =>
        total + Number(reservation.reservedBytes),
      0
    );
    const now = new Date();
    const usageChanged = await tx
      .update(storageUsage)
      .set({
        usedBytes,
        reservedBytes,
        pendingDeleteBytes,
        version: usage.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(storageUsage.userId, row.userId),
          eq(storageUsage.version, usage.version),
          eq(storageUsage.reconcileLockToken, storageLockToken),
          gte(storageUsage.reconcileLockExpiresAt, now)
        )
      );
    if (affectedRowCount(usageChanged) !== 1) {
      throw new StorageConflictError('Storage mutation lock was lost');
    }

    await tx
      .delete(codeSession)
      .where(
        and(eq(codeSession.userId, row.userId), eq(codeSession.id, row.id))
      );
    const [remainingSession] = await tx
      .select({ id: codeSession.id })
      .from(codeSession)
      .where(
        and(eq(codeSession.userId, row.userId), eq(codeSession.id, row.id))
      )
      .limit(1);
    if (remainingSession) {
      throw new StorageConflictError('Session deletion was interrupted');
    }

    return {
      removedStorageObjects: true,
      removedStorageReservations: true,
      removedSession: true,
    };
  });
}

async function permanentlyDeleteSessionWithReason(
  userId: string,
  sessionId: string,
  reason: 'delete-permanently' | 'discard'
) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');
  if (
    row.status !== 'active' &&
    row.status !== 'suspended' &&
    row.status !== 'ended'
  ) {
    throw new Error(
      'Session cannot be permanently deleted in its current state'
    );
  }

  const archiveLockToken = await acquireArchiveLock(row);
  let storageLockToken = '';
  try {
    // Acquire both lifecycle locks before the first irreversible external
    // action. A lock conflict must never leave an active DB row whose Runtime
    // was already destroyed.
    storageLockToken = await acquireStorageMutationLock(userId);
    let runtime: Awaited<ReturnType<typeof destroyRuntimeForPermanentDelete>>;
    let billing: unknown = null;
    try {
      runtime = await withStorageMutationHeartbeat(
        userId,
        storageLockToken,
        () => destroyRuntimeForPermanentDelete(row)
      );
    } catch (error) {
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: `session.${reason}.failed`,
        severity: 'error',
        message: (error as Error).message || 'Runtime destruction failed',
        metadata: { stage: 'runtime.destroy', previousStatus: row.status },
      });
      throw error;
    }

    if (row.status === 'active') {
      try {
        billing = await settleSessionRuntimeUsage({
          userId,
          sessionId,
          runtimeState: 'active',
          endedAt: new Date(),
          metadata: { reason },
        });
      } catch (error) {
        await recordCodeSessionEvent({
          userId,
          sessionId,
          runtimeUserId: row.runtimeUserId,
          agent: row.agent,
          model: row.model,
          eventType: 'session.billing.failed',
          severity: 'warn',
          message: (error as Error).message,
          metadata: { during: `session.${reason}` },
        });
      }
    }

    const pending = (await markStorageObjectsDeleting({
      userId,
      sessionId,
      scope: 'session',
      lockToken: storageLockToken,
    })) as Array<{ key: string }>;
    const trackedKeys: string[] = [
      ...new Set(pending.map((object) => object.key)),
    ];
    let physicalDelete: Awaited<ReturnType<typeof deleteRuntimeArchives>>;
    try {
      physicalDelete = await withStorageMutationHeartbeat(
        userId,
        storageLockToken,
        () =>
          deleteRuntimeArchives({
            runtimeUserId: row.runtimeUserId,
            sessionId: row.id,
            scope: 'all',
          })
      );
    } catch (error) {
      if (trackedKeys.length > 0) {
        await restoreStorageObjects({
          userId,
          keys: trackedKeys,
          lockToken: storageLockToken,
        }).catch(() => undefined);
      }
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: `session.${reason}.failed`,
        severity: 'error',
        message: (error as Error).message || 'Archive deletion failed',
        metadata: { stage: 'storage.delete', previousStatus: row.status },
      });
      throw error;
    }

    if (physicalDelete.failed.length > 0) {
      const confirmedPhysicalKeys = new Set([
        ...(physicalDelete.deletedKeys || []),
        ...(physicalDelete.notFound || []),
      ]);
      const unconfirmedTrackedKeys = trackedKeys.filter(
        (key) => !confirmedPhysicalKeys.has(key)
      );
      if (unconfirmedTrackedKeys.length > 0) {
        // A scope deletion only lists objects that existed at scan time. Verify
        // tracked keys explicitly so already-absent objects are settled instead
        // of being restored to active quota after a mixed R2 result.
        const verification = await withStorageMutationHeartbeat(
          userId,
          storageLockToken,
          () =>
            deleteRuntimeArchives({
              runtimeUserId: row.runtimeUserId,
              sessionId: row.id,
              keys: unconfirmedTrackedKeys,
            })
        ).catch(() => null);
        for (const key of [
          ...(verification?.deletedKeys || []),
          ...(verification?.notFound || []),
        ]) {
          confirmedPhysicalKeys.add(key);
        }
      }
      const confirmedTrackedKeys = trackedKeys.filter((key) =>
        confirmedPhysicalKeys.has(key)
      );
      const unresolvedTrackedKeys = trackedKeys.filter(
        (key) => !confirmedPhysicalKeys.has(key)
      );

      if (confirmedTrackedKeys.length > 0) {
        await settleStorageDeletion({
          userId,
          keys: confirmedTrackedKeys,
          lockToken: storageLockToken,
        });
      }
      if (row.archiveKey && confirmedPhysicalKeys.has(row.archiveKey)) {
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
              eq(codeSession.archiveLockToken, archiveLockToken),
              eq(codeSession.archiveKey, row.archiveKey)
            )
          );
      }
      if (unresolvedTrackedKeys.length > 0) {
        await restoreStorageObjects({
          userId,
          keys: unresolvedTrackedKeys,
          lockToken: storageLockToken,
        }).catch(() => undefined);
      }
      const error = new Error(
        `${physicalDelete.failed.length} archive object(s) could not be deleted`
      );
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: `session.${reason}.failed`,
        severity: 'error',
        message: error.message,
        metadata: {
          stage: 'storage.delete',
          previousStatus: row.status,
          failedKeys: physicalDelete.failed.map((item) => item.key),
        },
      });
      throw error;
    }

    const ledgerDelete = await settleStorageDeletion({
      userId,
      keys: trackedKeys,
      lockToken: storageLockToken,
    });
    const finalized = await finalizePermanentSessionDeletion(
      row,
      storageLockToken
    );
    const result = {
      deleted: true as const,
      sessionId: row.id,
      previousStatus: row.status as CodeSessionStatus,
      runtime,
      storage: {
        scope: 'session' as const,
        physicalDeletedBytes: physicalDelete.deletedBytes,
        physicalDeletedKeys: physicalDelete.deletedKeys,
        trackedDeletedBytes: ledgerDelete.deletedBytes,
        trackedDeletedKeys: ledgerDelete.deletedKeys,
        ...finalized,
      },
      billing: pickRuntimeFields(billing),
    };
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType:
        reason === 'discard'
          ? 'session.discarded'
          : 'session.deleted_permanently',
      message:
        reason === 'discard'
          ? 'Session discarded and permanently deleted'
          : 'Session permanently deleted',
      metadata: {
        previousStatus: row.status,
        previousArchiveKey: row.archiveKey || '',
        runtime,
        storage: result.storage,
        billing: pickRuntimeFields(billing),
      },
    }).catch(() => undefined);

    return { result, deletedRow: row };
  } finally {
    if (storageLockToken) {
      await releaseStorageMutationLock(userId, storageLockToken).catch(
        () => undefined
      );
    }
    await releaseArchiveLock(row, archiveLockToken).catch(() => undefined);
  }
}

export async function deleteSessionPermanently(
  userId: string,
  sessionId: string
) {
  const operation = await permanentlyDeleteSessionWithReason(
    userId,
    sessionId,
    'delete-permanently'
  );
  return operation.result;
}

export async function discardSession(userId: string, sessionId: string) {
  const operation = await permanentlyDeleteSessionWithReason(
    userId,
    sessionId,
    'discard'
  );
  const endedAt = new Date();
  const session: CodeSessionView = {
    ...toView(operation.deletedRow),
    status: 'ended',
    archiveKey: null,
    archiveDigest: null,
    suspensionReason: '',
    lastActiveAt: endedAt.toISOString(),
    endedAt: endedAt.toISOString(),
  };
  return {
    ...operation.result,
    session,
    clear: operation.result.runtime.result,
    billing: operation.result.billing,
  };
}

export async function meterActiveSessions(now = new Date()) {
  const settings = await getCodeBillingSettings();
  const result = {
    ok: true,
    enabled: settings.enabled && settings.runtimeMeterEnabled,
    checked: 0,
    charged: 0,
    chargedCredits: 0,
    initialized: 0,
    notDue: 0,
    unpaid: 0,
    suspended: 0,
    failed: 0,
    at: now.toISOString(),
  };

  if (!result.enabled) return result;

  const rows = await db()
    .select()
    .from(codeSession)
    .where(eq(codeSession.status, 'active'))
    .orderBy(asc(codeSession.lastBilledAt), asc(codeSession.createdAt))
    .limit(50);
  result.checked = rows.length;

  const intervalMs = settings.runtimeMeterIntervalMinutes * 60_000;
  const maxDurationSeconds = settings.runtimeMeterMaxCatchupMinutes * 60;
  const bucket = Math.floor(now.getTime() / intervalMs);

  for (const row of rows) {
    try {
      const lastBilledAt = dateValue(row.lastBilledAt);
      if (!lastBilledAt) {
        await db()
          .update(codeSession)
          .set({ lastBilledAt: now, updatedAt: now })
          .where(eq(codeSession.id, row.id));
        result.initialized += 1;
        continue;
      }
      if (now.getTime() - lastBilledAt.getTime() < intervalMs) {
        result.notDue += 1;
        continue;
      }

      const lastActiveAt = dateValue(row.lastActiveAt) || lastBilledAt;
      const runtimeState =
        now.getTime() - lastActiveAt.getTime() >= intervalMs * 2
          ? 'idle'
          : 'active';
      const event = await settleSessionRuntimeUsage({
        userId: row.userId,
        sessionId: row.id,
        runtimeState,
        endedAt: now,
        maxDurationSeconds,
        recordZeroCharge: false,
        wholeMinutesOnly: true,
        metadata: { reason: 'incremental-meter', bucket },
      });

      if (event.status === 'not_due' || event.status === 'not_billable') {
        result.notDue += 1;
        continue;
      }
      if (event.status === 'charged') {
        result.charged += 1;
        result.chargedCredits += Number(event.chargedCredits || 0);
        continue;
      }
      if (event.status !== 'unpaid') continue;

      result.unpaid += 1;
      await recordCodeSessionEvent({
        userId: row.userId,
        sessionId: row.id,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.billing.insufficient_credits',
        severity: 'warn',
        message: 'Runtime suspended because credits are insufficient',
        metadata: {
          chargedCredits: event.chargedCredits,
          durationSeconds: event.durationSeconds,
          runtimeState,
        },
      });
      await suspendSessionRow(row, {
        reason: 'insufficient_credits',
        now,
        skipBilling: true,
      });
      result.suspended += 1;
    } catch (error) {
      result.failed += 1;
      console.warn('[code-runtime-meter] session failed', {
        sessionId: row.id,
        userId: row.userId,
        message: (error as Error).message,
      });
    }
  }

  return result;
}

export async function suspendIdleSessions(now = new Date()) {
  const cutoff = new Date(now.getTime() - idleSuspendMinutes() * 60_000);
  const rows = await db()
    .select()
    .from(codeSession)
    .where(
      and(
        eq(codeSession.status, 'active'),
        lt(codeSession.lastActiveAt, cutoff)
      )
    )
    .orderBy(asc(codeSession.lastActiveAt))
    .limit(idleReaperBatchSize());

  const result = {
    ok: true,
    checked: rows.length,
    suspended: 0,
    skipped: 0,
    failed: 0,
    cutoff: cutoff.toISOString(),
    idleMinutes: idleSuspendMinutes(),
  };

  for (const row of rows) {
    try {
      await suspendSessionRow(row, {
        reason: 'idle-timeout',
        now,
        cutoff,
      });
      result.suspended += 1;
    } catch (error) {
      result.failed += 1;
      console.warn('[code-session-reaper] suspend failed', {
        sessionId: row.id,
        userId: row.userId,
        message: (error as Error).message,
      });
    }
  }

  return result;
}

async function suspendSessionRow(
  row: CodeSession,
  options: {
    reason: string;
    now?: Date;
    cutoff?: Date;
    skipBilling?: boolean;
  }
) {
  if (row.status === 'suspended') {
    return {
      session: toView(row),
      archive: null,
      clear: null,
      archiveError: null,
      clearError: null,
      billing: null,
    };
  }
  if (row.status !== 'active') throw new Error('Session is not active');

  let archive: RuntimeActionResult | null = null;
  let archiveError: string | null = null;
  let archiveLockToken = '';
  let storageLockToken = '';
  try {
    const operation = await beginArchiveRuntimeWithQuota(row);
    archive = operation.archive;
    archiveLockToken = operation.lockToken;
    storageLockToken = operation.storageLockToken;
  } catch (error) {
    archiveError = (error as Error).message || 'Archive failed';
    await recordCodeSessionEvent({
      userId: row.userId,
      sessionId: row.id,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.archive.failed',
      severity: 'warn',
      message: archiveError,
      metadata: { during: 'session.suspend', reason: options.reason },
    });
    throw error;
  }

  try {
    if (!archive) {
      await recordCodeSessionEvent({
        userId: row.userId,
        sessionId: row.id,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.suspend.failed',
        severity: 'warn',
        message: 'No new archive is available for the suspended session',
        metadata: { reason: options.reason },
      });
      throw new Error('Cannot suspend session without a new workspace archive');
    }

    let clear: RuntimeActionResult | null = null;
    let clearError: string | null = null;
    try {
      clear = await runtimeJson(
        'clear',
        row.runtimeUserId,
        row.id,
        'POST',
        normalizeAgent(row.agent),
        row.model
      );
    } catch (error) {
      clearError = (error as Error).message || 'Runtime cleanup failed';
      await recordCodeSessionEvent({
        userId: row.userId,
        sessionId: row.id,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.clear.failed',
        severity: 'warn',
        message: clearError,
        metadata: { during: 'session.suspend', reason: options.reason },
      });
    }

    const suspendedAt = options.now || new Date();
    let billing: unknown = null;
    if (!options.skipBilling) {
      try {
        billing = await settleSessionRuntimeUsage({
          userId: row.userId,
          sessionId: row.id,
          runtimeState: 'active',
          endedAt: suspendedAt,
          metadata: { reason: options.reason, suspended: true },
        });
      } catch (error) {
        await recordCodeSessionEvent({
          userId: row.userId,
          sessionId: row.id,
          runtimeUserId: row.runtimeUserId,
          agent: row.agent,
          model: row.model,
          eventType: 'session.billing.failed',
          severity: 'warn',
          message: (error as Error).message,
          metadata: { during: 'session.suspend', reason: options.reason },
        });
      }
    }

    const session = await markSessionSuspended(
      row.userId,
      row.id,
      archive,
      suspendedAt,
      options.reason
    );
    await recordCodeSessionEvent({
      userId: row.userId,
      sessionId: row.id,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.suspended',
      message: 'Session suspended',
      metadata: {
        reason: options.reason,
        cutoff: options.cutoff?.toISOString(),
        archiveError,
        clearError,
        archive: archiveMetadata(archive),
        billing: pickRuntimeFields(billing),
      },
    });

    return { session, archive, clear, archiveError, clearError, billing };
  } finally {
    if (storageLockToken) {
      await releaseStorageMutationLock(row.userId, storageLockToken).catch(
        () => undefined
      );
    }
    if (archiveLockToken) {
      await releaseArchiveLock(row, archiveLockToken).catch(() => undefined);
    }
  }
}

export async function endSession(userId: string, sessionId: string) {
  const row = await getOwnedSession(userId, sessionId);
  if (!row) throw new Error('Session not found');

  let archive: RuntimeActionResult | null = null;
  let archiveError: string | null = null;
  let archiveLockToken = '';
  let storageLockToken = '';
  if (row.status === 'active') {
    try {
      const operation = await beginArchiveRuntimeWithQuota(row);
      archive = operation.archive;
      archiveLockToken = operation.lockToken;
      storageLockToken = operation.storageLockToken;
    } catch (error) {
      archiveError = (error as Error).message || 'Archive failed';
      await recordCodeSessionEvent({
        userId,
        sessionId,
        runtimeUserId: row.runtimeUserId,
        agent: row.agent,
        model: row.model,
        eventType: 'session.archive.failed',
        severity: 'warn',
        message: archiveError,
        metadata: { during: 'session.end' },
      });
      throw error;
    }
  }

  try {
    const clear = await runtimeJson(
      'clear',
      row.runtimeUserId,
      sessionId,
      'POST',
      normalizeAgent(row.agent),
      row.model
    );
    const endedAt = new Date();
    const billing = await settleSessionRuntimeUsage({
      userId,
      sessionId,
      runtimeState: 'active',
      endedAt,
    });
    const session = await markSessionEnded(userId, sessionId, archive, endedAt);
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.ended',
      message: 'Session ended',
      metadata: {
        archiveError,
        archive: archiveMetadata(archive),
        billing: pickRuntimeFields(billing),
      },
    });
    return { session, archive, clear, archiveError, billing };
  } catch (error) {
    await markSessionError(userId, sessionId);
    await recordCodeSessionEvent({
      userId,
      sessionId,
      runtimeUserId: row.runtimeUserId,
      agent: row.agent,
      model: row.model,
      eventType: 'session.end.failed',
      severity: 'error',
      message: (error as Error).message,
    });
    throw error;
  } finally {
    if (storageLockToken) {
      await releaseStorageMutationLock(userId, storageLockToken).catch(
        () => undefined
      );
    }
    if (archiveLockToken) {
      await releaseArchiveLock(row, archiveLockToken).catch(() => undefined);
    }
  }
}

async function ensureCanStartBillableSession(
  userId: string,
  model?: CodeModelView
) {
  const settings = await getCodeBillingSettings();
  if (!settings.enabled) {
    return;
  }

  if (
    (settings.requireConfiguredModelCosts || settings.modelGateEnabled) &&
    model &&
    !hasConfiguredModelTokenCosts(model)
  ) {
    throw new CodeSessionStartError(
      'model_costs_not_configured',
      'Selected model billing is not configured',
      { agent: model.agent, model: model.model }
    );
  }

  if (settings.sessionCreateMinBalanceCredits <= 0) return;

  let balance = await getBalance(userId);
  if (balance >= settings.sessionCreateMinBalanceCredits) {
    return;
  }

  const history = await getHistory(userId, 1);
  if (history.length === 0) {
    await grantForNewUser({
      userId,
      configs: await getAllConfigs(),
    });
    balance = await getBalance(userId);
  }

  if (balance < settings.sessionCreateMinBalanceCredits) {
    throw new CodeSessionStartError(
      'insufficient_credits',
      'Insufficient credits to start a new session',
      {
        balance,
        requiredBalance: settings.sessionCreateMinBalanceCredits,
      }
    );
  }
}
