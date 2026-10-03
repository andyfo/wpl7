CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_token_hash_unique` ON `api_keys` (`token_hash`);--> statement-breakpoint
CREATE TABLE `backups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer,
	`site_slug` text NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL,
	`path` text NOT NULL,
	`size_bytes` integer,
	`wp_version` text,
	`php_version` text,
	`note` text,
	`job_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `backups_site_created_idx` ON `backups` (`site_slug`,`created_at`);--> statement-breakpoint
CREATE TABLE `job_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_logs_job_idx` ON `job_logs` (`job_id`,`id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`site_id` integer,
	`site_slug` text,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`result` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_site_created_idx` ON `jobs` (`site_slug`,`created_at`);--> statement-breakpoint
CREATE TABLE `plugins` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`zip_path` text,
	`is_default` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `plugins_kind_slug_idx` ON `plugins` (`kind`,`slug`);--> statement-breakpoint
CREATE TABLE `server_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`load1` real NOT NULL,
	`load5` real NOT NULL,
	`load15` real NOT NULL,
	`mem_total` integer NOT NULL,
	`mem_used` integer NOT NULL,
	`disk_total` integer NOT NULL,
	`disk_used` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `server_stats_ts_idx` ON `server_stats` (`ts`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`sid` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `site_stats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`up` integer,
	`http_ms` integer,
	`cpu_pct` real,
	`mem_bytes` integer,
	`disk_bytes` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_stats_site_ts_idx` ON `site_stats` (`site_id`,`ts`);--> statement-breakpoint
CREATE TABLE `sites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`domains` text NOT NULL,
	`dev_hostname` text,
	`is_live` integer DEFAULT 0 NOT NULL,
	`keep_dev_alias` integer DEFAULT 1 NOT NULL,
	`php_version` text NOT NULL,
	`locale` text DEFAULT 'en_US' NOT NULL,
	`status` text NOT NULL,
	`db_name` text NOT NULL,
	`db_user` text NOT NULL,
	`db_password` text NOT NULL,
	`wp_admin_user` text,
	`wp_admin_email` text,
	`container_name` text NOT NULL,
	`disk_bytes` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sites_slug_unique` ON `sites` (`slug`);