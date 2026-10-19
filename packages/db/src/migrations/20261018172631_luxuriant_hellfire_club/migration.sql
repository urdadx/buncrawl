CREATE TABLE `crawl_frontier` (
	`job_id` text NOT NULL,
	`url` text NOT NULL,
	`origin` text NOT NULL,
	`depth` integer NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`final_url` text,
	`final_origin` text,
	`byte_size` integer DEFAULT 0 NOT NULL,
	`reserved_bytes` integer DEFAULT 0 NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`lease_version` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `crawl_frontier_pk` PRIMARY KEY(`job_id`, `url`),
	CONSTRAINT `fk_crawl_frontier_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "crawl_frontier_depth_check" CHECK("depth" >= 0),
	CONSTRAINT "crawl_frontier_bytes_check" CHECK("byte_size" >= 0),
	CONSTRAINT "crawl_frontier_reserved_check" CHECK("reserved_bytes" >= 0),
	CONSTRAINT "crawl_frontier_state_check" CHECK("state" IN ('queued', 'running', 'completed', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE `crawl_hosts` (
	`job_id` text NOT NULL,
	`origin` text NOT NULL,
	`active` integer DEFAULT 0 NOT NULL,
	`max_concurrency` integer DEFAULT 1 NOT NULL,
	`min_delay_ms` integer DEFAULT 0 NOT NULL,
	`next_allowed_at` integer DEFAULT 0 NOT NULL,
	`robots_fetched_at` integer,
	`robots_body` text,
	CONSTRAINT `crawl_hosts_pk` PRIMARY KEY(`job_id`, `origin`),
	CONSTRAINT `fk_crawl_hosts_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE CASCADE,
	CONSTRAINT "crawl_hosts_active_check" CHECK("active" >= 0),
	CONSTRAINT "crawl_hosts_concurrency_check" CHECK("max_concurrency" > 0),
	CONSTRAINT "crawl_hosts_delay_check" CHECK("min_delay_ms" >= 0)
);
--> statement-breakpoint
CREATE INDEX `crawl_frontier_claim_idx` ON `crawl_frontier` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `crawl_frontier_host_idx` ON `crawl_frontier` (`job_id`,`origin`,`state`);
--> statement-breakpoint
CREATE TRIGGER `job_items_pending_limit` BEFORE INSERT ON `job_items`
WHEN NEW.state IN ('queued', 'running') AND
  (SELECT count(*) FROM job_items WHERE state IN ('queued', 'running')) >= 10000
BEGIN SELECT RAISE(ABORT, 'BATCH_QUEUE_FULL'); END;
--> statement-breakpoint
CREATE TRIGGER `crawl_frontier_started` AFTER UPDATE OF state ON `crawl_frontier`
WHEN OLD.state != 'running' AND NEW.state = 'running'
BEGIN
  UPDATE crawl_hosts SET active = active + 1,
    next_allowed_at = NEW.updated_at + min_delay_ms
  WHERE job_id = NEW.job_id AND origin = NEW.origin;
END;
--> statement-breakpoint
CREATE TRIGGER `crawl_redirect_dedup` AFTER UPDATE OF state ON `crawl_frontier`
WHEN NEW.state = 'completed' AND NEW.final_url IS NOT NULL AND NEW.final_url != NEW.url
BEGIN
  INSERT INTO crawl_frontier (job_id, url, origin, depth, state, created_at, updated_at)
  VALUES (NEW.job_id, NEW.final_url, NEW.final_origin, NEW.depth, 'completed', NEW.updated_at, NEW.updated_at)
  ON CONFLICT(job_id, url) DO UPDATE SET state = 'completed', updated_at = NEW.updated_at
    WHERE state = 'queued';
END;
--> statement-breakpoint
CREATE TRIGGER `crawl_frontier_released` AFTER UPDATE OF state ON `crawl_frontier`
WHEN OLD.state = 'running' AND NEW.state != 'running'
BEGIN
  UPDATE crawl_hosts SET active = active - 1
  WHERE job_id = OLD.job_id AND origin = OLD.origin;
END;
