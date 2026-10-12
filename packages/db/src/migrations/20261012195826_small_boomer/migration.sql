CREATE TABLE `job_events` (
	`job_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `job_events_pk` PRIMARY KEY(`job_id`, `sequence`),
	CONSTRAINT `fk_job_events_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "job_events_sequence_check" CHECK("sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE `job_items` (
	`id` text PRIMARY KEY,
	`job_id` text NOT NULL,
	`index` integer NOT NULL,
	`state` text NOT NULL,
	`request_json` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT `fk_job_items_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "job_items_index_check" CHECK("index" >= 0),
	CONSTRAINT "job_items_state_check" CHECK("state" IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "job_items_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "job_items_lease_version_check" CHECK("lease_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY,
	`type` text NOT NULL,
	`state` text NOT NULL,
	`request_json` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`progress_json` text NOT NULL,
	`limits_json` text NOT NULL,
	`cancellation_requested_at` integer,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_version` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "jobs_type_check" CHECK("type" IN ('batch_scrape', 'map', 'crawl')),
	CONSTRAINT "jobs_state_check" CHECK("state" IN ('queued', 'running', 'completed', 'failed', 'cancelling', 'cancelled')),
	CONSTRAINT "jobs_lease_version_check" CHECK("lease_version" >= 0),
	CONSTRAINT "jobs_attempts_check" CHECK("attempts" >= 0)
);
--> statement-breakpoint
CREATE INDEX `job_events_created_at_idx` ON `job_events` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `job_items_job_id_index_uidx` ON `job_items` (`job_id`,`index`);--> statement-breakpoint
CREATE INDEX `job_items_claim_idx` ON `job_items` (`state`,`lease_expires_at`,`created_at`);--> statement-breakpoint
CREATE INDEX `job_items_job_id_state_idx` ON `job_items` (`job_id`,`state`);--> statement-breakpoint
CREATE INDEX `jobs_state_created_at_idx` ON `jobs` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_lease_expires_at_idx` ON `jobs` (`lease_expires_at`);