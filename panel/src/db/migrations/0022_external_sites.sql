CREATE TABLE `alert_states` (
	`key` text PRIMARY KEY NOT NULL,
	`site_id` integer,
	`since` integer NOT NULL,
	`notified_at` integer,
	`detail` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_connections` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer,
	`for_site_id` integer,
	`status` text NOT NULL,
	`token` text,
	`token_hash` text NOT NULL,
	`private_key` text,
	`public_key` text NOT NULL,
	`allow_http` integer DEFAULT 0 NOT NULL,
	`source_url` text,
	`home_url` text,
	`endpoint_url` text,
	`transport` text,
	`skew_s` integer DEFAULT 0 NOT NULL,
	`budget_ms` integer,
	`plugin_version` text,
	`protocol` integer,
	`report` text,
	`warnings` text,
	`commands` text,
	`act_as_user_id` integer,
	`act_as_login` text,
	`last_contact_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`fail_count` integer DEFAULT 0 NOT NULL,
	`cert_expires_at` integer,
	`last_backup_at` integer,
	`offered_version` text,
	`checked_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`enrolled_at` integer,
	`added_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`for_site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_connections_token_hash_idx` ON `site_connections` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `site_connections_site_idx` ON `site_connections` (`site_id`);--> statement-breakpoint
CREATE INDEX `site_connections_status_idx` ON `site_connections` (`status`);--> statement-breakpoint
CREATE TABLE `vuln_notices` (
	`site_id` integer NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`advisory` text NOT NULL,
	`notified_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `kind`, `slug`, `advisory`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sites` ADD `kind` text DEFAULT 'hosted' NOT NULL;