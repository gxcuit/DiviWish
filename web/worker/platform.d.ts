import type { D1Database as CloudflareD1Database, Fetcher as CloudflareFetcher } from "@cloudflare/workers-types";

declare global {
  type D1Database = CloudflareD1Database;
  type Fetcher = CloudflareFetcher;
}
