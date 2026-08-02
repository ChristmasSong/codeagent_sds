/**
 * PostgreSQL schema definitions.
 *
 * This is the PostgreSQL dialect of the database schema.
 * To use: set DATABASE_PROVIDER=postgres in .env.local,
 * then copy this file's content into schema.ts.
 */

import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const table = pgTable;

// ─── Auth ────────────────────────────────────────────────────────────────────

export const user = table(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    utmSource: text('utm_source').notNull().default(''),
    ip: text('ip').notNull().default(''),
    locale: text('locale').notNull().default(''),
    codeModelBillingRemainderUnits: integer(
      'code_model_billing_remainder_units'
    )
      .notNull()
      .default(0),
    codeBillingLockToken: text('code_billing_lock_token').notNull().default(''),
    codeBillingLockExpiresAt: timestamp('code_billing_lock_expires_at'),
  },
  (table) => [
    index('idx_user_name').on(table.name),
    index('idx_user_created_at').on(table.createdAt),
  ]
);

export const session = table(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [
    index('idx_session_user_expires').on(table.userId, table.expiresAt),
  ]
);

export const account = table(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_account_user_id').on(table.userId),
    index('idx_account_provider_account').on(table.providerId, table.accountId),
  ]
);

export const verification = table(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('idx_verification_identifier').on(table.identifier)]
);

// ─── Content ─────────────────────────────────────────────────────────────────

export const config = table('config', {
  name: text('name').unique().notNull(),
  value: text('value'),
});

export const taxonomy = table(
  'taxonomy',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    slug: text('slug').unique().notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    image: text('image'),
    icon: text('icon'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [index('idx_taxonomy_type_status').on(table.type, table.status)]
);

export const post = table(
  'post',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    slug: text('slug').unique().notNull(),
    type: text('type').notNull(),
    title: text('title'),
    description: text('description'),
    image: text('image'),
    content: text('content'),
    categories: text('categories'),
    tags: text('tags'),
    authorName: text('author_name'),
    authorImage: text('author_image'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [index('idx_post_type_status').on(table.type, table.status)]
);

// ─── Business ────────────────────────────────────────────────────────────────

export const order = table(
  'order',
  {
    id: text('id').primaryKey(),
    orderNo: text('order_no').unique().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'),
    status: text('status').notNull(),
    amount: integer('amount').notNull(),
    currency: text('currency').notNull(),
    productId: text('product_id'),
    paymentType: text('payment_type'),
    paymentInterval: text('payment_interval'),
    paymentProvider: text('payment_provider').notNull(),
    paymentSessionId: text('payment_session_id'),
    checkoutInfo: text('checkout_info').notNull(),
    checkoutResult: text('checkout_result'),
    paymentResult: text('payment_result'),
    discountCode: text('discount_code'),
    discountAmount: integer('discount_amount'),
    discountCurrency: text('discount_currency'),
    paymentEmail: text('payment_email'),
    paymentAmount: integer('payment_amount'),
    paymentCurrency: text('payment_currency'),
    paidAt: timestamp('paid_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    description: text('description'),
    productName: text('product_name'),
    subscriptionId: text('subscription_id'),
    subscriptionResult: text('subscription_result'),
    checkoutUrl: text('checkout_url'),
    callbackUrl: text('callback_url'),
    creditsAmount: integer('credits_amount'),
    creditsValidDays: integer('credits_valid_days'),
    planName: text('plan_name'),
    paymentProductId: text('payment_product_id'),
    invoiceId: text('invoice_id'),
    invoiceUrl: text('invoice_url'),
    subscriptionNo: text('subscription_no'),
    transactionId: text('transaction_id'),
    paymentUserName: text('payment_user_name'),
    paymentUserId: text('payment_user_id'),
  },
  (table) => [
    index('idx_order_user_status_payment_type').on(
      table.userId,
      table.status,
      table.paymentType
    ),
    index('idx_order_transaction_provider').on(
      table.transactionId,
      table.paymentProvider
    ),
    index('idx_order_created_at').on(table.createdAt),
  ]
);

export const subscription = table(
  'subscription',
  {
    id: text('id').primaryKey(),
    subscriptionNo: text('subscription_no').unique().notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'),
    status: text('status').notNull(),
    paymentProvider: text('payment_provider').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    subscriptionResult: text('subscription_result'),
    productId: text('product_id'),
    description: text('description'),
    amount: integer('amount'),
    currency: text('currency'),
    interval: text('interval'),
    intervalCount: integer('interval_count'),
    trialPeriodDays: integer('trial_period_days'),
    currentPeriodStart: timestamp('current_period_start'),
    currentPeriodEnd: timestamp('current_period_end'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    planName: text('plan_name'),
    billingUrl: text('billing_url'),
    productName: text('product_name'),
    creditsAmount: integer('credits_amount'),
    creditsValidDays: integer('credits_valid_days'),
    paymentProductId: text('payment_product_id'),
    paymentUserId: text('payment_user_id'),
    canceledAt: timestamp('canceled_at'),
    canceledEndAt: timestamp('canceled_end_at'),
    canceledReason: text('canceled_reason'),
    canceledReasonType: text('canceled_reason_type'),
  },
  (table) => [
    index('idx_subscription_user_status_interval').on(
      table.userId,
      table.status,
      table.interval
    ),
    index('idx_subscription_provider_id').on(
      table.subscriptionId,
      table.paymentProvider
    ),
    index('idx_subscription_created_at').on(table.createdAt),
  ]
);

export const credit = table(
  'credit',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email'),
    orderNo: text('order_no'),
    subscriptionNo: text('subscription_no'),
    transactionNo: text('transaction_no').unique().notNull(),
    transactionType: text('transaction_type').notNull(),
    transactionScene: text('transaction_scene'),
    credits: integer('credits').notNull(),
    remainingCredits: integer('remaining_credits').notNull().default(0),
    description: text('description'),
    expiresAt: timestamp('expires_at'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    consumedDetail: text('consumed_detail'),
    metadata: text('metadata'),
  },
  (table) => [
    index('idx_credit_consume_fifo').on(
      table.userId,
      table.status,
      table.transactionType,
      table.remainingCredits,
      table.expiresAt
    ),
    index('idx_credit_order_no').on(table.orderNo),
    index('idx_credit_subscription_no').on(table.subscriptionNo),
  ]
);

export const apikey = table(
  'apikey',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    title: text('title').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('idx_apikey_user_status').on(table.userId, table.status),
    index('idx_apikey_keyhash_status').on(table.keyHash, table.status),
  ]
);

// ─── RBAC ────────────────────────────────────────────────────────────────────

export const role = table(
  'role',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull().unique(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    sort: integer('sort').default(0).notNull(),
  },
  (table) => [index('idx_role_status').on(table.status)]
);

export const permission = table(
  'permission',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    resource: text('resource').notNull(),
    action: text('action').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_permission_resource_action').on(table.resource, table.action),
  ]
);

export const rolePermission = table(
  'role_permission',
  {
    id: text('id').primaryKey(),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permissionId: text('permission_id')
      .notNull()
      .references(() => permission.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('idx_role_permission_role_permission').on(
      table.roleId,
      table.permissionId
    ),
  ]
);

export const userRole = table(
  'user_role',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    expiresAt: timestamp('expires_at'),
  },
  (table) => [
    index('idx_user_role_user_expires').on(table.userId, table.expiresAt),
  ]
);

// ─── AI ──────────────────────────────────────────────────────────────────────

export const aiTask = table(
  'ai_task',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mediaType: text('media_type').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    prompt: text('prompt').notNull(),
    options: text('options'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp('deleted_at'),
    taskId: text('task_id'),
    taskInfo: text('task_info'),
    taskResult: text('task_result'),
    costCredits: integer('cost_credits').notNull().default(0),
    scene: text('scene').notNull().default(''),
    creditId: text('credit_id'),
  },
  (table) => [
    index('idx_ai_task_user_media_type').on(table.userId, table.mediaType),
    index('idx_ai_task_media_type_status').on(table.mediaType, table.status),
  ]
);

export const chat = table(
  'chat',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    title: text('title').notNull().default(''),
    parts: text('parts').notNull(),
    metadata: text('metadata'),
    content: text('content'),
  },
  (table) => [index('idx_chat_user_status').on(table.userId, table.status)]
);

export const chatMessage = table(
  'chat_message',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => new Date())
      .notNull(),
    role: text('role').notNull(),
    parts: text('parts').notNull(),
    metadata: text('metadata'),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
  },
  (table) => [
    index('idx_chat_message_chat_id').on(table.chatId, table.status),
    index('idx_chat_message_user_id').on(table.userId, table.status),
  ]
);

// ─── Types ───────────────────────────────────────────────────────────────────

export type User = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;
export type Session = typeof session.$inferSelect;
export type NewSession = typeof session.$inferInsert;
export type Account = typeof account.$inferSelect;
export type NewAccount = typeof account.$inferInsert;
export type Verification = typeof verification.$inferSelect;
export type Config = typeof config.$inferSelect;
export type Taxonomy = typeof taxonomy.$inferSelect;
export type NewTaxonomy = typeof taxonomy.$inferInsert;
export type Post = typeof post.$inferSelect;
export type NewPost = typeof post.$inferInsert;
export type Order = typeof order.$inferSelect;
export type NewOrder = typeof order.$inferInsert;
export type Subscription = typeof subscription.$inferSelect;
export type NewSubscription = typeof subscription.$inferInsert;
export type Credit = typeof credit.$inferSelect;
export type NewCredit = typeof credit.$inferInsert;
export type Apikey = typeof apikey.$inferSelect;
export type NewApikey = typeof apikey.$inferInsert;
export type Role = typeof role.$inferSelect;
export type NewRole = typeof role.$inferInsert;
export type Permission = typeof permission.$inferSelect;
export type RolePermission = typeof rolePermission.$inferSelect;
export type UserRole = typeof userRole.$inferSelect;
export type AiTask = typeof aiTask.$inferSelect;
export type NewAiTask = typeof aiTask.$inferInsert;
export type Chat = typeof chat.$inferSelect;
export type NewChat = typeof chat.$inferInsert;
export type ChatMessage = typeof chatMessage.$inferSelect;
export type NewChatMessage = typeof chatMessage.$inferInsert;

// ─── Tickets (support) ───────────────────────────────────────────────────────

export const ticket = table(
  'ticket',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    title: text('title').notNull(),
    status: text('status').notNull().default('open'), // open | replied | closed
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_ticket_user').on(t.userId),
    index('idx_ticket_status').on(t.status),
  ]
);

export const ticketMessage = table(
  'ticket_message',
  {
    id: text('id').primaryKey(),
    ticketId: text('ticket_id')
      .notNull()
      .references(() => ticket.id),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    role: text('role').notNull().default('user'), // user | admin
    content: text('content').notNull(),
    attachments: text('attachments').notNull().default('[]'), // JSON array of image URLs
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_ticket_message_ticket').on(t.ticketId)]
);

export type Ticket = typeof ticket.$inferSelect;
export type NewTicket = typeof ticket.$inferInsert;
export type TicketMessage = typeof ticketMessage.$inferSelect;
export type NewTicketMessage = typeof ticketMessage.$inferInsert;

// ─── Custom tables ───────────────────────────────────────────────────────────
// Add your own tables below this line.

// ─── Code Models & Sessions ──────────────────────────────────────────────────

export const codeModel = table(
  'code_model',
  {
    id: text('id').primaryKey(),
    agent: text('agent').notNull().default('claude'),
    provider: text('provider').notNull().default('yunwu'),
    model: text('model').notNull(),
    label: text('label').notNull(),
    baseUrl: text('base_url').notNull().default(''),
    description: text('description').notNull().default(''),
    inputTokenCostCreditsPer1m: doublePrecision(
      'input_token_cost_credits_per_1m'
    )
      .notNull()
      .default(0),
    outputTokenCostCreditsPer1m: doublePrecision(
      'output_token_cost_credits_per_1m'
    )
      .notNull()
      .default(0),
    cacheCreationInputTokenCostCreditsPer1m: doublePrecision(
      'cache_creation_input_token_cost_credits_per_1m'
    )
      .notNull()
      .default(0),
    cachedInputTokenCostCreditsPer1m: doublePrecision(
      'cached_input_token_cost_credits_per_1m'
    )
      .notNull()
      .default(0),
    billingMultiplier: integer('billing_multiplier').notNull().default(200),
    enabled: boolean('enabled').default(true).notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    sort: integer('sort').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('idx_code_model_agent_enabled').on(t.agent, t.enabled),
    index('idx_code_model_agent_default').on(t.agent, t.isDefault),
    index('idx_code_model_agent_sort').on(t.agent, t.sort),
  ]
);

export const codeSession = table(
  'code_session',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    runtimeUserId: text('runtime_user_id').notNull(),
    agent: text('agent').notNull().default('claude'),
    model: text('model').notNull().default(''),
    status: text('status').notNull().default('active'),
    title: text('title').notNull().default(''),
    archiveKey: text('archive_key'),
    archiveDigest: text('archive_digest'),
    archiveLockToken: text('archive_lock_token').notNull().default(''),
    archiveLockExpiresAt: timestamp('archive_lock_expires_at'),
    suspensionReason: text('suspension_reason').notNull().default(''),
    lastBilledAt: timestamp('last_billed_at'),
    billedCredits: integer('billed_credits').default(0).notNull(),
    lastActiveAt: timestamp('last_active_at').defaultNow().notNull(),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('idx_code_session_user_status').on(t.userId, t.status),
    index('idx_code_session_user_last_active').on(t.userId, t.lastActiveAt),
    index('idx_code_session_archive_lock').on(t.archiveLockExpiresAt),
  ]
);

export const codeSessionEvent = table(
  'code_session_event',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    runtimeUserId: text('runtime_user_id').notNull().default(''),
    agent: text('agent').notNull().default('claude'),
    model: text('model').notNull().default(''),
    eventType: text('event_type').notNull(),
    severity: text('severity').notNull().default('info'),
    source: text('source').notNull().default('app'),
    message: text('message').notNull().default(''),
    metadata: text('metadata').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_code_session_event_user_created').on(t.userId, t.createdAt),
    index('idx_code_session_event_session_created').on(
      t.sessionId,
      t.createdAt
    ),
    index('idx_code_session_event_type').on(t.eventType),
    index('idx_code_session_event_severity_created').on(
      t.severity,
      t.createdAt
    ),
  ]
);

export const codeBillingEvent = table(
  'code_billing_event',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    agent: text('agent').notNull().default('claude'),
    model: text('model').notNull().default(''),
    eventType: text('event_type').notNull(),
    idempotencyKey: text('idempotency_key'),
    provider: text('provider').notNull().default(''),
    endpoint: text('endpoint').notNull().default(''),
    upstreamStatus: integer('upstream_status').default(0).notNull(),
    requestId: text('request_id').notNull().default(''),
    costSource: text('cost_source').notNull().default('token_rates'),
    providerRequestId: text('provider_request_id').notNull().default(''),
    providerQuota: integer('provider_quota').notNull().default(0),
    providerQuotaPerCny: integer('provider_quota_per_cny')
      .notNull()
      .default(1000000),
    providerGroup: text('provider_group').notNull().default(''),
    providerGroupRatio: doublePrecision('provider_group_ratio')
      .notNull()
      .default(0),
    runtimeState: text('runtime_state').notNull().default(''),
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    cacheCreationInputTokens: integer('cache_creation_input_tokens')
      .default(0)
      .notNull(),
    cachedInputTokens: integer('cached_input_tokens').default(0).notNull(),
    durationSeconds: integer('duration_seconds').default(0).notNull(),
    rawCostCredits: integer('raw_cost_credits').default(0).notNull(),
    chargedCredits: integer('charged_credits').default(0).notNull(),
    billingMultiplier: integer('billing_multiplier').default(200).notNull(),
    creditId: text('credit_id'),
    status: text('status').notNull().default('charged'),
    collectible: integer('collectible').notNull().default(0),
    settlementAttempts: integer('settlement_attempts').notNull().default(0),
    lastSettlementAt: timestamp('last_settlement_at'),
    settledAt: timestamp('settled_at'),
    settlementError: text('settlement_error').notNull().default(''),
    description: text('description').notNull().default(''),
    metadata: text('metadata').notNull().default(''),
    rawUsage: text('raw_usage').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('idx_code_billing_event_user_created').on(t.userId, t.createdAt),
    index('idx_code_billing_event_session').on(t.sessionId),
    index('idx_code_billing_event_type').on(t.eventType),
    index('idx_code_billing_event_collectible_status').on(
      t.collectible,
      t.status,
      t.createdAt
    ),
    uniqueIndex('idx_code_billing_event_idempotency').on(t.idempotencyKey),
  ]
);

export const storageUsage = table(
  'code_storage_usage',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    usedBytes: bigint('used_bytes', { mode: 'number' }).default(0).notNull(),
    reservedBytes: bigint('reserved_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    pendingDeleteBytes: bigint('pending_delete_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    quotaOverrideBytes: bigint('quota_override_bytes', { mode: 'number' }),
    reconciledAt: timestamp('reconciled_at'),
    reconcileLockToken: text('reconcile_lock_token').notNull().default(''),
    reconcileLockExpiresAt: timestamp('reconcile_lock_expires_at'),
    version: integer('version').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    index('idx_code_storage_usage_used').on(t.usedBytes),
    index('idx_code_storage_usage_updated').on(t.updatedAt),
    index('idx_code_storage_usage_reconcile').on(t.reconciledAt),
  ]
);

export const storagePlatformUsage = table('code_storage_platform_usage', {
  id: text('id').primaryKey(),
  usedBytes: bigint('used_bytes', { mode: 'number' }).default(0).notNull(),
  reservedBytes: bigint('reserved_bytes', { mode: 'number' })
    .default(0)
    .notNull(),
  pendingDeleteBytes: bigint('pending_delete_bytes', { mode: 'number' })
    .default(0)
    .notNull(),
  observedBytes: bigint('observed_bytes', { mode: 'number' })
    .default(0)
    .notNull(),
  observedObjects: integer('observed_objects').default(0).notNull(),
  observedAt: timestamp('observed_at'),
  version: integer('version').default(0).notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

export const storageReservation = table(
  'code_storage_reservation',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedBytes: bigint('requested_bytes', { mode: 'number' }).notNull(),
    replaceableBytes: bigint('replaceable_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    reservedBytes: bigint('reserved_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    actualBytes: bigint('actual_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    replaceObjectId: text('replace_object_id'),
    objectKey: text('object_key'),
    status: text('status').default('reserved').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    settledAt: timestamp('settled_at'),
    releasedAt: timestamp('released_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex('idx_code_storage_reservation_idempotency').on(
      t.idempotencyKey
    ),
    index('idx_code_storage_reservation_user_status').on(t.userId, t.status),
    index('idx_code_storage_reservation_expires').on(t.status, t.expiresAt),
  ]
);

export const storageObject = table(
  'code_storage_object',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    key: text('key').notNull(),
    kind: text('kind').default('current').notNull(),
    status: text('status').default('pending').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).default(0).notNull(),
    digest: text('digest'),
    reservationId: text('reservation_id').references(
      () => storageReservation.id,
      { onDelete: 'set null' }
    ),
    expiresAt: timestamp('expires_at'),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex('idx_code_storage_object_key').on(t.key),
    uniqueIndex('idx_code_storage_object_reservation').on(t.reservationId),
    index('idx_code_storage_object_user_status').on(t.userId, t.status),
    index('idx_code_storage_object_session_status').on(t.sessionId, t.status),
    index('idx_code_storage_object_expiry').on(t.status, t.expiresAt),
  ]
);

export const storageDailyMetric = table(
  'code_storage_daily_metric',
  {
    id: text('id').primaryKey(),
    metricDate: text('metric_date').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    storedBytes: bigint('stored_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    uploadedBytes: bigint('uploaded_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    deletedBytes: bigint('deleted_bytes', { mode: 'number' })
      .default(0)
      .notNull(),
    archiveCount: integer('archive_count').default(0).notNull(),
    deleteCount: integer('delete_count').default(0).notNull(),
    classAOperations: integer('class_a_operations').default(0).notNull(),
    classBOperations: integer('class_b_operations').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [
    uniqueIndex('idx_code_storage_daily_metric_user_date').on(
      t.userId,
      t.metricDate
    ),
    index('idx_code_storage_daily_metric_date').on(t.metricDate),
  ]
);

// ─── Invite Codes ────────────────────────────────────────────────────────────

export const inviteCode = table(
  'invite_code',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    trialDays: integer('trial_days').notNull().default(15),
    note: text('note').default(''),
    createdBy: text('created_by').references(() => user.id),
    expiresAt: timestamp('expires_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('idx_invite_code_code').on(t.code)]
);

export const userInvite = table(
  'user_invite',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id),
    inviteCodeId: text('invite_code_id')
      .notNull()
      .references(() => inviteCode.id),
    activatedAt: timestamp('activated_at').defaultNow().notNull(),
    trialEndsAt: timestamp('trial_ends_at').notNull(),
  },
  (t) => [
    index('idx_user_invite_user').on(t.userId),
    index('idx_user_invite_code').on(t.inviteCodeId),
  ]
);

export type CodeSession = typeof codeSession.$inferSelect;
export type NewCodeSession = typeof codeSession.$inferInsert;
export type CodeModel = typeof codeModel.$inferSelect;
export type NewCodeModel = typeof codeModel.$inferInsert;
export type CodeBillingEvent = typeof codeBillingEvent.$inferSelect;
export type NewCodeBillingEvent = typeof codeBillingEvent.$inferInsert;
export type StorageUsage = typeof storageUsage.$inferSelect;
export type NewStorageUsage = typeof storageUsage.$inferInsert;
export type StoragePlatformUsage = typeof storagePlatformUsage.$inferSelect;
export type NewStoragePlatformUsage = typeof storagePlatformUsage.$inferInsert;
export type StorageObject = typeof storageObject.$inferSelect;
export type NewStorageObject = typeof storageObject.$inferInsert;
export type StorageReservation = typeof storageReservation.$inferSelect;
export type NewStorageReservation = typeof storageReservation.$inferInsert;
export type StorageDailyMetric = typeof storageDailyMetric.$inferSelect;
export type NewStorageDailyMetric = typeof storageDailyMetric.$inferInsert;
export type InviteCode = typeof inviteCode.$inferSelect;
export type NewInviteCode = typeof inviteCode.$inferInsert;
export type UserInvite = typeof userInvite.$inferSelect;
export type NewUserInvite = typeof userInvite.$inferInsert;
