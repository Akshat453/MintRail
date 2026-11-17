/** Railyard smoke tests over seeded data, signed in as the seeded staff personas. */
import { expect, type Page, test } from "@playwright/test";

const PASSWORD = process.env.MINTRAIL_DEMO_PASSWORD ?? "mintrail-demo-password";

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Staff email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("role")).toBeVisible();
}

test("Riya (ops): KYC queue, merchant lookup, disputes", async ({ page }) => {
  await signIn(page, "riya@mintrail.example");
  await expect(page.getByTestId("role")).toHaveText("OPS");
  await expect(page.getByTestId("kyc-pending")).toBeVisible();
  await page.goto("/kyc");
  await expect(page.getByTestId("kyc-queue").locator("tbody tr").first()).toBeVisible();
  await page.goto("/merchants?q=kesari");
  await page.getByTestId("merchants").getByRole("link", { name: "Kesari Threads" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Kesari Threads");
  await expect(page.getByText("Money policy")).toBeVisible();
  await page.goto("/disputes");
  await expect(page.getByRole("heading", { name: "Disputes" })).toBeVisible();
  // Ops cannot see the audit log or approve payouts
  await expect(page.getByRole("link", { name: "Audit log" })).toHaveCount(0);
});

test("Arjun (finance): settlements reconcile clean; payout approvals page", async ({ page }) => {
  await signIn(page, "arjun@mintrail.example");
  await page.goto("/settlements");
  await expect(page.getByTestId("recon")).toContainText("0 mismatches");
  await page.goto("/payouts");
  await expect(page.getByRole("heading", { name: "Payout approvals" })).toBeVisible();
});

test("Meera (security): audit log, webhook replay; anyone can open a Derailment", async ({ page }) => {
  await signIn(page, "meera@mintrail.example");
  await page.goto("/audit");
  await expect(page.getByTestId("audit").locator("tbody tr").first()).toContainText("@mintrail.example");
  await page.goto("/webhooks?status=failed");
  await expect(page.getByRole("heading", { name: "Webhook deliveries" })).toBeVisible();
  await page.goto("/derailments");
  await page.getByLabel("Title").fill(`Smoke test incident ${Date.now()}`);
  await page.getByLabel("Summary").fill("Created by the Playwright smoke test.");
  await page.getByRole("button", { name: "Open incident" }).click();
  await expect(page.getByTestId("timeline")).toContainText("Derailment opened");
  await page.getByLabel("Note").fill("Mitigated by the smoke test.");
  await page.getByLabel("Change status").selectOption("resolved");
  await page.getByRole("button", { name: "Add note" }).click();
  await expect(page.getByRole("status")).toHaveText("Note added.");
});
