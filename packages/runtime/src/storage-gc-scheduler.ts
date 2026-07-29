const STORAGE_GC_PREFIX = 'integrated-workspaces/';
const STORAGE_GC_STATE_KEY = 'maintenance/storage-gc-state.json';
const STORAGE_GC_LEASE_KEY = 'maintenance/storage-gc-lease.json';
// The app request is capped at 45 seconds and the surrounding R2 page/state
// operations also consume time. Keep the lease across the next one-minute cron
// tick so a slow but healthy run cannot be overlapped by the following tick.
const STORAGE_GC_LEASE_MS = 2 * 60_000;
// One app sweep results in at most 20 R2 deletes + 20 verification HEADs,
// keeping a page below the Workers Free subrequest ceiling.
export const STORAGE_GC_PAGE_SIZE = 20;
export const STORAGE_GC_CYCLE_COOLDOWN_MS = 6 * 60 * 60_000;
const STORAGE_GC_RETRY_BASE_MS = 60_000;
const STORAGE_GC_RETRY_MAX_MS = 60 * 60_000;

interface StorageGcPhysicalObject {
  key: string;
  size: number;
  uploaded: string;
  etag?: string;
  customMetadata?: Record<string, string>;
}

interface StorageGcPendingPage {
  objects: StorageGcPhysicalObject[];
  truncated: boolean;
  nextCursor?: string;
}

interface StorageGcState {
  version: 1;
  cursor?: string;
  pending?: StorageGcPendingPage;
  failures: number;
  nextAttemptAt: string;
  cycleStartedAt?: string;
  updatedAt: string;
}

interface StorageGcCandidate {
  key: string;
  reason: string;
}

interface StorageGcPlanResponse {
  scanned: number;
  managed: number;
  candidates: StorageGcCandidate[];
}

interface StorageGcSweepResponse extends StorageGcPlanResponse {
  deletedKeys: string[];
  failedKeys: string[];
  skippedKeys: string[];
}

export interface StorageGcSchedulerEnv {
  WORKSPACE_ARCHIVES: R2Bucket;
  APP_BASE_URL?: string;
  BILLING_USAGE_WEBHOOK_SECRET?: string;
}

export interface StorageGcScheduleResult {
  status: 'deferred' | 'page_complete' | 'cycle_complete' | 'failed';
  scanned: number;
  candidates: number;
  deleted: number;
  failures: number;
  nextAttemptAt: string;
  error?: string;
}

interface StorageGcSchedulerOptions {
  now?: Date;
  fetchFn?: typeof fetch;
}

interface StorageGcScheduleLease {
  acquired: boolean;
  expiresAt: string;
  etag?: string;
  token?: string;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function storageGcRetryDelayMs(failures: number) {
  return Math.min(
    STORAGE_GC_RETRY_MAX_MS,
    STORAGE_GC_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1)
  );
}

function initialState(now: Date): StorageGcState {
  return {
    version: 1,
    failures: 0,
    nextAttemptAt: new Date(0).toISOString(),
    updatedAt: now.toISOString(),
  };
}

function validIso(value: unknown) {
  if (typeof value !== 'string') return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function storedObject(value: unknown): StorageGcPhysicalObject | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Partial<StorageGcPhysicalObject>;
  if (
    typeof object.key !== 'string' ||
    !object.key.startsWith(STORAGE_GC_PREFIX) ||
    !Number.isSafeInteger(object.size) ||
    Number(object.size) < 0 ||
    !validIso(object.uploaded)
  ) {
    return null;
  }
  return {
    key: object.key,
    size: Number(object.size),
    uploaded: validIso(object.uploaded),
    ...(typeof object.etag === 'string' ? { etag: object.etag } : {}),
    ...(object.customMetadata &&
    typeof object.customMetadata === 'object' &&
    !Array.isArray(object.customMetadata)
      ? { customMetadata: object.customMetadata }
      : {}),
  };
}

function parseState(raw: string, now: Date): StorageGcState {
  try {
    const value = JSON.parse(raw) as Partial<StorageGcState>;
    if (value.version !== 1) return initialState(now);
    const nextAttemptAt = validIso(value.nextAttemptAt);
    const updatedAt = validIso(value.updatedAt);
    if (!nextAttemptAt || !updatedAt) return initialState(now);
    let pending: StorageGcPendingPage | undefined;
    if (value.pending) {
      const objects = Array.isArray(value.pending.objects)
        ? value.pending.objects
            .map(storedObject)
            .filter((object): object is StorageGcPhysicalObject =>
              Boolean(object)
            )
        : [];
      if (objects.length > 0) {
        pending = {
          objects,
          truncated: value.pending.truncated === true,
          ...(typeof value.pending.nextCursor === 'string' &&
          value.pending.nextCursor
            ? { nextCursor: value.pending.nextCursor }
            : {}),
        };
      }
    }
    return {
      version: 1,
      ...(typeof value.cursor === 'string' && value.cursor
        ? { cursor: value.cursor }
        : {}),
      ...(pending ? { pending } : {}),
      failures:
        Number.isSafeInteger(value.failures) && Number(value.failures) >= 0
          ? Number(value.failures)
          : 0,
      nextAttemptAt,
      ...(validIso(value.cycleStartedAt)
        ? { cycleStartedAt: validIso(value.cycleStartedAt) }
        : {}),
      updatedAt,
    };
  } catch {
    return initialState(now);
  }
}

async function loadState(env: StorageGcSchedulerEnv, now: Date) {
  const object = await env.WORKSPACE_ARCHIVES.get(STORAGE_GC_STATE_KEY);
  if (!object) return initialState(now);
  return parseState(await object.text().catch(() => ''), now);
}

async function saveState(env: StorageGcSchedulerEnv, state: StorageGcState) {
  await env.WORKSPACE_ARCHIVES.put(
    STORAGE_GC_STATE_KEY,
    JSON.stringify(state),
    { httpMetadata: { contentType: 'application/json' } }
  );
}

async function acquireScheduleLease(
  env: StorageGcSchedulerEnv,
  now: Date
): Promise<StorageGcScheduleLease> {
  const current = await env.WORKSPACE_ARCHIVES.get(STORAGE_GC_LEASE_KEY);
  let currentExpiry = '';
  if (current) {
    const value = (await current.json().catch(() => ({}))) as {
      expiresAt?: unknown;
    };
    currentExpiry = validIso(value.expiresAt);
    if (currentExpiry && new Date(currentExpiry).getTime() > now.getTime()) {
      return { acquired: false, expiresAt: currentExpiry };
    }
  }

  const expiresAt = new Date(now.getTime() + STORAGE_GC_LEASE_MS).toISOString();
  const token = crypto.randomUUID();
  const stored = await env.WORKSPACE_ARCHIVES.put(
    STORAGE_GC_LEASE_KEY,
    JSON.stringify({
      token,
      expiresAt,
      acquiredAt: now.toISOString(),
    }),
    {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: current
        ? { etagMatches: current.etag }
        : { etagDoesNotMatch: '*' },
    }
  );
  return {
    acquired: Boolean(stored),
    expiresAt,
    ...(stored ? { etag: stored.etag, token } : {}),
  };
}

async function renewScheduleLease(
  env: StorageGcSchedulerEnv,
  lease: StorageGcScheduleLease
): Promise<StorageGcScheduleLease | null> {
  if (!lease.etag || !lease.token) return null;
  const renewedAt = new Date();
  const expiresAt = new Date(
    renewedAt.getTime() + STORAGE_GC_LEASE_MS
  ).toISOString();
  const stored = await env.WORKSPACE_ARCHIVES.put(
    STORAGE_GC_LEASE_KEY,
    JSON.stringify({
      token: lease.token,
      expiresAt,
      renewedAt: renewedAt.toISOString(),
    }),
    {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagMatches: lease.etag },
    }
  );
  return stored
    ? {
        acquired: true,
        expiresAt,
        etag: stored.etag,
        token: lease.token,
      }
    : null;
}

async function releaseScheduleLease(
  env: StorageGcSchedulerEnv,
  lease: StorageGcScheduleLease,
  now: Date
) {
  if (!lease.etag || !lease.token) return;
  await env.WORKSPACE_ARCHIVES.put(
    STORAGE_GC_LEASE_KEY,
    JSON.stringify({
      token: lease.token,
      expiresAt: now.toISOString(),
      releasedAt: now.toISOString(),
    }),
    {
      httpMetadata: { contentType: 'application/json' },
      onlyIf: { etagMatches: lease.etag },
    }
  );
}

function schedulerConfig(env: StorageGcSchedulerEnv) {
  const appBaseUrl = (env.APP_BASE_URL || '').trim();
  const secret = (env.BILLING_USAGE_WEBHOOK_SECRET || '').trim();
  if (!appBaseUrl || !secret) {
    throw new Error('Storage GC app URL or runtime secret is not configured');
  }
  return {
    url: new URL('/api/internal/storage/gc', appBaseUrl),
    secret,
  };
}

async function postGc<T>(
  env: StorageGcSchedulerEnv,
  body: Record<string, unknown>,
  fetchFn: typeof fetch
): Promise<T> {
  const { url, secret } = schedulerConfig(env);
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hicode-runtime-secret': secret,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    code?: number;
    message?: string;
    data?: T;
  };
  if (!response.ok || payload.code !== 0 || payload.data === undefined) {
    throw new Error(
      payload.message ||
        response.statusText ||
        'Storage GC application request failed'
    );
  }
  return payload.data;
}

async function loadNextPage(
  env: StorageGcSchedulerEnv,
  state: StorageGcState,
  now: Date
) {
  const listOptions = {
    prefix: STORAGE_GC_PREFIX,
    limit: STORAGE_GC_PAGE_SIZE,
    include: ['customMetadata'],
    ...(state.cursor ? { cursor: state.cursor } : {}),
  } as R2ListOptions;
  const listed = await env.WORKSPACE_ARCHIVES.list(listOptions);
  const nextCursor = listed.truncated ? listed.cursor : undefined;
  const pending: StorageGcPendingPage = {
    objects: listed.objects.map((object) => ({
      key: object.key,
      size: object.size,
      uploaded: object.uploaded.toISOString(),
      etag: object.etag,
      customMetadata: object.customMetadata || {},
    })),
    truncated: listed.truncated,
    ...(nextCursor ? { nextCursor } : {}),
  };
  const nextState: StorageGcState = {
    ...state,
    pending,
    failures: 0,
    nextAttemptAt: now.toISOString(),
    cycleStartedAt: state.cycleStartedAt || now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return nextState;
}

function approvedCandidates(
  plan: StorageGcPlanResponse,
  pending: StorageGcPendingPage
) {
  const pageKeys = new Set(pending.objects.map((object) => object.key));
  return [
    ...new Map(
      (plan.candidates || [])
        .filter(
          (candidate) =>
            candidate &&
            typeof candidate.key === 'string' &&
            pageKeys.has(candidate.key)
        )
        .map((candidate) => [candidate.key, candidate])
    ).values(),
  ];
}

function failureState(
  state: StorageGcState,
  now: Date,
  error: unknown
): {
  state: StorageGcState;
  result: StorageGcScheduleResult;
} {
  const failures = state.failures + 1;
  const nextAttemptAt = new Date(
    now.getTime() + storageGcRetryDelayMs(failures)
  ).toISOString();
  const nextState = {
    ...state,
    failures,
    nextAttemptAt,
    updatedAt: now.toISOString(),
  };
  return {
    state: nextState,
    result: {
      status: 'failed',
      scanned: state.pending?.objects.length || 0,
      candidates: 0,
      deleted: 0,
      failures,
      nextAttemptAt,
      error: errorMessage(error),
    },
  };
}

/**
 * Processes at most one persisted R2 page per cron invocation. A page is not
 * advanced until every approved deletion is physically absent and the app has
 * acknowledged ledger settlement.
 */
export async function runStorageGcSchedule(
  env: StorageGcSchedulerEnv,
  options: StorageGcSchedulerOptions = {}
): Promise<StorageGcScheduleResult> {
  const now = options.now || new Date();
  const fetchFn = options.fetchFn || fetch;
  let state = await loadState(env, now);
  if (new Date(state.nextAttemptAt).getTime() > now.getTime()) {
    return {
      status: 'deferred',
      scanned: 0,
      candidates: 0,
      deleted: 0,
      failures: state.failures,
      nextAttemptAt: state.nextAttemptAt,
    };
  }
  let lease = await acquireScheduleLease(env, now);
  if (!lease.acquired) {
    return {
      status: 'deferred',
      scanned: 0,
      candidates: 0,
      deleted: 0,
      failures: state.failures,
      nextAttemptAt: lease.expiresAt,
    };
  }

  try {
    if (!state.pending) {
      state = await loadNextPage(env, state, now);
      const renewedLease = await renewScheduleLease(env, lease);
      if (!renewedLease) {
        throw new Error(
          'Storage GC schedule lease was lost before page state commit'
        );
      }
      lease = renewedLease;
      // Persist the page before the external sweep. A terminated Worker will
      // resume the same deletion/confirmation unit instead of advancing the
      // R2 cursor.
      await saveState(env, state);
    }
    const pending = state.pending;
    if (!pending) throw new Error('Storage GC page was not persisted');

    const sweep = await postGc<StorageGcSweepResponse>(
      env,
      { action: 'sweep', objects: pending.objects },
      fetchFn
    );
    const candidates = approvedCandidates(sweep, pending);
    const pageKeys = new Set(pending.objects.map((object) => object.key));
    const deletedKeys = new Set(
      (sweep.deletedKeys || []).filter((key) => pageKeys.has(key))
    );
    const failedKeys = new Set(
      (sweep.failedKeys || []).filter((key) => pageKeys.has(key))
    );

    if (failedKeys.size > 0) {
      state = {
        ...state,
        pending: {
          ...pending,
          objects: pending.objects.filter((object) =>
            failedKeys.has(object.key)
          ),
        },
      };
      throw new Error(`${failedKeys.size} R2 deletion(s) remain unconfirmed`);
    }

    const hasNextPage = Boolean(pending.truncated && pending.nextCursor);
    const nextAttemptAt = new Date(
      hasNextPage ? now.getTime() : now.getTime() + STORAGE_GC_CYCLE_COOLDOWN_MS
    ).toISOString();
    const nextState: StorageGcState = {
      version: 1,
      ...(hasNextPage ? { cursor: pending.nextCursor } : {}),
      failures: 0,
      nextAttemptAt,
      ...(hasNextPage
        ? { cycleStartedAt: state.cycleStartedAt || now.toISOString() }
        : {}),
      updatedAt: now.toISOString(),
    };
    const renewedLease = await renewScheduleLease(env, lease);
    if (!renewedLease) {
      throw new Error('Storage GC schedule lease was lost before state commit');
    }
    lease = renewedLease;
    await saveState(env, nextState);
    return {
      status: hasNextPage ? 'page_complete' : 'cycle_complete',
      scanned: pending.objects.length,
      candidates: candidates.length,
      deleted: deletedKeys.size,
      failures: 0,
      nextAttemptAt,
    };
  } catch (error) {
    const failure = failureState(state, now, error);
    const renewedLease = await renewScheduleLease(env, lease).catch(() => null);
    if (renewedLease) {
      lease = renewedLease;
      await saveState(env, failure.state);
    }
    return failure.result;
  } finally {
    // Conditional release cannot shorten a lease that another invocation has
    // already acquired after this one expired.
    await releaseScheduleLease(env, lease, now).catch(() => undefined);
  }
}
