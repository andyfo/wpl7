ALTER TABLE `sites` ADD `page_cache` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `object_cache` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sites` ADD `cache_rules` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `stack_switch_error` text;--> statement-breakpoint
ALTER TABLE `sites` ADD `stack_switch_image` text;