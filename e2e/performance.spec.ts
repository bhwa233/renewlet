import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { installPerformanceProbe, measurePerformance } from "./support/performance-browser";
import { performanceEnvironmentSchema, performancePages } from "../scripts/browser-performance";

const routes = {
  dashboard: "/", subscriptions: "/subscriptions", statistics: "/statistics", calendar: "/calendar", settings: "/settings",
} as const;

async function waitForContent(page: Page, route: keyof typeof routes) {
  if (route === "dashboard") await expect(page.getByTestId("dashboard-stat-grid")).toBeVisible();
  if (route === "subscriptions") await expect(page.getByTestId("subscription-card").first()).toBeVisible();
  if (route === "statistics") {
    const charts = page.getByTestId("statistics-chart-frame");
    await expect(charts).toHaveCount(3);
    for (const chart of await charts.all()) await expect(chart.locator(".recharts-surface")).toBeVisible();
    await expect(charts.first().locator(".recharts-sector").first()).toBeVisible();
  }
  if (route === "calendar") {
    await expect(page.getByRole("button", { name: "下个月", exact: true })).toBeVisible();
    await expect(page.locator("main")).not.toHaveAttribute("aria-busy", "true");
  }
  if (route === "settings") {
    await expect(page.getByTestId("settings-section-content")).toBeVisible();
    // 夹具保存 zh-CN，而初始草稿是 auto；等待远端值提交，不能把表单外壳当成就绪。
    await expect(page.locator("#locale")).toHaveText("中文");
  }
}

async function navigate(page: Page, route: keyof typeof routes) {
  await page.locator(`header a[href="${routes[route]}"]:visible`).first().click();
}

test.beforeEach(async ({ page }, testInfo) => {
  const environment = performanceEnvironmentSchema.parse(testInfo.config.metadata["performance"]);
  await installPerformanceProbe(page, environment.fixtureDay);
});

for (const route of performancePages) {
  test(`production ${route}: cold document and warm SPA navigation`, async ({ page }, testInfo) => {
    await measurePerformance(page, testInfo, route, "cold-document",
      () => page.goto(routes[route], { waitUntil: "domcontentloaded" }),
      () => waitForContent(page, route));
    const away = route === "dashboard" ? "subscriptions" : "dashboard";
    await navigate(page, away);
    await waitForContent(page, away);
    await measurePerformance(page, testInfo, route, "warm-spa",
      () => navigate(page, route), () => waitForContent(page, route));
  });
}

test("production search commits its filtered result", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  await waitForContent(page, "subscriptions");
  const name = "Performance Subscription 1000-777";
  await measurePerformance(page, testInfo, "search", "interaction",
    () => page.getByPlaceholder("搜索订阅、标签或备注...").fill(name),
    async () => {
      await expect(page.getByTestId("subscription-card")).toHaveCount(1);
      await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    });
});

test("production 1000-row virtual list scroll", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  await waitForContent(page, "subscriptions");
  const indexResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/app/subscriptions/index");
  await page.getByPlaceholder("搜索订阅、标签或备注...").fill("Performance Subscription");
  expect((await indexResponse).ok()).toBe(true);
  await expect(page.getByTestId("virtualized-subscription-list")).toBeVisible();
  // 先证明索引已提交为千行虚拟列表，避免把 50 条分页数据的滚动误记成规模基线。
  await expect.poll(() => page.getByTestId("virtualized-subscription-list").evaluate((list) => list.getBoundingClientRect().height)).toBeGreaterThan(20_000);
  await measurePerformance(page, testInfo, "scroll", "interaction",
    () => page.locator("#root").evaluate((root) => root.scrollTo({ top: root.scrollHeight })),
    async () => {
      await expect.poll(() => page.locator("#root").evaluate((root) => root.scrollTop)).toBeGreaterThan(0);
      await expect.poll(() => page.getByTestId("virtualized-subscription-list").locator(":scope > [data-index]").last().getAttribute("data-index").then(Number)).toBeGreaterThan(300);
      await expect(page.getByTestId("subscription-card").last()).toBeVisible();
    });
});

test("production add dialog opens without changing data", async ({ page }, testInfo) => {
  await page.goto("/subscriptions");
  await waitForContent(page, "subscriptions");
  const dialog = page.getByRole("dialog", { name: "添加新订阅" });
  await measurePerformance(page, testInfo, "dialog", "interaction",
    () => page.getByRole("button", { name: "添加订阅", exact: true }).first().click(),
    () => expect(dialog.getByLabel("服务名称", { exact: true })).toBeVisible());
  // 表单要求显式关闭；计时结束后走取消清理，不用 Escape 绕过既有草稿保护。
  await dialog.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test("production calendar switches the requested month", async ({ page }, testInfo) => {
  await page.goto("/calendar");
  await waitForContent(page, "calendar");
  await measurePerformance(page, testInfo, "calendar-switch", "interaction", async () => {
    const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/app/subscriptions/calendar");
    await page.getByRole("button", { name: "下个月", exact: true }).click();
    expect((await response).ok()).toBe(true);
  }, async () => {
    await waitForContent(page, "calendar");
  });
});
