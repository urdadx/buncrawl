import { appRouter } from "@buncrawl/api/routers/index";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";

import { createContext } from "../context";
import { endpoint } from "../http";

export const trpcRoutes = {
  "/trpc/*": endpoint((request) =>
    fetchRequestHandler({
      endpoint: "/trpc",
      req: request,
      router: appRouter,
      createContext,
    }),
  ),
};
