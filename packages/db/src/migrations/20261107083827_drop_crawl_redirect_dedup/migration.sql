-- Redirect targets are deduplicated in enqueueCrawlUrl/finishCrawlUrl instead; this trigger
-- inserted document-less "completed" rows that bypassed the maxPages budget.
DROP TRIGGER IF EXISTS `crawl_redirect_dedup`;
