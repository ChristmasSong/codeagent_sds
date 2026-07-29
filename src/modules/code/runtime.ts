// Pure helpers for the hicode runtime session. No DOM / browser deps —
// safe to run under tsx and to import from server functions.

export const CODE_SESSION_AGENTS = ['claude', 'codex'] as const;
export type CodeSessionAgent = (typeof CODE_SESSION_AGENTS)[number];

interface WorkspaceRestoreDecision {
  archiveKey?: string | null;
  status?: string | null;
  workspaceExists?: boolean;
  restorePending?: boolean;
}

export function normalizeAgent(value: unknown): CodeSessionAgent {
  return value === 'codex' ? 'codex' : 'claude';
}

export function shouldRestoreWorkspace({
  archiveKey,
  status,
  workspaceExists,
  restorePending = false,
}: WorkspaceRestoreDecision): boolean {
  if (!archiveKey || status !== 'active') return false;
  return restorePending || workspaceExists === false;
}

// Lossy by design: lowercases and strips everything outside [a-z0-9-], so
// two distinct auth user ids could in theory collapse to the same slug and
// share a runtime container namespace. Acceptable for round 1 (random
// better-auth ids); revisit if round 2 moves to token-based auth with
// user-chosen or predictable ids.
export function sanitizeUserId(raw: string): string {
  const slug = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || 'user';
}

export function generateSessionId(): string {
  const time = Date.now().toString(36);
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 10)
      : Math.floor(Math.random() * 1e16).toString(36);
  return `s-${time}-${rand}`.toLowerCase();
}

function trimSlashes(base: string): string {
  return base.replace(/\/+$/, '');
}

function appendSessionParams(
  url: string,
  agent?: CodeSessionAgent,
  model?: string
): string {
  const normalized = normalizeAgent(agent);
  if (normalized === 'claude' && !model) return url;
  const parsed = new URL(url);
  if (normalized !== 'claude') parsed.searchParams.set('agent', normalized);
  if (model) parsed.searchParams.set('model', model);
  return parsed.toString();
}

export function terminalHttpUrl(
  base: string,
  userId: string,
  sessionId: string,
  agent?: CodeSessionAgent,
  model?: string
): string {
  return appendSessionParams(
    `${trimSlashes(base)}/terminal/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`,
    agent,
    model
  );
}

export function terminalWsUrl(
  base: string,
  userId: string,
  sessionId: string,
  agent?: CodeSessionAgent,
  model?: string
): string {
  return terminalHttpUrl(base, userId, sessionId, agent, model).replace(
    /^http/,
    'ws'
  );
}

export function actionUrl(
  base: string,
  action: string,
  userId: string,
  sessionId?: string,
  agent?: CodeSessionAgent,
  model?: string
): string {
  const parts = [
    trimSlashes(base),
    encodeURIComponent(action),
    encodeURIComponent(userId),
  ];
  if (sessionId) parts.push(encodeURIComponent(sessionId));
  return appendSessionParams(parts.join('/'), agent, model);
}

export function workspaceFilesUrl(
  base: string,
  userId: string,
  sessionId: string,
  operation?: 'status' | 'content'
): string {
  const suffix = operation ? `/${operation}` : '';
  return `${trimSlashes(base)}/files/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}${suffix}`;
}
