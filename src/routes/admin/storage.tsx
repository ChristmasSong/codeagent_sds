import { useQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import {
  AlertTriangle,
  Archive,
  Banknote,
  Clock3,
  Database,
  Gauge,
  HardDrive,
  RefreshCw,
  Users,
} from 'lucide-react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { m } from '@/core/i18n/messages';
import { apiGet } from '@/lib/api-client';
import {
  formatStorageBytes,
  storagePercent,
  type AdminStorageResponse,
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
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';
import { Progress, ProgressLabel } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const REPORT_DAYS = 30;
const TOP_USERS = 10;

function AdminStoragePage() {
  const storageQuery = useQuery({
    queryKey: ['admin-storage', REPORT_DAYS, TOP_USERS],
    queryFn: () =>
      apiGet<AdminStorageResponse>(
        `/api/admin/storage?days=${REPORT_DAYS}&top=${TOP_USERS}`
      ),
    refetchInterval: 60_000,
  });

  const data = storageQuery.data;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">{m['admin.storage.title']()}</h1>
          <p className="text-muted-foreground">
            {m['admin.storage.description']()}
          </p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => storageQuery.refetch()}
            disabled={storageQuery.isFetching}
          >
            <RefreshCw
              className={cn(
                'size-4',
                storageQuery.isFetching && 'animate-spin'
              )}
            />
            {m['admin.storage.refresh']()}
          </Button>
          {data?.summary.updatedAt ? (
            <p className="text-muted-foreground text-xs">
              {m['admin.storage.updated_at']({
                date: formatDateTime(data.summary.updatedAt),
              })}
            </p>
          ) : null}
        </div>
      </div>

      {storageQuery.isPending ? (
        <AdminStorageSkeleton />
      ) : storageQuery.isError || !data ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
            <AlertTriangle className="text-destructive size-8" />
            <div>
              <p className="font-medium">{m['admin.storage.load_failed']()}</p>
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
        <StorageDashboard data={data} />
      )}
    </div>
  );
}

function StorageDashboard({ data }: { data: AdminStorageResponse }) {
  const { summary, budget } = data;
  const capacityPercent = storagePercent(summary.usedBytes, summary.limitBytes);
  const budgetPercent =
    budget.monthlyBudgetUsd > 0
      ? storagePercent(budget.estimatedCostUsd, budget.monthlyBudgetUsd)
      : Math.max(0, budget.percentUsed);
  const chartConfig = {
    usedBytes: {
      label: m['admin.storage.chart_used'](),
      color: 'var(--chart-1)',
    },
  } satisfies ChartConfig;

  return (
    <>
      {capacityPercent >= 85 || budgetPercent >= 85 ? (
        <div
          className={cn(
            'flex gap-3 rounded-lg border p-4 text-sm',
            capacityPercent >= 100 || budgetPercent >= 100
              ? 'border-destructive/40 bg-destructive/5 text-destructive'
              : 'border-chart-4/40 bg-chart-4/10'
          )}
          role="alert"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            {capacityPercent >= 85 && budgetPercent >= 85
              ? m['admin.storage.alert_both']({
                  capacity: Math.round(capacityPercent),
                  budget: Math.round(budgetPercent),
                })
              : capacityPercent >= 85
                ? m['admin.storage.alert_capacity']({
                    percent: Math.round(capacityPercent),
                  })
                : m['admin.storage.alert_budget']({
                    percent: Math.round(budgetPercent),
                  })}
          </p>
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={HardDrive}
          title={m['admin.storage.total_usage']()}
          value={formatStorageBytes(summary.usedBytes)}
          description={
            summary.limitBytes > 0
              ? m['admin.storage.capacity_total']({
                  amount: formatStorageBytes(summary.limitBytes),
                })
              : m['admin.storage.capacity_unlimited']()
          }
        />
        <SummaryCard
          icon={Clock3}
          title={m['admin.storage.reserved']()}
          value={formatStorageBytes(summary.reservedBytes)}
          description={m['admin.storage.reserved_description']()}
        />
        <SummaryCard
          icon={Banknote}
          title={m['admin.storage.estimated_cost']()}
          value={formatCurrency(budget.estimatedCostUsd)}
          description={m['admin.storage.cost_description']({
            month: budget.month,
          })}
        />
        <SummaryCard
          icon={Users}
          title={m['admin.storage.users']()}
          value={formatCount(summary.userCount)}
          description={m['admin.storage.sessions_objects']({
            sessions: formatCount(summary.sessionCount),
            objects: formatCount(summary.objectCount),
          })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Gauge className="size-5" />
              {m['admin.storage.capacity_title']()}
            </CardTitle>
            <CardDescription>
              {m['admin.storage.capacity_description']()}
            </CardDescription>
            <CardAction>
              <Badge variant={usageBadgeVariant(capacityPercent)}>
                {Math.round(capacityPercent)}%
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-5">
            {summary.limitBytes > 0 ? (
              <Progress
                value={capacityPercent}
                className={progressClassName(capacityPercent)}
              >
                <ProgressLabel>
                  {formatStorageBytes(summary.usedBytes)}
                </ProgressLabel>
                <span className="text-muted-foreground ml-auto text-sm tabular-nums">
                  {formatStorageBytes(summary.limitBytes)}
                </span>
              </Progress>
            ) : (
              <p className="text-muted-foreground text-sm">
                {m['admin.storage.capacity_not_configured']()}
              </p>
            )}
            <StorageBreakdown data={summary} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Banknote className="size-5" />
              {m['admin.storage.budget_title']()}
            </CardTitle>
            <CardDescription>
              {m['admin.storage.budget_description']()}
            </CardDescription>
            <CardAction>
              <Badge variant={usageBadgeVariant(budgetPercent)}>
                {Math.round(budgetPercent)}%
              </Badge>
            </CardAction>
          </CardHeader>
          <CardContent className="space-y-5">
            {budget.monthlyBudgetUsd > 0 ? (
              <Progress
                value={budgetPercent}
                className={progressClassName(budgetPercent)}
              >
                <ProgressLabel>
                  {formatCurrency(budget.estimatedCostUsd)}
                </ProgressLabel>
                <span className="text-muted-foreground ml-auto text-sm tabular-nums">
                  {formatCurrency(budget.monthlyBudgetUsd)}
                </span>
              </Progress>
            ) : (
              <p className="text-muted-foreground text-sm">
                {m['admin.storage.budget_not_configured']()}
              </p>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <DetailMetric
                label={m['admin.storage.storage_cost']()}
                value={formatCurrency(budget.storageCostUsd)}
              />
              <DetailMetric
                label={m['admin.storage.operation_cost']()}
                value={formatCurrency(budget.operationCostUsd)}
              />
              <DetailMetric
                label={m['admin.storage.gb_days']()}
                value={formatNumber(budget.gbDays)}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              {m['admin.storage.estimate_notice']()}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.storage.trend_title']()}</CardTitle>
          <CardDescription>
            {m['admin.storage.trend_description']({ days: REPORT_DAYS })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.trend.length > 0 ? (
            <ChartContainer config={chartConfig} className="h-[280px] w-full">
              <AreaChart
                data={data.trend}
                margin={{ top: 8, right: 12, left: 4, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="storage-fill" x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor="var(--color-usedBytes)"
                      stopOpacity={0.35}
                    />
                    <stop
                      offset="95%"
                      stopColor="var(--color-usedBytes)"
                      stopOpacity={0.04}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="date"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                  tickFormatter={(value) => formatShortDate(String(value))}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  width={64}
                  tickFormatter={(value) => formatStorageBytes(Number(value))}
                />
                <ChartTooltip
                  cursor={false}
                  content={
                    <ChartTooltipContent
                      formatter={(value) => formatStorageBytes(Number(value))}
                    />
                  }
                />
                <Area
                  dataKey="usedBytes"
                  type="monotone"
                  fill="url(#storage-fill)"
                  stroke="var(--color-usedBytes)"
                  strokeWidth={2}
                />
              </AreaChart>
            </ChartContainer>
          ) : (
            <div className="text-muted-foreground flex h-[240px] items-center justify-center text-sm">
              {m['admin.storage.no_trend']()}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{m['admin.storage.top_users_title']()}</CardTitle>
          <CardDescription>
            {m['admin.storage.top_users_description']()}
          </CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m['admin.storage.user_col']()}</TableHead>
                <TableHead className="text-right">
                  {m['admin.storage.used_col']()}
                </TableHead>
                <TableHead className="text-right">
                  {m['admin.storage.reserved_col']()}
                </TableHead>
                <TableHead className="text-right">
                  {m['admin.storage.sessions_col']()}
                </TableHead>
                <TableHead className="text-right">
                  {m['admin.storage.objects_col']()}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.topUsers.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={5}
                    className="text-muted-foreground h-24 text-center"
                  >
                    {m['admin.storage.no_users']()}
                  </TableCell>
                </TableRow>
              ) : (
                data.topUsers.map((user) => (
                  <TableRow key={user.userId}>
                    <TableCell>
                      <div className="max-w-[300px]">
                        <p className="truncate font-medium">
                          {user.email || user.name || user.userId}
                        </p>
                        <p className="text-muted-foreground mt-1 truncate font-mono text-xs">
                          {user.userId}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatStorageBytes(user.usedBytes)}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right tabular-nums">
                      {formatStorageBytes(user.reservedBytes)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(user.sessionCount)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatCount(user.objectCount)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function SummaryCard({
  icon: Icon,
  title,
  value,
  description,
}: {
  icon: typeof HardDrive;
  title: string;
  value: string;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        <CardAction>
          <Icon className="text-muted-foreground size-4" />
        </CardAction>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-bold tabular-nums">{value}</p>
        <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      </CardContent>
    </Card>
  );
}

function StorageBreakdown({ data }: { data: AdminStorageResponse['summary'] }) {
  const rows = [
    {
      icon: Database,
      label: m['admin.storage.current_archives'](),
      value: data.currentBytes,
    },
    {
      icon: Archive,
      label: m['admin.storage.snapshots'](),
      value: data.snapshotBytes,
    },
    {
      icon: Clock3,
      label: m['admin.storage.temporary'](),
      value: data.tempBytes,
    },
    {
      icon: AlertTriangle,
      label: m['admin.storage.pending_delete'](),
      value: data.pendingDeleteBytes,
    },
  ];

  return (
    <div className="divide-border divide-y rounded-lg border">
      {rows.map(({ icon: Icon, label, value }) => (
        <div key={label} className="flex items-center gap-3 px-3 py-2.5">
          <Icon className="text-muted-foreground size-4" />
          <span className="flex-1 text-sm">{label}</span>
          <span className="text-sm font-medium tabular-nums">
            {formatStorageBytes(value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted/40 rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function AdminStorageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-32 w-full" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <Skeleton className="h-80 w-full" />
    </div>
  );
}

function usageBadgeVariant(percent: number) {
  if (percent >= 100) return 'destructive' as const;
  if (percent >= 85) return 'secondary' as const;
  return 'outline' as const;
}

function progressClassName(percent: number) {
  if (percent >= 100) {
    return '[&_[data-slot=progress-indicator]]:bg-destructive';
  }
  if (percent >= 85) {
    return '[&_[data-slot=progress-indicator]]:bg-chart-4';
  }
  return '';
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatNumber(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(Number.isFinite(value) ? value : 0);
}

function formatShortDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
      }).format(date);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export const Route = createFileRoute('/admin/storage')({
  component: AdminStoragePage,
});
