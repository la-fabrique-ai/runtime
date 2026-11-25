import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExecOptions, ExecResult } from "../cli/lib/context.ts";
import { execAdapter, OPS, serveLine } from "../cli/lib/tickets/protocol.ts";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import { fakeContext } from "./lib/fake-context.ts";

type Exec = (argv: string[], o?: ExecOptions) => Promise<ExecResult>;

function client(exec: Exec, opts: { credentialFile?: string } = {}) {
  const ctx = fakeContext();
  ctx.exec = exec;
  return execAdapter(ctx, { argv: ["my-adapter", "--x"], ...opts });
}

const fixed = (stdout: string, code = 0): Exec => async () => ({ code, stdout, stderr: "" });

test("un aller-retour createTicket puis getTicket à travers l'adaptateur", async () => {
  const base = openMarkdownBase(mkdtempSync(join(tmpdir(), "proto-")));
  const c = client(async (_a, o) => ({ code: 0, stdout: (await serveLine(base, o!.input!)) + "\n", stderr: "" }));
  const t = await c.createTicket({ title: "a", description: "d", repositories: [{ name: "api", base: "main" }] });
  assert.deepEqual(await c.getTicket({ id: t.id }), t);
  assert.equal((await c.listTickets({})).tickets.length, 1);
});

test("serveLine refuse les lignes et les opérations invalides, sans pile", async () => {
  const base = openMarkdownBase(mkdtempSync(join(tmpdir(), "proto-")));
  for (const line of ['{"op":"constructor","args":{}}', '{"op":"__proto__","args":{}}', '{"op":"getTicket","args":[]}', "not json"]) {
    const r = JSON.parse(await serveLine(base, line));
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.error, /\n\s+at /);
  }
  assert.ok(OPS.includes("getTicket") && OPS.length === 15);
});

test("une erreur inattendue ne donne que internal error", async () => {
  const base = openMarkdownBase(mkdtempSync(join(tmpdir(), "proto-")));
  base.getTicket = async () => { throw new Error("secret /home/x"); };
  assert.deepEqual(JSON.parse(await serveLine(base, '{"op":"getTicket","args":{"id":"T-1"}}')), { ok: false, error: "internal error" });
});

const bogus = '{"ok":true,"result":{"id":"T-1","title":"a","description":"","status":"bogus","priority":1,"repositories":[]}}';
for (const [name, exec] of [
  ["code 1", fixed("", 1)],
  ["timeout", async () => ({ code: 124, stdout: "", stderr: "", timedOut: true })],
  ["objet vide", fixed("{}")],
  ["deux lignes", fixed('{"ok":true,"result":1}\n{"ok":true,"result":2}\n')],
  ["résultat invalide", fixed(bogus)],
] as [string, Exec][]) {
  test(`un adaptateur en échec : ${name}`, async () => {
    await assert.rejects(client(exec).getTicket({ id: "T-1" }), (e: Error) => e.message.startsWith("adapter my-adapter:"));
  });
}

test("le message d'erreur de l'adaptateur est borné et nettoyé", async () => {
  const line = JSON.stringify({ ok: false, error: "bad\u001b[31m" + "x".repeat(900) });
  await assert.rejects(client(fixed(line)).getTicket({ id: "T-1" }), (e: Error) => e.message.length < 600 && !e.message.includes("\u001b"));
});

test("le fichier d'identifiants passe par l'environnement, pas par la requête", async () => {
  let seen: ExecOptions | undefined;
  const c = client(async (_a, o) => { seen = o; return { code: 0, stdout: '{"ok":true,"result":{"tickets":[],"problems":[]}}', stderr: "" }; }, { credentialFile: "/run/cred" });
  await c.listTickets({});
  assert.equal(seen!.env!.FORGE_ADAPTER_CREDENTIAL_FILE, "/run/cred");
  assert.ok(!seen!.input!.includes("/run/cred"));
  assert.equal(seen!.timeoutMs, 30_000);
});
