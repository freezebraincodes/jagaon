import { createMedicineInfoHandler } from "./medicine-info-handler";

/**
 * HSA preview (owner decision 2026-10-14, "Get general information with AI"): the bounded DeepSeek medicine-information route
 * (MEDICINE_GENERAL_INFO). The provider credential is a server-only secret, read by the handler only after every request check, both
 * switches, the origin and access checks and the spend reservation. Off unless JAGAON_REMOTE_AI and JAGAON_AI_MEDICINE_INFO are both
 * exactly "on" and its own daily spend limit JAGAON_AI_MEDICINE_INFO_DAILY_SPEND_LIMIT_USD is set.
 */
export const dynamic = "force-dynamic";

const handle = createMedicineInfoHandler({ environment: process.env });

export async function POST(request: Request): Promise<Response> {
  return handle(request);
}
