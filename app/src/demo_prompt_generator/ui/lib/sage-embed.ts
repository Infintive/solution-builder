/**
 * Sage embed bridge (child side).
 *
 * When Solution Builder runs embedded in an iframe inside Sage, this lets it
 * inherit Sage's theme + palette and mirror its route into Sage's address bar.
 * Standalone (Electron, or opened directly), none of this activates — the app
 * keeps its own look and routing.
 *
 * Protocol (must match Sage's lib/embedded-app-protocol.ts):
 *   child → Sage : { type: "SAGE_EMBED_READY" }
 *   Sage  → child: { type: "SAGE_EMBED_THEME", theme, tokens }
 *   child → Sage : { type: "SAGE_EMBED_ROUTE_CHANGE", path, search, hash }
 *
 * Token format note: Sage sends bare HSL triples ("11 65% 49%", or
 * "11 100% 57% / 0.30") because Sage consumes them as `hsl(var(--x))`. This app
 * (Tailwind v4) consumes tokens as `var(--x)` directly, so we wrap the triples
 * in `hsl(...)` before applying — no color-space conversion needed.
 *
 * Customer safety: this whole integration is compiled out unless the build sets
 * SAGE_EMBED=1 (vite injects __SAGE_EMBED__). Solution Builder ships to
 * customers in prod; those builds leave the flag off, so the bundle contains
 * none of this code (no "Sage" / "databricksapps.com" strings) — it exists only
 * in the FE-internal build that Sage embeds. `sageEmbedActive()` ANDs that
 * build flag with a runtime iframe check, so even the FE build stays inert
 * unless actually running inside Sage.
 */

// Compile-time flag injected by vite `define` (defaults to false). A literal
// `false` lets the bundler dead-code-eliminate everything gated on it.
declare const __SAGE_EMBED__: boolean;

const SAGE_EMBED = {
  READY: "SAGE_EMBED_READY",
  THEME: "SAGE_EMBED_THEME",
  ROUTE_CHANGE: "SAGE_EMBED_ROUTE_CHANGE",
} as const;

/** True only in the FE-internal build AND when actually running inside Sage. */
export function sageEmbedActive(): boolean {
  return __SAGE_EMBED__ && isSageEmbedded();
}

type SageMode = "light" | "dark";

/** Sage token names whose value should also be written to a differently-named
 *  token here (Sage's `--sidebar-background` is this app's `--sidebar`). */
const TOKEN_ALIASES: Record<string, string[]> = {
  "--sidebar-background": ["--sidebar"],
};

/** True when running inside an iframe (i.e. embedded in Sage). */
export function isSageEmbedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin access to window.top throws → we're framed by another origin.
    return true;
  }
}

/** Only trust theme messages from a Databricks Apps host (Sage) or localhost. */
function isTrustedSageOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname.endsWith(".databricksapps.com");
  } catch {
    return false;
  }
}

/** Apply Sage's design tokens onto our :root, adapting the value format. */
function applySageTokens(tokens: Record<string, string>): void {
  const root = document.documentElement;
  for (const [name, raw] of Object.entries(tokens)) {
    if (typeof raw !== "string" || !raw) continue;
    // Color tokens are HSL triples (contain "%"); non-color tokens (e.g.
    // --radius: 0.5rem) are applied verbatim.
    const value = raw.includes("%") ? `hsl(${raw})` : raw;
    root.style.setProperty(name, value);
    for (const alias of TOKEN_ALIASES[name] ?? []) {
      root.style.setProperty(alias, value);
    }
  }
}

/**
 * Announce readiness to Sage and apply theme + palette pushes.
 * `onMode` is called with Sage's light/dark mode so the app's own theme state
 * stays in sync (drives the .dark class). Returns a cleanup function.
 */
export function initSageThemeBridge(onMode: (mode: SageMode) => void): () => void {
  // Guard on the raw literal (not sageEmbedActive) so the bundler folds
  // `if (!false || …)` → `if (true)` and dead-code-eliminates the body below,
  // stripping every SAGE_EMBED string from customer builds.
  if (!__SAGE_EMBED__ || !isSageEmbedded()) return () => {};

  const handler = (event: MessageEvent) => {
    if (!isTrustedSageOrigin(event.origin)) return;
    const data = event.data as { type?: string; theme?: string; tokens?: Record<string, string> };
    if (!data || data.type !== SAGE_EMBED.THEME) return;
    if (data.theme === "light" || data.theme === "dark") onMode(data.theme);
    if (data.tokens) applySageTokens(data.tokens);
  };

  window.addEventListener("message", handler);
  // Tell Sage we're listening; it replies with the current theme + tokens.
  window.parent.postMessage({ type: SAGE_EMBED.READY }, "*");

  return () => window.removeEventListener("message", handler);
}

/**
 * Mirror this app's route into Sage's address bar. Reports on every resolved
 * navigation (and once immediately). Returns the router unsubscribe function.
 */
export function initSageRouteBridge(router: {
  subscribe: (event: "onResolved", cb: () => void) => () => void;
}): () => void {
  if (!__SAGE_EMBED__ || !isSageEmbedded()) return () => {};

  const report = () => {
    window.parent.postMessage(
      {
        type: SAGE_EMBED.ROUTE_CHANGE,
        path: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      },
      "*",
    );
  };

  report();
  return router.subscribe("onResolved", report);
}
