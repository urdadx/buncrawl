CREATE TABLE `artifacts` (
	`key` text PRIMARY KEY,
	`backend` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`checksum` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `artifacts_expires_at_idx` ON `artifacts` (`expires_at`);