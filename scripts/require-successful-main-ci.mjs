import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 80;
const DEFAULT_INTERVAL_MS = 15_000;
const CI_WORKFLOW = "ci.yml";

export function selectLatestCiRun(runs, headSha) {
  return [...(Array.isArray(runs) ? runs : [])]
    .filter((run) => run?.head_sha === headSha && run?.event === "push")
    .sort((left, right) => {
      const attemptDifference = Number(right?.run_attempt || 0) - Number(left?.run_attempt || 0);
      if (attemptDifference) return attemptDifference;
      const createdDifference = Date.parse(right?.created_at || "") - Date.parse(left?.created_at || "");
      if (Number.isFinite(createdDifference) && createdDifference) return createdDifference;
      return Number(right?.id || 0) - Number(left?.id || 0);
    })[0];
}

export function classifyCiRun(run) {
  if (!run) return { state: "waiting", detail: "No CI run exists yet for this commit." };
  if (run.status !== "completed") {
    return { state: "waiting", detail: `CI is ${run.status || "pending"}.`, run };
  }
  if (run.conclusion === "success") {
    return { state: "success", detail: "CI completed successfully.", run };
  }
  return {
    state: "failure",
    detail: `CI completed with conclusion ${run.conclusion || "unknown"}.`,
    run
  };
}

export function resolveTaggedCommit(tag) {
  return execFileSync("git", ["rev-parse", `${tag}^{commit}`], { encoding: "utf8" }).trim();
}

export function buildWorkflowRunsUrl(repository, headSha) {
  const [owner, repo] = String(repository || "").split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must use the owner/repository form.");
  const query = new URLSearchParams({ head_sha: headSha, event: "push", per_page: "20" });
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${CI_WORKFLOW}/runs?${query}`;
}

export async function requireSuccessfulMainCi({
  tag,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  attempts = readPositiveInteger(process.env.CI_GATE_POLL_ATTEMPTS, DEFAULT_ATTEMPTS),
  intervalMs = readNonNegativeInteger(process.env.CI_GATE_POLL_INTERVAL_MS, DEFAULT_INTERVAL_MS),
  fetchImpl = fetch,
  sleep = delay,
  resolveCommit = resolveTaggedCommit
}) {
  if (!tag) throw new Error("A release tag is required for the CI gate.");
  if (!token) throw new Error("GH_TOKEN is required to verify the main CI result.");

  const headSha = resolveCommit(tag);
  const url = buildWorkflowRunsUrl(repository, headSha);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Unable to verify CI for ${headSha} (${response.status}): ${sanitizeApiMessage(body)}`);
    }

    const payload = body ? JSON.parse(body) : {};
    const result = classifyCiRun(selectLatestCiRun(payload.workflow_runs, headSha));
    if (result.state === "success") {
      console.log(`Exact-commit CI gate passed for ${headSha}: ${result.run.html_url || "CI run succeeded"}.`);
      return result.run;
    }
    if (result.state === "failure") {
      throw new Error(`Release blocked because exact-commit CI failed for ${headSha}: ${result.detail} ${result.run.html_url || ""}`.trim());
    }
    if (attempt === attempts) break;
    console.log(`Waiting for exact-commit CI (${attempt}/${attempts}): ${result.detail}`);
    await sleep(intervalMs);
  }

  throw new Error(`Release blocked because no successful push CI completed for ${headSha} within the polling window.`);
}

function sanitizeApiMessage(value) {
  return String(value || "").replace(/("token"\s*:\s*")[^"]+("|$)/gi, "$1[redacted]$2").slice(0, 1_000);
}

function readPositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function readNonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireSuccessfulMainCi({ tag: process.argv[2] || process.env.RELEASE_TAG }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
