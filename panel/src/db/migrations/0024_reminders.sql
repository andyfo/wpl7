CREATE TABLE `domain_lookups` (
	`domain` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`data` text NOT NULL,
	`anchor` text NOT NULL,
	`subject_key` text,
	`site_id` integer,
	`server_id` integer,
	`recipient_user_id` integer,
	`recipient_selected` integer DEFAULT 0 NOT NULL,
	`snoozed_until` text,
	`pending_until` integer,
	`done_at` integer,
	`email_key` text,
	`emailed_at` integer,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_subject_key_unique` ON `reminders` (`subject_key`);