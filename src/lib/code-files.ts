export type WorkspaceEntryType = 'directory' | 'file';

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  type: WorkspaceEntryType;
  size: number | null;
  mtime: string;
  hasChildren: boolean;
}

export interface WorkspaceDirectoryResult {
  sessionStatus: string;
  exists: boolean;
  path: string;
  entries: WorkspaceFileEntry[];
  truncated: boolean;
}

export interface WorkspaceStatusResult {
  sessionStatus: string;
  exists: boolean;
  digest: string | null;
  entryCount: number;
  truncated: boolean;
}

export const SANDBOX_DOWNLOAD_MUTATION_KEY = ['sandbox-download-all'] as const;
export const SANDBOX_DOWNLOAD_START_TIMEOUT_MS = 30_000;
export const SANDBOX_DOWNLOAD_STATUS_TIMEOUT_MS = 31 * 60_000;

export type WorkspaceTransferState =
  | 'not_started'
  | 'preparing'
  | 'streaming'
  | 'completed'
  | 'failed';

export interface WorkspaceTransferStatusResult {
  sessionStatus: string;
  transferId: string;
  transferState: WorkspaceTransferState;
  transferBusy: boolean;
}

interface WorkspaceDownloadWaitOptions {
  readStatus: (cancel?: boolean) => Promise<WorkspaceTransferStatusResult>;
  now?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
  startTimeoutMs?: number;
  timeoutMs?: number;
}

function workspaceDownloadPollInterval(
  state: WorkspaceTransferState,
  elapsedMs: number
): number {
  if (state === 'not_started') return elapsedMs < 5_000 ? 250 : 500;
  if (elapsedMs < 10_000) return 500;
  if (elapsedMs < 60_000) return 1_000;
  return 5_000;
}

function workspaceDownloadErrorPollInterval(errorCount: number): number {
  return Math.min(500 * 2 ** Math.min(Math.max(errorCount - 1, 0), 5), 10_000);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export async function waitForWorkspaceDownloadCompletion({
  readStatus,
  now = monotonicNow,
  sleep: wait = sleep,
  startTimeoutMs = SANDBOX_DOWNLOAD_START_TIMEOUT_MS,
  timeoutMs = SANDBOX_DOWNLOAD_STATUS_TIMEOUT_MS,
}: WorkspaceDownloadWaitOptions): Promise<void> {
  const startedAt = now();
  let lastState: WorkspaceTransferState = 'not_started';
  let statusErrorCount = 0;
  let cancellationError = '';

  while (true) {
    const elapsedMs = now() - startedAt;
    if (elapsedMs >= timeoutMs && !cancellationError) {
      cancellationError = 'workspace_download_status_timeout';
    }

    let status: WorkspaceTransferStatusResult;
    try {
      status = await readStatus(Boolean(cancellationError));
    } catch {
      // A temporary status failure must not release the lifecycle lock while
      // the download may still be streaming.
      statusErrorCount += 1;
      await wait(workspaceDownloadErrorPollInterval(statusErrorCount));
      continue;
    }

    statusErrorCount = 0;
    lastState = status.transferState;
    if (!status.transferBusy && status.transferState === 'completed') return;
    if (!status.transferBusy && status.transferState === 'failed') {
      throw new Error(cancellationError || 'workspace_download_failed');
    }
    if (
      !status.transferBusy &&
      status.transferState === 'not_started' &&
      elapsedMs >= startTimeoutMs
    ) {
      cancellationError ||= 'workspace_download_not_started';
      continue;
    }

    await wait(workspaceDownloadPollInterval(lastState, elapsedMs));
  }
}

export interface WorkspaceStatusPollSnapshot {
  sessionStatus: string;
  exists: boolean;
  digest: string | null;
}

export interface WorkspaceStatusPollState extends WorkspaceStatusPollSnapshot {
  sessionId: string;
  stableChecks: number;
}

export interface WorkspaceStatusPollTarget {
  sessionId: string | null;
  enabled: boolean;
}

export function shouldConfirmWorkspaceStatus(
  previous: WorkspaceStatusPollTarget,
  next: WorkspaceStatusPollTarget
): boolean {
  return Boolean(
    next.sessionId &&
    next.enabled &&
    (!previous.enabled || previous.sessionId !== next.sessionId)
  );
}

export function nextWorkspaceStatusPollState(
  previous: WorkspaceStatusPollState | undefined,
  sessionId: string,
  snapshot: WorkspaceStatusPollSnapshot
): WorkspaceStatusPollState {
  if (!previous || previous.sessionId !== sessionId) {
    return { sessionId, ...snapshot, stableChecks: 0 };
  }
  if (
    previous.sessionStatus !== snapshot.sessionStatus ||
    previous.exists !== snapshot.exists ||
    previous.digest !== snapshot.digest
  ) {
    return { sessionId, ...snapshot, stableChecks: 0 };
  }
  return {
    sessionId,
    ...snapshot,
    stableChecks: previous.stableChecks + 1,
  };
}

export function workspaceStatusPollInterval(stableChecks: number): number {
  if (stableChecks >= 10) return 120_000;
  if (stableChecks >= 5) return 60_000;
  if (stableChecks >= 2) return 30_000;
  return 15_000;
}

export type WorkspaceFilePreviewKind =
  | 'text'
  | 'markdown'
  | 'image'
  | 'svg'
  | 'pdf'
  | 'html'
  | 'binary';

export interface WorkspaceFileContentResult {
  sessionStatus: string;
  exists: boolean;
  path: string;
  name: string;
  size: number;
  mtime: string;
  mimeType: string;
  kind: WorkspaceFilePreviewKind;
  encoding: 'utf-8' | null;
  etag: string;
  previewable: boolean;
  rawAvailable: boolean;
  tooLarge: boolean;
  truncated: boolean;
  content?: string;
}
