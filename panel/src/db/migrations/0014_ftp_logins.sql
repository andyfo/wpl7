CREATE TABLE `ftp_servers` (
	`server_id` integer PRIMARY KEY NOT NULL,
	`host_key_ed25519` text NOT NULL,
	`host_key_rsa` text NOT NULL,
	`tls_cert_pem` text NOT NULL,
	`tls_key_pem` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_ftp` (
	`site_id` integer PRIMARY KEY NOT NULL,
	`file_server_host_key` text NOT NULL,
	`client_key` text NOT NULL,
	`changed_at` integer NOT NULL,
	`rotated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `site_ftp_users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`site_id` integer NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`folder` text DEFAULT '' NOT NULL,
	`expires_at` integer,
	`created_by` text,
	`password_set_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `site_ftp_users_username_unique` ON `site_ftp_users` (`username`);--> statement-breakpoint
CREATE INDEX `site_ftp_users_site_idx` ON `site_ftp_users` (`site_id`);