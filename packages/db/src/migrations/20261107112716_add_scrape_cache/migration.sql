CREATE TABLE `webhook_deliveries` (
	`job_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`lease_until` integer DEFAULT 0 NOT NULL,
	`delivered_at` integer,
	`last_error` text,
	CONSTRAINT `webhook_deliveries_pk` PRIMARY KEY(`job_id`, `sequence`),
	CONSTRAINT `fk_webhook_deliveries_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "webhook_deliveries_state_check" CHECK("state" IN ('pending', 'delivered', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `scrape_cache` (
	`key` text PRIMARY KEY,
	`url` text NOT NULL,
	`document_json` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `scrape_cache_created_at_idx` ON `scrape_cache` (`created_at`);