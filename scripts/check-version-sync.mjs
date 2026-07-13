import { readFileSync } from "node:fs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const pkg = readJson("package.json");
const lock = readJson("package-lock.json");
const manifest = readJson("public/manifest.json");
const appMetadata = readFileSync("src/lib/appMetadata.ts", "utf8");
const readme = readFileSync("README.md", "utf8");
const securityReview = readFileSync("SECURITY_REVIEW.md", "utf8");
const expected = pkg.version;
const values = {
  "package-lock root": lock.version,
  "package-lock workspace": lock.packages?.[""]?.version,
  manifest: manifest.version,
  "runtime metadata": appMetadata.match(/APP_VERSION\s*=\s*"([^"]+)"/)?.[1],
  "README current version": readme.match(/Current version:\s*\*\*v([^*]+)\*\*/)?.[1],
  "security review": securityReview.match(/Reviewed for v([^\.\s]+(?:\.[^\.\s]+){2})\./)?.[1]
};

const mismatches = Object.entries(values).filter(([, value]) => value !== expected);
if (mismatches.length) {
  throw new Error(`Version mismatch; package=${expected}; ${mismatches.map(([name, value]) => `${name}=${value || "missing"}`).join(", ")}`);
}

const tag = process.env.GITHUB_REF_NAME;
if (tag?.startsWith("v") && tag.slice(1) !== expected) {
  throw new Error(`Tag/version mismatch: tag=${tag.slice(1)}, package=${expected}`);
}

console.log(`QuickPIM++ version ${expected} is synchronized.`);
