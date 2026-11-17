/**
 * Dashboard smoke test over seeded data: sign in as a seeded merchant owner and walk
 * the main pages, issue a refund, add a webhook endpoint (secret shown once) and
 * download a settlement CSV.
 */
import { expect, test } from "@playwright/test";

const EMAIL = process.env.MINTRAIL_SMOKE_MERCHANT ?? "owner@kesari-threads.example";
const PASSWORD = process.env.MINTRAIL_DEMO_PASSWORD ?? "mintrail-demo-password";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Work email").fill(EMAIL);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("mode")).toHaveText("LIVE");
});

test("overview shows seeded volume and success rate", async ({ page }) => {
  await expect(page.getByTestId("kpi-volume")).toContainText("₹");
  await expect(page.getByTestId("kpi-success")).toContainText(/\d+\.\d{2}%/);
  await expect(page.locator("svg[aria-label='Daily volume']")).toBeVisible();
  expect(await page.locator("svg[aria-label='Daily volume'] rect").count()).toBe(30);
});

test("payments: filter, open a captured payment, issue a partial refund", async ({ page }) => {
  await page.goto("/payments?status=captured&method=card");
  const rows = page.getByTestId("payments-table").locator("tbody tr");
  await expect(rows.first()).toBeVisible();
  await rows.first().locator("a").first().click();
  // Seeded card payments include USD (international) ones.
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/[₹$]/);
  const form = page.getByTestId("refund-form");
  await form.getByLabel(/Amount/).fill("1");
  page.once("dialog", (d) => d.accept());
  await form.getByRole("button", { name: "Issue refund" }).click();
  await expect(page.getByRole("status")).toContainText("Refund rfd_");
});

test("settlements list and CSV report", async ({ page }) => {
  await page.goto("/settlements");
  const first = page.getByTestId("settlements-table").locator("tbody tr").first();
  await expect(first).toContainText("stl_");
  const download = page.waitForEvent("download");
  await first.getByRole("link", { name: "CSV" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^settlement-\d{4}-\d{2}-\d{2}-stl_.+\.csv$/);
});

test("webhooks: add an endpoint and see its secret exactly once; disputes and keys render", async ({ page }) => {
  await page.goto("/webhooks");
  await page.getByLabel("URL").fill(`https://hooks.smoke-${Date.now()}.example/mintrail`);
  await page.getByRole("button", { name: "Add endpoint" }).click();
  await expect(page.getByTestId("secret-once").locator(".secret")).toHaveText(/^whsec_[A-Za-z0-9]{32}$/);
  await page.goto("/webhooks");
  await expect(page.locator(".secret")).toHaveCount(0);
  await page.goto("/disputes");
  await expect(page.getByRole("heading", { name: "Disputes" })).toBeVisible();
  await page.goto("/api-keys");
  await expect(page.getByText("mr_live_")).toBeVisible();
});
