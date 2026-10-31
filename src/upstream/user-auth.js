import { ImsTokenProvider } from "./ims.js";

/** Token source for a sign-in that yielded no refresh token: usable until the access token expires, then the user must sign in again. */
class ExpiringToken {
  constructor(token, expiresAt, now) { Object.assign(this, { token, expiresAt, now }); }
  async getToken() {
    if (this.expiresAt - 30_000 <= this.now()) throw new Error("Your Adobe sign-in expired. Remove and re-add the connector, then sign in again.");
    return this.token;
  }
  invalidate() {}
  status() { return { method: "user-access-token", hasToken: true, expiresAt: new Date(this.expiresAt).toISOString() }; }
}

/**
 * Per-user Adobe tokens captured at sign-in. Upstreams listed in ADOBE_USER_TOKEN_UPSTREAMS are called with the
 * signed-in user's own token (and the sign-in app's client id) instead of the shared server-to-server credential.
 * Memory only: a server restart means the user signs in again.
 */
export class UserUpstreamAuth {
  constructor({ tokenUrl, clientId, clientSecret, now = Date.now, fetchImpl = fetch }) {
    Object.assign(this, { tokenUrl, clientId, now, fetchImpl });
    this.secret = clientSecret;
    this.users = new Map();
  }
  set(userId, { accessToken, refreshToken, expiresIn }) {
    const expiresAt = this.now() + Number(expiresIn ?? 3600) * 1000;
    let provider;
    if (refreshToken) {
      provider = new ImsTokenProvider({
        tokenUrl: this.tokenUrl, clientId: this.clientId, clientSecret: this.secret, refreshToken, fetchImpl: this.fetchImpl, now: this.now,
      });
      provider.cached = { token: accessToken, expiresAt };
    } else provider = new ExpiringToken(accessToken, expiresAt, this.now);
    this.users.set(userId, provider);
  }
  has(userId) { return this.users.has(userId); }
  provider(userId) { return this.users.get(userId); }
}
