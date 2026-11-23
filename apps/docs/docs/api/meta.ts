import { defineMeta } from "blume";

import { icons } from "../../icons";

export default defineMeta({
  title: "API",
  icon: icons.api,
  order: 2,
  pages: ["index", "scrape", "crawl", "map", "batch-scrape", "jobs", "webhooks", "migrate-from-firecrawl"],
});
