import type { CapturedMessage } from "./provider.js";

export type AssistantCapturePolicy = "exclude" | "include";

const REDACTED = "[REDACTED]";

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Opt-in, deterministic data-minimization pass. This is deliberately
 * documented as pattern redaction, not DLP: it reduces common accidental
 * capture without claiming to identify every secret or personal datum.
 */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED)
    .replace(
      /((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd)\s*[=:]\s*["']?)[^\s,"'};]+/gi,
      `$1${REDACTED}`,
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, REDACTED)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED)
    .replace(/(?<!\w)(?:\+?\d[\d ().-]{7,}\d)(?!\w)/g, (candidate) => {
      const digits = candidate.replace(/\D/g, "");
      if (passesLuhn(candidate) || (digits.length >= 10 && digits.length <= 15)) {
        return REDACTED;
      }
      return candidate;
    });
}

export function applyCapturePrivacy(
  messages: CapturedMessage[],
  options: {
    assistantCapture: AssistantCapturePolicy;
    sensitiveDataRedaction: boolean;
  },
): CapturedMessage[] {
  return messages
    .filter((message) => options.assistantCapture === "include" || message.role !== "assistant")
    .map((message) => options.sensitiveDataRedaction
      ? { ...message, content: redactSensitiveText(message.content) }
      : message);
}
