import assert from "node:assert/strict";
import { AuthPolicy } from "../src/auth/auth-policy.js";
import { useCoworkerLogin, signinScopes } from "../src/auth/coworker.js";

const base = { ADOBE_SIGNIN_SCOPES: "openid,AdobeID,profile" };

// default: coworker login is ON and coworker calls act as the signed-in user
assert.equal(useCoworkerLogin({}), true);
let p = AuthPolicy.load({ ...base });
assert.deepEqual([p.rule("coworker", "t").mode, p.rule("coworker", "t").connection], ["delegated", "coworker"]);
assert.deepEqual([p.rule("cdp", "t").mode, p.rule("cdp", "t").connection], ["delegated", "coworker"], "audiences (cdp) run as the signed-in user");
assert.equal(p.rule("aep", "t").mode, "service");
assert.equal(signinScopes("openid", { ADOBE_COWORKER_SCOPES: "offline_access, openid" }), "openid,offline_access");

// extra services can ride the coworker connection
p = AuthPolicy.load({ ADOBE_COWORKER_SERVICES: "aem, cdp" });
assert.deepEqual(["coworker", "aem", "cdp"].map((s) => p.rule(s, "t").connection), ["coworker", "coworker", "coworker"]);

// explicit per-service mode still wins
p = AuthPolicy.load({ ADOBE_AUTH_MODE_COWORKER: "service" });
assert.equal(p.rule("coworker", "t").mode, "service");

// switch OFF (also "false"/"off"/"no") restores the original flow: service mode, identity-only scopes
for (const v of ["0", "false", "off", "NO"]) {
  const env = { USE_COWORKER_LOGIN: v, ADOBE_COWORKER_SCOPES: "offline_access" };
  assert.equal(useCoworkerLogin(env), false);
  assert.equal(AuthPolicy.load(env).rule("coworker", "t").mode, "service");
  assert.equal(AuthPolicy.load(env).rule("cdp", "t").mode, "service");
  assert.equal(signinScopes("openid,AdobeID,profile", env), "openid,AdobeID,profile");
}

console.log("coworker login OK");
