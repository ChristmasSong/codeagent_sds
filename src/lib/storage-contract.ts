export type StorageObjectKind = 'current' | 'snapshot' | 'temp';

export type StorageObjectStatus = 'pending' | 'active' | 'deleting' | 'failed';

export interface StorageObjectSummary {
  id: string;
  sessionId: string;
  kind: StorageObjectKind;
  key: string;
  sizeBytes: number;
  digest: string | null;
  status: StorageObjectStatus | string;
  createdAt: string;
  expiresAt: string | null;
}

export interface StorageSessionSummary {
  id: string;
  title: string;
  status?: string;
  totalBytes: number;
  current: StorageObjectSummary | null;
  snapshots: StorageObjectSummary[];
}

export interface StorageQuotaSummary {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  currentBytes: number;
  snapshotBytes: number;
  tempBytes: number;
  pendingDeleteBytes?: number;
}

export interface UserStorageResponse {
  quota: StorageQuotaSummary;
  sessions: StorageSessionSummary[];
}

export interface AdminStorageSummary {
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
  currentBytes: number;
  snapshotBytes: number;
  tempBytes: number;
  pendingDeleteBytes: number;
  userCount: number;
  sessionCount: number;
  objectCount: number;
  updatedAt?: string | null;
}

export interface AdminStorageBudget {
  month: string;
  monthlyBudgetUsd: number;
  estimatedCostUsd: number;
  storageCostUsd: number;
  operationCostUsd: number;
  gbDays: number;
  percentUsed: number;
}

export interface AdminStorageTrendPoint {
  date: string;
  usedBytes: number;
  addedBytes: number;
  deletedBytes: number;
  estimatedCostUsd?: number;
}

export interface AdminStorageUser {
  userId: string;
  email: string | null;
  name: string | null;
  usedBytes: number;
  reservedBytes: number;
  sessionCount: number;
  objectCount: number;
}

export interface AdminStorageResponse {
  summary: AdminStorageSummary;
  budget: AdminStorageBudget;
  trend: AdminStorageTrendPoint[];
  topUsers: AdminStorageUser[];
}

export function storagePercent(usedBytes: number, limitBytes: number) {
  if (limitBytes <= 0) return 0;
  return Math.min(100, Math.max(0, (usedBytes / limitBytes) * 100));
}

export function formatStorageBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const unitIndex = Math.min(
    Math.floor(Math.log(value) / Math.log(1024)),
    units.length - 1
  );
  const amount = value / 1024 ** unitIndex;

  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: amount >= 100 ? 0 : amount >= 10 ? 1 : 2,
  }).format(amount)} ${units[unitIndex]}`;
}
