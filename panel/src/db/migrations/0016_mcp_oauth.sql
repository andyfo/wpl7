CREATE TABLE `oauth_clients` (
	`client_id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'dcr' NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_ip` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE INDEX `oauth_clients_created_idx` ON `oauth_clients` (`created_at`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`access` text NOT NULL,
	`resource` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_user_idx` ON `oauth_grants` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_client_idx` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`grant_id` integer NOT NULL,
	`kind` text NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`rotated_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_tokens_token_hash_unique` ON `oauth_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_grant_idx` ON `oauth_tokens` (`grant_id`);--> statement-breakpoint
CREATE INDEX `oauth_tokens_expires_idx` ON `oauth_tokens` (`expires_at`);--> statement-breakpoint
ALTER TABLE `api_events` ADD `via` text;--> statement-breakpoint
ALTER TABLE `api_events` ADD `connection_id` integer;--> statement-breakpoint
ALTER TABLE `api_events` ADD `tool` text;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `access` text DEFAULT 'full' NOT NULL;