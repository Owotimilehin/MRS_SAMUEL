import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Layout & accessibility sanity for the admin SPA. One spec walks every
 * key route at three viewport widths and asserts three classes of
 * regression that typecheck/unit tests can't catch:
 *
 *   1. Sidebar background covers the full visible height (would have caught
 *      the .app-side height:100vh / overflowing nav bug).
 *   2. No element with a sunrise gradient or "is-active" class renders with
 *      a transparent background (would have caught the size-toggle
 *      invisible-active-state bug, ported to admin equivalents).
 *   3. Axe-core finds no AA-level WCAG violations (catches low-contrast
 *      labels, missing aria-label on icon buttons, etc).
 *
 * Plus: a full-page screenshot per route per viewport. With
 *   --update-snapshots
 * Playwright stores baselines; subsequent runs flag pixel diffs so the
 * reviewer immediately sees layout drift.
 *
 * Prerequisites: the same stack the existing smoke spec needs
 * (Postgres + Redis + api on :3001 + admin on :3000 + seeded DB).
 */

const VIEWPORTS = [
  { name: "mobile",  width: 390,  height: 844  },
  { name: "tablet",  width: 1024, height: 768  },
  { name: "desktop", width: 1440, height: 900  },
];

/** Routes that render the OWNER shell (left nav present). */
const OWNER_ROUTES = [
  "/owner/dashboard",
  "/owner/review",
  "/owner/orders",
  "/owner/customers",
  "/owner/zones",
  "/owner/returns",
  "/owner/devices",
  "/owner/settings",
  "/owner/products",
  "/owner/branches",
  "/owner/factories",
  "/owner/inventory",
  "/owner/users",
  "/owner/audit-log",
  "/owner/closes",
  "/owner/transfers",
  "/owner/blog",
  "/factory/production-runs",
];

/** Routes that render the BRANCH shell. */
const BRANCH_ROUTES = [
  "/branch",
  "/branch/sell",
  "/branch/sales",
  "/branch/transfers",
  "/branch/stock",
  "/branch/returns",
  "/branch/close",
  "/branch/closes",
  "/branch/queue",
  "/branch/device",
];

/** Sign in once before each test. */
async function signIn(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill("owner@example.com");
  await page.locator("#password").fill("ChangeMe!Owner-1234");
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/owner|\/branch|\/factory|\/$/, { timeout: 8_000 });
}

/**
 * Assertion: the sidebar's white background must cover the full visible
 * viewport height. Failing means either the sidebar shrunk (the bug we
 * just fixed) or the rest of the layout pushed it off-screen.
 */
async function assertSidebarFillsViewport(page: Page, sel: string): Promise<void> {
  const box = await page.locator(sel).boundingBox();
  expect(box, `${sel} not found in DOM`).not.toBeNull();
  const viewportHeight = await page.evaluate(() => window.innerHeight);
  // Allow a 1px rounding tolerance.
  expect(box!.height + 1).toBeGreaterThanOrEqual(viewportHeight);

  const bg = await page
    .locator(sel)
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  // Must not be transparent — that's the visual "misfit" signature.
  expect(bg, `${sel} has transparent background`).not.toBe("rgba(0, 0, 0, 0)");
  expect(bg).not.toBe("transparent");
}

/**
 * Assertion: every element with .is-active must have a NON-transparent
 * background (catches the size-toggle class of bug — visible class but
 * invisible visual state).
 */
async function assertActiveElementsAreVisible(page: Page): Promise<void> {
  const offenders = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll(".is-active"))) {
      const bg = getComputedStyle(el).backgroundColor;
      const color = getComputedStyle(el).color;
      const transparent = bg === "rgba(0, 0, 0, 0)" || bg === "transparent";
      if (transparent) {
        out.push(
          `is-active element with transparent background: ${el.className} (text color ${color})`,
        );
      }
    }
    return out;
  });
  expect(offenders).toEqual([]);
}

/** Run axe-core; allow some non-critical rules but enforce contrast + names. */
async function runAxe(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    // Color-contrast & button-name are the categories that map to the
    // misfit class of bugs we care about most.
    .disableRules([
      "landmark-one-main", // SPA shells don't all expose <main>
      "region",            // same — TanStack router boundaries
    ])
    .analyze();

  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) =>
          `[${v.impact}] ${v.id} — ${v.help} (${v.nodes.length} node${
            v.nodes.length === 1 ? "" : "s"
          })`,
      )
      .join("\n");
    expect(
      results.violations,
      `axe violations on ${label}:\n${summary}`,
    ).toEqual([]);
  }
}

test.describe("Layout sanity — owner shell", () => {
  for (const viewport of VIEWPORTS) {
    test(`owner shell at ${viewport.name} (${viewport.width}×${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await signIn(page);

      for (const route of OWNER_ROUTES) {
        await page.goto(route);
        // Wait for the lazy chunk to land + content to settle.
        await page.waitForLoadState("networkidle", { timeout: 10_000 });

        // 1. Sidebar invariant — collapsed nav drawer below 1024px in the
        //    future would change this; for now, the owner shell renders
        //    the side rail at every width.
        await assertSidebarFillsViewport(page, ".app-side");

        // 2. No invisible is-active elements.
        await assertActiveElementsAreVisible(page);

        // 3. Screenshot for diff. Stored under
        //    e2e/__screenshots__/layout-sanity.spec.ts-snapshots/.
        await expect(page).toHaveScreenshot(
          `owner-${viewport.name}-${route.replace(/\//g, "_")}.png`,
          { fullPage: true, maxDiffPixelRatio: 0.02 },
        );

        // 4. Axe contrast/aria pass.
        await runAxe(page, `${route} @ ${viewport.name}`);
      }
    });
  }
});

test.describe("Layout sanity — branch shell", () => {
  for (const viewport of VIEWPORTS) {
    test(`branch shell at ${viewport.name} (${viewport.width}×${viewport.height})`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await signIn(page);

      for (const route of BRANCH_ROUTES) {
        await page.goto(route);
        await page.waitForLoadState("networkidle", { timeout: 10_000 });
        await assertSidebarFillsViewport(page, ".app-side");
        await assertActiveElementsAreVisible(page);
        await expect(page).toHaveScreenshot(
          `branch-${viewport.name}-${route.replace(/\//g, "_")}.png`,
          { fullPage: true, maxDiffPixelRatio: 0.02 },
        );
        await runAxe(page, `${route} @ ${viewport.name}`);
      }
    });
  }
});

test.describe("Layout sanity — login & public root", () => {
  test("login renders cleanly at all viewports", async ({ page }) => {
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.goto("/login");
      await page.waitForLoadState("networkidle");

      // Sidebar absent here — but assert the form is visible and the
      // submit button is reachable.
      const submit = page.getByRole("button", { name: /sign in/i });
      await expect(submit).toBeVisible();
      // The CTA must be visibly filled — accept either a solid colour or a
      // gradient (the button uses a green linear-gradient, so backgroundColor
      // is transparent while backgroundImage carries the fill).
      const { bgColor, bgImage } = await submit.evaluate((el) => {
        const s = getComputedStyle(el);
        return { bgColor: s.backgroundColor, bgImage: s.backgroundImage };
      });
      expect(bgColor !== "rgba(0, 0, 0, 0)" || bgImage.includes("gradient")).toBe(true);

      await expect(page).toHaveScreenshot(`login-${viewport.name}.png`, {
        fullPage: true,
        maxDiffPixelRatio: 0.02,
      });
      await runAxe(page, `login @ ${viewport.name}`);
    }
  });
});
