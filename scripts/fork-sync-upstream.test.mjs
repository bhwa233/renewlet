import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { prepareMerge, verifyForkConfiguration } from "./fork-sync-upstream.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "renewlet-fork-sync-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Sync Test");
  git("config", "user.email", "sync@example.invalid");
  git("config", "core.autocrlf", "false");
  const config = {
    name: "renewlet-user", account_id: "user-account", workers_dev: false, preview_urls: false,
    routes: [{ pattern: "renewlet.example.com", custom_domain: true }],
    observability: { logs: { head_sampling_rate: 0.1 } },
    d1_databases: [{ binding: "DB", database_name: "user-db", database_id: "user-db-id" }],
    r2_buckets: [{ binding: "ASSETS_BUCKET", bucket_name: "user-assets" }],
    queues: {
      producers: [{ binding: "MEDIA_ICON_INDEX_REFRESH_QUEUE", queue: "user-queue" }],
      consumers: [{ queue: "user-queue", dead_letter_queue: "user-dlq", max_retries: 3 }],
    },
    vars: { SETUP_ENABLED: "false" },
  };
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  mkdirSync(join(cwd, "docs"));
  mkdirSync(join(cwd, ".github/workflows"), { recursive: true });
  write("wrangler.jsonc", `// instance config\n${JSON.stringify(config, null, 2)}\n`);
  write("docs/deployment-bhwa233.md", "Instance instructions\n");
  write("app.txt", "base\n");
  write(".github/workflows/upstream.yml", "name: Before\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("branch", "upstream");
  write("fork-only.txt", "keep\n");
  git("add", ".");
  git("commit", "-m", "fork customization");
  return { cwd, git, write, config, base };
}

test("already merged upstream creates no commit and keeps fork files", (t) => {
  const f = fixture(t);
  const head = f.git("rev-parse", "HEAD");
  assert.deepEqual(prepareMerge(f.cwd, "upstream"), { changed: false, baseSha: head, candidateSha: head });
  assert.equal(f.git("status", "--porcelain"), "");
  assert.equal(readFileSync(join(f.cwd, "fork-only.txt"), "utf8"), "keep\n");
});

test("merges upstream history and workflow updates while preserving instance config", async (t) => {
  const f = fixture(t);
  const configBytes = readFileSync(join(f.cwd, "wrangler.jsonc"), "utf8");
  f.git("switch", "upstream");
  f.write("app.txt", "upstream update\n");
  f.write(".github/workflows/upstream.yml", "name: Updated\n");
  f.git("add", ".");
  f.git("commit", "-m", "upstream update");
  f.git("switch", "main");
  const result = prepareMerge(f.cwd, "upstream");
  assert.equal(result.changed, true);
  assert.equal(f.git("rev-list", "--parents", "-n", "1", "HEAD").split(/\s+/).length, 3);
  assert.equal(f.git("merge-base", "--is-ancestor", "upstream", "HEAD"), "");
  assert.equal(readFileSync(join(f.cwd, "wrangler.jsonc"), "utf8"), configBytes);
  assert.equal(readFileSync(join(f.cwd, ".github/workflows/upstream.yml"), "utf8"), "name: Updated\n");
  await verifyForkConfiguration(f.cwd, result.baseSha);
});

test("conflict aborts cleanly and leaves main at its original commit", (t) => {
  const f = fixture(t);
  f.write("app.txt", "fork change\n");
  f.git("add", ".");
  f.git("commit", "-m", "fork change");
  const head = f.git("rev-parse", "HEAD");
  f.git("switch", "upstream");
  f.write("app.txt", "upstream change\n");
  f.git("add", ".");
  f.git("commit", "-m", "upstream change");
  f.git("switch", "main");
  assert.throws(() => prepareMerge(f.cwd, "upstream"), /merge stopped[\s\S]*app.txt/);
  assert.equal(f.git("rev-parse", "HEAD"), head);
  assert.equal(f.git("status", "--porcelain"), "");
});

test("dirty checkout is rejected without modifying local work", (t) => {
  const f = fixture(t);
  f.write("app.txt", "local changes\n");
  assert.throws(() => prepareMerge(f.cwd, "upstream"), /clean checkout/);
  assert.equal(readFileSync(join(f.cwd, "app.txt"), "utf8"), "local changes\n");
});

test("rejects unrelated upstream history", (t) => {
  const f = fixture(t);
  f.git("checkout", "--orphan", "unrelated");
  f.git("add", ".");
  f.git("commit", "-m", "unrelated root");
  f.git("switch", "main");
  assert.throws(() => prepareMerge(f.cwd, "unrelated"), /no shared Git history/);
});

test("configuration guard allows new runtime settings but rejects resource or domain drift", async (t) => {
  const f = fixture(t);
  const head = f.git("rev-parse", "HEAD");
  const writeConfig = (config) => f.write("wrangler.jsonc", JSON.stringify(config));
  writeConfig({ ...f.config, compatibility_date: "2026-10-14", vars: { ...f.config.vars, NEW_DEFAULT: "true" } });
  await verifyForkConfiguration(f.cwd, head);
  for (const [label, modify] of [
    ["routes", (c) => { c.routes[0].pattern = "wrong.example.com"; }],
    ["DB.database_id", (c) => { c.d1_databases[0].database_id = "template-id"; }],
    ["ASSETS_BUCKET.bucket_name", (c) => { c.r2_buckets[0].bucket_name = "wrong-bucket"; }],
    ["MEDIA_ICON_INDEX_REFRESH_QUEUE.queue", (c) => { c.queues.producers[0].queue = "wrong-queue"; }],
    ["user-queue.dead_letter_queue", (c) => { c.queues.consumers[0].dead_letter_queue = "wrong-dlq"; }],
    ["vars.SETUP_ENABLED", (c) => { c.vars.SETUP_ENABLED = "true"; }],
    ["observability", (c) => { c.observability.logs.head_sampling_rate = 1; }],
  ]) {
    const changed = structuredClone(f.config);
    modify(changed);
    writeConfig(changed);
    await assert.rejects(verifyForkConfiguration(f.cwd, head), (error) => error.message.includes(label));
  }
  writeConfig(f.config);
  f.write("docs/deployment-bhwa233.md", "removed instructions\n");
  await assert.rejects(verifyForkConfiguration(f.cwd, head), /deployment-bhwa233/);
});
