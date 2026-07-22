const names = process.argv.slice(2);

if (names.length === 0 || names.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
  console.error("Usage: node scripts/require-env.mjs ENV_NAME [ENV_NAME ...]");
  process.exit(2);
}

const missing = names.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Required environment variables are present: ${names.join(", ")}`);
