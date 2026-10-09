// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VOICE_ACCESS_HEADER, VOICE_USERSIG_MAX_BODY_BYTES, VOICE_USERSIG_ROUTE_PATH, voiceUserSigRequestSchema, voiceUserSigResponseSchema } from "./trtc-usersig-contract";

const issued = { kind: "ISSUED", sdkAppId: 1400000001, userId: "jv_abc-DEF_123", userSig: "eJwtzEEKgjAU*-_-", roomId: "jr_room-1", expiresAt: "2026-10-09T10:05:00.000Z", maxSessionSeconds: 90 };

describe("voice UserSig route contract", () => {
  it("pins the route, the header literal and the body cap", () => {
    expect(VOICE_USERSIG_ROUTE_PATH).toBe("/api/voice/usersig");
    expect(VOICE_ACCESS_HEADER).toBe("x-jagaon-demo-passcode");
    expect(VOICE_USERSIG_MAX_BODY_BYTES).toBe(256);
  });

  it("accepts only an empty strict request", () => {
    expect(voiceUserSigRequestSchema.safeParse({}).success).toBe(true);
    for (const body of [{ userId: "patient" }, { language: "en" }, null, []]) expect(voiceUserSigRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
  });

  it("closes the response: ISSUED, REFUSED or FAILED, no secret field", () => {
    expect(voiceUserSigResponseSchema.safeParse(issued).success).toBe(true);
    expect(voiceUserSigResponseSchema.safeParse({ ...issued, secretKey: "x" }).success).toBe(false);
    expect(voiceUserSigResponseSchema.safeParse({ ...issued, userId: "x".repeat(33) }).success).toBe(false);
    expect(voiceUserSigResponseSchema.safeParse({ ...issued, userId: "patient name" }).success).toBe(false);
    expect(voiceUserSigResponseSchema.safeParse({ ...issued, roomId: "r".repeat(65) }).success).toBe(false);
    expect(voiceUserSigResponseSchema.safeParse({ ...issued, userSig: "a+b/c=" }).success).toBe(false);
    expect(voiceUserSigResponseSchema.safeParse({ ...issued, maxSessionSeconds: 901 }).success).toBe(false);
    for (const reason of ["VOICE_DISABLED", "ORIGIN_REJECTED", "ACCESS_DENIED", "RATE_LIMITED", "MINUTES_EXHAUSTED"]) expect(voiceUserSigResponseSchema.safeParse({ kind: "REFUSED", reason }).success, reason).toBe(true);
    expect(voiceUserSigResponseSchema.safeParse({ kind: "REFUSED", reason: "OTHER" }).success).toBe(false);
    expect(voiceUserSigResponseSchema.safeParse({ kind: "FAILED", reason: "PAYLOAD_INVALID" }).success).toBe(true);
    expect(voiceUserSigResponseSchema.safeParse({ kind: "FAILED", reason: "PAYLOAD_INVALID", detail: "x" }).success).toBe(false);
  });

  it("imports no SDK, signer or server module", () => {
    const source = readFileSync(join(process.cwd(), "src/voice/trtc/trtc-usersig-contract.ts"), "utf8");
    expect([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1])).toEqual(["zod"]);
  });
});
