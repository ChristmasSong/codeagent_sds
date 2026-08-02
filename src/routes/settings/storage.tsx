import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  AlertTriangle,
  Archive,
  Box,
  Clock3,
  Database,
  HardDrive,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { m } from '@/core/i18n/messages';
import { apiDelete, apiGet, apiPost } from '@/lib/api-client';
import {
  formatStorageBytes,
  storagePercent,
  type StorageObjectSummary,
  type UserStorageResponse,
} from '@/lib/storage-contract';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';

type CleanupTarget =
  | {
      kind: 'snapshot';
      objectId: string;
      label: string;
    }
  | {
      kind: 'all-snapshots';
      label: string;
    }
  | {
      kind: 'session';
      sessionId: string;
      label: string;
    };

function StoragePage() {
  const queryClient = useQueryClient();
  const [cleanupTarget, setCleanupTarget] = useState<CleanupTarget | null>(
    null
  );

  const storageQuery = useQuery({
    queryKey: ['user-storage'],
    queryFn: () => apiGet<UserStorageResponse>('/api/storage'),
    staleTime: 30_000,
  });

  const cleanupMutation = useMutation({
    mutationFn: async (target: CleanupTarget) => {
      if (target.kind === 'snapshot') {
        return apiDelete(
          `/api/storage/objects/${encodeURIComponent(target.objectId)}`
        );
      }
      if (target.kind === 'session') {
        return apiPost('/api/storage/cleanup', {
          scope: 'session',
          sessionId: target.sessionId,
        });
      }
      return apiPost('/api/storage/cleanup', {
        scope: 'all-snapshots',
      });
    },
    onSuccess: async () => {
      toast.success(m['settings.storage.cleanup_success']());
      setCleanupTarget(null);
      await queryClient.invalidateQueries({ queryKey: ['user-storage'] });
    },
    onError: (error) => {
      toast.error(
        error instanceof Error
          ? error.message
          : m['settings.storage.cleanup_failed']()
      );
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['user-storage'] });
    },
  });

  const data = storageQuery.data;
  const quota = data?.quota;
  const countedBytes = quota ? quota.usedBytes + quota.reservedBytes : 0;
  const usagePercent = quota
    ? storagePercent(countedBytes, quota.limitBytes)
    : 0;
  const availableBytes = quota
    ? Math.max(0, quota.limitBytes - countedBytes)
    : 0;
  const snapshotCount =
    data?.sessions.reduce(
      (total, session) => total + session.snapshots.length,
      0
    ) ?? 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">
            {m['settings.storage.title']()}
          </h1>
          <p className="text-muted-foreground">
            {m['settings.storage.description']()}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => storageQuery.refetch()}
          disabled={storageQuery.isFetching}
          className="gap-2"
        >
          <RefreshCw
            className={cn('size-4', storageQuery.isFetching && 'animate-spin')}
          />
          {m['settings.storage.refresh']()}
        </Button>
      </div>

      {storageQuery.isPending ? (
        <StoragePageSkeleton />
      ) : storageQuery.isError || !data || !quota ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <AlertTriangle className="text-destructive size-8" />
            <div>
              <p className="font-medium">
                {m['settings.storage.load_failed']()}
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                {storageQuery.error instanceof Error
                  ? storageQuery.error.message
                  : m['common.error.message']()}
              </p>
            </div>
            <Button variant="outline" onClick={() => storageQuery.refetch()}>
              {m['common.error.retry']()}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <HardDrive className="size-5" />
                {m['settings.storage.usage_title']()}
              </CardTitle>
              <CardDescription>
                {m['settings.storage.usage_description']()}
              </CardDescription>
              <CardAction>
                <Badge variant={usageBadgeVariant(usagePercent)}>
                  {usageStatusLabel(usagePercent)} · {Math.round(usagePercent)}%
                </Badge>
              </CardAction>
            </CardHeader>
            <CardContent>
              <div className="grid gap-7 lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-center">
                <QuotaGauge
                  percent={usagePercent}
                  countedBytes={countedBytes}
                  limitBytes={quota.limitBytes}
                />

                <div className="space-y-5">
                  <Progress
                    value={usagePercent}
                    className={progressClassName(usagePercent)}
                  >
                    <ProgressLabel>
                      {m['settings.storage.usage_of_limit']({
                        used: formatStorageBytes(countedBytes),
                        limit: formatStorageBytes(quota.limitBytes),
                      })}
                    </ProgressLabel>
                    <ProgressValue>
                      {() =>
                        m['settings.storage.available']({
                          amount: formatStorageBytes(availableBytes),
                        })
                      }
                    </ProgressValue>
                  </Progress>

                  {usagePercent >= 80 ? (
                    <div
                      className={cn(
                        'flex gap-3 rounded-lg border p-3 text-sm',
                        usagePercent >= 100
                          ? 'border-destructive/30 bg-destructive/5 text-destructive'
                          : 'border-chart-4/40 bg-chart-4/10'
                      )}
                      role="alert"
                    >
                      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                      <p>
                        {usagePercent >= 100
                          ? m['settings.storage.limit_reached']()
                          : m['settings.storage.limit_warning']()}
                      </p>
                    </div>
                  ) : null}

                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    <UsageMetric
                      icon={Database}
                      label={m['settings.storage.current_usage']()}
                      value={formatStorageBytes(quota.currentBytes)}
                    />
                    <UsageMetric
                      icon={Archive}
                      label={m['settings.storage.snapshot_usage']()}
                      value={formatStorageBytes(quota.snapshotBytes)}
                    />
                    <UsageMetric
                      icon={Box}
                      label={m['settings.storage.temp_usage']()}
                      value={formatStorageBytes(quota.tempBytes)}
                    />
                    <UsageMetric
                      icon={Clock3}
                      label={m['settings.storage.reserved_usage']()}
                      value={formatStorageBytes(quota.reservedBytes)}
                    />
                    <UsageMetric
                      icon={Trash2}
                      label={m['settings.storage.pending_delete']()}
                      value={formatStorageBytes(quota.pendingDeleteBytes ?? 0)}
                    />
                  </div>

                  <p className="text-muted-foreground text-xs">
                    {m['settings.storage.pending_release_hint']()}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">
                {m['settings.storage.sessions_title']()}
              </h2>
              <p className="text-muted-foreground text-sm">
                {m['settings.storage.sessions_description']()}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={snapshotCount === 0 || cleanupMutation.isPending}
              onClick={() =>
                setCleanupTarget({
                  kind: 'all-snapshots',
                  label: m['settings.storage.all_snapshots'](),
                })
              }
            >
              <Trash2 className="size-4" />
              {m['settings.storage.cleanup_all_snapshots']()}
            </Button>
          </div>

          {data.sessions.length === 0 ? (
            <Card>
              <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
                <Archive className="text-muted-foreground size-8" />
                <p className="font-medium">
                  {m['settings.storage.empty_title']()}
                </p>
                <p className="text-muted-foreground max-w-md text-sm">
                  {m['settings.storage.empty_description']()}
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {data.sessions.map((session) => (
                <Card key={session.id}>
                  <CardHeader>
                    <CardTitle>{session.title || session.id}</CardTitle>
                    <CardDescription className="font-mono text-xs">
                      {session.id}
                    </CardDescription>
                    <CardAction>
                      <span className="font-medium tabular-nums">
                        {formatStorageBytes(session.totalBytes)}
                      </span>
                    </CardAction>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {session.current ? (
                      <StorageObjectRow object={session.current} />
                    ) : (
                      <div className="border-border text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
                        {m['settings.storage.no_current_archive']()}
                      </div>
                    )}

                    {session.snapshots.map((snapshot) => (
                      <StorageObjectRow
                        key={snapshot.id}
                        object={snapshot}
                        onDelete={() =>
                          setCleanupTarget({
                            kind: 'snapshot',
                            objectId: snapshot.id,
                            label: m['settings.storage.snapshot_label'](),
                          })
                        }
                      />
                    ))}

                    <div className="flex justify-end border-t pt-3">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive gap-2"
                        disabled={cleanupMutation.isPending}
                        onClick={() =>
                          setCleanupTarget({
                            kind: 'session',
                            sessionId: session.id,
                            label: session.title || session.id,
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                        {m['settings.storage.delete_session_storage']()}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <CleanupDialog
        target={cleanupTarget}
        pending={cleanupMutation.isPending}
        onClose={() => setCleanupTarget(null)}
        onConfirm={() => {
          if (cleanupTarget) cleanupMutation.mutate(cleanupTarget);
        }}
      />
    </div>
  );
}

function QuotaGauge({
  percent,
  countedBytes,
  limitBytes,
}: {
  percent: number;
  countedBytes: number;
  limitBytes: number;
}) {
  const clampedPercent = Math.min(100, Math.max(0, percent));
  const label = m['settings.storage.usage_of_limit']({
    used: formatStorageBytes(countedBytes),
    limit: formatStorageBytes(limitBytes),
  });

  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <div
        className="relative size-36"
        role="img"
        aria-label={`${label}, ${Math.round(percent)}%`}
      >
        <svg
          className="size-full -rotate-90"
          viewBox="0 0 120 120"
          aria-hidden="true"
        >
          <circle
            className="stroke-muted"
            cx="60"
            cy="60"
            r="50"
            fill="none"
            strokeWidth="10"
          />
          {clampedPercent > 0 ? (
            <circle
              className={cn(
                'stroke-current transition-[stroke-dasharray] duration-500',
                gaugeToneClassName(percent)
              )}
              cx="60"
              cy="60"
              r="50"
              fill="none"
              pathLength="100"
              strokeDasharray={`${clampedPercent} ${100 - clampedPercent}`}
              strokeLinecap="round"
              strokeWidth="10"
            />
          ) : null}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold tracking-tight tabular-nums">
            {Math.round(percent)}%
          </span>
          <span className="text-muted-foreground mt-0.5 text-xs">
            {m['settings.storage.counted_usage']()}
          </span>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">{label}</p>
    </div>
  );
}

function UsageMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Database;
  label: string;
  value: string;
}) {
  return (
    <div className="bg-muted/40 flex items-center gap-3 rounded-lg p-3">
      <div className="bg-background ring-foreground/10 rounded-md p-2 ring-1">
        <Icon className="text-muted-foreground size-4" />
      </div>
      <div className="min-w-0">
        <p className="text-muted-foreground truncate text-xs">{label}</p>
        <p className="font-semibold tabular-nums">{value}</p>
      </div>
    </div>
  );
}

function StorageObjectRow({
  object,
  onDelete,
}: {
  object: StorageObjectSummary;
  onDelete?: () => void;
}) {
  const isCurrent = object.kind === 'current';
  return (
    <div className="border-border flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <div className="bg-muted mt-0.5 rounded-md p-2">
          {isCurrent ? (
            <Database className="size-4" />
          ) : (
            <Archive className="size-4" />
          )}
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">
              {isCurrent
                ? m['settings.storage.current_label']()
                : m['settings.storage.snapshot_label']()}
            </p>
            <Badge variant={isCurrent ? 'default' : 'secondary'}>
              {formatStorageBytes(object.sizeBytes)}
            </Badge>
            {object.status !== 'active' ? (
              <Badge variant="outline">
                {storageObjectStatusLabel(object.status)}
              </Badge>
            ) : null}
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {formatDateTime(object.createdAt)}
            {object.expiresAt
              ? ` · ${m['settings.storage.expires_at']({
                  date: formatDateTime(object.expiresAt),
                })}`
              : ''}
          </p>
          {object.digest ? (
            <p className="text-muted-foreground mt-1 truncate font-mono text-[11px]">
              {object.digest}
            </p>
          ) : null}
        </div>
      </div>
      {onDelete ? (
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground hover:text-destructive self-end sm:self-auto"
          onClick={onDelete}
          aria-label={m['settings.storage.delete_snapshot']()}
        >
          <Trash2 className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

function CleanupDialog({
  target,
  pending,
  onClose,
  onConfirm,
}: {
  target: CleanupTarget | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const isSession = target?.kind === 'session';

  return (
    <Dialog
      open={!!target}
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isSession
              ? m['settings.storage.delete_session_title']()
              : m['settings.storage.delete_snapshot_title']()}
          </DialogTitle>
          <DialogDescription>
            {isSession
              ? m['settings.storage.delete_session_description']({
                  name: target?.label ?? '',
                })
              : m['settings.storage.delete_snapshot_description']({
                  name: target?.label ?? '',
                })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {m['settings.storage.cancel']()}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending
              ? m['settings.storage.cleaning']()
              : m['settings.storage.confirm_cleanup']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StoragePageSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </CardHeader>
        <CardContent>
          <div className="grid gap-7 lg:grid-cols-[12rem_minmax(0,1fr)] lg:items-center">
            <Skeleton className="size-36 justify-self-center rounded-full" />
            <div className="space-y-5">
              <Skeleton className="h-8 w-full" />
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                {Array.from({ length: 5 }).map((_, index) => (
                  <Skeleton key={index} className="h-16 w-full" />
                ))}
              </div>
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        </CardContent>
      </Card>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

function usageBadgeVariant(percent: number) {
  if (percent >= 100) return 'destructive' as const;
  if (percent >= 80) return 'secondary' as const;
  return 'outline' as const;
}

function progressClassName(percent: number) {
  if (percent >= 100) {
    return '[&_[data-slot=progress-indicator]]:bg-destructive';
  }
  if (percent >= 80) {
    return '[&_[data-slot=progress-indicator]]:bg-chart-4';
  }
  return '';
}

function gaugeToneClassName(percent: number) {
  if (percent >= 100) return 'text-destructive';
  if (percent >= 80) return 'text-chart-4';
  return 'text-primary';
}

function usageStatusLabel(percent: number) {
  if (percent >= 100) return m['settings.storage.status_reached']();
  if (percent >= 80) return m['settings.storage.status_warning']();
  return m['settings.storage.status_available']();
}

function storageObjectStatusLabel(status: string) {
  switch (status) {
    case 'active':
      return m['settings.storage.status_active']();
    case 'deleting':
      return m['settings.storage.status_deleting']();
    case 'pending':
      return m['settings.storage.status_pending']();
    case 'failed':
      return m['settings.storage.status_failed']();
    default:
      return status;
  }
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export const Route = createFileRoute('/settings/storage')({
  component: StoragePage,
});
