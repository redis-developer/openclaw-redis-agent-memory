import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const required = [
  "AGENT_MEMORY_ENDPOINT",
  "AGENT_MEMORY_API_KEY",
  "AGENT_MEMORY_STORE_ID",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

const nodeMajor = process.versions.node.split(".")[0];
const resultsDir = resolve("artifacts", "ram-live");
mkdirSync(resultsDir, { recursive: true });
const passes = [];

for (let pass = 1; pass <= 2; pass += 1) {
  const stem = `node${nodeMajor}-pass${pass}`;
  const junitFile = resolve(resultsDir, `${stem}-junit.xml`);
  const result = spawnSync(
    process.execPath,
    [
      "./node_modules/vitest/vitest.mjs",
      "run",
      "integration",
      "--reporter=default",
      "--reporter=junit",
      `--outputFile.junit=${junitFile}`,
      "--no-file-parallelism",
      "--maxWorkers=1",
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        RAM_RELEASE_GATE: "1",
        RAM_RELEASE_RUN: String(pass),
        RAM_RELEASE_RESULTS_DIR: resultsDir,
      },
    },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);

  const junit = readFileSync(junitFile, "utf8");
  const tests = (junit.match(/<testcase\b/g) ?? []).length;
  const skipped = (junit.match(/<skipped\b/g) ?? []).length;
  const failures = (junit.match(/<(?:failure|error)\b/g) ?? []).length;
  if (tests < 16 || skipped > 0 || failures > 0) {
    console.error(
      `Live release pass ${pass} was not complete: tests=${tests} skipped=${skipped} failures=${failures}`,
    );
    process.exit(1);
  }
  passes.push({ pass, nodeMajor: Number(nodeMajor), tests, skipped, failures });
  writeFileSync(
    resolve(resultsDir, `${stem}-summary.json`),
    JSON.stringify(passes.at(-1), null, 2) + "\n",
  );
}

writeFileSync(
  resolve(resultsDir, `node${nodeMajor}-release-summary.json`),
  JSON.stringify({ status: "passed", passes }, null, 2) + "\n",
);
console.log(`RAM live release gate passed twice on Node ${nodeMajor}.`);
