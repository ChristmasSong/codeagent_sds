CREATE TABLE `code_storage_daily_metric` (
	`id` text PRIMARY KEY NOT NULL,
	`metric_date` text NOT NULL,
	`user_id` text NOT NULL,
	`stored_bytes` integer DEFAULT 0 NOT NULL,
	`uploaded_bytes` integer DEFAULT 0 NOT NULL,
	`deleted_bytes` integer DEFAULT 0 NOT NULL,
	`archive_count` integer DEFAULT 0 NOT NULL,
	`delete_count` integer DEFAULT 0 NOT NULL,
	`class_a_operations` integer DEFAULT 0 NOT NULL,
	`class_b_operations` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_code_storage_daily_metric_user_date` ON `code_storage_daily_metric` (`user_id`,`metric_date`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_daily_metric_date` ON `code_storage_daily_metric` (`metric_date`);--> statement-breakpoint
CREATE TABLE `code_storage_object` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text DEFAULT 'current' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`digest` text,
	`reservation_id` text,
	`expires_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reservation_id`) REFERENCES `code_storage_reservation`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_code_storage_object_key` ON `code_storage_object` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_code_storage_object_reservation` ON `code_storage_object` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_object_user_status` ON `code_storage_object` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_object_session_status` ON `code_storage_object` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_object_expiry` ON `code_storage_object` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `code_storage_platform_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`pending_delete_bytes` integer DEFAULT 0 NOT NULL,
	`observed_bytes` integer DEFAULT 0 NOT NULL,
	`observed_objects` integer DEFAULT 0 NOT NULL,
	`observed_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `code_storage_reservation` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`requested_bytes` integer NOT NULL,
	`replaceable_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`actual_bytes` integer DEFAULT 0 NOT NULL,
	`replace_object_id` text,
	`object_key` text,
	`status` text DEFAULT 'reserved' NOT NULL,
	`expires_at` integer NOT NULL,
	`settled_at` integer,
	`released_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_code_storage_reservation_idempotency` ON `code_storage_reservation` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_reservation_user_status` ON `code_storage_reservation` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_reservation_expires` ON `code_storage_reservation` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `code_storage_usage` (
	`user_id` text PRIMARY KEY NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`pending_delete_bytes` integer DEFAULT 0 NOT NULL,
	`quota_override_bytes` integer,
	`reconciled_at` integer,
	`reconcile_lock_token` text DEFAULT '' NOT NULL,
	`reconcile_lock_expires_at` integer,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_code_storage_usage_used` ON `code_storage_usage` (`used_bytes`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_usage_updated` ON `code_storage_usage` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_code_storage_usage_reconcile` ON `code_storage_usage` (`reconciled_at`);--> statement-breakpoint
ALTER TABLE `code_session` ADD `archive_lock_token` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `code_session` ADD `archive_lock_expires_at` integer;--> statement-breakpoint
CREATE INDEX `idx_code_session_archive_lock` ON `code_session` (`archive_lock_expires_at`);