/**
 * RETIRED legacy AI task route (Packet 11C Addendum B, Task B2a; B-boundary, D1).
 *
 * The Packet 11B route accepted a detached provider request (patient facts and values) and sent it to a provider. It is retired for product
 * use: the app never calls it, evaluation runners call the provider adapters directly, and a later activation must not re-open the legacy
 * fact-sending path. Every request is refused with one closed reason before the body is read, before any credential or configuration is
 * read and without constructing a provider. The app's only provider route is the value-blind POST /api/ai/shell.
 */

const RETIRED_BODY = JSON.stringify({ kind: "UNAVAILABLE", reason: "TASK_DISABLED" });

export function createAiTaskHandler(): (request: Request) => Promise<Response> {
  return async function handle(): Promise<Response> {
    return new Response(RETIRED_BODY, { status: 410, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  };
}
