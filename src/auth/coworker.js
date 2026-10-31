/**
 * CX Enterprise Coworker login path.
 *   USE_COWORKER_LOGIN   default ON. "0" / "false" / "off" keeps the original flow (identity-only sign-in, technical account for coworker).
 *   ADOBE_COWORKER_SCOPES  extra Adobe scopes requested at sign-in so the user's token can call the coworker gateway
 *                          (add offline_access for a refresh token). Must be enabled on the sign-in client in Adobe Developer Console.
 *   ADOBE_COWORKER_SERVICES  additional upstream services that run through the coworker connection. "coworker" and "cdp" (audiences,
 *                          profiles, segments via the cdp upstream) are always included, so Adobe enforces the signed-in user's own AEP role.
 * When on, the user's own Adobe sign-in token is kept as their "coworker" connection and every coworker call acts as that user.
 */
export const COWORKER_CONNECTION = "coworker";

export const useCoworkerLogin = (env = process.env) => !/^(0|false|no|off)$/i.test(String(env.USE_COWORKER_LOGIN ?? "1").trim());

export const coworkerServices = (env = process.env) => [...new Set(["coworker", "cdp", ...String(env.ADOBE_COWORKER_SERVICES ?? "").split(",").map((s) => s.trim()).filter(Boolean)])];

const split = (s) => String(s ?? "").split(/[,\s]+/).filter(Boolean);
const union = (...lists) => [...new Set(lists.flat())].join(",");

/** Sign-in scope string: the base identity scopes, plus the coworker scopes when the coworker login is on. */
export const signinScopes = (base, env = process.env) => (useCoworkerLogin(env) ? union(split(base), split(env.ADOBE_COWORKER_SCOPES)) : base);
