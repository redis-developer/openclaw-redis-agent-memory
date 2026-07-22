import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";

const required = [
  "AGENT_MEMORY_ENDPOINT",
  "AGENT_MEMORY_API_KEY",
  "AGENT_MEMORY_STORE_ID",
];

function environmentWithoutRamCredentials(): NodeJS.ProcessEnv {
  const env = { ...process.env, INTERNAL_SECRET_MARKER: "must-not-appear" };
  for (const name of required) delete env[name];
  return env;
}

describe("release gate preflight", () => {
  test.each([
    ["require-env.mjs", required],
    ["run-live-release.mjs", []],
  ])("%s fails closed with missing names and no values", (script, args) => {
    const result = spawnSync(
      process.execPath,
      [`scripts/${script}`, ...args],
      { encoding: "utf8", env: environmentWithoutRamCredentials() },
    );
    const output = `${result.stdout}${result.stderr}`;
    expect(result.status).not.toBe(0);
    for (const name of required) expect(output).toContain(name);
    expect(output).not.toContain("must-not-appear");
  });
});
