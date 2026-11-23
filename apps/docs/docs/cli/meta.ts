import { defineMeta } from "blume";

import { icons } from "../../icons";

export default defineMeta({
  title: "Command line",
  icon: icons.terminal,
  order: 3,
  pages: ["index", "scrape", "map", "crawl", "batch"],
});
