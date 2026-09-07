/// <reference types="node" />
import { defineConfig, devices } from "@playwright/test";

// 这个根层配置经常被编辑器作为独立文件打开；文件级 Node types 避免 TS Server
// 还没关联 tsconfig.playwright.json 时误报 process/node 内置类型缺失。
const env = process.env;

// Playwright 会为 reporter 设置 FORCE_COLOR；继承 NO_COLOR 会让 Node 在每个 webServer 子进程重复打印冲突告警。
delete env.NO_COLOR;
delete env.no_color;

// 本地 E2E 依赖 127.0.0.1 上的 Go server 和 Vite。继承用户代理配置时，
// localhost 请求可能被转发到外部代理，导致 healthcheck 或 API 等待随机失败。
for (const key of ["NO_PROXY", "no_proxy"]) {
  const values = new Set(
    (env[key] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  values.add("127.0.0.1");
  values.add("localhost");
  values.add("::1");
  env[key] = Array.from(values).join(",");
}

const proxyEnv = {
  NO_PROXY: env.NO_PROXY ?? "",
  no_proxy: env.no_proxy ?? "",
};

const e2eServerPort = 43190;
const e2eClientPort = 45173;
const e2eServerURL = `http://127.0.0.1:${e2eServerPort}`;
const e2eClientURL = `http://127.0.0.1:${e2eClientPort}`;
const adminStorageState = "e2e/.auth/admin.json";
const browserExecutablePath = env.RENEWLET_E2E_BROWSER_EXECUTABLE?.trim();
// 本地可能遇到 Playwright CDN/TLS 被代理拦截；只在显式传入时用系统浏览器，CI 仍使用 hermetic 浏览器。
const localBrowserFallback = browserExecutablePath ? { launchOptions: { executablePath: browserExecutablePath } } : {};

// 端口必须保持拆分：43190 只给 PocketBase/Go API，浏览器页面只从 45173 的 Vite 入口进入。
// 如果把 baseURL 指到后端端口，headed 调试会看到 PocketBase UI 而不是 Renewlet 前端。
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 90_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: e2eClientURL,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    ...localBrowserFallback,
  },
  webServer: [
    {
      // 每次清空 e2e 数据目录，让 setup project 拥有唯一的初始化状态；不复用旧 server
      // 可以避免 storage state 与 PocketBase SQLite 数据跨测试轮次串味。
      command: `rm -rf ./pb_data_e2e && go run ./cmd/renewlet serve --http=127.0.0.1:${e2eServerPort} --dir=./pb_data_e2e`,
      cwd: "./apps/docker-server",
      env: {
        ...proxyEnv,
        SETUP_ENABLED: "true",
        GOMEMLIMIT: "128MiB",
      },
      url: `${e2eServerURL}/api/app/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      // 每轮强制重建 optimizer，确保 Worker 首次加载不依赖开发机残留的暖缓存。
      command: `pnpm --dir apps/web exec vite --force --host 127.0.0.1 --port ${e2eClientPort} --strictPort`,
      env: {
        ...proxyEnv,
        VITE_DEV_PROXY_TARGET: e2eServerURL,
      },
      url: e2eClientURL,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "setup",
      testMatch: /.*\.setup\.ts/,
      testIgnore: "**/cloudflare-check/**",
      use: { ...devices["Desktop Chrome"] },
    },
    // setup 通过真实 Renewlet UI 生成登录态；业务项目只消费 storage state，
    // 这样每个 spec 独立验证旅程，又不重复穿过首次安装流程。
    {
      name: "desktop",
      dependencies: ["setup"],
      testMatch: [
        "**/calendar-feed-management.spec.ts",
        "**/subscriptions.spec.ts",
        "**/settings.spec.ts",
        "**/statistics.spec.ts",
        "**/release-smoke.spec.ts",
        "**/route-progress.spec.ts",
      ],
      use: {
        ...devices["Desktop Chrome"],
        storageState: adminStorageState,
      },
    },
    {
      name: "mobile",
      dependencies: ["setup"],
      testMatch: ["**/mobile-*.spec.ts", "**/route-progress.spec.ts"],
      use: {
        ...devices["Pixel 5"],
        storageState: adminStorageState,
      },
    },
  ],
});
