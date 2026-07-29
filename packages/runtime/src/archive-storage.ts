export const MAX_ARCHIVE_SNAPSHOTS = 2;
export const ARCHIVE_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ARCHIVE_TEMP_TTL_MS = 24 * 60 * 60 * 1000;

export type ArchiveCleanupReason =
  | 'history_limit'
  | 'history_ttl'
  | 'replace_current'
  | 'temporary_ttl';

export interface ArchiveObjectLike {
  key: string;
  size: number;
  uploaded: Date;
  etag?: string;
  customMetadata?: Record<string, string>;
}

export interface ArchiveCleanupCandidate {
  object: ArchiveObjectLike;
  reason: ArchiveCleanupReason;
}

export function userArchivePrefix(userId: string): string {
  return `integrated-workspaces/${encodeURIComponent(userId)}/`;
}

export function sessionArchivePrefix(
  userId: string,
  sessionId: string
): string {
  return `${userArchivePrefix(userId)}${encodeURIComponent(sessionId)}/`;
}

export function legacyArchiveKey(userId: string, sessionId: string): string {
  return `${sessionArchivePrefix(userId, sessionId)}workspace.tar.gz`;
}

export function archiveVersionsPrefix(
  userId: string,
  sessionId: string
): string {
  return `${sessionArchivePrefix(userId, sessionId)}archives/`;
}

export function archiveTemporaryPrefix(
  userId: string,
  sessionId: string
): string {
  return `${sessionArchivePrefix(userId, sessionId)}temporary/`;
}

export function archiveVersionKey(
  userId: string,
  sessionId: string,
  now = new Date(),
  uniqueId = crypto.randomUUID()
): string {
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `${archiveVersionsPrefix(userId, sessionId)}${timestamp}-${uniqueId}.tar.gz`;
}

export function isSessionArchiveKey(
  userId: string,
  sessionId: string,
  key: string
): boolean {
  return key.startsWith(sessionArchivePrefix(userId, sessionId));
}

export function isVersionArchiveKey(
  userId: string,
  sessionId: string,
  key: string
): boolean {
  const prefix = archiveVersionsPrefix(userId, sessionId);
  const suffix = key.startsWith(prefix) ? key.slice(prefix.length) : '';
  return Boolean(suffix && !suffix.includes('/') && suffix.endsWith('.tar.gz'));
}

export function newestArchiveObject<T extends ArchiveObjectLike>(
  objects: T[]
): T | null {
  return (
    [...objects].sort(
      (left, right) =>
        right.uploaded.getTime() - left.uploaded.getTime() ||
        right.key.localeCompare(left.key)
    )[0] || null
  );
}

export function archiveCleanupPlan(
  versionObjects: ArchiveObjectLike[],
  temporaryObjects: ArchiveObjectLike[],
  currentKey: string,
  options: {
    now?: Date;
    retainPrevious?: boolean;
    maxSnapshots?: number;
    historyTtlMs?: number;
    temporaryTtlMs?: number;
  } = {}
): ArchiveCleanupCandidate[] {
  const now = options.now || new Date();
  const retainPrevious = options.retainPrevious !== false;
  const maxSnapshots = Math.max(
    0,
    options.maxSnapshots ?? MAX_ARCHIVE_SNAPSHOTS
  );
  const historyCutoff =
    now.getTime() - (options.historyTtlMs ?? ARCHIVE_HISTORY_TTL_MS);
  const temporaryCutoff =
    now.getTime() - (options.temporaryTtlMs ?? ARCHIVE_TEMP_TTL_MS);
  const candidates: ArchiveCleanupCandidate[] = [];
  const history = versionObjects
    .filter((object) => object.key !== currentKey)
    .sort(
      (left, right) =>
        right.uploaded.getTime() - left.uploaded.getTime() ||
        right.key.localeCompare(left.key)
    );

  history.forEach((object, index) => {
    if (!retainPrevious) {
      candidates.push({ object, reason: 'replace_current' });
    } else if (object.uploaded.getTime() < historyCutoff) {
      candidates.push({ object, reason: 'history_ttl' });
    } else if (index >= maxSnapshots) {
      candidates.push({ object, reason: 'history_limit' });
    }
  });

  for (const object of temporaryObjects) {
    if (object.uploaded.getTime() < temporaryCutoff) {
      candidates.push({ object, reason: 'temporary_ttl' });
    }
  }

  return candidates;
}
