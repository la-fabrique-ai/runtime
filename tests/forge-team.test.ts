import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SOURCE = join(import.meta.dirname, "..", "container", "forge-team");

let dir: string;
// Une copie hors du dépôt : dans le container, /usr/local/bin n'a pas de
// package.json, le script y est du CommonJS ; sous le `type: module` du dépôt
// il serait lu comme un module.
let forgeTeam: string;
let server: Server;
let received: string[];
// Ce que le faux serveur répond à la prochaine requête ; null : il ferme sans répondre.
let answer: string | null;
// Les requêtes `status` reçues.
let probes: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "forge-team-"));
  forgeTeam = join(dir, "forge-team");
  copyFileSync(SOURCE, forgeTeam);
  received = [];
  probes = 0;
  answer = '{"ok":true,"id":7}';
  server = createServer((socket) => {
    let line = "";
    socket.setEncoding("utf8");
    socket.on("data", (c) => {
      line += c;
      if (line.includes("\n")) {
        if (line.trimEnd() === '{"op":"status"}') probes++;
        else received.push(line.trimEnd());
        if (answer === null) socket.end();
        else socket.end(`${answer}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(dir, "api.sock"), resolve));
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

// Lance forge-team contre la socket de test, `stdin` sur son entrée standard.
function run(args: string[], stdin: string, socket = join(dir, "api.sock")): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [forgeTeam, ...args], { env: { ...process.env, FORGE_API_SOCKET: socket } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

test("done sends the bare verb; status prints the mission when the reply has its shape", async () => {
  const r = await run(["done"], "");
  assert.deepEqual([r.code, r.stdout], [0, "ok 7\n"]);
  assert.equal(received[0], '{"op":"done"}');
  answer = '{"ok":true,"mission":{"kind":"dev","ticket":"T-1","subtask":"T-1.1","repository":"web","branch":"agent/T-1.1","base":"origin/main"}}';
  const held = await run(["status"], "");
  assert.deepEqual([held.code, held.stdout],
    [0, "ok\nmission: T-1.1 ticket=T-1 repository=web branch=agent/T-1.1 base=origin/main\n"]);
  answer = '{"ok":true,"mission":null}';
  assert.equal((await run(["status"], "")).stdout, "ok\nmission: none\n");
});

test("a refusal exits 1 with the reason on stderr; an unreachable socket exits 2", async () => {
  answer = '{"ok":false,"error":"nothing committed on agent/T-1.1 beyond origin/main"}';
  const refused = await run(["done"], "");
  assert.deepEqual([refused.code, refused.stdout, refused.stderr], [1, "", "forge-team: nothing committed on agent/T-1.1 beyond origin/main\n"]);
  const nowhere = await run(["status"], "", join(dir, "absent.sock"));
  assert.equal(nowhere.code, 2);
  assert.match(nowhere.stderr, /cannot reach the forge API/);
});

test("a connection closed without an answer says the request may have gone through", async () => {
  answer = null;
  const r = await run(["done"], "");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no answer from the forge API: the request may have been carried out; check forge-team status/);
});

test("only done and status exist: any other verb prints the usage and exits 64, without a request", async () => {
  for (const args of [["message", "agent-x", "Salut"], ["assign", "x", "t"], ["release", "x"], ["ask", "Quoi ?"], ["bogus"], [], ["done", "extra"]]) {
    const r = await run(args, "texte");
    assert.equal(r.code, 64, args.join(" "));
    assert.match(r.stderr, /usage: forge-team done.*\n\s+forge-team status/);
  }
  assert.deepEqual(received, []);
  assert.equal(probes, 0);
});
