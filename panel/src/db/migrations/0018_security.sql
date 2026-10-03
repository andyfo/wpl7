CREATE TABLE `integrity_manifests` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`version` text NOT NULL,
	`locale` text,
	`status` text NOT NULL,
	`files` text,
	`hash_type` text,
	`fetched_at` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE TABLE `plugin_zip_checks` (
	`plugin_id` integer PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`zip_sha256` text,
	`scanner` text,
	`folder` text,
	`version` text,
	`files` integer,
	`manifest` text,
	`findings` text,
	`confirmed` integer DEFAULT 0 NOT NULL,
	`problem` text,
	`requested_at` integer,
	`checked_at` integer,
	`reviewed_at` integer,
	`reviewed_by` text,
	`reviewed_digest` text,
	`alerted_for` text,
	FOREIGN KEY (`plugin_id`) REFERENCES `plugins`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `security_admin_addresses` (
	`address` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `security_admin_addresses_seen_idx` ON `security_admin_addresses` (`last_seen_at`);--> statement-breakpoint
CREATE TABLE `security_blocks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`family` integer NOT NULL,
	`source` text NOT NULL,
	`rule` text,
	`reason` text NOT NULL,
	`evidence` text,
	`site_id` integer,
	`server_id` integer,
	`country` text,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer,
	`ended_at` integer,
	`end_reason` text,
	`ended_by` text,
	`strike` integer DEFAULT 1 NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`last_hit_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_blocks_active_idx` ON `security_blocks` (`address`) WHERE ended_at IS NULL;--> statement-breakpoint
CREATE INDEX `security_blocks_address_idx` ON `security_blocks` (`address`,`created_at`);--> statement-breakpoint
CREATE INDEX `security_blocks_created_idx` ON `security_blocks` (`created_at`);--> statement-breakpoint
CREATE TABLE `security_never_block` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`address` text NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `security_never_block_address_unique` ON `security_never_block` (`address`);--> statement-breakpoint
CREATE TABLE `site_blocked` (
	`site_id` integer NOT NULL,
	`day` integer NOT NULL,
	`rule` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `rule`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_blocked_recent` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`rule` text NOT NULL,
	`ip` text,
	`country` text,
	`via` text,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_blocked_recent_site_ts_idx` ON `site_blocked_recent` (`site_id`,`ts`);--> statement-breakpoint
CREATE INDEX `site_blocked_recent_ts_idx` ON `site_blocked_recent` (`ts`);--> statement-breakpoint
CREATE TABLE `site_quarantine` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`finding_id` integer,
	`path` text NOT NULL,
	`stored_name` text NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer,
	`mode` text,
	`reason` text,
	`moved_at` integer NOT NULL,
	`moved_by` text NOT NULL,
	`restored_at` integer,
	`restored_by` text,
	`deleted_at` integer,
	`deleted_by` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`finding_id`) REFERENCES `site_scan_findings`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `site_quarantine_site_idx` ON `site_quarantine` (`site_id`,`moved_at`);--> statement-breakpoint
CREATE TABLE `site_scan_findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`engine` text NOT NULL,
	`kind` text NOT NULL,
	`confidence` text NOT NULL,
	`severity` text NOT NULL,
	`path` text NOT NULL,
	`line` integer,
	`rule` text,
	`detail` text,
	`package` text,
	`package_version` text,
	`sha256` text,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`last_scan_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`status_at` integer,
	`status_by` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_scan_findings_fingerprint_idx` ON `site_scan_findings` (`site_id`,`fingerprint`);--> statement-breakpoint
CREATE INDEX `site_scan_findings_status_idx` ON `site_scan_findings` (`site_id`,`status`);--> statement-breakpoint
CREATE TABLE `site_scan_status` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`last_scan_id` integer,
	`last_started_at` integer,
	`last_finished_at` integer,
	`last_outcome` text,
	`open_findings` integer DEFAULT 0 NOT NULL,
	`open_confirmed` integer DEFAULT 0 NOT NULL,
	`quarantined` integer DEFAULT 0 NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_alert_at` integer,
	`requested_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_scans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`server_id` integer,
	`job_id` integer,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`engines` text DEFAULT '{}' NOT NULL,
	`files_scanned` integer,
	`findings_total` integer,
	`findings_new` integer,
	`no_checksums` text,
	`error` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_scans_site_started_idx` ON `site_scans` (`site_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `site_security` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`level` text,
	`overrides` text DEFAULT '{}' NOT NULL,
	`custom_rules` text DEFAULT '[]' NOT NULL,
	`scan_enabled` integer,
	`scan_on_finding` text,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
