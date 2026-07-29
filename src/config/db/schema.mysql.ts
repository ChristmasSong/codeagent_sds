/**
 * MySQL schema definitions.
 *
 * This is the MySQL dialect of the database schema.
 * To use: set DATABASE_PROVIDER=mysql in .env.local,
 * then copy this file's content into schema.ts.
 */

import {
  bigint,
  boolean,
  double,
  index,
  int,
  longtext,
  mysqlTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';

const table = mysqlTable;

const varchar191 = (name: string) => varchar(name, { length: 191 });

// ─── Auth ────────────────────────────────────────────────────────────────────

export const user = table(
  'user',
  {
    id: varchar191('id').primaryKey(),
    name: varchar191('name').notNull(),
    email: varchar191('email').notNull().unique(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    utmSource: varchar('utm_source', { length: 100 }).notNull().default(''),
    ip: varchar('ip', { length: 45 }).notNull().default(''),
    locale: varchar('locale', { length: 20 }).notNull().default(''),
    codeModelBillingRemainderUnits: int('code_model_billing_remainder_units')
      .notNull()
      .default(0),
    codeBillingLockToken: varchar191('code_billing_lock_token')
      .notNull()
      .default(''),
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
    id: varchar191('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: varchar191('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    userId: varchar191('user_id')
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
    id: varchar191('id').primaryKey(),
    accountId: varchar191('account_id').notNull(),
    providerId: varchar('provider_id', { length: 50 }).notNull(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: varchar('scope', { length: 255 }),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index('idx_account_user_id').on(table.userId),
    index('idx_account_provider_account').on(table.providerId, table.accountId),
  ]
);

export const verification = table(
  'verification',
  {
    id: varchar191('id').primaryKey(),
    identifier: varchar191('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [index('idx_verification_identifier').on(table.identifier)]
);

// ─── Content ─────────────────────────────────────────────────────────────────

export const config = table('config', {
  name: varchar191('name').unique().notNull(),
  value: text('value'),
});

export const taxonomy = table(
  'taxonomy',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: varchar191('parent_id'),
    slug: varchar191('slug').unique().notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),
    image: text('image'),
    icon: varchar191('icon'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [index('idx_taxonomy_type_status').on(table.type, table.status)]
);

export const post = table(
  'post',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: varchar191('parent_id'),
    slug: varchar191('slug').unique().notNull(),
    type: varchar('type', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }),
    description: text('description'),
    image: text('image'),
    content: longtext('content'),
    categories: text('categories'),
    tags: text('tags'),
    authorName: varchar191('author_name'),
    authorImage: text('author_image'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [index('idx_post_type_status').on(table.type, table.status)]
);

// ─── Business ────────────────────────────────────────────────────────────────

export const order = table(
  'order',
  {
    id: varchar191('id').primaryKey(),
    orderNo: varchar191('order_no').unique().notNull(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: varchar191('user_email'),
    status: varchar('status', { length: 50 }).notNull(),
    amount: int('amount').notNull(),
    currency: varchar('currency', { length: 10 }).notNull(),
    productId: varchar191('product_id'),
    paymentType: varchar('payment_type', { length: 50 }),
    paymentInterval: varchar('payment_interval', { length: 50 }),
    paymentProvider: varchar('payment_provider', { length: 50 }).notNull(),
    paymentSessionId: varchar191('payment_session_id'),
    checkoutInfo: text('checkout_info').notNull(),
    checkoutResult: text('checkout_result'),
    paymentResult: text('payment_result'),
    discountCode: varchar191('discount_code'),
    discountAmount: int('discount_amount'),
    discountCurrency: varchar('discount_currency', { length: 10 }),
    paymentEmail: varchar191('payment_email'),
    paymentAmount: int('payment_amount'),
    paymentCurrency: varchar('payment_currency', { length: 10 }),
    paidAt: timestamp('paid_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    description: text('description'),
    productName: varchar('product_name', { length: 255 }),
    subscriptionId: varchar191('subscription_id'),
    subscriptionResult: text('subscription_result'),
    checkoutUrl: text('checkout_url'),
    callbackUrl: text('callback_url'),
    creditsAmount: int('credits_amount'),
    creditsValidDays: int('credits_valid_days'),
    planName: varchar191('plan_name'),
    paymentProductId: varchar191('payment_product_id'),
    invoiceId: varchar191('invoice_id'),
    invoiceUrl: text('invoice_url'),
    subscriptionNo: varchar191('subscription_no'),
    transactionId: varchar191('transaction_id'),
    paymentUserName: varchar191('payment_user_name'),
    paymentUserId: varchar191('payment_user_id'),
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
    id: varchar191('id').primaryKey(),
    subscriptionNo: varchar191('subscription_no').unique().notNull(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: varchar191('user_email'),
    status: varchar('status', { length: 50 }).notNull(),
    paymentProvider: varchar('payment_provider', { length: 50 }).notNull(),
    subscriptionId: varchar191('subscription_id').notNull(),
    subscriptionResult: text('subscription_result'),
    productId: varchar191('product_id'),
    description: text('description'),
    amount: int('amount'),
    currency: varchar('currency', { length: 10 }),
    interval: varchar('interval', { length: 50 }),
    intervalCount: int('interval_count'),
    trialPeriodDays: int('trial_period_days'),
    currentPeriodStart: timestamp('current_period_start'),
    currentPeriodEnd: timestamp('current_period_end'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    planName: varchar191('plan_name'),
    billingUrl: text('billing_url'),
    productName: varchar('product_name', { length: 255 }),
    creditsAmount: int('credits_amount'),
    creditsValidDays: int('credits_valid_days'),
    paymentProductId: varchar191('payment_product_id'),
    paymentUserId: varchar191('payment_user_id'),
    canceledAt: timestamp('canceled_at'),
    canceledEndAt: timestamp('canceled_end_at'),
    canceledReason: text('canceled_reason'),
    canceledReasonType: varchar('canceled_reason_type', { length: 50 }),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: varchar191('user_email'),
    orderNo: varchar191('order_no'),
    subscriptionNo: varchar191('subscription_no'),
    transactionNo: varchar191('transaction_no').unique().notNull(),
    transactionType: varchar('transaction_type', { length: 50 }).notNull(),
    transactionScene: varchar('transaction_scene', { length: 50 }),
    credits: int('credits').notNull(),
    remainingCredits: int('remaining_credits').notNull().default(0),
    description: text('description'),
    expiresAt: timestamp('expires_at'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    keyHash: varchar191('key_hash').notNull(),
    keyPrefix: varchar191('key_prefix').notNull(),
    title: varchar191('title').notNull(),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    name: varchar191('name').notNull().unique(),
    title: varchar191('title').notNull(),
    description: text('description'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    sort: int('sort').default(0).notNull(),
  },
  (table) => [index('idx_role_status').on(table.status)]
);

export const permission = table(
  'permission',
  {
    id: varchar191('id').primaryKey(),
    code: varchar191('code').notNull().unique(),
    resource: varchar('resource', { length: 50 }).notNull(),
    action: varchar('action', { length: 50 }).notNull(),
    title: varchar191('title').notNull(),
    description: text('description'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (table) => [
    index('idx_permission_resource_action').on(table.resource, table.action),
  ]
);

export const rolePermission = table(
  'role_permission',
  {
    id: varchar191('id').primaryKey(),
    roleId: varchar191('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    permissionId: varchar191('permission_id')
      .notNull()
      .references(() => permission.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    roleId: varchar191('role_id')
      .notNull()
      .references(() => role.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mediaType: varchar('media_type', { length: 50 }).notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
    model: varchar191('model').notNull(),
    prompt: longtext('prompt').notNull(),
    options: longtext('options'),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    deletedAt: timestamp('deleted_at'),
    taskId: varchar191('task_id'),
    taskInfo: longtext('task_info'),
    taskResult: longtext('task_result'),
    costCredits: int('cost_credits').notNull().default(0),
    scene: varchar('scene', { length: 100 }).notNull().default(''),
    creditId: varchar191('credit_id'),
  },
  (table) => [
    index('idx_ai_task_user_media_type').on(table.userId, table.mediaType),
    index('idx_ai_task_media_type_status').on(table.mediaType, table.status),
  ]
);

export const chat = table(
  'chat',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    model: varchar191('model').notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
    title: varchar('title', { length: 255 }).notNull().default(''),
    parts: longtext('parts').notNull(),
    metadata: longtext('metadata'),
    content: longtext('content'),
  },
  (table) => [index('idx_chat_user_status').on(table.userId, table.status)]
);

export const chatMessage = table(
  'chat_message',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatId: varchar191('chat_id')
      .notNull()
      .references(() => chat.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 50 }).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
    role: varchar('role', { length: 50 }).notNull(),
    parts: longtext('parts').notNull(),
    metadata: longtext('metadata'),
    model: varchar191('model').notNull(),
    provider: varchar('provider', { length: 50 }).notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id),
    title: varchar('title', { length: 255 }).notNull(),
    status: varchar('status', { length: 50 }).notNull().default('open'), // open | replied | closed
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index('idx_ticket_user').on(t.userId),
    index('idx_ticket_status').on(t.status),
  ]
);

export const ticketMessage = table(
  'ticket_message',
  {
    id: varchar191('id').primaryKey(),
    ticketId: varchar191('ticket_id')
      .notNull()
      .references(() => ticket.id),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id),
    role: varchar('role', { length: 50 }).notNull().default('user'), // user | admin
    content: longtext('content').notNull(),
    attachments: longtext('attachments').notNull(), // JSON array of image URLs (default [] set by service)
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
    id: varchar191('id').primaryKey(),
    agent: varchar('agent', { length: 32 }).notNull().default('claude'),
    provider: varchar('provider', { length: 64 }).notNull().default('yunwu'),
    model: varchar('model', { length: 191 }).notNull(),
    label: varchar('label', { length: 191 }).notNull(),
    baseUrl: varchar('base_url', { length: 255 }).notNull().default(''),
    description: text('description'),
    inputTokenCostCreditsPer1m: double('input_token_cost_credits_per_1m')
      .notNull()
      .default(0),
    outputTokenCostCreditsPer1m: double('output_token_cost_credits_per_1m')
      .notNull()
      .default(0),
    cacheCreationInputTokenCostCreditsPer1m: double(
      'cache_creation_input_token_cost_credits_per_1m'
    )
      .notNull()
      .default(0),
    cachedInputTokenCostCreditsPer1m: double(
      'cached_input_token_cost_credits_per_1m'
    )
      .notNull()
      .default(0),
    billingMultiplier: int('billing_multiplier').notNull().default(200),
    enabled: boolean('enabled').default(true).notNull(),
    isDefault: boolean('is_default').default(false).notNull(),
    sort: int('sort').default(0).notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    runtimeUserId: varchar191('runtime_user_id').notNull(),
    agent: varchar('agent', { length: 32 }).notNull().default('claude'),
    model: varchar('model', { length: 191 }).notNull().default(''),
    status: varchar('status', { length: 50 }).notNull().default('active'),
    title: varchar('title', { length: 255 }).notNull().default(''),
    archiveKey: text('archive_key'),
    archiveDigest: varchar('archive_digest', { length: 128 }),
    archiveLockToken: varchar191('archive_lock_token').notNull().default(''),
    archiveLockExpiresAt: timestamp('archive_lock_expires_at'),
    suspensionReason: varchar('suspension_reason', { length: 100 })
      .notNull()
      .default(''),
    lastBilledAt: timestamp('last_billed_at'),
    billedCredits: int('billed_credits').notNull().default(0),
    lastActiveAt: timestamp('last_active_at').defaultNow().notNull(),
    endedAt: timestamp('ended_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: varchar191('session_id').notNull(),
    runtimeUserId: varchar191('runtime_user_id').notNull().default(''),
    agent: varchar('agent', { length: 32 }).notNull().default('claude'),
    model: varchar('model', { length: 191 }).notNull().default(''),
    eventType: varchar('event_type', { length: 96 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull().default('info'),
    source: varchar('source', { length: 32 }).notNull().default('app'),
    message: text('message'),
    metadata: longtext('metadata'),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: varchar191('session_id'),
    agent: varchar('agent', { length: 32 }).notNull().default('claude'),
    model: varchar('model', { length: 191 }).notNull().default(''),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }),
    provider: varchar('provider', { length: 255 }).notNull().default(''),
    endpoint: varchar('endpoint', { length: 255 }).notNull().default(''),
    upstreamStatus: int('upstream_status').notNull().default(0),
    requestId: varchar('request_id', { length: 255 }).notNull().default(''),
    costSource: varchar('cost_source', { length: 32 })
      .notNull()
      .default('token_rates'),
    providerRequestId: varchar('provider_request_id', { length: 255 })
      .notNull()
      .default(''),
    providerQuota: int('provider_quota').notNull().default(0),
    providerQuotaPerCny: int('provider_quota_per_cny')
      .notNull()
      .default(1000000),
    providerGroup: varchar('provider_group', { length: 255 })
      .notNull()
      .default(''),
    providerGroupRatio: double('provider_group_ratio').notNull().default(0),
    runtimeState: varchar('runtime_state', { length: 32 })
      .notNull()
      .default(''),
    inputTokens: int('input_tokens').notNull().default(0),
    outputTokens: int('output_tokens').notNull().default(0),
    cacheCreationInputTokens: int('cache_creation_input_tokens')
      .notNull()
      .default(0),
    cachedInputTokens: int('cached_input_tokens').notNull().default(0),
    durationSeconds: int('duration_seconds').notNull().default(0),
    rawCostCredits: int('raw_cost_credits').notNull().default(0),
    chargedCredits: int('charged_credits').notNull().default(0),
    billingMultiplier: int('billing_multiplier').notNull().default(200),
    creditId: varchar191('credit_id'),
    status: varchar('status', { length: 32 }).notNull().default('charged'),
    collectible: int('collectible').notNull().default(0),
    settlementAttempts: int('settlement_attempts').notNull().default(0),
    lastSettlementAt: timestamp('last_settlement_at'),
    settledAt: timestamp('settled_at'),
    settlementError: varchar('settlement_error', { length: 500 })
      .notNull()
      .default(''),
    description: text('description'),
    metadata: longtext('metadata'),
    rawUsage: varchar('raw_usage', { length: 2048 }).notNull().default(''),
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
    userId: varchar191('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    usedBytes: bigint('used_bytes', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    reservedBytes: bigint('reserved_bytes', {
      mode: 'number',
      unsigned: true,
    })
      .notNull()
      .default(0),
    pendingDeleteBytes: bigint('pending_delete_bytes', {
      mode: 'number',
      unsigned: true,
    })
      .notNull()
      .default(0),
    quotaOverrideBytes: bigint('quota_override_bytes', {
      mode: 'number',
      unsigned: true,
    }),
    reconciledAt: timestamp('reconciled_at'),
    reconcileLockToken: varchar191('reconcile_lock_token')
      .notNull()
      .default(''),
    reconcileLockExpiresAt: timestamp('reconcile_lock_expires_at'),
    version: int('version').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    index('idx_code_storage_usage_used').on(t.usedBytes),
    index('idx_code_storage_usage_updated').on(t.updatedAt),
    index('idx_code_storage_usage_reconcile').on(t.reconciledAt),
  ]
);

export const storagePlatformUsage = table('code_storage_platform_usage', {
  id: varchar191('id').primaryKey(),
  usedBytes: bigint('used_bytes', { mode: 'number', unsigned: true })
    .notNull()
    .default(0),
  reservedBytes: bigint('reserved_bytes', {
    mode: 'number',
    unsigned: true,
  })
    .notNull()
    .default(0),
  pendingDeleteBytes: bigint('pending_delete_bytes', {
    mode: 'number',
    unsigned: true,
  })
    .notNull()
    .default(0),
  observedBytes: bigint('observed_bytes', {
    mode: 'number',
    unsigned: true,
  })
    .notNull()
    .default(0),
  observedObjects: int('observed_objects').notNull().default(0),
  observedAt: timestamp('observed_at'),
  version: int('version').notNull().default(0),
  updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
});

export const storageReservation = table(
  'code_storage_reservation',
  {
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: varchar191('session_id').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    requestedBytes: bigint('requested_bytes', {
      mode: 'number',
      unsigned: true,
    }).notNull(),
    replaceableBytes: bigint('replaceable_bytes', {
      mode: 'number',
      unsigned: true,
    })
      .notNull()
      .default(0),
    reservedBytes: bigint('reserved_bytes', {
      mode: 'number',
      unsigned: true,
    })
      .notNull()
      .default(0),
    actualBytes: bigint('actual_bytes', {
      mode: 'number',
      unsigned: true,
    })
      .notNull()
      .default(0),
    replaceObjectId: varchar191('replace_object_id'),
    objectKey: text('object_key'),
    status: varchar('status', { length: 32 }).notNull().default('reserved'),
    expiresAt: timestamp('expires_at').notNull(),
    settledAt: timestamp('settled_at'),
    releasedAt: timestamp('released_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sessionId: varchar191('session_id').notNull(),
    key: varchar('key', { length: 512 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull().default('current'),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    sizeBytes: bigint('size_bytes', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    digest: varchar('digest', { length: 128 }),
    reservationId: varchar191('reservation_id').references(
      () => storageReservation.id,
      { onDelete: 'set null' }
    ),
    expiresAt: timestamp('expires_at'),
    deletedAt: timestamp('deleted_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
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
    id: varchar191('id').primaryKey(),
    metricDate: varchar('metric_date', { length: 10 }).notNull(),
    userId: varchar191('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    storedBytes: bigint('stored_bytes', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    uploadedBytes: bigint('uploaded_bytes', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    deletedBytes: bigint('deleted_bytes', { mode: 'number', unsigned: true })
      .notNull()
      .default(0),
    archiveCount: int('archive_count').notNull().default(0),
    deleteCount: int('delete_count').notNull().default(0),
    classAOperations: int('class_a_operations').notNull().default(0),
    classBOperations: int('class_b_operations').notNull().default(0),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow().notNull(),
  },
  (t) => [
    uniqueIndex('idx_code_storage_daily_metric_user_date').on(
      t.userId,
      t.metricDate
    ),
    index('idx_code_storage_daily_metric_date').on(t.metricDate),
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
