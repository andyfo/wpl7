CREATE TABLE `site_panel_files` (
	`site_id` integer NOT NULL,
	`path` text NOT NULL,
	`sha256` text NOT NULL,
	`written_at` integer NOT NULL,
	PRIMARY KEY(`site_id`, `path`, `sha256`),
	FOREIGN KEY (`site_id`) REFERENCES `sites`(`id`) ON UPDATE no action ON DELETE cascade
);
