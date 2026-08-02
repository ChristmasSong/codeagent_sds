import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import * as codeSessions from '@/modules/code/service';
import { enforceMinIntervalRateLimit } from '@/lib/rate-limit';
import { respData, respErr, respJson } from '@/lib/resp';

const ACTIONS = [
  'health',
  'inspect',
  'archive',
  'restore',
  'resume-preflight',
  'resume',
  'suspend',
  'discard',
  'end',
  'delete-permanently',
] as const;
type Action = (typeof ACTIONS)[number];

async function currentUser(request: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new Error('Unauthorized');
  return session.user;
}

function isAction(value: unknown): value is Action {
  return typeof value === 'string' && ACTIONS.includes(value as Action);
}

async function POST({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    const user = await currentUser(request);
    const body = await request.json().catch(() => ({}));
    if (!isAction(body.action)) return respErr('Invalid action');
    if (
      (body.action === 'discard' || body.action === 'delete-permanently') &&
      body.confirmSessionId !== params.id
    ) {
      return respErr('Full session ID confirmation is required');
    }

    const limited = enforceMinIntervalRateLimit(request, {
      intervalMs: 2000,
      keyPrefix: 'code-session-action',
      extraKey: `${user.id}:${params.id}:${body.action}`,
    });
    if (limited) return limited;

    switch (body.action) {
      case 'health':
        return respData(await codeSessions.health(user.id, params.id));
      case 'inspect':
        return respData(await codeSessions.inspectSession(user.id, params.id));
      case 'archive':
        return respData(await codeSessions.archiveSession(user.id, params.id));
      case 'restore':
        return respData(await codeSessions.restoreSession(user.id, params.id));
      case 'resume-preflight':
        return respData(
          await codeSessions.preflightSessionResume(user.id, params.id)
        );
      case 'resume':
        return respData(
          await codeSessions.resumeArchivedSession(user.id, params.id)
        );
      case 'suspend':
        return respData(await codeSessions.suspendSession(user.id, params.id));
      case 'discard':
        return respData(await codeSessions.discardSession(user.id, params.id));
      case 'end':
        return respData(await codeSessions.endSession(user.id, params.id));
      case 'delete-permanently':
        return respData(
          await codeSessions.deleteSessionPermanently(user.id, params.id)
        );
    }
  } catch (error: any) {
    if (error instanceof codeSessions.CodeSessionStartError) {
      return respJson(-1, error.message, {
        reason: error.reason,
        ...error.details,
      });
    }
    if (error instanceof codeSessions.RuntimeRequestError) {
      return respJson(-1, error.message, {
        reason: 'runtime_error',
        status: error.status,
        code: error.code,
        stage: error.stage,
        details: error.details,
      });
    }
    return respErr(error.message || 'Code session action failed');
  }
}

export const Route = createFileRoute('/api/code/sessions/$id/actions')({
  server: {
    handlers: { POST },
  },
});
