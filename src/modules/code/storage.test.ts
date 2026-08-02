import assert from 'node:assert/strict';

import {
  assertWorkspaceWithinQuota,
  calculateReservationDecision,
  calculateSettlementDecision,
  getCodeStorageSettings,
  GIB,
  WorkspaceQuotaExceededError,
} from './storage';

assert.deepEqual(
  getCodeStorageSettings({
    code_storage_user_quota_gb: '1',
    code_storage_workspace_quota_gb: '2',
    code_storage_platform_capacity_gb: '100',
    code_storage_monthly_budget_usd: '25',
  }),
  {
    userQuotaBytes: GIB,
    workspaceQuotaBytes: 2 * GIB,
    platformCapacityBytes: 100 * GIB,
    monthlyBudgetUsd: 25,
    retentionDays: 7,
    maxSnapshotsPerSession: 2,
  }
);

assert.equal(
  getCodeStorageSettings({ billing_storage_free_gb: '3' }).userQuotaBytes,
  GIB
);

assert.deepEqual(
  calculateReservationDecision({
    usedBytes: 950,
    reservedBytes: 0,
    requestedBytes: 900,
    replaceableBytes: 900,
    limitBytes: 1000,
  }),
  {
    allowed: true,
    netReservedBytes: 0,
    projectedBytes: 950,
    availableBytes: 50,
  }
);

assert.equal(
  calculateReservationDecision({
    usedBytes: 950,
    reservedBytes: 20,
    requestedBytes: 100,
    limitBytes: 1000,
  }).allowed,
  false
);

assert.deepEqual(
  calculateSettlementDecision({
    usedBytes: 950,
    reservedBytes: 50,
    reservationBytes: 50,
    actualBytes: 900,
    deletedBytes: 900,
    limitBytes: 1000,
  }),
  {
    allowed: true,
    nextUsedBytes: 950,
    nextReservedBytes: 0,
    projectedBytes: 950,
  }
);

assert.equal(
  calculateSettlementDecision({
    usedBytes: 950,
    reservedBytes: 50,
    reservationBytes: 50,
    actualBytes: 100,
    limitBytes: 1000,
  }).allowed,
  false
);

assert.doesNotThrow(() =>
  assertWorkspaceWithinQuota(2 * GIB, {
    code_storage_workspace_quota_gb: '2',
  })
);
assert.throws(
  () =>
    assertWorkspaceWithinQuota(2 * GIB + 1, {
      code_storage_workspace_quota_gb: '2',
    }),
  WorkspaceQuotaExceededError
);

console.log('code storage quota tests passed');
