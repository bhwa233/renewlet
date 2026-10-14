#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

function git(cwd, args, allowFailure = false) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function requireCleanCheckout(cwd) {
  if (git(cwd, ["status", "--porcelain"]).stdout.trim()) {
    throw new Error("Sync requires a clean checkout; no local files were changed.");
  }
}

export function prepareMerge(cwd, upstreamRef) {
  requireCleanCheckout(cwd);
  const baseSha = git(cwd, ["rev-parse", "HEAD"]).stdout.trim();
  const upstreamSha = git(cwd, ["rev-parse", "--verify", `${upstreamRef}^{commit}`]).stdout.trim();
  const ancestry = git(cwd, ["merge-base", "--is-ancestor", upstreamSha, baseSha], true);
  if (ancestry.status === 0) return { changed: false, baseSha, candidateSha: baseSha };
  if (ancestry.status !== 1) throw new Error(`Cannot inspect upstream ancestry: ${ancestry.stderr}`);
  if (git(cwd, ["merge-base", baseSha, upstreamSha], true).status !== 0) {
    throw new Error("Upstream has no shared Git history. This workflow only supports this fork.");
  }
  const merge = git(cwd, ["merge", "--no-ff", "--no-edit", upstreamSha], true);
  if (merge.status !== 0) {
    const conflicts = git(cwd, ["diff", "--name-only", "--diff-filter=U"]).stdout.trim();
    const abort = git(cwd, ["merge", "--abort"], true);
    if (abort.status !== 0) throw new Error(`Merge failed and could not be aborted: ${abort.stderr}`);
    throw new Error(`Upstream merge stopped; main was not pushed.\n${conflicts || merge.stderr}`);
  }
  return {
    changed: true,
    baseSha,
    candidateSha: git(cwd, ["rev-parse", "HEAD"]).stdout.trim(),
  };
}

function unchanged(label, before, after) {
  if (!isDeepStrictEqual(before, after)) {
    throw new Error(`Fork configuration changed: ${label}. Review it manually before syncing.`);
  }
}

export async function verifyForkConfiguration(cwd, baseRef) {
  const { parse, printParseErrorCode } = await import("jsonc-parser");
  function parseConfig(text) {
    const errors = [];
    const value = parse(text, errors, { allowTrailingComma: true });
    if (errors.length) throw new Error(`Invalid Wrangler JSONC: ${printParseErrorCode(errors[0].error)}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Wrangler config must be a JSON object.");
    }
    return value;
  }
  const before = parseConfig(git(cwd, ["show", `${baseRef}:wrangler.jsonc`]).stdout);
  const after = parseConfig(readFileSync(resolve(cwd, "wrangler.jsonc"), "utf8"));
  for (const key of ["name", "account_id", "workers_dev", "preview_urls", "routes", "observability"]) {
    unchanged(key, before[key], after[key]);
  }
  for (const [key, identityFields] of [
    ["d1_databases", ["database_name", "database_id"]],
    ["r2_buckets", ["bucket_name"]],
  ]) {
    for (const original of before[key] ?? []) {
      const merged = after[key]?.find((item) => item.binding === original.binding);
      if (!merged) throw new Error(`Fork binding removed: ${original.binding}`);
      for (const field of identityFields) {
        unchanged(`${original.binding}.${field}`, original[field], merged[field]);
      }
    }
  }
  for (const original of before.queues?.producers ?? []) {
    const merged = after.queues?.producers?.find((item) => item.binding === original.binding);
    unchanged(`${original.binding}.queue`, original.queue, merged?.queue);
  }
  for (const original of before.queues?.consumers ?? []) {
    const merged = after.queues?.consumers?.find((item) => item.queue === original.queue);
    if (!merged) throw new Error(`Fork queue consumer removed: ${original.queue}`);
    unchanged(`${original.queue}.dead_letter_queue`, original.dead_letter_queue, merged.dead_letter_queue);
  }
  for (const [key, value] of Object.entries(before.vars ?? {})) {
    unchanged(`vars.${key}`, value, after.vars?.[key]);
  }
  unchanged(
    "docs/deployment-bhwa233.md",
    git(cwd, ["show", `${baseRef}:docs/deployment-bhwa233.md`]).stdout.replaceAll("\r\n", "\n"),
    readFileSync(resolve(cwd, "docs/deployment-bhwa233.md"), "utf8").replaceAll("\r\n", "\n"),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, ref] = process.argv.slice(2);
  if (!ref || !["prepare", "verify"].includes(command)) {
    throw new Error("Usage: node scripts/fork-sync-upstream.mjs <prepare|verify> <git-ref>");
  }
  if (command === "prepare") {
    const result = prepareMerge(process.cwd(), ref);
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `changed=${result.changed}\nbase_sha=${result.baseSha}\ncandidate_sha=${result.candidateSha}\n`);
    }
    const message = result.changed
      ? `Prepared merge ${result.candidateSha}; validation must pass before pushing.`
      : "Upstream main is already merged; no commit or deployment is needed.";
    console.log(message);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
  } else {
    await verifyForkConfiguration(process.cwd(), ref);
    console.log("Fork domain, resource identities, settings and deployment documentation are preserved.");
  }
}
