import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlatform } from "../src/platform.js";

const base = { MARKETO_CLIENT_ID: "mkto-client", MARKETO_CLIENT_SECRET: "mkto-secret-value", MARKETO_BASE_URL: "https://123-ABC-456.mktorest.com/rest" };
const dir = mkdtempSync(join(tmpdir(), "sa-"));
const env = { ...base, EMAIL_LISTS_FILE: join(dir, "lists.json") };

// Marketo credentials are only sent to *.mktorest.com unless explicitly overridden
await assert.rejects(createPlatform({ env: { ...env, MARKETO_BASE_URL: "https://evil.example.com/rest" } }).initUpstreams(), /Refusing to send Marketo credentials/);
await assert.rejects(createPlatform({ env: { ...env, MARKETO_BASE_URL: "http://123-ABC-456.mktorest.com/rest" } }).initUpstreams(), /Refusing to send Marketo credentials/);
await createPlatform({ env: { ...env, MARKETO_BASE_URL: "http://127.0.0.1:1/rest", ADOBE_ALLOW_CUSTOM_HOSTS: "1" } }).initUpstreams();

const p = createPlatform({ env });
await p.initUpstreams();
const inv = (user, service, tool, args = {}) => p.gateway.invoke({ identity: p.auth.identityFor(user), service, tool, args });
const fails = (user, service, tool, args) => inv(user, service, tool, args).then(() => assert.fail("should fail"), (e) => e);

// self-authenticating service still audits the executing principal (the Marketo credential), plus the requesting user
const e = await fails("casey.cm", "marketo_rest", "update_list_membership", { listId: 1, action: "add" }); // fails locally: no leads, no network call
assert.match(e.message, /No leads to add/);
const a = p.gateway.security.query({ user: "casey.cm", service: "marketo_rest" }).at(-1);
assert.deepEqual([a.authMode, a.principal, a.user], ["service", "marketo:mkto-client", "casey.cm"]);

// role access still gates reads vs writes on the Marketo service (data_manager: read only)
assert.equal((await fails("dana.data", "marketo_rest", "update_list_membership", { listId: 1, action: "add", leadIds: [1] })).code, "forbidden");
assert.equal((await fails("lee.leader", "marketo_rest", "list_programs")).code, "forbidden");

// secrets never reach the audit trail
assert(!JSON.stringify(p.gateway.security.entries).includes("mkto-secret-value"));

// email lists: list ids are user input and must not resolve through the prototype chain
for (const id of ["constructor", "__proto__", "toString"]) {
  assert.match((await fails("casey.cm", "email_lists", "view_email_list", { listId: id })).message, /Unknown email list/);
}
const up = await inv("casey.cm", "email_lists", "upload_email_list", { name: "t", csv: "email\na@x.com" });
assert.equal(up.result.uploaded, 1);
assert.match((await fails("morgan.ops", "email_lists", "view_email_list", { listId: up.result.listId })).message, /Unknown email list/, "lists are private per user");

rmSync(dir, { recursive: true, force: true });
console.log("self-auth guards OK");
process.exit(0);
