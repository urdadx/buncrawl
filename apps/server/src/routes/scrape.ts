import { endpoint } from "../http";
import { handleScrape } from "./v1/scrape";

export const scrapeRoutes = {
  "/v1/scrape": endpoint(handleScrape),
};
