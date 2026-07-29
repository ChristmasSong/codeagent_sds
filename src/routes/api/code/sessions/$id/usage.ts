import { createFileRoute } from '@tanstack/react-router';

import { getAuth } from '@/core/auth';
import {
  authorizeModelUsage,
  CodeBillingAuthorizationError,
  getCodeSessionById,
  recordModelTokenUsage,
  recordModelUsageReconciliationIssue,
  settleSessionRuntimeUsage,
} from '@/modules/code/billing';
import { getAllConfigs } from '@/modules/config/service';
import { respData, respErr, respJson } from '@/lib/resp';

async function resolveUsageUser(request: Request, sessionId: string) {
  const configs = await getAllConfigs();
  const secret = configs.billing_usage_webhook_secret;
  const provided =
    request.headers.get('x-hicode-billing-secret') ||
    request.headers.get('x-codeagent-billing-secret');

  if (secret && provided && provided === secret) {
    const row = await getCodeSessionById(sessionId);
    if (!row) throw new Error('Session not found');
    return row.userId;
  }

  const auth = getAuth();
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) throw new Error('Unauthorized');
  return session.user.id;
}

async function POST({
  request,
  params,
}: {
  request: Request;
  params: { id: string };
}) {
  try {
    const userId = await resolveUsageUser(request, params.id);
    const body = await request.json().catch(() => ({}));
    const eventType = body.eventType || body.type;

    if (eventType === 'model_authorize') {
      return respData(
        await authorizeModelUsage({
          userId,
          sessionId: params.id,
          estimatedInputTokens:
            body.estimatedInputTokens ?? body.estimated_input_tokens,
          maxOutputTokens: body.maxOutputTokens ?? body.max_output_tokens,
          authorizationKey: body.authorizationKey ?? body.authorization_key,
          requestedModel: body.requestedModel ?? body.requested_model,
        })
      );
    }

    if (eventType === 'model_tokens') {
      return respData(
        await recordModelTokenUsage({
          userId,
          sessionId: params.id,
          inputTokens: body.inputTokens ?? body.input_tokens,
          outputTokens: body.outputTokens ?? body.output_tokens,
          cacheCreationInputTokens:
            body.cacheCreationInputTokens ?? body.cache_creation_input_tokens,
          cachedInputTokens: body.cachedInputTokens ?? body.cached_input_tokens,
          idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
          provider: body.provider,
          endpoint: body.endpoint,
          upstreamStatus: body.upstreamStatus ?? body.upstream_status,
          requestId: body.requestId ?? body.request_id,
          costSource: body.costSource ?? body.cost_source,
          providerRequestId: body.providerRequestId ?? body.provider_request_id,
          providerQuota: body.providerQuota ?? body.provider_quota,
          providerGroup: body.providerGroup ?? body.provider_group,
          providerGroupRatio:
            body.providerGroupRatio ?? body.provider_group_ratio,
          rawUsage: body.rawUsage ?? body.raw_usage,
          description: body.description,
          metadata: body.metadata,
        })
      );
    }

    if (eventType === 'model_usage_unresolved') {
      return respData(
        await recordModelUsageReconciliationIssue({
          userId,
          sessionId: params.id,
          idempotencyKey: body.idempotencyKey ?? body.idempotency_key,
          provider: body.provider,
          endpoint: body.endpoint,
          upstreamStatus: body.upstreamStatus ?? body.upstream_status,
          requestId: body.requestId ?? body.request_id,
          inputTokens: body.inputTokens ?? body.input_tokens,
          outputTokens: body.outputTokens ?? body.output_tokens,
          cacheCreationInputTokens:
            body.cacheCreationInputTokens ?? body.cache_creation_input_tokens,
          cachedInputTokens: body.cachedInputTokens ?? body.cached_input_tokens,
          attempts: body.attempts,
          firstQueuedAt: body.firstQueuedAt ?? body.first_queued_at,
          lastError: body.lastError ?? body.last_error,
          metadata: body.metadata,
        })
      );
    }

    if (eventType === 'runtime_minutes') {
      return respData(
        await settleSessionRuntimeUsage({
          userId,
          sessionId: params.id,
          runtimeState: body.runtimeState ?? body.runtime_state,
          metadata: body.metadata,
        })
      );
    }

    return respErr('Invalid usage event type');
  } catch (error: any) {
    if (error instanceof CodeBillingAuthorizationError) {
      return respJson(-1, error.message, {
        reason: error.reason,
        ...error.details,
      });
    }
    return respErr(error.message || 'Failed to record usage');
  }
}

export const Route = createFileRoute('/api/code/sessions/$id/usage')({
  server: {
    handlers: { POST },
  },
});
