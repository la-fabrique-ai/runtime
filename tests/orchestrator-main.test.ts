import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openMarkdownBase } from "../cli/lib/tickets/markdown-base.ts";
import { parseArgs } from "../cli/orchestrator.ts";

const script = resolve(import.meta.dirname, "..", "cli", "orchestrator.ts");

test("parseArgs lit toutes les options", () => {
  assert.deepEqual(
    parseArgs(["--base", "/b", "--socket", "/s", "--state", "/st", "--prefix", "X", "--poll-seconds", "5"]),
    { base: "/b", socket: "/s", state: "/st", prefix: "X", pollSeconds: 5, channel: null, channelGroup: null },
  );
  assert.deepEqual(
    parseArgs(["--base", "/b", "--socket", "/s", "--state", "/st", "--channel", "/c.sock", "--channel-group", "1001"]),
    { base: "/b", socket: "/s", state: "/st", prefix: "T", pollSeconds: 10, channel: "/c.sock", channelGroup: 1001 },
  );
  assert.throws(() => parseArgs(["--base", "/b", "--socket", "/s", "--state", "/st", "--channel-group", "1001"]));
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
        s.write(JSON.stringify({ ok: true, events: [], last: 0 }) + "\n");
      } else {
        if (req.op === "assign") onAssign();
        s.write(JSON.stringify({ ok: true }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const channel = join(dir, "channel.sock");
  const child = spawn(process.execPath, [script, "--base", base, "--socket", sock, "--state", state, "--channel", channel], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  try {
    await assigned;
    // Le canal local répond, avec les problèmes du dernier tour.
    const { connect } = await import("node:net");
    const reply = await new Promise<string>((resolve, reject) => {
      const c = connect(channel);
      let o = "";
      c.setEncoding("utf8");
      c.on("connect", () => c.write('{"op":"problems"}\n'));
      c.on("data", (d: string) => (o += d));
      c.on("close", () => resolve(o));
      c.on("error", reject);
    });
    assert.deepEqual(JSON.parse(reply), { ok: true, problems: [] });
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

test("une ligne de problème identique n'est imprimée qu'une fois d'un tour à l'autre", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-orch-"));
  const base = join(dir, "base");
  const sock = join(dir, "host.sock");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(base);
  const tickets = openMarkdownBase(base);
  const t = await tickets.createTicket({ title: "t", description: "d", priority: 1, repositories: [{ name: "web", base: "main" }] });
  await tickets.setTicketStatus({ id: t.id, status: "dev" });
  await tickets.createSubtask({ ticket: t.id, repository: "web", position: 1, rank: 1, kind: "implementation", text: "s" });

  // Un fichier de sous-tâche illisible : le même problème revient à chaque tour
  // (un assign refusé, lui, attend son délai avant d'être retenté).
  writeFileSync(join(base, t.id, "subtasks", "2.md"), "pas un en-tête\n\nx");
  let statuses = 0;
  let onSecond: () => void = () => {};
  const second = new Promise<void>((r) => (onSecond = r));
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
        if (++statuses === 2) onSecond();
        s.write(JSON.stringify({ ok: true, executors: [{ name: "ex-1", mission: null, session: "none" }] }) + "\n");
      } else if (req.op === "events") {
        s.write(JSON.stringify({ ok: true, events: [], last: 0 }) + "\n");
      } else {
        s.write(JSON.stringify({ ok: true }) + "\n");
      }
    });
  });
  await new Promise<void>((r) => server.listen(sock, r));
  const child = spawn(process.execPath, [script, "--base", base, "--socket", sock, "--state", join(dir, "state"), "--poll-seconds", "2"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  try {
    // SIGTERM pendant le second tour : il s'achève (et imprime) avant la sortie.
    await second;
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    const lines = out.split("\n").filter((l) => l.startsWith("[orchestrator] problem: "));
    assert.equal(lines.length, 1, out);
    assert.match(lines[0], /^\[orchestrator\] problem: T-1: /);
  } finally {
    child.kill("SIGKILL");
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("une base absente est fatale : sortie 1, [orchestrator] fatal: sur stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-orch-"));
  try {
    const child = spawn(process.execPath, [script, "--base", join(dir, "nope"), "--socket", join(dir, "s"), "--state", join(dir, "state")], { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const code = await new Promise<number | null>((r) => child.on("exit", (c) => r(c)));
    assert.equal(code, 1);
    assert.match(err, /^\[orchestrator\] fatal: /m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
