CREATE TABLE `servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`ssh_host` text,
	`ssh_port` integer DEFAULT 22 NOT NULL,
	`ssh_user` text DEFAULT 'ceo-panel' NOT NULL,
	`host_key_sha256` text,
	`public_ip` text DEFAULT '' NOT NULL,
	`dev_domain` text DEFAULT '' NOT NULL,
	`dns_provider` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ok' NOT NULL,
	`last_seen_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_name_unique` ON `servers` (`name`);--> statement-breakpoint
ALTER TABLE `backups` ADD `server_id` integer DEFAULT 1 NOT NULL REFERENCES servers(id);--> statement-breakpoint
ALTER TABLE `jobs` ADD `server_id` integer;--> statement-breakpoint
ALTER TABLE `jobs` ADD `aux_server_id` integer;--> statement-breakpoint
CREATE INDEX `jobs_status_server_idx` ON `jobs` (`status`,`server_id`);--> statement-breakpoint
ALTER TABLE `server_stats` ADD `server_id` integer DEFAULT 1 NOT NULL REFERENCES servers(id);--> statement-breakpoint
CREATE INDEX `server_stats_server_ts_idx` ON `server_stats` (`server_id`,`ts`);--> statement-breakpoint
ALTER TABLE `sites` ADD `server_id` integer DEFAULT 1 NOT NULL REFERENCES servers(id);--> statement-breakpoint
INSERT INTO `servers` (`id`, `name`, `kind`, `status`, `created_at`, `updated_at`) VALUES (1, 'local', 'local', 'ok', 0, 0);