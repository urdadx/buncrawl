import { endpoint } from "../http";

export const healthRoutes = {
  "/": endpoint((request) =>
    request.method === "GET" ? new Response("OK") : new Response("Not Found", { status: 404 }),
  ),
};
