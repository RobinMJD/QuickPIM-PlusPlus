import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";
import {
  buildWorkflowRunsUrl,
  classifyCiRun,
  requireSuccessfulMainCi,
  selectLatestCiRun
} from "../scripts/require-successful-main-ci.mjs";

describe("release exact-commit CI gate", () => {
  test("tags and default manual runs cannot publish either Store", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toMatch(/publish_target:[\s\S]*?default: github/);
    expect(workflow).toMatch(/publish_stores:[\s\S]*?default: false/);
    for (const [job, target] of [["chrome-web-store", "chrome"], ["microsoft-edge-add-ons", "edge"]]) {
      const condition = workflow.split(`  ${job}:`)[1].match(/\n    if: \$\{\{ (.+) \}\}/)[1]
        .replace(/needs\.([a-z-]+)/g, (_, key) => `needs["${key}"]`);
      const allowed = (event, publishStores, publicationTarget = "all", verify = "success", githubResult = "success", manualTag = "") => runInNewContext(condition, {
        always: () => true, github: { event_name: event }, inputs: { tag: "v9.8.7", publish_stores: publishStores, publish_target: publicationTarget },
        needs: { "verify-package": { result: verify }, "github-release": { result: githubResult } },
        vars: { EDGE_ADDONS_MANUAL_SUBMISSION_TAG: manualTag }
      });
      expect(allowed("push", true, "all")).toBe(false);
      expect(allowed("workflow_dispatch", undefined)).toBe(false);
      expect(allowed("workflow_dispatch", false)).toBe(false);
      expect(allowed("workflow_dispatch", true, "github")).toBe(false);
      expect(allowed("workflow_dispatch", true, target)).toBe(true);
      expect(allowed("workflow_dispatch", true, target, "failure")).toBe(false);
      expect(allowed("workflow_dispatch", true, target, "success", "failure")).toBe(false);
      expect(allowed("workflow_dispatch", true, target, "success", "skipped")).toBe(true);
      if (target === "edge") expect(allowed("workflow_dispatch", true, target, "success", "success", "v9.8.7")).toBe(false);
    }
  });
  test("selects the latest push attempt for the tagged commit", () => {
    const run = selectLatestCiRun([
      { id: 1, head_sha: "abc", event: "push", run_attempt: 1, status: "completed", conclusion: "failure" },
      { id: 2, head_sha: "other", event: "push", run_attempt: 4, status: "completed", conclusion: "success" },
      { id: 3, head_sha: "abc", event: "pull_request", run_attempt: 5, status: "completed", conclusion: "success" },
      { id: 4, head_sha: "abc", event: "push", run_attempt: 2, status: "completed", conclusion: "success" }
    ], "abc");

    expect(run?.id).toBe(4);
  });

  test("fails closed for every completed non-success conclusion", () => {
    expect(classifyCiRun(undefined).state).toBe("waiting");
    expect(classifyCiRun({ status: "in_progress" }).state).toBe("waiting");
    expect(classifyCiRun({ status: "completed", conclusion: "success" }).state).toBe("success");
    for (const conclusion of ["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", null]) {
      expect(classifyCiRun({ status: "completed", conclusion }).state).toBe("failure");
    }
  });

  test("targets the CI workflow and exact head SHA", () => {
    const url = new URL(buildWorkflowRunsUrl("owner/repo", "abc123"));
    expect(url.pathname).toContain("/actions/workflows/ci.yml/runs");
    expect(url.searchParams.get("head_sha")).toBe("abc123");
    expect(url.searchParams.get("event")).toBe("push");
  });

  test("waits for the exact commit and returns only after a successful push CI", async () => {
    const payloads = [
      { workflow_runs: [] },
      { workflow_runs: [{ id: 9, head_sha: "abc123", event: "push", status: "completed", conclusion: "success", html_url: "https://example.test/run/9" }] }
    ];
    let sleeps = 0;
    const run = await requireSuccessfulMainCi({
      tag: "v9.8.7",
      repository: "owner/repo",
      token: "test-token",
      attempts: 2,
      intervalMs: 0,
      resolveCommit: () => "abc123",
      sleep: async () => { sleeps += 1; },
      fetchImpl: async () => new Response(JSON.stringify(payloads.shift()), { status: 200 })
    });

    expect(run.id).toBe(9);
    expect(sleeps).toBe(1);
  });

  test("blocks publication immediately when exact-commit CI completed unsuccessfully", async () => {
    await expect(requireSuccessfulMainCi({
      tag: "v9.8.7",
      repository: "owner/repo",
      token: "test-token",
      attempts: 5,
      intervalMs: 0,
      resolveCommit: () => "abc123",
      sleep: async () => {},
      fetchImpl: async () => new Response(JSON.stringify({
        workflow_runs: [{ id: 10, head_sha: "abc123", event: "push", status: "completed", conclusion: "failure" }]
      }), { status: 200 })
    })).rejects.toThrow(/exact-commit CI failed/);
  });

  test("release workflow gates every publication job on verified exact-commit CI", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain("actions: read");
    expect(workflow).toContain("Require successful main CI for tagged commit");
    expect(workflow).toContain("scripts/require-successful-main-ci.mjs");
    expect(workflow).toContain("github-release:\n    needs: verify-package");
    expect(workflow).toContain("chrome-web-store:\n    needs: [verify-package, github-release]");
    expect(workflow).toContain("microsoft-edge-add-ons:\n    needs: [verify-package, github-release]");
  });
});
