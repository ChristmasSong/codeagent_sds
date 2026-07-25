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
