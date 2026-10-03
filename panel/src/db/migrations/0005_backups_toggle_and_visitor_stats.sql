CREATE TABLE `site_traffic` (
	`site_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`page_views` integer DEFAULT 0 NOT NULL,
	`bot_requests` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`duration_ms_sum` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `ts`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_traffic_paths` (
	`site_id` integer NOT NULL,
	`day` integer NOT NULL,
	`path` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `path`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_traffic_referrers` (
	`site_id` integer NOT NULL,
	`day` integer NOT NULL,
	`referrer` text NOT NULL,
	`views` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `referrer`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_visitors` (
	`site_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`visitor` text NOT NULL,
	PRIMARY KEY(`site_id`, `ts`, `visitor`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sites` ADD `backups_enabled` integer DEFAULT 1 NOT NULL;