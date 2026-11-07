# Job event tester

A dependency-free Bun app for testing Buncrawl's batch/map/crawl SSE events and signed webhooks.

From the `buncrawl/` directory, with the Buncrawl server running on port 3000:

```sh
bun examples/job-events-tester/server.ts
```

Open <http://localhost:4100>. Override the target with `BUNCRAWL_URL=http://localhost:3000`
or the tester's port with `TESTER_PORT=4100` if needed. Form fields, the active tab and filters
are remembered between visits.

## SSE tab

- **Start a job** or **attach to an existing job ID**, then connect.
- **Start from**: a snapshot (no cursor), a full replay (`after=0`), or after any sequence N.
- **Client**: _EventSource_ reconnects automatically with `Last-Event-ID` (the tester forwards
  it to Buncrawl); _Raw frames_ reads the body directly so you see `id:`/`event:`/`data:` lines,
  heartbeats and the server closing the stream after a job finishes.
- Every event is checked against the previous sequence: skipped numbers are flagged as **gaps**
  and repeats as **duplicates**. Click a type chip to hide or show it.

## Webhooks tab

- **Simulate a delivery** (valid, bad signature, expired timestamp) to test the verifier
  without a tunnel.
- For real deliveries, expose the tester's port through an HTTPS tunnel (for example
  `cloudflared tunnel --url http://localhost:4100`) and paste the public URL; `/webhook` is
  appended for you. **Check** confirms the URL really reaches this tester. Buncrawl
  intentionally rejects localhost/private webhook destinations.
- Choose which **events** to deliver; leaving all ticked omits the filter.
- **Respond with** 200, 500, or an 11-second hang to exercise Buncrawl's retry and backoff.
  Deliveries are grouped by `x-buncrawl-delivery`, so each retry appears as another attempt
  with its response code and the delay since the previous attempt.

If no webhook appears, check the tunnel and the Buncrawl server logs: a delivery that cannot
reach the receiver cannot appear in the tester.

## Shared job panel

Below both tabs, the job panel polls Buncrawl for progress, item results (Markdown and document
JSON) and errors while the job is running. Use **Load more results** for paginated jobs or
**Cancel job** to exercise cancellation events.

The webhook secret is generated in memory at startup (reveal or copy it in the Webhooks tab);
set `TESTER_WEBHOOK_SECRET` to a fixed value if desired. Restarting the tester clears received
deliveries. Only `/webhook` is accessible through a non-local hostname; the UI and API endpoints
are local-only.
