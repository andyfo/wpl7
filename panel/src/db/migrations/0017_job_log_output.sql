ALTER TABLE `job_logs` ADD `without_output` text;--> statement-breakpoint
-- Lines logged before the column: a plugin recipe's failed step, in the formats the runner has
-- always written (services/licenses.ts), in the jobs that run recipes.
UPDATE `job_logs` SET `without_output` = substr(`message`, 1, instr(`message`, ': FAILED - ') + 10) || 'what the step printed is not shown at Read only access'
WHERE `level` = 'warn' AND `message` GLOB '*: FAILED - *'
  AND `job_id` IN (SELECT `id` FROM `jobs` WHERE `type` IN ('site.create', 'site.delete', 'site.updateDomains', 'backup.restore', 'site.move', 'wp.recipes'));--> statement-breakpoint
UPDATE `job_logs` SET `without_output` = substr(`message`, 1, instr(`message`, ' did not succeed (') + 15) || '; continuing.'
WHERE `level` = 'warn' AND `message` GLOB '* did not succeed (*); continuing.'
  AND `job_id` IN (SELECT `id` FROM `jobs` WHERE `type` IN ('site.create', 'site.delete', 'site.updateDomains', 'backup.restore', 'site.move', 'wp.recipes'));
