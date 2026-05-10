/**
 * App-level smoke tests — brand subtitle reflects the active route; nav
 * has the right groups + dividers; routes render the expected components.
 *
 * Subtitle is now derived from the router's pathname (via `useLocation`),
 * so tests drive route changes via `MemoryRouter`'s `initialEntries` —
 * no `window.location` munging needed.
 */
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App.tsx";
import type * as api from "./lib/api.ts";

// Stub all API helpers — App pulls in VaultsList / Permissions / Tokens
// at module-load time, and each of those calls into lib/api.ts on mount.
// Without stubs, jsdom would attempt real fetches and the route tests
// would race against unmounted state.
vi.mock("./lib/api.ts", async (orig) => {
  const actual = (await orig()) as typeof api;
  return {
    ...actual,
    listVaults: vi.fn().mockResolvedValue([]),
    listGrants: vi.fn().mockResolvedValue([]),
    listTokens: vi.fn().mockResolvedValue({ tokens: [], next_cursor: null }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderAt(pathname: string) {
  return render(
    <MemoryRouter initialEntries={[pathname]}>
      <App />
    </MemoryRouter>,
  );
}

describe("App — brand subtitle (route-derived)", () => {
  it("/vaults renders 'vaults'", () => {
    renderAt("/vaults");
    expect(screen.getByText(/vaults/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("/vaults/new renders 'vaults' (sub-route still under vaults)", () => {
    renderAt("/vaults/new");
    expect(screen.getByText(/vaults/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("/permissions renders 'permissions'", () => {
    renderAt("/permissions");
    expect(screen.getByText(/permissions/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("/tokens renders 'tokens'", () => {
    renderAt("/tokens");
    expect(screen.getByText(/tokens/i, { selector: ".sub" })).toBeInTheDocument();
  });

  it("origin root (/) falls back to 'vaults' (the SPA's home)", () => {
    renderAt("/");
    expect(screen.getByText(/vaults/i, { selector: ".sub" })).toBeInTheDocument();
  });
});

describe("App — nav structure", () => {
  it("renders all nav links in order: brand, Vaults, Permissions, Tokens, Discovery", () => {
    renderAt("/vaults");
    const nav = screen.getByRole("navigation");
    const links = within(nav).getAllByRole("link");
    const labels = links.map((a) => a.textContent?.trim());
    expect(labels).toEqual([
      expect.stringMatching(/parachute admin/i),
      "Vaults",
      "Permissions",
      "Tokens",
      "Discovery",
    ]);
  });

  it("renders one visual divider between SPA-internal links and Discovery", () => {
    // Single mount = single SPA section. The remaining divider separates
    // in-SPA `<Link>` nav from the cross-mount Discovery `<a href>` (which
    // leaves the SPA basename).
    const { container } = renderAt("/vaults");
    const dividers = container.querySelectorAll(".nav-divider");
    expect(dividers).toHaveLength(1);
    for (const d of dividers) {
      expect(d.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("brand label is 'Parachute Admin' (renamed from 'Parachute Hub' in #231)", () => {
    renderAt("/vaults");
    expect(screen.getByText(/parachute admin/i)).toBeInTheDocument();
    expect(screen.queryByText(/^parachute hub/i)).toBeNull();
  });
});

describe("App — route rendering", () => {
  it("/vaults renders VaultsList (heading 'Vaults')", async () => {
    renderAt("/vaults");
    expect(await screen.findByRole("heading", { name: /^vaults/i })).toBeInTheDocument();
  });

  it("/vaults/new renders NewVault (form input for vault name)", () => {
    renderAt("/vaults/new");
    // NewVault's form has a name input — surfaces immediately on mount.
    expect(screen.getByLabelText(/vault name/i)).toBeInTheDocument();
  });

  it("/permissions renders Permissions (heading 'Permissions')", () => {
    renderAt("/permissions");
    expect(screen.getByRole("heading", { name: /^permissions$/i })).toBeInTheDocument();
  });

  it("/tokens renders Tokens (heading 'Tokens')", () => {
    renderAt("/tokens");
    expect(screen.getByRole("heading", { name: /^tokens$/i })).toBeInTheDocument();
  });

  it("origin root (/) renders VaultsList (the SPA's home)", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: /^vaults/i })).toBeInTheDocument();
  });

  it("unknown path renders 404 with link back to vaults", () => {
    renderAt("/this-does-not-exist");
    const empty = screen.getByText(/404/).closest(".empty");
    expect(empty).not.toBeNull();
    // Scope the link query to the 404 body — the brand link in the nav
    // also matches /vaults/i and would otherwise multi-match.
    const backLink = within(empty as HTMLElement).getByRole("link", { name: /vaults/i });
    expect(backLink).toHaveAttribute("href", "/vaults");
  });
});
