ALTER TABLE `move_cleanups` ADD `handover` text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE `move_cleanups` ADD `handed_over_at` integer;