import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(resolve(tmpdir(), "redis-memory-package-smoke-"));
const packDirectory = resolve(temporary, "pack");
const consumerDirectory = resolve(temporary, "consumer");
mkdirSync(packDirectory);
mkdirSync(consumerDirectory);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: resolve(temporary, "npm-cache") },
    ...options,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }
  return result.stdout;
}

const packOutput = run("npm", ["pack", "--json", "--pack-destination", packDirectory]);
const packed = JSON.parse(packOutput);
if (!Array.isArray(packed) || packed.length !== 1 || !packed[0]?.filename) {
  throw new Error("npm pack did not return exactly one candidate tarball");
}
const tarball = resolve(packDirectory, packed[0].filename);
const entries = run("tar", ["-tf", tarball]).trim().split("\n");
const forbidden = entries.filter((entry) =>
  /(^|\/)(?:specs|\.git)(?:\/|$)|(^|\/)\.env(?:\.|$)|REVIEW-/i.test(entry),
);
if (forbidden.length > 0) {
  throw new Error(`candidate tarball contains forbidden internal paths: ${forbidden.join(", ")}`);
}

writeFileSync(resolve(consumerDirectory, "package.json"), JSON.stringify({
  name: "redis-memory-package-consumer-smoke",
  private: true,
  type: "module",
  dependencies: {
    "openclaw-redis-agent-memory": `file:${tarball}`,
  },
}, null, 2));
run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock"], {
  cwd: consumerDirectory,
});

writeFileSync(resolve(consumerDirectory, "smoke.mjs"), `
import plugin, { memoryConfigSchema, parseMemoryConfig } from "openclaw-redis-agent-memory";
import { parseMemoryConfig as parseConfigExport } from "openclaw-redis-agent-memory/config";

if (typeof plugin?.register !== "function") throw new Error("default plugin export is missing");
if (typeof memoryConfigSchema?.parse !== "function") throw new Error("config schema export is missing");
if (parseMemoryConfig !== parseConfigExport) throw new Error("config subpath export does not match");
const parsed = parseMemoryConfig({ provider: "self-hosted", serverUrl: "http://127.0.0.1:8000" });
if (parsed.provider !== "self-hosted") throw new Error("config parser returned the wrong provider");
const tools = [];
const services = [];
const hooks = {};
await plugin.register({
  id: "package-smoke",
  name: "Package Smoke",
  source: "package-smoke",
  config: {},
  pluginConfig: {
    provider: "self-hosted",
    serverUrl: "http://127.0.0.1:8000",
    autoCapture: false,
    autoRecall: false,
  },
  runtime: {},
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  registerTool(tool, options) { tools.push({ tool, options }); },
  registerService(service) { services.push(service); },
  on(name, handler) { (hooks[name] ??= []).push(handler); },
  resolvePath(value) { return value; },
});
if (tools.length !== 4 || services.length !== 1) throw new Error("packed plugin registration is incomplete");
`);
run(process.execPath, ["smoke.mjs"], { cwd: consumerDirectory });

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
console.log(
  `Package consumer smoke passed for ${packageJson.name}@${packageJson.version} ` +
  `(${entries.length} tar entries, Node ${process.versions.node}).`,
);
