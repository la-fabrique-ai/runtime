import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// `channel` : la socket du canal local (le container de contrôle) ; absente par défaut.
function run(
  args: string[], stdin: string, socket = join(dir, "api.sock"), channel = join(dir, "no-channel.sock"),
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [forgeTeam, ...args], { env: { ...process.env, FORGE_API_SOCKET: socket, FORGE_CHANNEL_SOCKET: channel } });
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
  assert.equal(received[0], '{"op":"done","report":null}');
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

test("any other verb, or a bad argument, prints the usage and exits 64, without a request", async () => {
  for (const args of [["message", "agent-x", "Salut"], ["assign", "x", "t"], ["release", "x"], ["ask", "Quoi ?"], ["ask", "--recommended-file"], ["bogus"], [], ["done", "extra"], ["status", "x"]]) {
    const r = await run(args, "texte");
    assert.equal(r.code, 64, args.join(" "));
    assert.match(r.stderr, /usage: forge-team done \[--report-file <file>\] \[--qa-report-file <file>\]\n\s+forge-team ask \[--recommended-file <file>\].*\n\s+forge-team status/);
  }
  assert.deepEqual(received, []);
  assert.equal(probes, 0);
});

test("done --report-file sends the file; a missing report file exits 64 and sends nothing", async () => {
  const report = join(dir, "r.md");
  writeFileSync(report, "Did x.\n");
  await run(["done", "--report-file", report], "");
  assert.equal(received[0], JSON.stringify({ op: "done", report: "Did x.\n" }));
  const missing = await run(["done", "--report-file", join(dir, "missing.md")], "");
  assert.equal(missing.code, 64);
  assert.equal(received.length, 1);
});

// Le container de contrôle : la socket du canal existe (ici, celle du faux serveur).
const control = (args: string[], stdin = "") => run(args, stdin, join(dir, "absent.sock"), join(dir, "api.sock"));

test("control: create-stack sends the JSON array read on stdin; a stdin that is not an array exits 64", async () => {
  answer = '{"ok":true,"subtasks":["T-1.1","T-1.2"]}';
  const list = [{ repository: "web", text: "one" }, { repository: "api", text: "two" }];
  const r = await control(["create-stack", "T-1"], JSON.stringify(list));
  assert.deepEqual([r.code, r.stdout], [0, "ok T-1.1 T-1.2\n"]);
  assert.equal(received[0], JSON.stringify({ op: "create-stack", id: "T-1", subtasks: list }));
  assert.equal((await control(["create-stack", "T-1"], '{"a":1}')).code, 64);
  assert.equal(received.length, 1);
});

test("control: ticket prints a request without answer as WAITING", async () => {
  answer = JSON.stringify({
    ok: true,
    ticket: { id: "T-1", title: "Paginate", description: "d", status: "dev", priority: 2, repositories: [{ name: "web", base: "main" }] },
    subtasks: [], comments: [],
    requests: [{ id: "1", ticket: "T-1", subtask: "T-1.1", text: "Which limit?", recommended: null, answer: null }],
  });
  const r = await control(["ticket", "T-1"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /request 1 on T-1\.1: WAITING\nWhich limit\?\n/);
});

test("with the channel's socket, done is a usage error; without it, tickets is", async () => {
  const done = await control(["done"]);
  assert.equal(done.code, 64);
  assert.match(done.stderr, /usage: forge-team tickets/);
  const tickets = await run(["tickets"], "");
  assert.equal(tickets.code, 64);
  assert.deepEqual(received, []);
});

test("ask sends stdin as the question and the file as recommended, trailing newlines (and carriage returns) removed; it says the container is about to be released", async () => {
  const file = join(dir, "r.md");
  writeFileSync(file, "100 per page\n\n");
  const r = await run(["ask", "--recommended-file", file], "Which limit?\n");
  assert.equal(received[0], JSON.stringify({ op: "ask", text: "Which limit?", recommended: "100 per page" }));
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^ok 7\n.*goes to the human.*released/s);
  await run(["ask"], "Which limit?");
  assert.equal(received[1], JSON.stringify({ op: "ask", text: "Which limit?", recommended: null }));
  writeFileSync(file, "100 per page\r\n");
  await run(["ask", "--recommended-file", file], "Which limit?\r\n");
  assert.equal(received[2], JSON.stringify({ op: "ask", text: "Which limit?", recommended: "100 per page" }));
  const empty = await run(["ask"], "\n");
  assert.equal(empty.code, 64);
  const missing = await run(["ask", "--recommended-file", join(dir, "none.md")], "q");
  assert.equal(missing.code, 64);
  assert.equal(received.length, 3);
});

test("done --qa-report-file sends the parsed report as qa; a file that is not JSON exits 64 and sends nothing; status says the kind", async () => {
  const qa = join(dir, "qa.json");
  writeFileSync(qa, '{"verdict":"ko","defects":[{"subtask":"T-1.1","text":"empty"}]}\n');
  const r = await run(["done", "--qa-report-file", qa], "");
  assert.equal(r.code, 0);
  assert.equal(received[0], JSON.stringify({ op: "done", report: null, qa: { verdict: "ko", defects: [{ subtask: "T-1.1", text: "empty" }] } }));
  writeFileSync(qa, "not json");
  const bad = await run(["done", "--qa-report-file", qa], "");
  assert.equal(bad.code, 64);
  assert.match(bad.stderr, /--qa-report-file/);
  assert.equal(received.length, 1);
  answer = '{"ok":true,"mission":{"kind":"qa","ticket":"T-1","subtask":"T-1.2","repository":"web","branch":"agent/T-1.2","base":"agent/T-1.1"}}';
  assert.equal((await run(["status"], "")).stdout, "ok\nmission: qa T-1 (web) branch=agent/T-1.2 base=agent/T-1.1\n");
});

test("control: create-fixes sends the stdin array, create-ticket the stdin object; anything else on stdin exits 64", async () => {
  answer = '{"ok":true,"subtasks":["T-1.3"]}';
  const fixes = [{ fixes: "T-1.1", text: "empty" }];
  const r = await control(["create-fixes", "T-1"], JSON.stringify(fixes));
  assert.deepEqual([r.code, r.stdout], [0, "ok T-1.3\n"]);
  assert.equal(received[0], JSON.stringify({ op: "create-fixes", id: "T-1", fixes }));
  assert.equal((await control(["create-fixes", "T-1"], '{"fixes":null}')).code, 64);
  answer = '{"ok":true,"id":"T-2"}';
  const t = await control(["create-ticket", "T-1"], JSON.stringify({ title: "Spinner", text: "Show it." }));
  assert.deepEqual([t.code, t.stdout], [0, "ok T-2\n"]);
  assert.equal(received[1], JSON.stringify({ op: "create-ticket", from: "T-1", title: "Spinner", text: "Show it." }));
  assert.equal((await control(["create-ticket", "T-1"], "[]")).code, 64);
  assert.equal(received.length, 2);
});
