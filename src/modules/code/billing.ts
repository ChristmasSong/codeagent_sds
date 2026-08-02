import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  codeBillingEvent,
  codeModel,
  codeSession,
  user,
  type CodeModel,
  type CodeSession,
  type NewCodeBillingEvent,
} from '@/config/db/schema';
import { getAllConfigs } from '@/modules/config/service';
import {
  consume,
  CreditTransactionScene,
  getBalance,
} from '@/modules/credits/service';
import { getUuid } from '@/lib/hash';

import { normalizeAgent } from './runtime';

const ONE_MILLION = 1_000_000;
const DEFAULT_PROVIDER_QUOTA_PER_CNY = 500_000;
const MODEL_CHARGE_UNITS_PER_CREDIT = ONE_MILLION * 100;
const MODEL_INPUT_AUTHORIZATION_BUFFER_PERCENT = 125;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const BILLING_LOCK_LEASE_MS = 60_000;
const BILLING_LOCK_WAIT_MS = 10_000;
const BILLING_LOCK_RETRY_MS = 75;

export type CodeBillingEventType = 'model_tokens' | 'runtime_minutes';
export type RuntimeBillingState = 'idle' | 'active' | 'high_load';

export interface CodeBillingSettings {
  enabled: boolean;
  requireConfiguredModelCosts: boolean;
  modelGateEnabled: boolean;
  runtimeMeterEnabled: boolean;
  unpaidAutoSettleEnabled: boolean;
  creditsPerCny: number;
  providerQuotaPerCny: number;
  defaultMultiplier: number;
  freeMinutesPerSession: number;
  idleCreditsPerMinute: number;
  activeCreditsPerMinute: number;
  highLoadCreditsPerMinute: number;
  sessionCreateMinBalanceCredits: number;
  idleTimeoutMinutes: number;
  maxSessionMinutes: number;
  storageFreeGb: number;
  storageCreditsPerGbDay: number;
  dailyFreeNetworkGb: number;
  networkCreditsPerGb: number;
  runtimeMeterIntervalMinutes: number;
  runtimeMeterMaxCatchupMinutes: number;
}

export type CodeBillingAuthorizationReason =
  | 'insufficient_credits'
  | 'model_mismatch'
  | 'model_costs_not_configured'
  | 'session_not_active';

export class CodeBillingAuthorizationError extends Error {
  constructor(
    public reason: CodeBillingAuthorizationReason,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'CodeBillingAuthorizationError';
  }
}

export interface ModelUsageAuthorizationInput {
  userId: string;
  sessionId: string;
  estimatedInputTokens?: unknown;
  maxOutputTokens?: unknown;
  authorizationKey?: unknown;
  requestedModel?: unknown;
}

export interface ModelTokenUsageInput {
  userId: string;
  sessionId: string;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  cachedInputTokens?: unknown;
  idempotencyKey?: unknown;
  provider?: unknown;
  endpoint?: unknown;
  upstreamStatus?: unknown;
  requestId?: unknown;
  costSource?: unknown;
  providerRequestId?: unknown;
  providerQuota?: unknown;
  providerGroup?: unknown;
  providerGroupRatio?: unknown;
  rawUsage?: unknown;
  description?: string;
  metadata?: unknown;
}

export interface ModelUsageReconciliationIssueInput {
  userId: string;
  sessionId: string;
  idempotencyKey?: unknown;
  provider?: unknown;
  endpoint?: unknown;
  upstreamStatus?: unknown;
  requestId?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheCreationInputTokens?: unknown;
  cachedInputTokens?: unknown;
  attempts?: unknown;
  firstQueuedAt?: unknown;
  lastError?: unknown;
  metadata?: unknown;
}

export interface RuntimeUsageInput {
  userId: string;
  sessionId: string;
  runtimeState?: unknown;
  endedAt?: Date;
  description?: string;
  metadata?: Record<string, unknown>;
  idempotencyKey?: string;
  maxDurationSeconds?: number;
  recordZeroCharge?: boolean;
  wholeMinutesOnly?: boolean;
}

export function calculateModelTokenCharge(params: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cachedInputTokens: number;
  inputTokenCostCreditsPer1m: number;
  outputTokenCostCreditsPer1m: number;
  cacheCreationInputTokenCostCreditsPer1m: number;
  cachedInputTokenCostCreditsPer1m: number;
  billingMultiplier: number;
}) {
  const inputCost = calculateModelTokenInputCost(params);

  const rawCostCredits =
    inputCost <= 0 ? 0 : Math.ceil(inputCost / ONE_MILLION);
  const chargedCredits =
    inputCost <= 0
      ? 0
      : Math.ceil((inputCost * params.billingMultiplier) / (ONE_MILLION * 100));

  return { rawCostCredits, chargedCredits };
}

export function calculateModelTokenChargeUnits(params: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cachedInputTokens: number;
  inputTokenCostCreditsPer1m: number;
  outputTokenCostCreditsPer1m: number;
  cacheCreationInputTokenCostCreditsPer1m: number;
  cachedInputTokenCostCreditsPer1m: number;
  billingMultiplier: number;
}) {
  return Math.max(
    0,
    Math.round(calculateModelTokenInputCost(params) * params.billingMultiplier)
  );
}

export function calculateProviderQuotaCharge(params: {
  providerQuota: number;
  providerQuotaPerCny: number;
  creditsPerCny: number;
  billingMultiplier: number;
}) {
  const rawCostCredits = providerQuotaCostCredits(params);
  return {
    rawCostCredits: rawCostCredits <= 0 ? 0 : Math.ceil(rawCostCredits),
    chargedCredits:
      rawCostCredits <= 0
        ? 0
        : Math.ceil((rawCostCredits * params.billingMultiplier) / 100),
  };
}

export function calculateProviderQuotaChargeUnits(params: {
  providerQuota: number;
  providerQuotaPerCny: number;
  creditsPerCny: number;
  billingMultiplier: number;
}) {
  const rawCostCredits = providerQuotaCostCredits(params);
  return Math.max(
    0,
    Math.round(rawCostCredits * params.billingMultiplier * ONE_MILLION)
  );
}

export function calculateAccumulatedModelTokenCharge(params: {
  remainderUnits: number;
  chargeUnits: number;
}) {
  const remainderUnits = Math.max(0, Math.floor(params.remainderUnits));
  const chargeUnits = Math.max(0, Math.floor(params.chargeUnits));
  const totalUnits = remainderUnits + chargeUnits;

  return {
    chargedCredits: Math.floor(totalUnits / MODEL_CHARGE_UNITS_PER_CREDIT),
    remainderUnits: totalUnits % MODEL_CHARGE_UNITS_PER_CREDIT,
  };
}

function calculateModelTokenInputCost(params: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cachedInputTokens: number;
  inputTokenCostCreditsPer1m: number;
  outputTokenCostCreditsPer1m: number;
  cacheCreationInputTokenCostCreditsPer1m: number;
  cachedInputTokenCostCreditsPer1m: number;
}) {
  return (
    params.inputTokens * params.inputTokenCostCreditsPer1m +
    params.outputTokens * params.outputTokenCostCreditsPer1m +
    params.cacheCreationInputTokens *
      params.cacheCreationInputTokenCostCreditsPer1m +
    params.cachedInputTokens * params.cachedInputTokenCostCreditsPer1m
  );
}

function providerQuotaCostCredits(params: {
  providerQuota: number;
  providerQuotaPerCny: number;
  creditsPerCny: number;
}) {
  const providerQuotaPerCny = positiveIntegerOrFallback(
    params.providerQuotaPerCny,
    ONE_MILLION
  );
  return (
    (Math.max(0, params.providerQuota) / providerQuotaPerCny) *
    Math.max(0, params.creditsPerCny)
  );
}

export function calculateRuntimeCharge(params: {
  durationSeconds: number;
  runtimeState: RuntimeBillingState;
  idleCreditsPerMinute: number;
  activeCreditsPerMinute: number;
  highLoadCreditsPerMinute: number;
}) {
  const durationSeconds = Math.max(0, Math.ceil(params.durationSeconds));
  const chargedMinutes =
    durationSeconds <= 0 ? 0 : Math.ceil(durationSeconds / 60);
  const rate =
    params.runtimeState === 'idle'
      ? params.idleCreditsPerMinute
      : params.runtimeState === 'high_load'
        ? params.highLoadCreditsPerMinute
        : params.activeCreditsPerMinute;

  return {
    chargedMinutes,
    chargedCredits: chargedMinutes * Math.max(0, rate),
  };
}

export function billingSettlementClaimStatus(id: string) {
  return `settling:${id.replaceAll('-', '').slice(0, 23)}`;
}

export function calculateMeteredDuration(params: {
  chargeStart: Date | null;
  endedAt: Date;
  maxDurationSeconds?: number;
  wholeMinutesOnly?: boolean;
}) {
  if (!params.chargeStart || params.endedAt <= params.chargeStart) {
    return {
      durationSeconds: 0,
      pendingDurationSeconds: 0,
      billedThrough: params.chargeStart,
    };
  }

  const elapsedSeconds = params.wholeMinutesOnly
    ? Math.floor(
        (params.endedAt.getTime() - params.chargeStart.getTime()) / 1000
      )
    : Math.ceil(
        (params.endedAt.getTime() - params.chargeStart.getTime()) / 1000
      );
  const maxDurationSeconds = positiveInteger(
    params.maxDurationSeconds,
    elapsedSeconds
  );
  const cappedDurationSeconds = Math.min(elapsedSeconds, maxDurationSeconds);
  const durationSeconds = params.wholeMinutesOnly
    ? Math.floor(cappedDurationSeconds / 60) * 60
    : cappedDurationSeconds;
  return {
    durationSeconds,
    pendingDurationSeconds: Math.max(0, elapsedSeconds - durationSeconds),
    billedThrough: new Date(
      params.chargeStart.getTime() + durationSeconds * 1000
    ),
  };
}

export async function getCodeBillingSettings(): Promise<CodeBillingSettings> {
  // Billing gates must reflect emergency admin changes immediately. The
  // general config cache can otherwise keep charging for up to an hour.
  const configs = await getAllConfigs({ fresh: true });
  const runtimeMeterIntervalMinutes = positiveIntegerOrFallback(
    configs.billing_runtime_meter_interval_minutes,
    1
  );
  const runtimeMeterMaxCatchupMinutes = Math.max(
    runtimeMeterIntervalMinutes,
    positiveIntegerOrFallback(
      configs.billing_runtime_meter_max_catchup_minutes,
      2
    )
  );
  return {
    enabled: boolConfig(configs.billing_enabled, true),
    requireConfiguredModelCosts: boolConfig(
      configs.billing_require_model_costs,
      false
    ),
    modelGateEnabled: boolConfig(configs.billing_model_gate_enabled, false),
    runtimeMeterEnabled: boolConfig(
      configs.billing_runtime_meter_enabled,
      false
    ),
    unpaidAutoSettleEnabled: boolConfig(
      configs.billing_unpaid_auto_settle_enabled,
      true
    ),
    creditsPerCny: numberConfig(configs.billing_credits_per_cny, 100),
    providerQuotaPerCny: numberConfig(
      configs.billing_provider_quota_per_cny,
      DEFAULT_PROVIDER_QUOTA_PER_CNY
    ),
    defaultMultiplier: numberConfig(configs.billing_default_multiplier, 200),
    freeMinutesPerSession: numberConfig(
      configs.billing_session_free_minutes,
      5
    ),
    idleCreditsPerMinute: numberConfig(
      configs.billing_runtime_idle_credits_per_minute,
      1
    ),
    activeCreditsPerMinute: numberConfig(
      configs.billing_runtime_active_credits_per_minute,
      2
    ),
    highLoadCreditsPerMinute: numberConfig(
      configs.billing_runtime_high_load_credits_per_minute,
      5
    ),
    sessionCreateMinBalanceCredits: numberConfig(
      configs.billing_session_min_balance_credits,
      0
    ),
    idleTimeoutMinutes: numberConfig(configs.billing_idle_timeout_minutes, 30),
    maxSessionMinutes: numberConfig(configs.billing_max_session_minutes, 240),
    storageFreeGb: numberConfig(configs.billing_storage_free_gb, 1),
    storageCreditsPerGbDay: numberConfig(
      configs.billing_storage_credits_per_gb_day,
      1
    ),
    dailyFreeNetworkGb: numberConfig(configs.billing_daily_free_network_gb, 1),
    networkCreditsPerGb: numberConfig(
      configs.billing_network_credits_per_gb,
      10
    ),
    runtimeMeterIntervalMinutes,
    runtimeMeterMaxCatchupMinutes,
  };
}

export async function getCodeSessionById(sessionId: string) {
  const [row] = await db()
    .select()
    .from(codeSession)
    .where(eq(codeSession.id, sessionId))
    .limit(1);
  return row;
}

export async function authorizeModelUsage(input: ModelUsageAuthorizationInput) {
  const settings = await getCodeBillingSettings();
  const row = await getOwnedActiveOrEndedSession(input.userId, input.sessionId);
  if (row.status !== 'active') {
    throw new CodeBillingAuthorizationError(
      'session_not_active',
      'Code session is not active',
      { sessionId: row.id, status: row.status }
    );
  }

  const requestedModel = optionalText(input.requestedModel, 160);
  if (!requestedModel || requestedModel !== row.model) {
    throw new CodeBillingAuthorizationError(
      'model_mismatch',
      'Requested model does not match the active code session',
      {
        sessionId: row.id,
        expectedModel: row.model,
        requestedModel,
      }
    );
  }

  const model = await getCodeModelRow(row.agent, row.model);
  const costsConfigured = Boolean(
    model &&
    nonNegativeNumber(model.inputTokenCostCreditsPer1m) > 0 &&
    nonNegativeNumber(model.outputTokenCostCreditsPer1m) > 0
  );
  const authorizationKey = optionalText(input.authorizationKey, 255);

  if (!settings.enabled || !settings.modelGateEnabled) {
    return {
      authorized: true,
      enforcement: 'disabled',
      authorizationKey,
      estimatedCredits: 0,
      requiredBalance: 0,
    };
  }

  const outstandingCredits = await settleAndGetCollectibleUnpaidCredits(
    input.userId
  );
  if (outstandingCredits > 0) {
    throw new CodeBillingAuthorizationError(
      'insufficient_credits',
      'Outstanding usage must be paid before another model request',
      {
        outstandingCredits,
        sessionId: row.id,
        model: row.model,
      }
    );
  }

  if (
    (settings.requireConfiguredModelCosts || settings.modelGateEnabled) &&
    !costsConfigured
  ) {
    throw new CodeBillingAuthorizationError(
      'model_costs_not_configured',
      'Selected model billing is not configured',
      { agent: normalizeAgent(row.agent), model: row.model }
    );
  }

  const estimatedInputTokens = Math.ceil(
    (nonNegativeInteger(input.estimatedInputTokens) *
      MODEL_INPUT_AUTHORIZATION_BUFFER_PERCENT) /
      100
  );
  const maxOutputTokens =
    nonNegativeInteger(input.maxOutputTokens) || DEFAULT_MAX_OUTPUT_TOKENS;
  const multiplier = positiveIntegerOrFallback(
    model?.billingMultiplier,
    settings.defaultMultiplier
  );
  const estimated = calculateModelTokenCharge({
    inputTokens: estimatedInputTokens,
    outputTokens: maxOutputTokens,
    cacheCreationInputTokens: 0,
    cachedInputTokens: 0,
    inputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.inputTokenCostCreditsPer1m
    ),
    outputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.outputTokenCostCreditsPer1m
    ),
    cacheCreationInputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.cacheCreationInputTokenCostCreditsPer1m
    ),
    cachedInputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.cachedInputTokenCostCreditsPer1m
    ),
    billingMultiplier: multiplier,
  });
  const requiredBalance = Math.max(
    estimated.chargedCredits,
    costsConfigured ? 1 : 0
  );
  const balance = await getBalance(input.userId);

  if (balance < requiredBalance) {
    throw new CodeBillingAuthorizationError(
      'insufficient_credits',
      'Insufficient credits for this model request',
      {
        balance,
        requiredBalance,
        estimatedCredits: estimated.chargedCredits,
        sessionId: row.id,
        model: row.model,
      }
    );
  }

  return {
    authorized: true,
    enforcement: 'enabled',
    authorizationKey,
    balance,
    estimatedCredits: estimated.chargedCredits,
    requiredBalance,
    estimatedInputTokens,
    maxOutputTokens,
  };
}

export async function recordModelTokenUsage(input: ModelTokenUsageInput) {
  const settings = await getCodeBillingSettings();
  const row = await getOwnedActiveOrEndedSession(input.userId, input.sessionId);
  const model = await getCodeModelRow(row.agent, row.model);
  const multiplier = positiveIntegerOrFallback(
    model?.billingMultiplier,
    settings.defaultMultiplier
  );
  const inputTokens = nonNegativeInteger(input.inputTokens);
  const outputTokens = nonNegativeInteger(input.outputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(
    input.cacheCreationInputTokens
  );
  const cachedInputTokens = nonNegativeInteger(input.cachedInputTokens);
  const idempotencyKey = optionalText(input.idempotencyKey, 255) || null;
  const provider =
    optionalText(input.provider, 255) || optionalText(model?.provider, 255);
  const endpoint = optionalText(input.endpoint, 255);
  const upstreamStatus = nonNegativeInteger(input.upstreamStatus);
  const requestId = optionalText(input.requestId, 255);
  const costSource = optionalText(input.costSource, 32);
  const providerRequestId =
    optionalText(input.providerRequestId, 255) || requestId;
  const hasProviderQuota = isNonNegativeNumber(input.providerQuota);
  const providerQuota = nonNegativeInteger(input.providerQuota);
  const providerGroup = optionalText(input.providerGroup, 255);
  const providerGroupRatio = nonNegativeNumber(input.providerGroupRatio);
  const exactProviderCost = Boolean(
    costSource === 'provider_log' && hasProviderQuota && providerRequestId
  );
  if (settings.enabled && settings.modelGateEnabled && !exactProviderCost) {
    throw new Error('Exact provider usage cost is not available yet');
  }
  const rawUsage = jsonText(input.rawUsage, 2048);
  const metadata = {
    ...metadataObject(input.metadata),
    sessionId: row.id,
    agent: normalizeAgent(row.agent),
    model: row.model,
    provider,
    endpoint,
    upstreamStatus,
    requestId,
    costSource: exactProviderCost ? 'provider_log' : 'token_rates',
    providerRequestId,
    providerQuota,
    providerQuotaPerCny: settings.providerQuotaPerCny,
    providerGroup,
    providerGroupRatio,
    idempotencyKey,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
  };

  const tokenCharge = calculateModelTokenCharge({
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    inputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.inputTokenCostCreditsPer1m
    ),
    outputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.outputTokenCostCreditsPer1m
    ),
    cacheCreationInputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.cacheCreationInputTokenCostCreditsPer1m
    ),
    cachedInputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.cachedInputTokenCostCreditsPer1m
    ),
    billingMultiplier: multiplier,
  });
  const tokenChargeUnits = calculateModelTokenChargeUnits({
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    inputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.inputTokenCostCreditsPer1m
    ),
    outputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.outputTokenCostCreditsPer1m
    ),
    cacheCreationInputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.cacheCreationInputTokenCostCreditsPer1m
    ),
    cachedInputTokenCostCreditsPer1m: nonNegativeNumber(
      model?.cachedInputTokenCostCreditsPer1m
    ),
    billingMultiplier: multiplier,
  });
  const providerCharge = calculateProviderQuotaCharge({
    providerQuota,
    providerQuotaPerCny: settings.providerQuotaPerCny,
    creditsPerCny: settings.creditsPerCny,
    billingMultiplier: multiplier,
  });
  const providerChargeUnits = calculateProviderQuotaChargeUnits({
    providerQuota,
    providerQuotaPerCny: settings.providerQuotaPerCny,
    creditsPerCny: settings.creditsPerCny,
    billingMultiplier: multiplier,
  });
  const rawCostCredits = exactProviderCost
    ? providerCharge.rawCostCredits
    : tokenCharge.rawCostCredits;
  const chargedCredits = exactProviderCost
    ? providerCharge.chargedCredits
    : tokenCharge.chargedCredits;
  const chargeUnits = exactProviderCost
    ? providerChargeUnits
    : tokenChargeUnits;

  return withUserBillingLock(input.userId, () =>
    db().transaction(async (tx: any) => {
      if (idempotencyKey) {
        const existing = await getBillingEventByIdempotencyKey(
          tx,
          input.userId,
          idempotencyKey
        );
        if (existing) {
          await markReconciliationIssueResolved(
            tx,
            input.userId,
            idempotencyKey
          );
          return existing;
        }
      }

      let appliedChargedCredits = 0;
      let remainderUnitsBefore = 0;
      let remainderUnitsAfter = 0;
      if (settings.enabled && settings.modelGateEnabled && chargeUnits > 0) {
        const [billingUser] = await tx
          .select({
            remainderUnits: user.codeModelBillingRemainderUnits,
          })
          .from(user)
          .where(eq(user.id, input.userId))
          .limit(1);
        if (!billingUser) throw new Error('Billing user not found');

        remainderUnitsBefore = nonNegativeInteger(billingUser.remainderUnits);
        const accumulated = calculateAccumulatedModelTokenCharge({
          remainderUnits: remainderUnitsBefore,
          chargeUnits,
        });
        appliedChargedCredits = accumulated.chargedCredits;
        remainderUnitsAfter = accumulated.remainderUnits;

        await tx
          .update(user)
          .set({
            codeModelBillingRemainderUnits: remainderUnitsAfter,
            updatedAt: new Date(),
          })
          .where(eq(user.id, input.userId));
      }

      const eventMetadata = {
        ...metadata,
        chargeUnits,
        remainderUnitsBefore,
        remainderUnitsAfter,
        roundedRequestChargeCredits: chargedCredits,
      };
      const result = await createBillingEvent(tx, {
        userId: input.userId,
        sessionId: row.id,
        agent: normalizeAgent(row.agent),
        model: row.model,
        eventType: 'model_tokens',
        idempotencyKey,
        provider,
        endpoint,
        upstreamStatus,
        requestId,
        costSource: exactProviderCost ? 'provider_log' : 'token_rates',
        providerRequestId,
        providerQuota,
        providerQuotaPerCny: settings.providerQuotaPerCny,
        providerGroup,
        providerGroupRatio,
        inputTokens,
        outputTokens,
        cacheCreationInputTokens,
        cachedInputTokens,
        rawUsage,
        rawCostCredits,
        chargedCredits: appliedChargedCredits,
        billingMultiplier: multiplier,
        description:
          input.description ||
          `Model usage: ${row.model} (${inputTokens} input / ${outputTokens} output tokens; ${exactProviderCost ? `provider quota ${providerQuota}` : 'token estimate'})`,
        metadata: jsonText(eventMetadata, 4096),
      });
      if (result.created && result.event.status === 'charged') {
        await tx
          .update(codeSession)
          .set({
            billedCredits: sql`${codeSession.billedCredits} + ${result.event.chargedCredits}`,
            updatedAt: new Date(),
          })
          .where(eq(codeSession.id, row.id));
      }
      if (idempotencyKey) {
        await markReconciliationIssueResolved(tx, input.userId, idempotencyKey);
      }
      return result.event;
    })
  );
}

export async function recordModelUsageReconciliationIssue(
  input: ModelUsageReconciliationIssueInput
) {
  const row = await getOwnedActiveOrEndedSession(input.userId, input.sessionId);
  const originalIdempotencyKey = optionalText(input.idempotencyKey, 230);
  if (!originalIdempotencyKey) {
    throw new Error('Missing reconciliation idempotency key');
  }

  const provider = optionalText(input.provider, 255);
  const endpoint = optionalText(input.endpoint, 255);
  const upstreamStatus = nonNegativeInteger(input.upstreamStatus);
  const requestId = optionalText(input.requestId, 255);
  const inputTokens = nonNegativeInteger(input.inputTokens);
  const outputTokens = nonNegativeInteger(input.outputTokens);
  const cacheCreationInputTokens = nonNegativeInteger(
    input.cacheCreationInputTokens
  );
  const cachedInputTokens = nonNegativeInteger(input.cachedInputTokens);
  const attempts = nonNegativeInteger(input.attempts);
  const firstQueuedAt = optionalText(input.firstQueuedAt, 64);
  const lastError = optionalText(input.lastError, 500);
  const metadata = {
    ...metadataObject(input.metadata),
    reconciliation: 'provider_usage_unresolved',
    originalIdempotencyKey,
    sessionId: row.id,
    agent: normalizeAgent(row.agent),
    model: row.model,
    provider,
    endpoint,
    upstreamStatus,
    requestId,
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cachedInputTokens,
    attempts,
    firstQueuedAt,
    lastError,
  };

  return db().transaction(async (tx: any) => {
    const result = await createBillingEvent(tx, {
      userId: input.userId,
      sessionId: row.id,
      agent: normalizeAgent(row.agent),
      model: row.model,
      eventType: 'model_tokens',
      idempotencyKey: reconciliationIssueIdempotencyKey(originalIdempotencyKey),
      provider,
      endpoint,
      upstreamStatus,
      requestId,
      costSource: 'provider_unresolved',
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cachedInputTokens,
      rawCostCredits: 0,
      chargedCredits: 0,
      billingMultiplier: 0,
      status: 'unresolved',
      collectible: 0,
      settlementError: lastError,
      description: `Provider usage reconciliation pending for ${row.model}`,
      metadata: jsonText(metadata, 4096),
    });
    return result.event;
  });
}

export async function settleSessionRuntimeUsage(input: RuntimeUsageInput) {
  const settings = await getCodeBillingSettings();
  const row = await getOwnedActiveOrEndedSession(input.userId, input.sessionId);
  const runtimeState = normalizeRuntimeState(input.runtimeState);
  const endedAt = input.endedAt || new Date();
  const chargeStart = runtimeChargeStart(row, settings, endedAt);
  const { durationSeconds, pendingDurationSeconds, billedThrough } =
    calculateMeteredDuration({
      chargeStart,
      endedAt,
      maxDurationSeconds: input.maxDurationSeconds,
      wholeMinutesOnly: input.wholeMinutesOnly,
    });
  const idempotencyKey =
    input.idempotencyKey ||
    (durationSeconds > 0 && chargeStart
      ? `runtime:${row.id}:${chargeStart.getTime()}`
      : null);
  const { chargedMinutes, chargedCredits } = calculateRuntimeCharge({
    durationSeconds,
    runtimeState,
    idleCreditsPerMinute: settings.idleCreditsPerMinute,
    activeCreditsPerMinute: settings.activeCreditsPerMinute,
    highLoadCreditsPerMinute: settings.highLoadCreditsPerMinute,
  });

  if (durationSeconds <= 0 && input.recordZeroCharge === false) {
    return {
      id: '',
      sessionId: row.id,
      eventType: 'runtime_minutes',
      runtimeState,
      durationSeconds: 0,
      rawCostCredits: 0,
      chargedCredits: 0,
      status: 'not_due',
    };
  }

  if (chargedCredits <= 0 && input.recordZeroCharge === false) {
    await db()
      .update(codeSession)
      .set({
        lastBilledAt: billedThrough || endedAt,
        updatedAt: endedAt,
      })
      .where(eq(codeSession.id, row.id));
    return {
      id: '',
      sessionId: row.id,
      eventType: 'runtime_minutes',
      runtimeState,
      durationSeconds,
      rawCostCredits: 0,
      chargedCredits: 0,
      status: 'not_billable',
    };
  }

  return withUserBillingLock(input.userId, () =>
    db().transaction(async (tx: any) => {
      const result = await createBillingEvent(tx, {
        userId: input.userId,
        sessionId: row.id,
        agent: normalizeAgent(row.agent),
        model: row.model,
        eventType: 'runtime_minutes',
        idempotencyKey,
        runtimeState,
        durationSeconds,
        rawCostCredits: chargedCredits,
        chargedCredits:
          settings.enabled && settings.runtimeMeterEnabled ? chargedCredits : 0,
        billingMultiplier: 100,
        description:
          input.description ||
          `Runtime usage: ${chargedMinutes} minute${chargedMinutes === 1 ? '' : 's'} (${runtimeState})`,
        metadata: JSON.stringify({
          ...(input.metadata || {}),
          sessionId: row.id,
          agent: normalizeAgent(row.agent),
          model: row.model,
          runtimeState,
          durationSeconds,
          pendingDurationSeconds,
          chargedMinutes,
          freeMinutesPerSession: settings.freeMinutesPerSession,
        }),
      });
      const event = result.event;

      if (result.created) {
        await tx
          .update(codeSession)
          .set({
            lastBilledAt: billedThrough || endedAt,
            billedCredits: sql`${codeSession.billedCredits} + ${event.status === 'charged' ? event.chargedCredits : 0}`,
            updatedAt: endedAt,
          })
          .where(eq(codeSession.id, row.id));
      }

      return event;
    })
  );
}

async function createBillingEvent(
  tx: any,
  values: Omit<NewCodeBillingEvent, 'id' | 'createdAt' | 'status'> & {
    status?: string;
  }
) {
  const chargedCredits = values.chargedCredits ?? 0;
  const metadata = values.metadata || '';
  const collectible = values.collectible ?? (chargedCredits > 0 ? 1 : 0);

  if (values.idempotencyKey) {
    const existing = await getBillingEventByIdempotencyKey(
      tx,
      values.userId,
      values.idempotencyKey
    );
    if (existing) return { event: existing, created: false };

    const event: NewCodeBillingEvent = {
      id: getUuid(),
      ...values,
      chargedCredits,
      creditId: values.creditId || '',
      status: values.status || (chargedCredits > 0 ? 'pending' : 'recorded'),
      collectible,
      settlementAttempts: 0,
      settlementError: values.settlementError || '',
      metadata,
      createdAt: new Date(),
    };

    try {
      await tx.insert(codeBillingEvent).values(event);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        const existingAfterConflict = await getBillingEventByIdempotencyKey(
          tx,
          values.userId,
          values.idempotencyKey
        );
        if (existingAfterConflict) {
          return { event: existingAfterConflict, created: false };
        }
      }
      throw error;
    }

    if (chargedCredits <= 0) return { event, created: true };

    const settled = await settleEventCredits(tx, {
      ...values,
      metadata,
      chargedCredits,
    });
    const settledAt = new Date();
    const settlementUpdate = {
      creditId: settled.creditId,
      status: settled.status,
      settlementAttempts: 1,
      lastSettlementAt: settledAt,
      settledAt: settled.status === 'charged' ? settledAt : null,
      settlementError: settled.error,
    };
    await tx
      .update(codeBillingEvent)
      .set(settlementUpdate)
      .where(eq(codeBillingEvent.id, event.id));

    return { event: { ...event, ...settlementUpdate }, created: true };
  }

  let status = chargedCredits > 0 ? 'charged' : 'recorded';
  let creditId = values.creditId || '';
  let settlementAttempts = 0;
  let lastSettlementAt: Date | null = null;
  let settledAt: Date | null = null;
  let settlementError = '';

  if (chargedCredits > 0) {
    const settled = await settleEventCredits(tx, {
      ...values,
      metadata,
      chargedCredits,
    });
    creditId = settled.creditId;
    status = settled.status;
    settlementAttempts = 1;
    lastSettlementAt = new Date();
    settledAt = status === 'charged' ? lastSettlementAt : null;
    settlementError = settled.error;
  }

  const event: NewCodeBillingEvent = {
    id: getUuid(),
    ...values,
    chargedCredits,
    creditId,
    status: values.status || status,
    collectible,
    settlementAttempts,
    lastSettlementAt,
    settledAt,
    settlementError: values.settlementError || settlementError,
    metadata,
    createdAt: new Date(),
  };
  await tx.insert(codeBillingEvent).values(event);
  return { event, created: true };
}

async function settleEventCredits(
  tx: any,
  values: {
    userId: string;
    eventType: string;
    chargedCredits: number;
    description?: string | null;
    metadata?: string | null;
  }
) {
  const result = await consume({
    userId: values.userId,
    credits: values.chargedCredits,
    scene:
      values.eventType === 'model_tokens'
        ? CreditTransactionScene.CODE_MODEL
        : CreditTransactionScene.CODE_RUNTIME,
    description: values.description,
    metadata: values.metadata,
    tx,
  });

  if (result.success) {
    return {
      creditId: result.consumedCredit?.id || '',
      status: 'charged',
      error: '',
    };
  }

  return {
    creditId: '',
    status: 'unpaid',
    error: 'insufficient_credits',
  };
}

export async function settleUnpaidBillingEventsForUser(input: {
  userId: string;
  limit?: number;
  tx?: any;
  enabled?: boolean;
}) {
  const enabled =
    input.enabled ?? (await getCodeBillingSettings()).unpaidAutoSettleEnabled;
  const result = {
    enabled,
    attempted: 0,
    settled: 0,
    settledCredits: 0,
    stoppedForInsufficientCredits: false,
  };
  if (!enabled) return result;

  const execute = async (tx: any) => {
    const rows = await tx
      .select()
      .from(codeBillingEvent)
      .where(
        and(
          eq(codeBillingEvent.userId, input.userId),
          eq(codeBillingEvent.status, 'unpaid'),
          eq(codeBillingEvent.collectible, 1)
        )
      )
      .orderBy(asc(codeBillingEvent.createdAt))
      .limit(Math.min(100, Math.max(1, input.limit || 25)));

    for (const row of rows) {
      const claimStatus = billingSettlementClaimStatus(getUuid());
      await tx
        .update(codeBillingEvent)
        .set({ status: claimStatus })
        .where(
          and(
            eq(codeBillingEvent.id, row.id),
            eq(codeBillingEvent.status, 'unpaid')
          )
        );
      const [claimed] = await tx
        .select({ id: codeBillingEvent.id })
        .from(codeBillingEvent)
        .where(
          and(
            eq(codeBillingEvent.id, row.id),
            eq(codeBillingEvent.status, claimStatus)
          )
        )
        .limit(1);
      if (!claimed) continue;

      result.attempted += 1;
      const settled = await settleEventCredits(tx, {
        userId: row.userId,
        eventType: row.eventType,
        chargedCredits: row.chargedCredits,
        description: row.description,
        metadata: row.metadata,
      });
      const attemptedAt = new Date();
      await tx
        .update(codeBillingEvent)
        .set({
          creditId: settled.creditId,
          status: settled.status,
          settlementAttempts: sql`${codeBillingEvent.settlementAttempts} + 1`,
          lastSettlementAt: attemptedAt,
          settledAt: settled.status === 'charged' ? attemptedAt : null,
          settlementError: settled.error,
        })
        .where(
          and(
            eq(codeBillingEvent.id, row.id),
            eq(codeBillingEvent.status, claimStatus)
          )
        );

      if (settled.status !== 'charged') {
        result.stoppedForInsufficientCredits = true;
        break;
      }

      if (row.sessionId) {
        await tx
          .update(codeSession)
          .set({
            billedCredits: sql`${codeSession.billedCredits} + ${row.chargedCredits}`,
            updatedAt: attemptedAt,
          })
          .where(eq(codeSession.id, row.sessionId));
      }
      result.settled += 1;
      result.settledCredits += row.chargedCredits;
    }

    return result;
  };

  if (input.tx) return execute(input.tx);
  return withUserBillingLock(input.userId, () => db().transaction(execute));
}

async function settleAndGetCollectibleUnpaidCredits(userId: string) {
  let outstandingCredits = await getCollectibleUnpaidCredits(userId);
  if (outstandingCredits <= 0) return 0;

  await settleUnpaidBillingEventsForUser({
    userId,
    limit: 100,
    enabled: true,
  });
  outstandingCredits = await getCollectibleUnpaidCredits(userId);
  return outstandingCredits;
}

async function getCollectibleUnpaidCredits(userId: string) {
  const [row] = await db()
    .select({
      credits: sql<number>`coalesce(sum(${codeBillingEvent.chargedCredits}), 0)`,
    })
    .from(codeBillingEvent)
    .where(
      and(
        eq(codeBillingEvent.userId, userId),
        eq(codeBillingEvent.status, 'unpaid'),
        eq(codeBillingEvent.collectible, 1)
      )
    );
  return nonNegativeInteger(row?.credits);
}

async function withUserBillingLock<T>(
  userId: string,
  execute: () => Promise<T>
): Promise<T> {
  const token = getUuid();
  const deadline = Date.now() + BILLING_LOCK_WAIT_MS;

  while (Date.now() < deadline) {
    const now = new Date();
    await db()
      .update(user)
      .set({
        codeBillingLockToken: token,
        codeBillingLockExpiresAt: new Date(
          now.getTime() + BILLING_LOCK_LEASE_MS
        ),
      })
      .where(
        and(
          eq(user.id, userId),
          or(
            eq(user.codeBillingLockToken, ''),
            isNull(user.codeBillingLockExpiresAt),
            lt(user.codeBillingLockExpiresAt, now)
          )
        )
      );

    const [lock] = await db()
      .select({ token: user.codeBillingLockToken })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (!lock) throw new Error('Billing user not found');

    if (lock.token === token) {
      try {
        return await execute();
      } finally {
        await db()
          .update(user)
          .set({
            codeBillingLockToken: '',
            codeBillingLockExpiresAt: null,
          })
          .where(
            and(eq(user.id, userId), eq(user.codeBillingLockToken, token))
          );
      }
    }

    await sleep(BILLING_LOCK_RETRY_MS);
  }

  throw new Error('Billing settlement is busy; retry shortly');
}

export async function settleCollectibleBillingDebts(limit = 25) {
  const settings = await getCodeBillingSettings();
  const result = {
    enabled: settings.unpaidAutoSettleEnabled,
    users: 0,
    attempted: 0,
    settled: 0,
    settledCredits: 0,
    failed: 0,
  };
  if (!result.enabled) return result;

  const users = await db()
    .selectDistinct({ userId: codeBillingEvent.userId })
    .from(codeBillingEvent)
    .where(
      and(
        eq(codeBillingEvent.status, 'unpaid'),
        eq(codeBillingEvent.collectible, 1)
      )
    )
    .limit(Math.min(100, Math.max(1, limit)));

  for (const row of users) {
    result.users += 1;
    try {
      const settled = await settleUnpaidBillingEventsForUser({
        userId: row.userId,
        enabled: true,
      });
      result.attempted += settled.attempted;
      result.settled += settled.settled;
      result.settledCredits += settled.settledCredits;
    } catch (error) {
      result.failed += 1;
      console.warn('[billing-debt-settlement] user failed', {
        userId: row.userId,
        message: (error as Error).message,
      });
    }
  }

  return result;
}

async function getBillingEventByIdempotencyKey(
  tx: any,
  userId: string,
  idempotencyKey: string
) {
  const [row] = await tx
    .select()
    .from(codeBillingEvent)
    .where(
      and(
        eq(codeBillingEvent.userId, userId),
        eq(codeBillingEvent.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);
  return row;
}

async function markReconciliationIssueResolved(
  tx: any,
  userId: string,
  originalIdempotencyKey: string
) {
  await tx
    .update(codeBillingEvent)
    .set({
      status: 'resolved',
      settlementError: '',
      settledAt: new Date(),
    })
    .where(
      and(
        eq(codeBillingEvent.userId, userId),
        eq(
          codeBillingEvent.idempotencyKey,
          reconciliationIssueIdempotencyKey(originalIdempotencyKey)
        ),
        eq(codeBillingEvent.status, 'unresolved')
      )
    );
}

function reconciliationIssueIdempotencyKey(originalIdempotencyKey: string) {
  return `unresolved:${originalIdempotencyKey}`.slice(0, 255);
}

async function getOwnedActiveOrEndedSession(userId: string, sessionId: string) {
  const [row] = await db()
    .select()
    .from(codeSession)
    .where(and(eq(codeSession.userId, userId), eq(codeSession.id, sessionId)))
    .limit(1);
  if (!row) throw new Error('Session not found');
  return row;
}

async function getCodeModelRow(agent: string, model: string) {
  const [row] = await db()
    .select()
    .from(codeModel)
    .where(
      and(
        eq(codeModel.agent, normalizeAgent(agent)),
        eq(codeModel.model, model)
      )
    )
    .orderBy(desc(codeModel.updatedAt))
    .limit(1);
  return row as CodeModel | undefined;
}

function runtimeChargeStart(
  row: CodeSession,
  settings: CodeBillingSettings,
  endedAt: Date
): Date | null {
  const createdAt = toDate(row.createdAt);
  if (!createdAt) return null;
  const freeUntil = new Date(
    createdAt.getTime() + settings.freeMinutesPerSession * 60_000
  );
  const lastBilledAt = toDate(row.lastBilledAt);
  if (!lastBilledAt) {
    const legacyCatchupStart = new Date(
      endedAt.getTime() - settings.runtimeMeterMaxCatchupMinutes * 60_000
    );
    return new Date(
      Math.max(freeUntil.getTime(), legacyCatchupStart.getTime())
    );
  }
  return new Date(Math.max(freeUntil.getTime(), lastBilledAt.getTime()));
}

function normalizeRuntimeState(value: unknown): RuntimeBillingState {
  return value === 'idle' || value === 'high_load' ? value : 'active';
}

function toDate(value: Date | string | number | null | undefined) {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}

function boolConfig(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === '') return fallback;
  return value === 'true';
}

function numberConfig(value: string | undefined, fallback: number) {
  return positiveInteger(value, fallback);
}

function nonNegativeInteger(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(typeof value === 'string' ? value : '0', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function nonNegativeNumber(value: unknown) {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseFloat(typeof value === 'string' ? value : '0');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function isNonNegativeNumber(value: unknown) {
  if (value === null || value === undefined || value === '') return false;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0;
}

function optionalText(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, maxLength);
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return metadataObject(parsed);
    } catch {
      return {};
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function jsonText(value: unknown, maxLength: number) {
  try {
    return JSON.stringify(value ?? {}).slice(0, maxLength);
  } catch {
    return '{}';
  }
}

function isUniqueConstraintError(error: unknown) {
  const message = String(
    (error as any)?.message || (error as any)?.cause?.message || ''
  ).toLowerCase();
  return (
    message.includes('unique') ||
    message.includes('duplicate') ||
    message.includes('constraint')
  );
}

function positiveInteger(value: unknown, fallback: number) {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function positiveIntegerOrFallback(value: unknown, fallback: number) {
  const parsed =
    typeof value === 'number'
      ? value
      : Number.parseInt(typeof value === 'string' ? value : '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
