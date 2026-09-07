import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { FullConfig, FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import {
  buildArtifactHash, performanceEnvironmentSchema, performanceSampleSchema, summarizeReport, worktreeHash,
  type PerformanceReport,
} from "../../scripts/browser-performance";

export default class PerformanceReporter implements Reporter {
  private report: PerformanceReport | undefined;
  private root = "";

  onBegin(config: FullConfig) {
    this.root = resolve(config.rootDir, "..");
    const environment = performanceEnvironmentSchema.parse(config.metadata["performance"]);
    this.report = {
      version: 1, environment, artifactHash: "",
      status: "running", samples: [], failures: [],
    };
    try {
      this.report.artifactHash = buildArtifactHash(resolve(this.root, "apps/web/dist"));
      if (worktreeHash(this.root) !== environment.worktreeHash) this.report.failures.push("Sources changed during production build");
    } catch (error) {
      this.report.failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!this.report) throw new Error("Missing performance report");
    for (const attachment of result.attachments.filter((item) => item.name === "performance-sample")) {
      try {
        const body = attachment.body ?? (attachment.path ? readFileSync(attachment.path) : undefined);
        if (!body) throw new Error("Missing performance attachment body");
        this.report.samples.push(performanceSampleSchema.parse(JSON.parse(body.toString())));
      } catch (error) {
        this.report.failures.push(`${test.title}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (result.status !== "passed") {
      this.report.failures.push(`${test.titlePath().join(" / ")}: ${result.status}`);
      this.report.failures.push(...result.errors.map((error) => error.message ?? error.value ?? "Unknown test error"));
    }
  }

  async onEnd(result: FullResult): Promise<{ status: "failed" | "passed" }> {
    if (!this.report) throw new Error("Missing performance report");
    this.report.status = result.status;
    let summaries: ReturnType<typeof summarizeReport> | undefined;
    try {
      if (worktreeHash(this.root) !== this.report.environment.worktreeHash) this.report.failures.push("Sources changed during measurement");
      summaries = summarizeReport(this.report);
    } catch (error) {
      this.report.failures.push(error instanceof Error ? error.message : String(error));
    }
    if (this.report.failures.length > 0) this.report.status = "failed";
    const directory = resolve(this.root, "test-results");
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "performance-summary.json"), JSON.stringify({ ...this.report, summaries }, null, 2));
    console.log(`Production performance: ${this.report.status}; report: test-results/performance-summary.json`);
    return { status: this.report.status === "passed" ? "passed" : "failed" };
  }
}
