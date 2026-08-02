import assert from 'node:assert/strict';

import {
  waitForWorkspaceDownloadCompletion,
  type WorkspaceTransferStatusResult,
} from './code-files';
import { downloadSandboxArchiveAndWait } from './sandbox-file-transfer';

const transferId = 'transfer-test-000001';

function status(
  transferState: WorkspaceTransferStatusResult['transferState'],
  transferBusy: boolean
): WorkspaceTransferStatusResult {
  return {
    sessionStatus: 'active',
    transferId,
    transferState,
    transferBusy,
  };
}

{
  let resolveStatus!: (value: WorkspaceTransferStatusResult) => void;
  const deferredStatus = new Promise<WorkspaceTransferStatusResult>(
    (resolve) => {
      resolveStatus = resolve;
    }
  );
  let triggeredWith: [string, string] | null = null;
  let settled = false;
  const download = downloadSandboxArchiveAndWait({
    sessionId: 'session-test',
    createTransferId: () => transferId,
    triggerDownload: (sessionId, id) => {
      triggeredWith = [sessionId, id];
    },
    readStatus: async () => deferredStatus,
  }).then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.deepEqual(triggeredWith, ['session-test', transferId]);
  assert.equal(
    settled,
    false,
    'the download mutation orchestration must await the terminal status'
  );
  resolveStatus(status('completed', false));
  await download;
  assert.equal(settled, true);
}

{
  let reads = 0;
  await waitForWorkspaceDownloadCompletion({
    readStatus: async () => {
      reads += 1;
      return status('completed', false);
    },
    sleep: async () => {
      throw new Error('completed transfer must not poll again');
    },
  });
  assert.equal(reads, 1, 'a fast completed download must be observed by ID');
}

{
  let now = 0;
  const statuses = [status('preparing', true), status('completed', false)];
  await waitForWorkspaceDownloadCompletion({
    readStatus: async () => statuses.shift()!,
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
  });
  assert.equal(statuses.length, 0);
}

{
  let now = 0;
  const statuses = [status('completed', true), status('completed', false)];
  await waitForWorkspaceDownloadCompletion({
    readStatus: async () => statuses.shift()!,
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
  });
  assert.equal(
    statuses.length,
    0,
    'a terminal ID must stay locked while another transfer owns the lock'
  );
}

{
  let now = 0;
  const statuses = [status('failed', true), status('failed', false)];
  await assert.rejects(
    waitForWorkspaceDownloadCompletion({
      readStatus: async () => statuses.shift()!,
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
    }),
    /workspace_download_failed/
  );
  assert.equal(
    statuses.length,
    0,
    'a failed download must stay locked until the Runtime lock is released'
  );
}

{
  let now = 0;
  let reads = 0;
  await waitForWorkspaceDownloadCompletion({
    readStatus: async () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary status failure');
      return status('completed', false);
    },
    now: () => now,
    sleep: async (delayMs) => {
      now += delayMs;
    },
  });
  assert.equal(
    reads,
    2,
    'a temporary status failure must not release the lock'
  );
}

{
  let now = 0;
  let cancellationConfirmed = false;
  await assert.rejects(
    waitForWorkspaceDownloadCompletion({
      readStatus: async (cancel) => {
        if (cancel) {
          cancellationConfirmed = true;
          return status('failed', false);
        }
        return status('not_started', false);
      },
      now: () => now,
      sleep: async (delayMs) => {
        now += delayMs;
      },
      startTimeoutMs: 500,
      timeoutMs: 2_000,
    }),
    /workspace_download_not_started/
  );
  assert.equal(
    cancellationConfirmed,
    true,
    'a late download must be cancelled before the lifecycle lock is released'
  );
}

{
  let now = 0;
  const retryDelays: number[] = [];
  let cancellationConfirmed = false;
  await assert.rejects(
    waitForWorkspaceDownloadCompletion({
      readStatus: async (cancel) => {
        if (cancel) {
          cancellationConfirmed = true;
          return status('failed', false);
        }
        throw new Error('status unavailable');
      },
      now: () => now,
      sleep: async (delayMs) => {
        retryDelays.push(delayMs);
        now += delayMs;
      },
      timeoutMs: 1_500,
    }),
    /workspace_download_status_timeout/
  );
  assert.deepEqual(retryDelays, [500, 1_000]);
  assert.equal(cancellationConfirmed, true);
}

{
  let now = 0;
  const statuses = [status('streaming', true), status('completed', false)];
  let cancellationAttempted = false;
  await waitForWorkspaceDownloadCompletion({
    readStatus: async (cancel) => {
      cancellationAttempted ||= Boolean(cancel);
      return statuses.shift()!;
    },
    now: () => now,
    sleep: async () => {
      now = 600;
    },
    timeoutMs: 500,
  });
  assert.equal(
    statuses.length,
    0,
    'the timeout must not release a lock that was last observed as busy'
  );
  assert.equal(cancellationAttempted, true);
}
