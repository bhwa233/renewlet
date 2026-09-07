import type { Page, Request, Response, TestInfo } from "@playwright/test";
import type { PerformanceMetrics, PerformanceSample } from "../../scripts/browser-performance";

interface BrowserProbe {
  start(): number;
  finish(startedAt: number): Pick<PerformanceMetrics, "durationMs" | "longTaskMs" | "longTasks" | "layoutShiftScore" | "domNodes">;
}

declare global {
  interface Window { __renewletPerformance: BrowserProbe }
}

export async function installPerformanceProbe(page: Page, fixtureDay: string) {
  await page.clock.setFixedTime(new Date(`${fixtureDay}T12:00:00+08:00`));
  await page.addInitScript(() => {
    const entries: PerformanceEntry[] = [];
    const types = ["longtask", "layout-shift"];
    if (types.some((type) => !PerformanceObserver.supportedEntryTypes.includes(type))) {
      throw new Error("Performance baseline requires Chromium longtask and layout-shift observers");
    }
    const observers = types.map((type) => {
      const observer = new PerformanceObserver((list) => entries.push(...list.getEntries()));
      observer.observe({ type, buffered: true });
      return observer;
    });
    const drain = () => {
      for (const observer of observers) entries.push(...observer.takeRecords());
    };
    window.__renewletPerformance = {
      start() {
        drain();
        entries.length = 0;
        return performance.now();
      },
      finish(startedAt) {
        drain();
        const finishedAt = performance.now();
        const tasks = entries.filter((entry) => entry.entryType === "longtask" && entry.startTime + entry.duration > startedAt);
        const shifts = entries.filter((entry) => entry.entryType === "layout-shift" && entry.startTime >= startedAt);
        return {
          durationMs: finishedAt - startedAt,
          longTasks: tasks.length,
          longTaskMs: tasks.reduce((total, entry) => total + Math.max(0, Math.min(finishedAt, entry.startTime + entry.duration) - Math.max(startedAt, entry.startTime)), 0),
          layoutShiftScore: shifts.reduce((total, entry) => {
            if (!("value" in entry) || typeof entry.value !== "number" || !("hadRecentInput" in entry) || entry.hadRecentInput) return total;
            return total + entry.value;
          }, 0),
          domNodes: document.getElementsByTagName("*").length,
        };
      },
    };
    window.addEventListener("pagehide", () => {
      for (const observer of observers) observer.disconnect();
    }, { once: true });
  });
}

export async function measurePerformance(
  page: Page,
  testInfo: TestInfo,
  scenario: string,
  cache: PerformanceSample["cache"],
  action: () => Promise<unknown>,
  ready: () => Promise<unknown>,
) {
  const requests = new Map<Request, { pending: boolean; api: boolean; bytes: number }>();
  const sizes: Promise<void>[] = [];
  const errors: string[] = [];
  let abortedReads = 0;
  let metrics: PerformanceMetrics | null = null;
  const onRequest = (request: Request) => {
    requests.set(request, { pending: true, api: new URL(request.url()).pathname.startsWith("/api/app/"), bytes: 0 });
  };
  const onResponse = (response: Response) => {
    if (requests.has(response.request()) && response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.request().method()} ${new URL(response.url()).pathname}`);
  };
  const onFailed = (request: Request) => {
    const record = requests.get(request);
    if (!record) return;
    record.pending = false;
    const failure = request.failure()?.errorText ?? "unknown request failure";
    // 页面切换可以取消 GET；保留单独计数，非 GET 取消和其他网络错误仍使样本失败。
    if (request.method() === "GET" && failure === "net::ERR_ABORTED") abortedReads += 1;
    else errors.push(`${request.method()} ${new URL(request.url()).pathname}: ${failure}`);
  };
  const onFinished = (request: Request) => {
    const record = requests.get(request);
    if (!record) return;
    record.pending = false;
    sizes.push(request.sizes().then((size) => { record.bytes = size.responseBodySize; }).catch(() => {
      errors.push("Request transfer size unavailable");
    }));
  };
  const stopListening = () => {
    page.off("request", onRequest);
    page.off("response", onResponse);
    page.off("requestfailed", onFailed);
    page.off("requestfinished", onFinished);
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onFailed);
  page.on("requestfinished", onFinished);
  try {
    const startedAt = cache === "cold-document" ? 0 : await page.evaluate(() => window.__renewletPerformance.start());
    await action();
    await ready();
    // 截止条件是主内容/交互结果，不等全局进度淡出；该耗时包含自动化等待，不作为线上 LCP/INP。
    const browserMetrics = await page.evaluate((start) => window.__renewletPerformance.finish(start), startedAt);
    // 浏览器截止回传后立即冻结网络窗口；读取已完成请求的大小不能把后续刷新混入样本。
    stopListening();
    await Promise.all(sizes);
    const records = [...requests.values()];
    metrics = {
      ...browserMetrics, requests: records.length,
      apiRequests: records.filter((record) => record.api).length,
      responseBodyBytes: records.reduce((total, record) => total + record.bytes, 0),
      pendingRequests: records.filter((record) => record.pending).length,
      abortedReads,
    };
    if (errors.length > 0) throw new Error(errors.join("\n"));
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    throw error;
  } finally {
    stopListening();
    await Promise.all(sizes);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("Performance sample requires a fixed viewport");
    const sample: PerformanceSample = {
      project: testInfo.project.name, scenario, cache, iteration: testInfo.repeatEachIndex,
      browser: page.context().browser()?.version() ?? "unknown", viewport, metrics, errors,
    };
    await testInfo.attach("performance-sample", { body: JSON.stringify(sample), contentType: "application/json" });
  }
}
