import { Client } from "@opensearch-project/opensearch";
import config from "../config/index.js";

// Single shared client. node-level retry/timeout only — application-level
// retry for indexing failures is handled by BullMQ (see search.service.js),
// not here.
export const opensearch = new Client({
  nodes: config.opensearch.nodes,
  auth: config.opensearch.username
    ? { username: config.opensearch.username, password: config.opensearch.password }
    : undefined,
  ssl: { rejectUnauthorized: config.opensearch.rejectUnauthorized },
  requestTimeout: config.opensearch.requestTimeoutMs,
});

export async function pingOpenSearch() {
  const res = await opensearch.ping();
  return res.statusCode === 200;
}
