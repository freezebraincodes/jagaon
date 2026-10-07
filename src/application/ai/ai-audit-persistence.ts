import type { AiInvocationAuditRow } from "@/domain/ai";
import type { JagaOnDatabase } from "@/storage/database";
import { implementedStorageRowCodecs } from "@/storage/implemented-row-codecs";
import type { AiInvocationAuditPort } from "./ai-provider-port";

/**
 * Local AI invocation audit repository over the existing Packet 10
 * `aiInvocationAudits` table (storage-backup-spec 2.7). `append` validates the
 * exact minimised row before one Dexie write and never overwrites an existing
 * request id; reads fail closed through the same closed codec. It accepts audit
 * metadata only, never an internal request or provider result.
 */

export type AiInvocationAuditRepository = AiInvocationAuditPort &
  Readonly<{
    get(requestId: string): Promise<AiInvocationAuditRow | undefined>;
    list(): Promise<AiInvocationAuditRow[]>;
  }>;

export function createAiInvocationAuditRepository(database: JagaOnDatabase): AiInvocationAuditRepository {
  const codec = implementedStorageRowCodecs.aiInvocationAudits;
  const table = () => database.table("aiInvocationAudits");
  return Object.freeze({
    async append(row: AiInvocationAuditRow): Promise<void> {
      const validated = codec.validateForWrite(row);
      await table().add(validated);
    },
    async get(requestId: string): Promise<AiInvocationAuditRow | undefined> {
      const stored = await table().get(requestId);
      return stored === undefined ? undefined : codec.validateAfterRead(stored);
    },
    async list(): Promise<AiInvocationAuditRow[]> {
      return (await table().toArray()).map((stored) => codec.validateAfterRead(stored));
    },
  });
}
