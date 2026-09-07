import { mock } from "node:test";
import { expect, test } from "./support/test";
import { installPerformanceProbe, measurePerformance } from "./support/performance-browser";
import { performanceSampleSchema } from "../scripts/browser-performance";

test.beforeEach(async ({ page }) => {
  await installPerformanceProbe(page, "2026-09-07");
  await page.route("**/performance-probe", (route) => route.fulfill({ contentType: "text/html", body: "<main>Probe</main>" }));
  await page.goto("/performance-probe");
});

test.afterEach(() => mock.restoreAll());

test("measurement freezes pending requests and removes its listeners", async ({ page }, testInfo) => {
  let releaseResponse = () => {};
  const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
  await page.route("**/performance-pending", async (route) => {
    await responseGate;
    await route.fulfill({ body: "finished after measurement" });
  });
  const on = mock.method(page, "on");
  const off = mock.method(page, "off");
  // 采集器自检不是产品性能样本，使用不同附件名，不能混入十次采样的分位数。
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("probe-observation", options) };
  try {
    await measurePerformance(page, observation, "probe", "interaction", async () => {
      const requested = page.waitForRequest("**/performance-pending");
      await page.evaluate(() => { void fetch("/performance-pending"); });
      await requested;
    }, async () => {});
    for (const call of on.mock.calls.slice(0, 4)) expect(off.mock.calls.map((removed) => removed.arguments)).toContainEqual(call.arguments);
    const body = testInfo.attachments.find((attachment) => attachment.name === "probe-observation")?.body;
    expect(body).toBeDefined();
    const sample = performanceSampleSchema.parse(JSON.parse(body?.toString() ?? "null"));
    expect(sample.errors).toEqual([]);
    expect(sample.metrics).toMatchObject({ requests: 1, pendingRequests: 1, responseBodyBytes: 0 });
  } finally {
    const finished = page.waitForResponse("**/performance-pending");
    releaseResponse();
    await (await finished).finished();
  }
});

test("failed measurement retains the error and cleans up listeners", async ({ page }, testInfo) => {
  const on = mock.method(page, "on");
  const off = mock.method(page, "off");
  const observation = { ...testInfo, attach: (_name: string, options: Parameters<typeof testInfo.attach>[1]) => testInfo.attach("probe-observation", options) };
  await expect(measurePerformance(page, observation, "probe", "interaction", async () => {
    throw new Error("intentional readiness failure");
  }, async () => {})).rejects.toThrow("intentional readiness failure");
  for (const call of on.mock.calls) expect(off.mock.calls.map((removed) => removed.arguments)).toContainEqual(call.arguments);
  const body = testInfo.attachments.find((attachment) => attachment.name === "probe-observation")?.body;
  const sample = performanceSampleSchema.parse(JSON.parse(body?.toString() ?? "null"));
  expect(sample.metrics).toBeNull();
  expect(sample.errors).toContain("intentional readiness failure");
});
