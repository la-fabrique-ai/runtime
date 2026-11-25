import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import { parseArgs } from "../cli/orchestrator.ts";

const script = resolve(import.meta.dirname, "..", "cli", "orchestrator.ts");

test("parseArgs lit toutes les options", () => {
  assert.deepEqual(
    parseArgs(["--base", "/b", "--socket", "/s", "--state", "/st", "--prefix", "X", "--poll-seconds", "5"]),
    { base: "/b", socket: "/s", state: "/st", prefix: "X", pollSeconds: 5 },
  );
});

test("parseArgs : valeurs par défaut", () => {
  const a = parseArgs(["--base", "/b", "--socket", "/s", "--state", "/st"]);
  assert.equal(a.prefix, "T");
  assert.equal(a.pollSeconds, 10);
});

test("parseArgs refuse un intervalle trop court et un --base manquant", () => {
  assert.throws(() => parseArgs(["--base", "/b", "--socket", "/s", "--state", "/st", "--poll-seconds", "1"]));
  assert.throws(() => parseArgs(["--socket", "/s", "--state", "/st"]));
});

test("le processus distribue, puis sort 0 sur SIGTERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-orch-"));
  const base = join(dir, "base");
  const state = join(dir, "state");
  const sock = join(dir, "host.sock");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(base);
  const tickets = openMarkdownBase(base);
  const t = await tickets.createTicket({ title: "t", description: "d", priority: 1, repositories: [{ name: "web", base: "main" }] });
  await tickets.setTicketStatus({ id: t.id, status: "dev" });
  await tickets.createSubtask({ ticket: t.id, repository: "web", position: 1, rank: 1, kind: "implementation", text: "s" });

  let onAssign: () => void = () => {};
  const assigned = new Promise<void>((r) => (onAssign = r));
  const sockets: import("node:net").Socket[] = [];
  const server = createServer((s) => {
    sockets.push(s);
    let buf = "";
    s.on("error", () => {});
    s.on("data", (d) => {
      buf += d.toString();
      if (!buf.includes("\n")) return;
      const req = JSON.parse(buf.split("\n")[0]!);
      buf = "";
      if (req.op === "status") {
        s.write(JSON.stringify({ ok: true, executors: [{ name: "ex-1", mission: null, session: "none" }] }) + "\n");
      } else if (req.op === "events") {
        s.write(JSON.stringify({ ok: true, events: [] }) + "\n");
      } else {
        if (req.op === "assign") onAssign();
        s.write(JSON.stringify({ ok: true }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const child = spawn(process.execPath, [script, "--base", base, "--socket", sock, "--state", state], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  try {
    await assigned;
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    assert.match(out, /\[orchestrator\] assigned T-1\.1 to ex-1/);
    assert.equal(statSync(state).mode & 0o777, 0o700);
  } finally {
    child.kill("SIGKILL");
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
