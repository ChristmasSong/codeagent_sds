import {
  waitForWorkspaceDownloadCompletion,
  type WorkspaceTransferStatusResult,
} from './code-files';

export const SANDBOX_UPLOAD_MAX_FILES = 10;
export const SANDBOX_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

const REJECTED_EXTENSIONS = new Set([
  '7z',
  'apk',
  'app',
  'bat',
  'bz2',
  'cmd',
  'com',
  'dll',
  'dmg',
  'doc',
  'docm',
  'exe',
  'gz',
  'iso',
  'jar',
  'msi',
  'ppt',
  'pptm',
  'rar',
  'tar',
  'tgz',
  'war',
  'xls',
  'xlsm',
  'xz',
  'zip',
]);

interface TransferErrorPayload {
  code?: number | string;
  error?: string;
  message?: string;
}

export type SandboxUploadValidationError =
  | 'file_too_large'
  | 'unsupported_file_type';

export class SandboxFileTransferError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number | string
  ) {
    super(message);
    this.name = 'SandboxFileTransferError';
  }
}

function filesEndpoint(
  sessionId: string,
  params: Record<string, string>
): string {
  const search = new URLSearchParams(params);
  return `/api/code/sessions/${encodeURIComponent(sessionId)}/files?${search}`;
}

function extensionOf(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : '';
}

export function validateSandboxUploadFile(
  file: File
): SandboxUploadValidationError | null {
  if (file.size > SANDBOX_UPLOAD_MAX_BYTES) return 'file_too_large';

  const extension = extensionOf(file.name);
  if (REJECTED_EXTENSIONS.has(extension)) return 'unsupported_file_type';

  // Unknown suffixes may still be UTF-8 plain text. Avoid buffering the file
  // in the browser; the server performs the authoritative content check.
  return null;
}

async function transferError(response: Response) {
  const payload = (await response
    .json()
    .catch(() => null)) as TransferErrorPayload | null;
  const message =
    payload?.message ||
    payload?.error ||
    response.statusText ||
    'file_transfer_failed';
  return new SandboxFileTransferError(message, response.status, payload?.code);
}

export async function uploadSandboxFile(options: {
  sessionId: string;
  path: string;
  file: File;
  signal?: AbortSignal;
}): Promise<unknown> {
  const response = await fetch(
    filesEndpoint(options.sessionId, {
      operation: 'upload',
      path: options.path,
    }),
    {
      method: 'PUT',
      body: options.file,
      credentials: 'same-origin',
      headers: {
        'Content-Type': options.file.type || 'application/octet-stream',
        'If-None-Match': '*',
      },
      signal: options.signal,
    }
  );
  if (!response.ok) throw await transferError(response);

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return;

  const payload = (await response.json().catch(() => null)) as
    | (TransferErrorPayload & { data?: unknown })
    | null;
  if (payload?.code !== undefined && payload.code !== 0) {
    throw new SandboxFileTransferError(
      payload.message || payload.error || 'file_transfer_failed',
      response.status,
      payload.code
    );
  }
  return payload?.data;
}

export function createSandboxTransferId(): string {
  return crypto.randomUUID();
}

export function downloadSandboxArchive(
  sessionId: string,
  transferId: string
): void {
  const link = document.createElement('a');
  link.href = filesEndpoint(sessionId, {
    operation: 'download-all',
    transferId,
  });
  // An empty download attribute keeps the transfer in the browser's streaming
  // download path. The server's Content-Disposition header supplies the name.
  link.download = '';
  link.hidden = true;
  link.rel = 'noopener';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

export async function downloadSandboxArchiveAndWait(options: {
  sessionId: string;
  readStatus: (
    transferId: string,
    cancel?: boolean
  ) => Promise<WorkspaceTransferStatusResult>;
  createTransferId?: () => string;
  triggerDownload?: (sessionId: string, transferId: string) => void;
}): Promise<void> {
  const transferId = (options.createTransferId || createSandboxTransferId)();
  (options.triggerDownload || downloadSandboxArchive)(
    options.sessionId,
    transferId
  );
  await waitForWorkspaceDownloadCompletion({
    readStatus: (cancel) => options.readStatus(transferId, cancel),
  });
}
