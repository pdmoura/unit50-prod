import { test, expect } from "@playwright/test";
test.afterAll(async ({ request }) => {
  await request.post("/__test/shutdown");
  await expect
    .poll(async () => {
      try {
        await request.get("/api/health", { timeout: 500 });
        return false;
      } catch {
        return true;
      }
    })
    .toBeTruthy();
});
test("real parcel → visit → follow-up → reload → complete → do not contact", async ({
  page,
}) => {
  const mapErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /Worker failed|Error.*(GeoJSON|parcels|selected)/i.test(message.text())
    )
      mapErrors.push(message.text());
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your next opportunity, mapped." }),
  ).toBeVisible();
  await expect(page.locator(".property-card").first()).toBeVisible();
  await expect(page.locator(".cluster-label").first()).toBeAttached();
  await page.screenshot({
    path: "test-results/mvp-overview.png",
    fullPage: true,
    animations: "disabled",
  });
  const selectedAddress = await page
    .locator(".property-card")
    .first()
    .locator("strong")
    .innerText();
  await page.locator(".property-card").first().click();
  const panel = page.getByRole("complementary", { name: "Property details" });
  await expect(panel).toBeVisible();
  await expect(panel.locator("h2")).toHaveText(selectedAddress);
  const address = await panel.locator("h2").innerText();
  await page.screenshot({
    path: "test-results/mvp-property.png",
    fullPage: true,
    animations: "disabled",
  });
  await panel.getByRole("button", { name: "Log visit", exact: true }).click();
  await panel.getByLabel("Visit result").selectOption("Interested");
  await panel
    .getByLabel("Notes", { exact: true })
    .fill("Browser acceptance test — isolated database");
  await panel.getByRole("button", { name: "Save visit", exact: true }).click();
  await expect(panel.getByLabel("CONTACT STATUS")).toHaveValue("Interested");
  await panel.getByRole("button", { name: "Follow up", exact: true }).click();
  await panel.getByLabel("Follow-up date").fill("2026-12-15");
  await panel
    .getByLabel("Notes", { exact: true })
    .fill("Discuss exterior options");
  await panel
    .getByRole("button", { name: "Save follow-up", exact: true })
    .click();
  await expect(
    panel.getByText("Discuss exterior options", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByLabel("Search address or parcel").fill(address);
  await page.locator(".property-card").first().click();
  await expect(panel.getByLabel("CONTACT STATUS")).toHaveValue("Interested");
  await panel.getByRole("button", { name: /Activity/ }).click();
  await expect(
    panel.getByText("Browser acceptance test — isolated database"),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Complete follow-up" }).click();
  await expect(panel.getByText("completed", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Overview", exact: true }).click();
  await panel.getByRole("button", { name: "Follow up", exact: true }).click();
  await panel.getByLabel("Follow-up date").fill("2026-12-20");
  await panel
    .getByRole("button", { name: "Save follow-up", exact: true })
    .click();
  await expect(panel.getByText("1 pending", { exact: true })).toBeVisible();
  await panel.getByLabel("CONTACT STATUS").selectOption("Do not contact");
  await expect(
    panel.getByText("Do not contact · outreach is paused"),
  ).toBeVisible();
  await expect(panel.getByText("cancelled", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "Close property details" }).click();
  await page.getByRole("link", { name: "Data & imports" }).click();
  await expect(
    page.getByRole("heading", { name: "Weber County · Parcel Master" }),
  ).toBeVisible();
  expect(mapErrors).toEqual([]);
});
test("map filters, agenda and narrow layout remain usable", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".property-card").first()).toBeVisible();
  await page.getByLabel("Filter priority").selectOption("High");
  await expect(
    page.locator(".property-card").first().locator(".badge"),
  ).toHaveText("High");
  await page
    .getByLabel("Search address or parcel")
    .fill("NO SUCH PROPERTY 123456789");
  await expect(page.getByText("No matching homes")).toBeVisible();
  await page.getByRole("button", { name: "Clear filters" }).click();
  await expect(page.locator(".property-card").first()).toBeVisible();
  await page.screenshot({ path: "test-results/mvp-map.png", fullPage: true });
  await page.getByRole("link", { name: /Follow-ups/ }).click();
  await expect(
    page.getByRole("heading", { name: "A little follow-through goes far." }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Prospecting map" }).click();
  await expect(page.getByLabel("Search address or parcel")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/mvp-mobile.png",
    fullPage: true,
  });
});
