CREATE TABLE `catalog_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`type_version` integer NOT NULL,
	`payload` text NOT NULL,
	`hash` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`changed_at` integer
);
--> statement-breakpoint
CREATE TABLE `installed_recipes` (
	`recipe_id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`payload` text,
	`installed_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recipe_inputs` (
	`recipe_id` text NOT NULL,
	`input_id` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`recipe_id`, `input_id`)
);
--> statement-breakpoint
CREATE TABLE `site_licenses` (
	`site_id` integer NOT NULL,
	`recipe_id` text NOT NULL,
	`status` text NOT NULL,
	`message` text,
	`url` text,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `recipe_id`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
