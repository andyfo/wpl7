CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`is_owner` integer DEFAULT 0 NOT NULL,
	`totp` text,
	`totp_enrollment` text,
	`email` text,
	`pending_email` text,
	`password_reset` text,
	`session_generation` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` integer;--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);