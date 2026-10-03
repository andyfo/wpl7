ALTER TABLE `backup_destinations` ADD `encryption` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `backup_destinations` ADD `crypt_password` text;--> statement-breakpoint
ALTER TABLE `backup_destinations` ADD `crypt_salt` text;