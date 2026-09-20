import type { Context as ApiContext } from "@buncrawl/api/context";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

import { db } from "./services";

export async function createContext(_options: FetchCreateContextFnOptions): Promise<ApiContext> {
  return {
    db,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
