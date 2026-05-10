/**
 * App-level smoke tests — brand subtitle reflects the active mount; nav
 * has the right groups + dividers.
 *
 * Note: `isHubMount` is computed at module-load time from
 * `window.location.pathname`. To test both branches we re-import the
 * module after mutating jsdom's location. Vitest's `vi.resetModules()`
 * + dynamic import gives us a fresh evaluation per test.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
});

async function renderAtPath(pathname: string) {
  // jsdom's `window.location` is read-only via assignment; replace via
  // `Object.defineProperty` so the module sees the new pathname when
  // re-evaluated.
  Object.defineProperty(window, "location", {
    value: { ...window.location, pathname },
    writable: true,
  });
  vi.resetModules();
  const { App } = await import("./App.tsx");
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
}

describe("App — brand subtitle", () => {
  it("/vault* renders 'vault provisioning'", async () => {
    await renderAtPath("/vault");
    expect(screen.getByText(/vault provisioning/i)).toBeInTheDocument();
    expect(screen.queryByText(/host admin/i)).toBeNull();
  });

  it("/vault/new also renders 'vault provisioning'", async () => {
    await renderAtPath("/vault/new");
    expect(screen.getByText(/vault provisioning/i)).toBeInTheDocument();
  });

  it("/hub* renders 'host admin'", async () => {
    await renderAtPath("/hub/tokens");
    expect(screen.getByText(/host admin/i)).toBeInTheDocument();
    expect(screen.queryByText(/vault provisioning/i)).toBeNull();
  });

  it("/hub/permissions also renders 'host admin'", async () => {
    await renderAtPath("/hub/permissions");
    expect(screen.getByText(/host admin/i)).toBeInTheDocument();
  });

  it("origin root falls back to vault-provisioning subtitle", async () => {
    await renderAtPath("/");
    expect(screen.getByText(/vault provisioning/i)).toBeInTheDocument();
  });
});

describe("App — nav structure", () => {
  it("renders all four nav links in order: Vaults, Permissions, Tokens, Discovery", async () => {
    await renderAtPath("/vault");
    const nav = screen.getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    // Brand link is index 0; the four nav items follow.
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).toEqual([
      expect.stringMatching(/parachute hub/i),
      "Vaults",
      "Permissions",
      "Tokens",
      "Discovery",
    ]);
  });

  it("renders two visual dividers between nav groups", async () => {
    const { container } = await renderAtPath("/vault");
    // Two `.nav-divider` spans: one between Vaults and Permissions, one
    // between Tokens and Discovery. aria-hidden so screen readers skip
    // them as decorative.
    const dividers = container.querySelectorAll(".nav-divider");
    expect(dividers).toHaveLength(2);
    for (const d of dividers) {
      expect(d.getAttribute("aria-hidden")).toBe("true");
    }
  });
});
