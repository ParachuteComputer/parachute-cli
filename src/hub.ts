import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR } from "./config.ts";

/**
 * Hub page served at `/` when the node is exposed. Lists every installed
 * service via a client-side fetch to `/.well-known/parachute.json` and each
 * service's own `/.parachute/info`. Everything that needs personalization
 * (name, tagline, icon) comes from the service, not the CLI — adding a new
 * frontend requires zero hub-page changes.
 *
 * Card kinds (from `info.kind`, optional):
 *   "frontend" | undefined  → whole card is an <a> that navigates to svc.url
 *   "api" | "tool"          → card is non-navigating; click toggles a detail
 *                             panel with OAuth/MCP/open-in-Notes links, so
 *                             API-only services don't dead-end on raw JSON.
 *
 * The file is fully self-contained (inline CSS + JS, no external assets)
 * so `tailscale serve` can mount it directly from disk with `--set-path=/`.
 */

export const HUB_PATH = join(CONFIG_DIR, "well-known", "hub.html");
export const HUB_MOUNT = "/";

export function renderHub(): string {
  return HTML;
}

export function writeHubFile(path: string = HUB_PATH): string {
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, HTML);
  renameSync(tmp, path);
  return path;
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Parachute</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ctext y='26' font-size='26'%3E\u{1FA82}%3C/text%3E%3C/svg%3E" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=DM+Sans:wght@400;500;600&display=swap" />
<style>
  :root {
    --bg: #faf8f4;
    --bg-soft: #f3f0ea;
    --fg: #2c2a26;
    --fg-muted: #6b6860;
    --fg-dim: #9a9690;
    --accent: #4a7c59;
    --accent-soft: rgba(74, 124, 89, 0.08);
    --accent-hover: #3d6849;
    --accent-light: #6a9b77;
    --border: #e4e0d8;
    --card-bg: #ffffff;
    --serif: 'Instrument Serif', Georgia, serif;
    --sans: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1a1917;
      --bg-soft: #24221f;
      --fg: #e8e4dc;
      --fg-muted: #a8a49a;
      --fg-dim: #6b6860;
      --accent: #7ab08a;
      --accent-soft: rgba(122, 176, 138, 0.1);
      --accent-hover: #8fc49e;
      --accent-light: #8fc49e;
      --border: #3a3733;
      --card-bg: #24221f;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--fg);
    font-family: var(--sans);
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    min-height: 100vh;
  }
  main {
    max-width: 960px;
    margin: 0 auto;
    padding: 4rem 1.5rem 6rem;
  }
  header {
    text-align: center;
    margin-bottom: 3.5rem;
  }
  h1 {
    font-family: var(--serif);
    font-weight: 400;
    font-size: clamp(2.75rem, 6vw, 4rem);
    line-height: 1.05;
    margin: 0 0 0.75rem;
    letter-spacing: -0.01em;
  }
  .tagline {
    color: var(--fg-muted);
    font-size: 1.1rem;
    margin: 0;
  }
  .grid {
    display: grid;
    gap: 1.25rem;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 1.75rem;
    text-decoration: none;
    color: inherit;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
    opacity: 0;
    animation: fadeUp 0.4s ease forwards;
  }
  .card:nth-child(1) { animation-delay: 0.02s; }
  .card:nth-child(2) { animation-delay: 0.06s; }
  .card:nth-child(3) { animation-delay: 0.1s; }
  .card:nth-child(4) { animation-delay: 0.14s; }
  .card:nth-child(5) { animation-delay: 0.18s; }
  .card:nth-child(n+6) { animation-delay: 0.22s; }
  .card:hover {
    border-color: var(--accent-light);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
    transform: translateY(-2px);
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .icon {
    width: 2.25rem;
    height: 2.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--accent-soft);
    border-radius: 8px;
    color: var(--accent);
    font-size: 1.25rem;
    flex-shrink: 0;
    overflow: hidden;
  }
  .icon img, .icon svg {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .card-title {
    font-family: var(--serif);
    font-size: 1.5rem;
    font-weight: 400;
    margin: 0;
    line-height: 1.1;
  }
  .card-tagline {
    color: var(--fg-muted);
    font-size: 0.95rem;
    margin: 0;
    flex-grow: 1;
  }
  .card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: var(--fg-dim);
  }
  .version {
    font-family: ui-monospace, 'SF Mono', Monaco, monospace;
    padding: 0.1rem 0.5rem;
    background: var(--bg-soft);
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .path {
    font-family: ui-monospace, 'SF Mono', Monaco, monospace;
    color: var(--fg-muted);
  }
  .kind-badge {
    font-size: 0.7rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg-dim);
    padding: 0.1rem 0.45rem;
    border-radius: 999px;
    border: 1px solid var(--border);
  }
  .card.interactive { cursor: pointer; }
  .card.interactive:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .details {
    display: none;
    flex-direction: column;
    gap: 0.5rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px dashed var(--border);
    font-size: 0.9rem;
  }
  .card.expanded .details { display: flex; }
  .details a {
    color: var(--accent);
    text-decoration: none;
    border-bottom: 1px solid transparent;
    transition: border-color 0.15s ease;
    word-break: break-all;
  }
  .details a:hover { border-bottom-color: var(--accent-light); }
  .details .row {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .details .row .label {
    font-size: 0.75rem;
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .empty, .error {
    text-align: center;
    color: var(--fg-muted);
    padding: 3rem 1rem;
    border: 1px dashed var(--border);
    border-radius: 12px;
  }
  .empty code, .error code {
    font-family: ui-monospace, 'SF Mono', Monaco, monospace;
    background: var(--bg-soft);
    padding: 0.1rem 0.4rem;
    border-radius: 4px;
    color: var(--accent);
  }
  footer {
    text-align: center;
    margin-top: 4rem;
    color: var(--fg-dim);
    font-size: 0.85rem;
  }
  footer a {
    color: var(--fg-muted);
    text-decoration: none;
    border-bottom: 1px solid var(--border);
  }
  footer a:hover {
    color: var(--accent);
    border-bottom-color: var(--accent-light);
  }
  @keyframes fadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @media (max-width: 640px) {
    main { padding: 2.5rem 1rem 4rem; }
    .card { padding: 1.5rem; }
  }
</style>
</head>
<body>
<main>
  <header>
    <h1>Parachute</h1>
    <p class="tagline">Your personal-computing services.</p>
  </header>
  <section id="services" class="grid" aria-live="polite">
    <div class="empty" id="loading">Loading services\u2026</div>
  </section>
  <footer>
    <a href="/.well-known/parachute.json">discovery</a>
  </footer>
</main>
<script>
(async () => {
  const root = document.getElementById('services');
  const fallbackIcon = \`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="9"/></svg>\`;

  function shortName(manifestName) {
    return manifestName.replace(/^parachute-/, '');
  }

  function fetchWithTimeout(url, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    return fetch(url, { signal: ctl.signal, credentials: 'omit' })
      .finally(() => clearTimeout(t));
  }

  async function loadInfo(infoUrl) {
    try {
      const r = await fetchWithTimeout(infoUrl, 2000);
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  function isInteractiveKind(kind) {
    return kind === 'api' || kind === 'tool';
  }

  function appendDetailRow(parent, label, node) {
    const row = document.createElement('div');
    row.className = 'row';
    const lab = document.createElement('span');
    lab.className = 'label';
    lab.textContent = label;
    row.appendChild(lab);
    row.appendChild(node);
    parent.appendChild(row);
  }

  function linkNode(href, text) {
    const a = document.createElement('a');
    a.href = href;
    a.textContent = text || href;
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }

  function renderDetails(svc, info) {
    const box = document.createElement('div');
    box.className = 'details';
    // OAuth discovery is served by the hub (this origin) per the Phase 0 seam.
    appendDetailRow(
      box,
      'OAuth discovery',
      linkNode('/.well-known/oauth-authorization-server'),
    );
    if (info && typeof info.mcpUrl === 'string' && info.mcpUrl) {
      appendDetailRow(box, 'MCP endpoint', linkNode(info.mcpUrl));
    }
    if (info && typeof info.openInNotesUrl === 'string' && info.openInNotesUrl) {
      appendDetailRow(box, 'Open in Notes', linkNode(info.openInNotesUrl, 'Open →'));
    }
    // Direct URL is still useful for power users even if the card doesn't navigate.
    appendDetailRow(box, 'Service URL', linkNode(svc.url));
    return box;
  }

  function renderCard(svc, info) {
    const kind = info && typeof info.kind === 'string' ? info.kind : 'frontend';
    const interactive = isInteractiveKind(kind);
    const root = document.createElement(interactive ? 'div' : 'a');
    root.className = 'card' + (interactive ? ' interactive' : '');
    if (!interactive) root.href = svc.url;
    if (interactive) {
      root.setAttribute('role', 'button');
      root.setAttribute('tabindex', '0');
      root.setAttribute('aria-expanded', 'false');
      const toggle = () => {
        const next = !root.classList.contains('expanded');
        root.classList.toggle('expanded', next);
        root.setAttribute('aria-expanded', next ? 'true' : 'false');
      };
      root.addEventListener('click', (e) => {
        if (e.target && e.target.closest && e.target.closest('.details')) return;
        toggle();
      });
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    }

    const head = document.createElement('div');
    head.className = 'card-head';

    const icon = document.createElement('div');
    icon.className = 'icon';
    const iconUrl = info && info.icon ? new URL(info.icon, svc.url).toString() : null;
    if (iconUrl) {
      const img = document.createElement('img');
      img.src = iconUrl;
      img.alt = '';
      img.onerror = () => { icon.innerHTML = fallbackIcon; };
      icon.appendChild(img);
    } else {
      icon.innerHTML = fallbackIcon;
    }

    const title = document.createElement('h2');
    title.className = 'card-title';
    title.textContent = (info && info.displayName) || shortName(svc.name);

    head.appendChild(icon);
    head.appendChild(title);
    root.appendChild(head);

    const tag = info && info.tagline;
    if (tag) {
      const p = document.createElement('p');
      p.className = 'card-tagline';
      p.textContent = tag;
      root.appendChild(p);
    }

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const path = document.createElement('span');
    path.className = 'path';
    path.textContent = svc.path;
    const right = document.createElement('span');
    right.style.display = 'inline-flex';
    right.style.gap = '0.35rem';
    right.style.alignItems = 'center';
    if (interactive) {
      const badge = document.createElement('span');
      badge.className = 'kind-badge';
      badge.textContent = kind;
      right.appendChild(badge);
    }
    const ver = document.createElement('span');
    ver.className = 'version';
    ver.textContent = 'v' + svc.version;
    right.appendChild(ver);
    meta.appendChild(path);
    meta.appendChild(right);
    root.appendChild(meta);

    if (interactive) root.appendChild(renderDetails(svc, info));

    return root;
  }

  try {
    const wk = await fetch('/.well-known/parachute.json', { credentials: 'omit' });
    if (!wk.ok) throw new Error('well-known fetch failed: ' + wk.status);
    const doc = await wk.json();
    const services = Array.isArray(doc.services) ? doc.services : [];
    if (services.length === 0) {
      root.innerHTML = '<div class="empty">No services installed yet. Try <code>parachute install vault</code>.</div>';
      return;
    }
    const infos = await Promise.all(services.map((s) => loadInfo(s.infoUrl)));
    root.innerHTML = '';
    services.forEach((svc, i) => root.appendChild(renderCard(svc, infos[i])));
  } catch (err) {
    root.innerHTML = '<div class="error">Could not load services: ' + (err && err.message ? err.message : String(err)) + '</div>';
  }
})();
</script>
</body>
</html>
`;
