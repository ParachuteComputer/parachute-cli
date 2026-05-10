/**
 * Parachute Admin SPA.
 *
 * Hub-served browser UI for cross-cutting host concerns:
 *
 *   - **`/admin/vaults`** — vault provisioning. List + create. Per-vault
 *     content (the Notes PWA, etc.) lives at `/vault/<name>/*` and is NOT
 *     part of this SPA — vaults own their own user-facing surfaces.
 *   - **`/admin/permissions`** — OAuth consent grant management.
 *   - **`/admin/tokens`** — token registry: mint, list, revoke.
 *
 * Single mount at `/admin/*` (as of hub#231). The prior dual mounts
 * (`/vault` for the vault SPA, `/hub/*` for permissions+tokens) are
 * 301-redirected in `hub-server.ts` so cached URLs keep working.
 *
 * Cross-surface navigation off the SPA (e.g. to `/` or `/vault/<name>/`)
 * uses plain `<a href>` since react-router's `<Link>` resolves against
 * the SPA basename.
 *
 * The discovery page at `/` (see `src/hub.ts`) is the operator's
 * entry point — its Use section links to per-service surfaces; its
 * Admin section links here.
 */
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { NewVault } from "./routes/NewVault.tsx";
import { Permissions } from "./routes/Permissions.tsx";
import { Tokens } from "./routes/Tokens.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

/**
 * Subtitle reflects the active route's section so a deep-link operator
 * knows where they are without reading the URL bar. Updates on
 * client-side navigation via the router's pathname.
 */
function subtitleFor(pathname: string): string {
  if (pathname === "/permissions" || pathname.startsWith("/permissions/")) {
    return "permissions";
  }
  if (pathname === "/tokens" || pathname.startsWith("/tokens/")) {
    return "tokens";
  }
  return "vaults";
}

export function App() {
  const { pathname } = useLocation();
  const subtitle = subtitleFor(pathname);

  return (
    <div className="page">
      <nav className="nav">
        <Link to="/vaults" className="brand">
          Parachute Admin <span className="sub">{subtitle}</span>
        </Link>
        <Link to="/vaults">Vaults</Link>
        <Link to="/permissions">Permissions</Link>
        <Link to="/tokens">Tokens</Link>
        <span className="nav-divider" aria-hidden="true" />
        <a href="/" title="Hub discovery page (top-level)">
          Discovery
        </a>
      </nav>

      <Routes>
        <Route path="/" element={<VaultsList />} />
        <Route path="/vaults" element={<VaultsList />} />
        <Route path="/vaults/new" element={<NewVault />} />
        <Route path="/permissions" element={<Permissions />} />
        <Route path="/tokens" element={<Tokens />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/vaults">vaults</Link>.
            </div>
          }
        />
      </Routes>
    </div>
  );
}
