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
