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
