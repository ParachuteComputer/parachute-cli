import { Link, Route, Routes } from "react-router-dom";
import { NewVault } from "./routes/NewVault.tsx";
import { Permissions } from "./routes/Permissions.tsx";
import { Tokens } from "./routes/Tokens.tsx";
import { VaultsList } from "./routes/VaultsList.tsx";

// Same SPA bundle, two mounts: /vault (primary, vault management) and
// /hub (back-compat + cross-cutting auth state — /hub/permissions and
// /hub/tokens). The active mount picks the route table — we don't render
// every route under both basenames since they are unrelated concerns.
// Cross-mount navigation uses plain <a href> because <Link> resolves
// against the active basename.
const isHubMount =
  typeof window !== "undefined" &&
  (window.location.pathname === "/hub" || window.location.pathname.startsWith("/hub/"));

export function App() {
  return (
    <div className="page">
      <nav className="nav">
        <a href="/vault" className="brand">
          Parachute Hub <span className="sub">vault management</span>
        </a>
        <a href="/vault">Vaults</a>
        <a href="/hub/permissions">Permissions</a>
        <a href="/hub/tokens">Tokens</a>
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
