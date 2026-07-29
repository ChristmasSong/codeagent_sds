import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { envConfigs } from '@/config';
import { signedPreviewUrl } from '@/modules/code/preview-access';
import * as codeSessions from '@/modules/code/service';
import { getAllConfigs } from '@/modules/config/service';

function textResponse(message: string, status: number) {
  return new Response(message, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    },
  });
}

async function GET({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  const authSession = await getAuth().api.getSession({
    headers: request.headers,
  });
  if (!authSession?.user) return textResponse('Unauthorized', 401);

  const session = await codeSessions.getOwnedSession(
    authSession.user.id,
    params.id
  );
  if (!session || session.status !== 'active') {
    return textResponse('Session not found', 404);
  }

  const configs = await getAllConfigs();
  const secret = (
    configs.billing_usage_webhook_secret ||
    envConfigs.billing_usage_webhook_secret ||
    ''
  ).trim();
  if (!secret) {
    return textResponse('Runtime preview is not configured', 503);
  }

  const preview = await signedPreviewUrl({
    runtimeBaseUrl: envConfigs.runtime_base_url,
    runtimeUserId: session.runtimeUserId,
    sessionId: session.id,
    secret,
  });
  return new Response(null, {
    status: 302,
    headers: {
      'cache-control': 'no-store',
      location: preview.url,
      'referrer-policy': 'no-referrer',
    },
  });
}

export const Route = createFileRoute('/api/code/sessions/$id/preview')({
  server: {
    handlers: { GET },
  },
});
