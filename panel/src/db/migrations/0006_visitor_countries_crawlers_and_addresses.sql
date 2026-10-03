CREATE TABLE `site_traffic_crawlers` (
	`site_id` integer NOT NULL,
	`day` integer NOT NULL,
	`crawler` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `crawler`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_traffic_ips` (
	`site_id` integer NOT NULL,
	`day` integer NOT NULL,
	`ip` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	`page_views` integer DEFAULT 0 NOT NULL,
	`bot_requests` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`country` text,
	`last_seen_at` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`site_id`, `day`, `ip`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `site_visitors` ADD `country` text;