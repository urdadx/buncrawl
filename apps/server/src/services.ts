import { createDb } from "@buncrawl/db";

import { ENV } from "./env.server";

export const db = createDb(ENV);
