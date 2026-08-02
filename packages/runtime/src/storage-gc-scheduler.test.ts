import assert from 'node:assert/strict';

import {
  runStorageGcSchedule,
  STORAGE_GC_CYCLE_COOLDOWN_MS,
  storageGcRetryDelayMs,
  type StorageGcSchedulerEnv,
} from './storage-gc-scheduler';

interface FakeObject {
  key: string;
  size: number;
  uploaded: Date;
  etag: string;
  customMetadata: Record<string, string>;
}

class FakeBucket {
  values = new Map<string, string>();
  etags = new Map<string, string>();
  objects = new Map<string, FakeObject>();
  pages: Array<{
    cursor?: string;
    objects: FakeObject[];
    truncated: boolean;
    nextCursor?: string;
  }> = [];
  keepAfterDelete = new Set<string>();
  listCalls = 0;
  beforeList?: (call: number) => Promise<void>;

  async get(key: string) {
    const value = this.values.get(key);
    return value === undefined
      ? null
      : {
          etag: this.etags.get(key) || '',
          text: async () => value,
          json: async () => JSON.parse(value),
        };
  }

  async put(
    key: string,
    value: string | ReadableStream | ArrayBuffer,
    options?: {
      onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string };
    }
  ) {
    const existing = this.etags.get(key);
    if (
      options?.onlyIf?.etagMatches &&
      options.onlyIf.etagMatches !== existing
    ) {
      return null;
    }
    if (options?.onlyIf?.etagDoesNotMatch === '*' && existing !== undefined) {
      return null;
    }
    this.values.set(key, String(value));
    const etag = `etag-${this.etags.size + 1}-${this.values.size}`;
    this.etags.set(key, etag);
    return { etag };
  }

  async delete(key: string | string[]) {
    for (const item of Array.isArray(key) ? key : [key]) {
      if (!this.keepAfterDelete.has(item)) this.objects.delete(item);
    }
  }

  async head(key: string) {
    return this.objects.get(key) || null;
  }

  async list(options: { cursor?: string }) {
    this.listCalls += 1;
    await this.beforeList?.(this.listCalls);
    const page = this.pages.find(
      (candidate) => candidate.cursor === options.cursor
    );
    if (!page) throw new Error(`Unexpected cursor: ${options.cursor || ''}`);
    return {
      objects: page.objects,
      truncated: page.truncated,
      ...(page.nextCursor ? { cursor: page.nextCursor } : {}),
    };
  }
}

const firstKey =
  'integrated-workspaces/runtime-1/session-1/archives/orphan-1.tar.gz';
const secondKey =
  'integrated-workspaces/runtime-2/session-2/archives/orphan-2.tar.gz';
const firstObject: FakeObject = {
  key: firstKey,
  size: 10,
  uploaded: new Date('2026-07-01T00:00:00.000Z'),
  etag: 'one',
  customMetadata: {},
};
const secondObject: FakeObject = {
  key: secondKey,
  size: 20,
  uploaded: new Date('2026-07-01T00:00:00.000Z'),
  etag: 'two',
  customMetadata: {},
};

function fakeEnv(bucket: FakeBucket): StorageGcSchedulerEnv {
  return {
    WORKSPACE_ARCHIVES: bucket as unknown as R2Bucket,
    APP_BASE_URL: 'https://app.example.test',
    BILLING_USAGE_WEBHOOK_SECRET: 'runtime-secret',
  };
}

function successfulApi(bucket: FakeBucket, sweeps: string[][]) {
  return async (_input: URL | RequestInfo, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    assert.equal(
      headers.get('x-hicode-runtime-secret'),
      'runtime-secret',
      'the internal endpoint must use the existing runtime secret'
    );
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.action, 'sweep');
    const keys = body.objects.map((object: FakeObject) => object.key);
    sweeps.push(keys);
    const deletedKeys: string[] = [];
    const failedKeys: string[] = [];
    for (const key of keys) {
      await bucket.delete(key);
      if (await bucket.head(key)) failedKeys.push(key);
      else deletedKeys.push(key);
    }
    return Response.json({
      code: 0,
      message: 'ok',
      data: {
        scanned: body.objects.length,
        managed: body.objects.length,
        candidates: body.objects.map((object: FakeObject) => ({
          key: object.key,
          reason: 'orphan_session',
        })),
        deletedKeys,
        failedKeys,
        skippedKeys: [],
      },
    });
  };
}

const now = new Date('2026-07-28T12:00:00.000Z');
const bucket = new FakeBucket();
bucket.objects.set(firstKey, firstObject);
bucket.objects.set(secondKey, secondObject);
bucket.pages = [
  {
    objects: [firstObject],
    truncated: true,
    nextCursor: 'page-2',
  },
  {
    cursor: 'page-2',
    objects: [secondObject],
    truncated: false,
  },
];
const sweeps: string[][] = [];

const first = await runStorageGcSchedule(fakeEnv(bucket), {
  now,
  fetchFn: successfulApi(bucket, sweeps) as typeof fetch,
});
assert.equal(first.status, 'page_complete');
assert.equal(first.deleted, 1);
assert.deepEqual(sweeps, [[firstKey]]);
assert.equal(bucket.objects.has(firstKey), false);

const second = await runStorageGcSchedule(fakeEnv(bucket), {
  now: new Date(now.getTime() + 60_000),
  fetchFn: successfulApi(bucket, sweeps) as typeof fetch,
});
assert.equal(second.status, 'cycle_complete');
assert.equal(second.deleted, 1);
assert.deepEqual(sweeps, [[firstKey], [secondKey]]);

const deferred = await runStorageGcSchedule(fakeEnv(bucket), {
  now: new Date(now.getTime() + 2 * 60_000),
  fetchFn: successfulApi(bucket, sweeps) as typeof fetch,
});
assert.equal(deferred.status, 'deferred');
assert.equal(
  new Date(deferred.nextAttemptAt).getTime(),
  new Date(now.getTime() + 60_000).getTime() + STORAGE_GC_CYCLE_COOLDOWN_MS
);

const retryBucket = new FakeBucket();
retryBucket.objects.set(firstKey, firstObject);
retryBucket.pages = [{ objects: [firstObject], truncated: false }];
let apiAttempts = 0;
const failingApi = async () => {
  apiAttempts += 1;
  return Response.json(
    { code: -1, message: 'temporary app failure' },
    { status: 503 }
  );
};
const failed = await runStorageGcSchedule(fakeEnv(retryBucket), {
  now,
  fetchFn: failingApi as typeof fetch,
});
assert.equal(failed.status, 'failed');
assert.equal(failed.failures, 1);
assert.equal(
  new Date(failed.nextAttemptAt).getTime(),
  now.getTime() + storageGcRetryDelayMs(1)
);
const retryDeferred = await runStorageGcSchedule(fakeEnv(retryBucket), {
  now: new Date(now.getTime() + 30_000),
  fetchFn: failingApi as typeof fetch,
});
assert.equal(retryDeferred.status, 'deferred');
assert.equal(apiAttempts, 1);

const overlapBucket = new FakeBucket();
overlapBucket.objects.set(firstKey, firstObject);
overlapBucket.pages = [{ objects: [firstObject], truncated: false }];
const overlapSweeps: string[][] = [];
const overlapResults = await Promise.all([
  runStorageGcSchedule(fakeEnv(overlapBucket), {
    now,
    fetchFn: successfulApi(overlapBucket, overlapSweeps) as typeof fetch,
  }),
  runStorageGcSchedule(fakeEnv(overlapBucket), {
    now,
    fetchFn: successfulApi(overlapBucket, overlapSweeps) as typeof fetch,
  }),
]);
assert.deepEqual(
  overlapResults.map((result) => result.status).sort(),
  ['cycle_complete', 'deferred'],
  'the conditional R2 lease must allow only one overlapping cron run'
);
assert.equal(overlapSweeps.length, 1);

const nextTickBucket = new FakeBucket();
nextTickBucket.objects.set(firstKey, firstObject);
nextTickBucket.pages = [{ objects: [firstObject], truncated: false }];
const nextTickSweeps: string[][] = [];
let releaseSlowSweep: (() => void) | undefined;
let reportSlowSweepStarted: (() => void) | undefined;
const slowSweepStarted = new Promise<void>((resolve) => {
  reportSlowSweepStarted = resolve;
});
const slowSweepGate = new Promise<void>((resolve) => {
  releaseSlowSweep = resolve;
});
const slowApi = async (input: URL | RequestInfo, init?: RequestInit) => {
  reportSlowSweepStarted?.();
  await slowSweepGate;
  return successfulApi(nextTickBucket, nextTickSweeps)(input, init);
};
const slowRun = runStorageGcSchedule(fakeEnv(nextTickBucket), {
  now,
  fetchFn: slowApi as typeof fetch,
});
await slowSweepStarted;
const nextTick = await runStorageGcSchedule(fakeEnv(nextTickBucket), {
  now: new Date(now.getTime() + 60_000),
  fetchFn: successfulApi(nextTickBucket, nextTickSweeps) as typeof fetch,
});
assert.equal(
  nextTick.status,
  'deferred',
  'the next one-minute cron tick must not overlap a slow healthy run'
);
assert.equal(nextTickSweeps.length, 0);
releaseSlowSweep?.();
assert.equal((await slowRun).status, 'cycle_complete');
assert.equal(nextTickSweeps.length, 1);

const leaseLossBucket = new FakeBucket();
leaseLossBucket.objects.set(firstKey, firstObject);
leaseLossBucket.pages = [{ objects: [firstObject], truncated: false }];
const leaseLossSweeps: string[][] = [];
let releaseExpiredRun: (() => void) | undefined;
let reportExpiredRunStarted: (() => void) | undefined;
const expiredRunStarted = new Promise<void>((resolve) => {
  reportExpiredRunStarted = resolve;
});
const expiredRunGate = new Promise<void>((resolve) => {
  releaseExpiredRun = resolve;
});
const expiredRunApi = async (input: URL | RequestInfo, init?: RequestInit) => {
  reportExpiredRunStarted?.();
  await expiredRunGate;
  return successfulApi(leaseLossBucket, leaseLossSweeps)(input, init);
};
const expiredRun = runStorageGcSchedule(fakeEnv(leaseLossBucket), {
  now,
  fetchFn: expiredRunApi as typeof fetch,
});
await expiredRunStarted;
const activeLease = JSON.parse(
  leaseLossBucket.values.get('maintenance/storage-gc-lease.json') || '{}'
);
const takeoverNow = new Date(new Date(activeLease.expiresAt).getTime() + 1);
const takeover = await runStorageGcSchedule(fakeEnv(leaseLossBucket), {
  now: takeoverNow,
  fetchFn: successfulApi(leaseLossBucket, leaseLossSweeps) as typeof fetch,
});
assert.equal(takeover.status, 'cycle_complete');
releaseExpiredRun?.();
const expiredResult = await expiredRun;
assert.equal(expiredResult.status, 'failed');
assert.match(
  expiredResult.error || '',
  /lease was lost/,
  'an expired owner must detect takeover before committing state'
);
const stateAfterTakeover = JSON.parse(
  leaseLossBucket.values.get('maintenance/storage-gc-state.json') || '{}'
);
assert.equal(
  stateAfterTakeover.failures,
  0,
  'an expired owner must not overwrite the new owner state'
);
assert.equal(
  new Date(stateAfterTakeover.nextAttemptAt).getTime(),
  takeoverNow.getTime() + STORAGE_GC_CYCLE_COOLDOWN_MS
);

const slowListBucket = new FakeBucket();
slowListBucket.objects.set(firstKey, firstObject);
slowListBucket.pages = [{ objects: [firstObject], truncated: false }];
const slowListSweeps: string[][] = [];
let releaseSlowList: (() => void) | undefined;
let reportSlowListStarted: (() => void) | undefined;
const slowListStarted = new Promise<void>((resolve) => {
  reportSlowListStarted = resolve;
});
const slowListGate = new Promise<void>((resolve) => {
  releaseSlowList = resolve;
});
slowListBucket.beforeList = async (call) => {
  if (call !== 1) return;
  reportSlowListStarted?.();
  await slowListGate;
};
const staleListRun = runStorageGcSchedule(fakeEnv(slowListBucket), {
  now,
  fetchFn: successfulApi(slowListBucket, slowListSweeps) as typeof fetch,
});
await slowListStarted;
const listTakeoverNow = new Date(now.getTime() + 3 * 60_000);
const listTakeover = await runStorageGcSchedule(fakeEnv(slowListBucket), {
  now: listTakeoverNow,
  fetchFn: successfulApi(slowListBucket, slowListSweeps) as typeof fetch,
});
assert.equal(listTakeover.status, 'cycle_complete');
releaseSlowList?.();
const staleListResult = await staleListRun;
assert.equal(staleListResult.status, 'failed');
assert.match(
  staleListResult.error || '',
  /lease was lost before page state commit/,
  'an owner that loses its lease during R2 listing must not persist a stale pending page'
);
const stateAfterListTakeover = JSON.parse(
  slowListBucket.values.get('maintenance/storage-gc-state.json') || '{}'
);
assert.equal(stateAfterListTakeover.failures, 0);
assert.equal(
  new Date(stateAfterListTakeover.nextAttemptAt).getTime(),
  listTakeoverNow.getTime() + STORAGE_GC_CYCLE_COOLDOWN_MS
);
assert.equal(
  slowListSweeps.length,
  1,
  'only the lease owner may sweep the page returned by a slow list operation'
);

const unconfirmedBucket = new FakeBucket();
unconfirmedBucket.objects.set(firstKey, firstObject);
unconfirmedBucket.keepAfterDelete.add(firstKey);
unconfirmedBucket.pages = [{ objects: [firstObject], truncated: false }];
const unconfirmedCalls: string[][] = [];
const unconfirmed = await runStorageGcSchedule(fakeEnv(unconfirmedBucket), {
  now,
  fetchFn: successfulApi(unconfirmedBucket, unconfirmedCalls) as typeof fetch,
});
assert.equal(unconfirmed.status, 'failed');
assert.equal(unconfirmed.deleted, 0);
assert.deepEqual(
  unconfirmedCalls,
  [[firstKey]],
  'a page remains pending while Runtime cannot confirm physical deletion'
);

console.log('storage-gc scheduler tests passed');
