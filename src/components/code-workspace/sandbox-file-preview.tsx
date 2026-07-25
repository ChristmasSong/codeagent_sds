import { useEffect, useState, type ReactNode } from 'react';
import {
  Check,
  Copy,
  FileQuestion,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';

import type { WorkspaceFileEntry } from '@/lib/code-files';
import { cn } from '@/lib/utils';
import {
  sandboxFileRawUrl,
  useSandboxFileContent,
} from '@/hooks/use-sandbox-files';
import { MarkdownContent } from '@/components/markdown-content';
import { Button } from '@/components/ui/button';

const MAX_RENDERED_CODE_LINES = 5_000;

export interface SandboxFilePreviewLabels {
  empty: string;
  inactive: string;
  loading: string;
  failed: string;
  unsupported: string;
  tooLarge: string;
  truncated: string;
  rendered: string;
  source: string;
  copy: string;
  copied: string;
  refresh: string;
  mime: string;
  size: string;
  modified: string;
  imageAlt: string;
}

interface SandboxFilePreviewProps {
  sessionId: string | null;
  sessionStatus?: string;
  file: WorkspaceFileEntry | null;
  labels: SandboxFilePreviewLabels;
}

export function SandboxFilePreview({
  sessionId,
  sessionStatus = 'active',
  file,
  labels,
}: SandboxFilePreviewProps) {
  const active = Boolean(sessionId && sessionStatus === 'active');
  const content = useSandboxFileContent(
    sessionId,
    file?.path || '',
    Boolean(active && file)
  );
  const [view, setView] = useState<'rendered' | 'source'>('rendered');
  const [copied, setCopied] = useState(false);
  const [rawFailed, setRawFailed] = useState(false);

  useEffect(() => {
    setView('rendered');
    setCopied(false);
    setRawFailed(false);
  }, [file?.path, sessionId]);

  useEffect(() => setRawFailed(false), [content.data?.etag]);

  if (!active) return <PreviewMessage>{labels.inactive}</PreviewMessage>;
  if (!file) {
    return (
      <PreviewMessage>
        <FileQuestion className="size-4" />
        {labels.empty}
      </PreviewMessage>
    );
  }
  if (content.isPending) {
    return (
      <PreviewMessage>
        <LoaderCircle className="size-4 animate-spin" />
        {labels.loading}
      </PreviewMessage>
    );
  }
  if (content.isError || !content.data) {
    return (
      <PreviewMessage destructive>
        <span>{previewErrorMessage(content.error, labels)}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void content.refetch()}
        >
          {labels.refresh}
        </Button>
      </PreviewMessage>
    );
  }

  const data = content.data;
  const rawUrl =
    sessionId && data.rawAvailable
      ? sandboxFileRawUrl(sessionId, data.path, data.etag)
      : '';
  const supportsSource =
    typeof data.content === 'string' &&
    ['markdown', 'html', 'svg'].includes(data.kind);
  const showSource =
    view === 'source' ||
    ((data.kind === 'html' || data.kind === 'svg') && !rawUrl);
  const copyContent = async () => {
    if (typeof data.content !== 'string') return;
    try {
      await navigator.clipboard.writeText(data.content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="border-border bg-muted/30 flex h-full min-h-0 flex-col overflow-hidden rounded-md border">
        <div className="border-border flex shrink-0 items-start justify-between gap-2 border-b px-3 py-2.5">
          <div className="min-w-0">
            <p className="truncate font-mono text-xs font-medium">
              {data.name}
            </p>
            <p
              className="text-muted-foreground mt-0.5 truncate font-mono text-[10px]"
              title={data.path}
            >
              {data.path}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {typeof data.content === 'string' && (
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label={copied ? labels.copied : labels.copy}
                title={copied ? labels.copied : labels.copy}
                onClick={() => void copyContent()}
              >
                {copied ? (
                  <Check className="size-3.5" />
                ) : (
                  <Copy className="size-3.5" />
                )}
              </Button>
            )}
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={labels.refresh}
              title={labels.refresh}
              disabled={content.isFetching}
              onClick={() => void content.refetch()}
            >
              <RefreshCw
                className={cn('size-3.5', content.isFetching && 'animate-spin')}
              />
            </Button>
          </div>
        </div>

        <div className="text-muted-foreground flex shrink-0 flex-wrap gap-x-3 gap-y-1 border-b px-3 py-2 text-[10px]">
          <span>
            {labels.size}: {formatBytes(data.size)}
          </span>
          <span>
            {labels.mime}: {data.mimeType.split(';', 1)[0]}
          </span>
          {data.mtime && (
            <span>
              {labels.modified}: {formatTime(data.mtime)}
            </span>
          )}
        </div>

        {supportsSource && (
          <div className="border-border flex shrink-0 gap-1 border-b px-2 py-1.5">
            <ViewButton
              active={view === 'rendered'}
              onClick={() => setView('rendered')}
            >
              {labels.rendered}
            </ViewButton>
            <ViewButton
              active={view === 'source'}
              onClick={() => setView('source')}
            >
              {labels.source}
            </ViewButton>
          </div>
        )}

        {(data.truncated || data.tooLarge) && (
          <div className="border-border shrink-0 border-b bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
            {data.truncated ? labels.truncated : labels.tooLarge}
          </div>
        )}

        <div className="bg-background min-h-0 flex-1 overflow-hidden">
          {!data.previewable ? (
            <PreviewMessage>
              {data.tooLarge ? labels.tooLarge : labels.unsupported}
            </PreviewMessage>
          ) : showSource && typeof data.content === 'string' ? (
            <CodePreview content={data.content} labels={labels} />
          ) : data.kind === 'text' && typeof data.content === 'string' ? (
            <CodePreview content={data.content} labels={labels} />
          ) : data.kind === 'markdown' && typeof data.content === 'string' ? (
            <div className="h-full min-h-0 overflow-auto p-4">
              <MarkdownContent
                content={data.content}
                className="text-xs leading-6"
                allowImages={false}
              />
            </div>
          ) : rawFailed ? (
            <PreviewMessage destructive>
              <span>{labels.failed}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setRawFailed(false)}
              >
                {labels.refresh}
              </Button>
            </PreviewMessage>
          ) : data.kind === 'image' && rawUrl ? (
            <div className="flex h-full min-h-0 items-center justify-center overflow-auto p-3">
              <img
                src={rawUrl}
                alt={`${labels.imageAlt}: ${data.name}`}
                className="max-h-full max-w-full object-contain"
                referrerPolicy="no-referrer"
                onError={() => setRawFailed(true)}
              />
            </div>
          ) : data.kind === 'pdf' && rawUrl ? (
            <iframe
              title={data.name}
              src={rawUrl}
              className="h-full min-h-0 w-full"
              sandbox=""
              referrerPolicy="no-referrer"
              onError={() => setRawFailed(true)}
            />
          ) : (data.kind === 'html' || data.kind === 'svg') && rawUrl ? (
            <iframe
              title={data.name}
              src={rawUrl}
              className="h-full min-h-0 w-full bg-white"
              sandbox=""
              referrerPolicy="no-referrer"
              onError={() => setRawFailed(true)}
            />
          ) : (
            <PreviewMessage>{labels.unsupported}</PreviewMessage>
          )}
        </div>
      </div>
    </div>
  );
}

function CodePreview({
  content,
  labels,
}: {
  content: string;
  labels: SandboxFilePreviewLabels;
}) {
  const allLines = content.replace(/\r\n?/g, '\n').split('\n');
  const lines = allLines.slice(0, MAX_RENDERED_CODE_LINES);
  return (
    <div className="h-full min-h-0 overflow-auto py-2 font-mono text-[11px] leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className="grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] px-2"
        >
          <span className="text-muted-foreground/60 border-border mr-3 border-r pr-2 text-right select-none">
            {index + 1}
          </span>
          <code className="min-w-0 break-all whitespace-pre-wrap">
            {line || ' '}
          </code>
        </div>
      ))}
      {allLines.length > MAX_RENDERED_CODE_LINES && (
        <p className="text-muted-foreground border-border mt-2 border-t px-4 py-2 text-xs">
          {labels.truncated}
        </p>
      )}
    </div>
  );
}

function ViewButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'rounded px-2 py-1 text-[11px] transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PreviewMessage({
  children,
  destructive = false,
}: {
  children: ReactNode;
  destructive?: boolean;
}) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex h-full min-h-24 items-center justify-center gap-2 px-4 text-center text-xs',
        destructive && 'text-destructive'
      )}
    >
      {children}
    </div>
  );
}

function previewErrorMessage(
  error: Error | null,
  labels: SandboxFilePreviewLabels
) {
  if (error?.message === 'file_too_large') return labels.tooLarge;
  if (error?.message === 'unsupported_file') return labels.unsupported;
  return labels.failed;
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount >= 10 ? amount.toFixed(1) : amount.toFixed(2)} ${unit}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
