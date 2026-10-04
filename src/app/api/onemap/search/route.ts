import { createOneMapSearchHandler } from "./onemap-search-handler";

/**
 * Same-origin OneMap search proxy. `ONEMAP_ACCESS_TOKEN` is a server-only
 * deployment secret; without it the route answers NOT_CONFIGURED and the app
 * keeps working through postal/snapshot search and the dated fallback.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return createOneMapSearchHandler({ token: process.env.ONEMAP_ACCESS_TOKEN })(request);
}
