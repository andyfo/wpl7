CREATE TABLE `batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`action` text NOT NULL,
	`options` text DEFAULT '{}' NOT NULL,
	`skipped` text DEFAULT '[]' NOT NULL,
	`target_count` integer DEFAULT 0 NOT NULL,
	`total_jobs` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `batches_created_idx` ON `batches` (`created_at`);--> statement-breakpoint
CREATE TABLE `site_wp_components` (
	`site_id` integer NOT NULL,
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`version` text DEFAULT '' NOT NULL,
	`update_version` text,
	`update_state` text DEFAULT 'none' NOT NULL,
	`auto_update` integer DEFAULT 0 NOT NULL,
	`file` text,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `kind`, `slug`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `site_wp_components_kind_slug_idx` ON `site_wp_components` (`kind`,`slug`);--> statement-breakpoint
CREATE TABLE `site_wp_status` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`core_version` text,
	`core_update_version` text,
	`core_update_type` text,
	`scanned_at` integer,
	`scan_error` text,
	`partial` integer DEFAULT 0 NOT NULL,
	`updates_count` integer DEFAULT 0 NOT NULL,
	`vulnerable_count` integer DEFAULT 0 NOT NULL,
	`worst_severity` text,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `vuln_feed` (
	`kind` text NOT NULL,
	`slug` text NOT NULL,
	`fetched_at` integer,
	`attempted_at` integer NOT NULL,
	`error` text,
	`known` integer DEFAULT 0 NOT NULL,
	`closed` integer DEFAULT 0 NOT NULL,
	`closed_reason` text,
	`latest_release_at` integer,
	`advisories` text DEFAULT '[]' NOT NULL,
	PRIMARY KEY(`kind`, `slug`)
);
--> statement-breakpoint
ALTER TABLE `jobs` ADD `batch_id` integer;--> statement-breakpoint
CREATE INDEX `jobs_batch_idx` ON `jobs` (`batch_id`);