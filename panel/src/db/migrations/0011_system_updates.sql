CREATE TABLE `system_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`from_version` text NOT NULL,
	`to_version` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL
);
