ALTER TABLE `mail_messages` ADD `hidden_at` integer;--> statement-breakpoint
CREATE INDEX `mail_messages_hidden_idx` ON `mail_messages` (`server_id`,`hidden_at`) WHERE hidden_at IS NOT NULL;