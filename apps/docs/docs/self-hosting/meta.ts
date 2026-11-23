import { defineMeta } from "blume";

import { icons } from "../../icons";

export default defineMeta({
  title: "Self-hosting",
  icon: icons.server,
  order: 4,
  pages: ["index", "docker", "binary", "configuration", "browsers", "storage", "security"],
});
