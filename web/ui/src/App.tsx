/**
 * Parachute Hub admin SPA.
 *
 * This bundle is the operator-facing browser UI for the **hub**. Two
 * concerns live under one roof, served at two mounts on the same hub:
 *
 *   - **`/vault/*`** — vault provisioning. Lists every vault registered
 *     with the hub (`/.well-known/parachute.json`); operators create new
 *     vaults via `/vault/new`. This is NOT a per-vault admin UI; vaults
 *     own their own surfaces (the MCP endpoint for AI clients, the Notes
 *     PWA for human content browsing). Per-vault admin (config, schemas)
 *     doesn't have a hub-served UI today; if/when it does, it'll be
 *     vault-served — analogous to how the agent has its own admin.
 *
 *   - **`/hub/*`** — cross-cutting host concerns. `/hub/permissions`
 *     manages the OAuth consent skip-list; `/hub/tokens` manages the
 *     hub's token registry (mint / list / revoke). These are operator
 *     state about the hub itself, not about any single vault.
 *
 * The active mount picks the route table — we don't render every route
 * under both basenames since the concerns are unrelated. Cross-mount
 * navigation uses plain `<a href>` because react-router's `<Link>`
 * resolves against the active basename.
 *
 * The brand subtitle reflects the active mount so an operator who lands
 * deep in either tree knows which surface they're on.
 */
import { Link, Route, Routes } from "react-router-dom";
import { NewVault } from "./routes/NewVault.tsx";
import { Permissions } from "./routes/Permissions.tsx";
import { Tokens } from "./routes/Tokens.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

const isHubMount =
  typeof window !== "undefined" &&
  (window.location.pathname === "/hub" || window.location.pathname.startsWith("/hub/"));

const subtitle = isHubMount ? "host admin" : "vault provisioning";

export function App() {
  return (
    <div className="page">
      <nav className="nav">
        <a href="/vault" className="brand">
          Parachute Hub <span className="sub">{subtitle}</span>
        </a>
        {/* Group 1 — vault provisioning (lives under /vault). */}
        <a href="/vault">Vaults</a>
        <span className="nav-divider" aria-hidden="true" />
        {/* Group 2 — host admin (lives under /hub). */}
        <a href="/hub/permissions">Permissions</a>
        <a href="/hub/tokens">Tokens</a>
        <span className="nav-divider" aria-hidden="true" />
        {/* Group 3 — top-level: the public discovery page at /. */}
        <a href="/" title="Hub discovery page (top-level)">
          Discovery
        </a>
      </nav>

      <Routes>
        {isHubMount ? (
          <>
            <Route path="/permissions" element={<Permissions />} />
            <Route path="/tokens" element={<Tokens />} />
            <Route
              path="*"
              element={
                <div className="empty">
                  404 — back to <a href="/vault">vaults</a>.
                </div>
              }
            />
          </>
        ) : (
          <>
            <Route path="/" element={<VaultsList />} />
            <Route path="/new" element={<NewVault />} />
            <Route
              path="*"
              element={
                <div className="empty">
                  404 — back to <Link to="/">vaults</Link>.
                </div>
              }
            />
          </>
        )}
      </Routes>
    </div>
  );
}
