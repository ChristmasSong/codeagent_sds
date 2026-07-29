import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import { envConfigs } from '@/config';
import { normalizeAgent, terminalHttpUrl } from '@/modules/code/runtime';
import * as codeSessions from '@/modules/code/service';
import { getAllConfigs } from '@/modules/config/service';

function logProxy(event: string, data: Record<string, unknown> = {}) {
  console.info('[code-terminal-proxy]', { event, ...data });
}

async function currentUser(request: Request) {
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new Error('Unauthorized');
  return session.user;
}

async function runtimeSecret(fresh = false) {
  const configs = await getAllConfigs({ fresh });
  const secret = (
    configs.billing_usage_webhook_secret ||
    envConfigs.billing_usage_webhook_secret ||
    ''
  ).trim();
  if (!secret) throw new Error('Runtime terminal proxy is not configured');
  return secret;
}

async function GET({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    logProxy('start', {
      sessionId: params.id,
      upgrade: request.headers.get('upgrade') || '',
      origin: request.headers.get('origin') || '',
      userAgent: request.headers.get('user-agent') || '',
    });

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      logProxy('reject-non-websocket', { sessionId: params.id });
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const user = await currentUser(request);
    logProxy('authenticated', { sessionId: params.id });
    const session = await codeSessions.getOwnedSession(user.id, params.id);
    if (!session || session.status !== 'active') {
      logProxy('reject-session', {
        sessionId: params.id,
        found: Boolean(session),
        status: session?.status || '',
      });
      return new Response('Session not found', { status: 404 });
    }

    const headers = new Headers(request.headers);
    headers.delete('cookie');
    headers.delete('host');
    headers.set('x-hicode-runtime-secret', await runtimeSecret());

    const upstreamUrl = terminalHttpUrl(
      envConfigs.runtime_base_url,
      session.runtimeUserId,
      session.id,
      normalizeAgent(session.agent),
      session.model
    );
    logProxy('upstream-start', {
      sessionId: session.id,
      agent: normalizeAgent(session.agent),
      model: session.model,
      runtimeHost: new URL(upstreamUrl).host,
    });

    let upstream = await fetch(upstreamUrl, {
      method: 'GET',
      headers,
    });
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => undefined);
      headers.set('x-hicode-runtime-secret', await runtimeSecret(true));
      upstream = await fetch(upstreamUrl, {
        method: 'GET',
        headers,
      });
    }
    logProxy('upstream-response', {
      sessionId: session.id,
      status: upstream.status,
      webSocket: Boolean(
        (upstream as Response & { webSocket?: WebSocket }).webSocket
      ),
    });
    return upstream;
  } catch (error: any) {
    const message = error?.message || 'Terminal proxy failed';
    const status = message === 'Unauthorized' ? 401 : 500;
    logProxy('error', {
      sessionId: params.id,
      status,
      message,
      name: error?.name || '',
    });
    return new Response(message, { status });
  }
}

export const Route = createFileRoute('/api/code/sessions/$id/terminal')({
  server: {
    handlers: { GET },
  },
});
