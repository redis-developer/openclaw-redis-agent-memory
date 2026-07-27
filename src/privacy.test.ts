import { describe, expect, test } from "vitest";

import { applyCapturePrivacy, redactSensitiveText } from "./privacy.js";

describe("capture privacy", () => {
  test("redacts common sensitive patterns without claiming DLP", () => {
    const input = [
      "email alice@example.com",
      "phone +1 (303) 555-1212",
      "ssn 123-45-6789",
      "card 4111 1111 1111 1111",
      "api_key=secret-value",
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "Bearer abc.def.ghi",
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    ].join("\n");
    const redacted = redactSensitiveText(input);
    for (const secret of [
      "alice@example.com",
      "303) 555-1212",
      "123-45-6789",
      "4111 1111 1111 1111",
      "secret-value",
      "sk-abcdefghijklmnopqrstuvwxyz123456",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "abc.def.ghi",
      "BEGIN PRIVATE KEY",
    ]) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(8);
  });

  test("excludes assistant output by secure default policy and redacts user text", () => {
    const messages = [
      { role: "user" as const, content: "reach me at alice@example.com", id: "u", timestampMs: 1 },
      { role: "assistant" as const, content: "echoed-secret", id: "a", timestampMs: 2 },
    ];
    expect(applyCapturePrivacy(messages, {
      assistantCapture: "exclude",
      sensitiveDataRedaction: true,
    })).toEqual([{
      role: "user",
      content: "reach me at [REDACTED]",
      id: "u",
      timestampMs: 1,
    }]);
  });

  test("assistant capture and redaction are explicit independent controls", () => {
    const messages = [
      { role: "assistant" as const, content: "alice@example.com", id: "a", timestampMs: 2 },
    ];
    expect(applyCapturePrivacy(messages, {
      assistantCapture: "include",
      sensitiveDataRedaction: false,
    })).toEqual(messages);
  });
});
