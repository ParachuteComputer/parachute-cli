/**
 * @openparachute/scope-guard
 *
 * Hub-issued JWT validation for Parachute resource servers. Build a
 * `ScopeGuard` bound to your hub origin once per process, then call
 * `guard.validateHubJwt(token, { expectedAudience? })` on each request.
 *
 * See README.md for the full API rundown and design.
 */

export { extractBearer, looksLikeJwt, parseScopes } from "./parse";
export { hasScope } from "./scope";
export type { JwksGetter, JwksOptions } from "./jwks";
// Revocation-cache surface: the cache itself is internal — `ScopeGuard` owns
// the lifecycle so downstream RSes don't accidentally instantiate parallel
// caches with diverging policies. The seam exposed here is `RevocationFetcher`
// (a custom fetch shape, e.g. a logged or auth-headered alternative to
// `defaultRevocationFetcher`); callers wire it via `createScopeGuard`'s
// `revocationFetcher` option.
export {
  REVOCATION_CACHE_TTL_MS,
  defaultRevocationFetcher,
  type RevocationFetcher,
  type RevocationListBody,
} from "./revocation-cache";
export {
  createScopeGuard,
  HubJwtError,
  type CreateScopeGuardOptions,
  type HubJwtClaims,
  type HubJwtErrorCode,
  type ScopeGuard,
  type ValidateHubJwtOptions,
} from "./validate";
