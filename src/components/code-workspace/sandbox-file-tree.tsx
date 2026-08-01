import {
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Upload,
} from 'lucide-react';

import type { WorkspaceFileEntry } from '@/lib/code-files';
import {
  SANDBOX_UPLOAD_MAX_FILES,
  validateSandboxUploadFile,
} from '@/lib/sandbox-file-transfer';
import { cn } from '@/lib/utils';
import {
  useSandboxDirectory,
  useSandboxDownloadAll,
  useSandboxFileUpload,
  useWorkspaceStatus,
} from '@/hooks/use-sandbox-files';

export interface SandboxFileTreeLabels {
  refresh: string;
  loading: string;
  empty: string;
  failed: string;
  inactive: string;
  truncated: string;
  selected: string;
  upload: string;
  uploadHint: string;
  dropFiles: string;
  uploadPending: string;
  uploading: string;
  uploadSuccess: string;
  uploadFailed: string;
  uploadTooLarge: string;
  uploadWorkspaceFull: string;
  uploadUnsupported: string;
  uploadConflict: string;
  uploadQueueLimit: string;
  downloadAll: string;
  downloadPreparing: string;
  downloadFailed: string;
}

interface SandboxFileTreeProps {
  sessionId: string | null;
  sessionStatus?: string;
  visible?: boolean;
  selectedPath?: string;
  onFileSelect?: (entry: WorkspaceFileEntry) => void;
  labels: SandboxFileTreeLabels;
}

type UploadQueueStatus = 'pending' | 'uploading' | 'success' | 'error';

interface UploadQueueEntry {
  id: string;
  file: File;
  status: UploadQueueStatus;
  error?: string;
}

export function SandboxFileTree({
  sessionId,
  sessionStatus = 'active',
  visible = true,
  selectedPath = '',
  onFileSelect,
  labels,
}: SandboxFileTreeProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepthRef = useRef(0);
  const transferBatchRef = useRef(0);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueEntry[]>([]);
  const [uploadNotice, setUploadNotice] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const isActive = Boolean(sessionId && sessionStatus === 'active');
  const workspaceStatus = useWorkspaceStatus(sessionId, isActive && visible);
  const uploadFile = useSandboxFileUpload(sessionId);
  const downloadAll = useSandboxDownloadAll(sessionId);
  const effectiveStatus =
    workspaceStatus.data?.sessionStatus || sessionStatus || 'active';
  const canRead = isActive && visible && effectiveStatus === 'active';
  const canRefresh = isActive && visible;
  const root = useSandboxDirectory(sessionId, '', canRead);
  const isUploading = uploadQueue.some(
    (entry) => entry.status === 'pending' || entry.status === 'uploading'
  );
  const transferBusy = isUploading || downloadAll.isPending;
  const canTransfer = canRead && !transferBusy;

  useEffect(() => {
    transferBatchRef.current += 1;
    uploadAbortRef.current?.abort();
    uploadAbortRef.current = null;
    dragDepthRef.current = 0;
    setUploadQueue([]);
    setUploadNotice('');
    setDownloadError('');
    setIsDraggingFiles(false);
  }, [sessionId]);

  useEffect(
    () => () => {
      uploadAbortRef.current?.abort();
    },
    []
  );

  const validationMessage = (file: File) => {
    const validationError = validateSandboxUploadFile(file);
    if (validationError === 'file_too_large') return labels.uploadTooLarge;
    if (validationError === 'unsupported_file_type') {
      return labels.uploadUnsupported;
    }
    return '';
  };

  const uploadErrorMessage = (error: unknown) => {
    const message = error instanceof Error ? error.message : '';
    if (/workspace_size_exceeded/i.test(message)) {
      return labels.uploadWorkspaceFull;
    }
    if (/too_large|payload_too_large|request_too_large/i.test(message)) {
      return labels.uploadTooLarge;
    }
    if (/unsupported|invalid_file_type|invalid_mime/i.test(message)) {
      return labels.uploadUnsupported;
    }
    if (
      /already_exists|file_exists|conflict|etag_mismatch|precondition/i.test(
        message
      )
    ) {
      return labels.uploadConflict;
    }
    return message && message !== 'file_transfer_failed'
      ? `${labels.uploadFailed}: ${message}`
      : labels.uploadFailed;
  };

  const enqueueFiles = async (files: File[]) => {
    if (!canTransfer || files.length === 0) return;

    const candidates = files.slice(0, SANDBOX_UPLOAD_MAX_FILES);
    setUploadNotice(
      files.length > SANDBOX_UPLOAD_MAX_FILES ? labels.uploadQueueLimit : ''
    );
    setDownloadError('');

    const entries = candidates.map((file, index): UploadQueueEntry => {
      const error = validationMessage(file);
      return {
        id: `${Date.now()}-${index}-${file.name}`,
        file,
        status: error ? 'error' : 'pending',
        ...(error ? { error } : {}),
      };
    });
    const batch = transferBatchRef.current + 1;
    transferBatchRef.current = batch;
    uploadAbortRef.current?.abort();
    const controller = new AbortController();
    uploadAbortRef.current = controller;
    setUploadQueue(entries);

    for (const entry of entries) {
      if (entry.status === 'error' || transferBatchRef.current !== batch) {
        continue;
      }
      setUploadQueue((current) =>
        current.map((item) =>
          item.id === entry.id ? { ...item, status: 'uploading' } : item
        )
      );
      try {
        await uploadFile.mutateAsync({
          file: entry.file,
          path: entry.file.name,
          signal: controller.signal,
        });
        if (transferBatchRef.current !== batch) return;
        setUploadQueue((current) =>
          current.map((item) =>
            item.id === entry.id ? { ...item, status: 'success' } : item
          )
        );
      } catch (error) {
        if (controller.signal.aborted || transferBatchRef.current !== batch) {
          return;
        }
        setUploadQueue((current) =>
          current.map((item) =>
            item.id === entry.id
              ? {
                  ...item,
                  status: 'error',
                  error: uploadErrorMessage(error),
                }
              : item
          )
        );
      }
    }

    if (uploadAbortRef.current === controller) uploadAbortRef.current = null;
  };

  const startDownload = async () => {
    if (!canTransfer) return;
    setDownloadError('');
    try {
      await downloadAll.mutateAsync();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      setDownloadError(
        message && message !== 'file_transfer_failed'
          ? `${labels.downloadFailed}: ${message}`
          : labels.downloadFailed
      );
    }
  };

  const handleFileDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canTransfer || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  };

  const handleFileDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canTransfer || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleFileDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isDraggingFiles) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  };

  const handleFileDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!canTransfer || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    void enqueueFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">
          {selectedPath ? `${labels.selected}: ${selectedPath}` : '/workspace'}
        </p>
        <div className="flex shrink-0 items-center gap-0.5">
          <input
            ref={fileInputRef}
            type="file"
            className="sr-only"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files || []);
              event.currentTarget.value = '';
              void enqueueFiles(files);
            }}
          />
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={labels.upload}
            title={`${labels.upload} · ${labels.uploadHint}`}
            disabled={!canTransfer}
            onClick={() => fileInputRef.current?.click()}
          >
            {isUploading ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Upload className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={
              downloadAll.isPending
                ? labels.downloadPreparing
                : labels.downloadAll
            }
            title={
              downloadAll.isPending
                ? labels.downloadPreparing
                : labels.downloadAll
            }
            disabled={!canTransfer}
            onClick={() => void startDownload()}
          >
            {downloadAll.isPending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
          </button>
          <button
            type="button"
            className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={labels.refresh}
            title={labels.refresh}
            disabled={!canRefresh || workspaceStatus.isFetching}
            onClick={() => void workspaceStatus.refresh()}
          >
            <RefreshCw
              className={cn(
                'size-3.5',
                workspaceStatus.isFetching && 'animate-spin'
              )}
            />
          </button>
        </div>
      </div>

      {(uploadQueue.length > 0 || uploadNotice || downloadError) && (
        <div
          className="border-border bg-muted/30 mb-2 max-h-32 shrink-0 overflow-y-auto rounded-md border px-2 py-1.5"
          aria-live="polite"
        >
          {uploadNotice && (
            <p className="text-muted-foreground pb-1 text-[10px] leading-4">
              {uploadNotice}
            </p>
          )}
          {downloadError && (
            <p className="text-destructive pb-1 text-[10px] leading-4">
              {downloadError}
            </p>
          )}
          {uploadQueue.map((entry) => (
            <div
              key={entry.id}
              className="flex min-w-0 items-start gap-1.5 py-0.5 text-[10px] leading-4"
            >
              {entry.status === 'uploading' || entry.status === 'pending' ? (
                <LoaderCircle
                  className={cn(
                    'text-muted-foreground mt-0.5 size-3 shrink-0',
                    entry.status === 'uploading' && 'animate-spin'
                  )}
                />
              ) : entry.status === 'success' ? (
                <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="text-destructive mt-0.5 size-3 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate" title={entry.file.name}>
                {entry.file.name}
              </span>
              <span
                className={cn(
                  'shrink-0',
                  entry.status === 'error'
                    ? 'text-destructive'
                    : 'text-muted-foreground'
                )}
                title={entry.error}
              >
                {entry.status === 'pending'
                  ? labels.uploadPending
                  : entry.status === 'uploading'
                    ? labels.uploading
                    : entry.status === 'success'
                      ? labels.uploadSuccess
                      : entry.error || labels.uploadFailed}
              </span>
            </div>
          ))}
        </div>
      )}

      <div
        className={cn(
          'border-border bg-background relative min-h-0 flex-1 overflow-auto rounded-md border py-1 transition-colors',
          isDraggingFiles && 'border-primary ring-primary/20 ring-2'
        )}
        onDragEnter={handleFileDragEnter}
        onDragOver={handleFileDragOver}
        onDragLeave={handleFileDragLeave}
        onDrop={handleFileDrop}
      >
        {isDraggingFiles && (
          <div className="bg-background/90 text-primary pointer-events-none absolute inset-1 z-10 flex items-center justify-center rounded-md border border-dashed text-center text-xs font-medium backdrop-blur-sm">
            {labels.dropFiles}
          </div>
        )}
        {!isActive || effectiveStatus !== 'active' ? (
          <TreeMessage>{labels.inactive}</TreeMessage>
        ) : root.isPending ? (
          <TreeMessage>
            <LoaderCircle className="size-3.5 animate-spin" />
            {labels.loading}
          </TreeMessage>
        ) : root.isError ? (
          <TreeMessage>{labels.failed}</TreeMessage>
        ) : root.data?.entries.length ? (
          <>
            {root.data.entries.map((entry) => (
              <FileTreeEntry
                key={entry.path}
                entry={entry}
                level={0}
                sessionId={sessionId!}
                enabled={canRead}
                selectedPath={selectedPath}
                onFileSelect={onFileSelect}
                labels={labels}
              />
            ))}
            {root.data.truncated && (
              <p className="text-muted-foreground px-3 py-2 text-[11px]">
                {labels.truncated}
              </p>
            )}
          </>
        ) : (
          <TreeMessage>{labels.empty}</TreeMessage>
        )}
      </div>
    </div>
  );
}

function FileTreeEntry({
  entry,
  level,
  sessionId,
  enabled,
  selectedPath,
  onFileSelect,
  labels,
}: {
  entry: WorkspaceFileEntry;
  level: number;
  sessionId: string;
  enabled: boolean;
  selectedPath: string;
  onFileSelect?: (entry: WorkspaceFileEntry) => void;
  labels: SandboxFileTreeLabels;
}) {
  const [expanded, setExpanded] = useState(false);
  const isDirectory = entry.type === 'directory';
  const children = useSandboxDirectory(
    sessionId,
    entry.path,
    enabled && isDirectory && expanded
  );

  return (
    <div>
      <button
        type="button"
        className={cn(
          'hover:bg-muted flex w-full min-w-0 items-center gap-1.5 py-1 pr-2 text-left text-xs transition-colors',
          selectedPath === entry.path && 'bg-muted text-foreground'
        )}
        style={{ paddingLeft: `${8 + level * 14}px` }}
        aria-expanded={isDirectory ? expanded : undefined}
        title={entry.path}
        onClick={() => {
          if (isDirectory) {
            setExpanded((value) => !value);
          } else {
            onFileSelect?.(entry);
          }
        }}
      >
        {isDirectory ? (
          expanded ? (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          )
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        {isDirectory ? (
          expanded ? (
            <FolderOpen className="text-primary size-3.5 shrink-0" />
          ) : (
            <Folder className="text-primary size-3.5 shrink-0" />
          )
        ) : (
          <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <span className="min-w-0 truncate">{entry.name}</span>
      </button>

      {isDirectory && expanded && (
        <div>
          {children.isPending ? (
            <div
              className="text-muted-foreground flex items-center gap-1.5 py-1 text-[11px]"
              style={{ paddingLeft: `${36 + level * 14}px` }}
            >
              <LoaderCircle className="size-3 animate-spin" />
              {labels.loading}
            </div>
          ) : children.isError ? (
            <p
              className="text-destructive py-1 text-[11px]"
              style={{ paddingLeft: `${36 + level * 14}px` }}
            >
              {labels.failed}
            </p>
          ) : children.data?.entries.length ? (
            children.data.entries.map((child) => (
              <FileTreeEntry
                key={child.path}
                entry={child}
                level={level + 1}
                sessionId={sessionId}
                enabled={enabled}
                selectedPath={selectedPath}
                onFileSelect={onFileSelect}
                labels={labels}
              />
            ))
          ) : (
            <p
              className="text-muted-foreground py-1 text-[11px]"
              style={{ paddingLeft: `${36 + level * 14}px` }}
            >
              {labels.empty}
            </p>
          )}
          {children.data?.truncated && (
            <p
              className="text-muted-foreground py-1 text-[11px]"
              style={{ paddingLeft: `${36 + level * 14}px` }}
            >
              {labels.truncated}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function TreeMessage({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full min-h-24 items-center justify-center gap-2 px-4 text-center text-xs">
      {children}
    </div>
  );
}
