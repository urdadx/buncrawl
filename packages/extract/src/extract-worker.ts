import { runExtractJob, type ExtractJobMessage, type ExtractJobReply } from "./job";

declare const self: Worker;

// Runs one extraction per message so CPU-heavy parsing never blocks the main thread.
self.onmessage = (event: MessageEvent<ExtractJobMessage>) => {
  const { id, job } = event.data;
  let reply: ExtractJobReply;
  try {
    reply = { id, output: runExtractJob(job) };
  } catch (error) {
    reply = { id, error: error instanceof Error ? error.message : "Extraction failed" };
  }
  self.postMessage(reply);
};
