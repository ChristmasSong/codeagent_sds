import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';

import type { WorkspaceFileEntry } from '@/lib/code-files';
import { cn } from '@/lib/utils';
import {
  useSandboxDirectory,
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
}

interface SandboxFileTreeProps {
  sessionId: string | null;
  sessionStatus?: string;
  visible?: boolean;
  selectedPath?: string;
  onFileSelect?: (entry: WorkspaceFileEntry) => void;
  labels: SandboxFileTreeLabels;
}

export function SandboxFileTree({
  sessionId,
  sessionStatus = 'active',
  visible = true,
  selectedPath = '',
  onFileSelect,
  labels,
}: SandboxFileTreeProps) {
  const isActive = Boolean(sessionId && sessionStatus === 'active');
  const workspaceStatus = useWorkspaceStatus(sessionId, isActive && visible);
  const effectiveStatus =
    workspaceStatus.data?.sessionStatus || sessionStatus || 'active';
  const canRead = isActive && visible && effectiveStatus === 'active';
  const canRefresh = isActive && visible;
  const root = useSandboxDirectory(sessionId, '', canRead);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="mb-2 flex shrink-0 items-center justify-between gap-3">
        <p className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">
          {selectedPath ? `${labels.selected}: ${selectedPath}` : '/workspace'}
        </p>
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

      <div className="border-border bg-background min-h-0 flex-1 overflow-auto rounded-md border py-1">
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
                sessionId={sessionId}
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
          <File className="text-muted-foreground size-3.5 shrink-0" />
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
