CREATE TABLE `mail_dkim_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain` text NOT NULL,
	`selector` text NOT NULL,
	`private_key_pem` text NOT NULL,
	`public_key_b64` text NOT NULL,
	`created_at` integer NOT NULL,
	`rotated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_dkim_keys_domain_unique` ON `mail_dkim_keys` (`domain`);--> statement-breakpoint
CREATE TABLE `mail_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer DEFAULT 1 NOT NULL,
	`queue_id` text NOT NULL,
	`site_slug` text,
	`client_host` text,
	`from_addr` text DEFAULT '' NOT NULL,
	`to_addr` text DEFAULT '' NOT NULL,
	`size_bytes` integer,
	`nrcpt` integer,
	`status` text NOT NULL,
	`dsn` text,
	`relay` text,
	`delay_ms` integer,
	`detail` text,
	`dkim_signed` integer,
	`dkim_domain` text,
	`first_seen_at` integer NOT NULL,
	`last_event_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mail_messages_queue_rcpt_idx` ON `mail_messages` (`server_id`,`queue_id`,`to_addr`);--> statement-breakpoint
CREATE INDEX `mail_messages_last_event_idx` ON `mail_messages` (`last_event_at`);--> statement-breakpoint
CREATE INDEX `mail_messages_site_idx` ON `mail_messages` (`site_slug`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `mail_messages_status_idx` ON `mail_messages` (`status`,`last_event_at`);