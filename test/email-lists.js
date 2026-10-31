import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmailListAgent, parseCsv } from "../src/upstream/email-lists.js";

assert.deepEqual(parseCsv('a,"b,1"\r\n"q""x",z\n'), [["a", "b,1"], ['q"x', "z"]]);

const dir = mkdtempSync(join(tmpdir(), "el-"));
const file = join(dir, "lists.json");
const me = { userId: "u1" }, other = { userId: "u2" };
const agent = new EmailListAgent({ file });

const csv = "Email,First Name,company\nAnn@Example.com,Ann,Acme\nbad-email,Bob,X\nann@example.com,Dup,Y\nc@d.io,Cy,\"Foo, Inc\"\n";
const up = await agent.call("upload_email_list", { name: "Q4", csv }, me);
assert.equal(up.uploaded, 2);
assert.deepEqual(up.skippedDetails.map((s) => s.reason), ["invalid email", "duplicate"]);

const v = await agent.call("view_email_list", { listId: up.listId }, me);
assert.equal(v.total, 2);
assert.equal(v.rows[0].email, "ann@example.com");
assert.equal(v.rows[1].company, "Foo, Inc");
assert.equal((await agent.call("view_email_list", { listId: up.listId, search: "foo" }, me)).total, 1);
assert.equal((await agent.call("list_email_lists", {}, me)).lists.length, 1);

// private per user
await assert.rejects(() => agent.call("view_email_list", { listId: up.listId }, other), /Unknown email list/);
assert.equal((await agent.call("list_email_lists", {}, other)).lists.length, 0);

// edit exactly one row
const e = await agent.call("edit_email_list_row", { listId: up.listId, email: "c@d.io", fields: { First_Name: "Cyrus", company: null } }, me);
assert.equal(e.after.First_Name, "Cyrus");
assert.equal("company" in e.after, false);
assert.equal(e.before.First_Name, "Cy");
const after = await agent.call("view_email_list", { listId: up.listId }, me);
assert.equal(after.rows[0].First_Name, "Ann", "other rows untouched");
await assert.rejects(() => agent.call("edit_email_list_row", { listId: up.listId, rowId: e.after.rowId, fields: { email: "nope" } }, me), /valid email/);
await assert.rejects(() => agent.call("edit_email_list_row", { listId: up.listId, rowId: e.after.rowId, fields: { email: "ann@example.com" } }, me), /already uses/);
await assert.rejects(() => agent.call("upload_email_list", { name: "x", rows: [{ email: "zzz" }] }, me), /No valid email/);

// persisted across restart
const again = new EmailListAgent({ file });
assert.equal((await again.call("view_email_list", { listId: up.listId }, me)).rows[1].First_Name, "Cyrus");
rmSync(dir, { recursive: true, force: true });
console.log("email-lists ok");
