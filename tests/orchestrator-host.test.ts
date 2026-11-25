import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostError, socketHost, type MissionSpec } from "../cli/lib/orchestrator/host.ts";

// Serveur de test : répond à chaque connexion par la ligne scriptée (ou se tait si null).
async function withServer(
  reply: string | null,
  fn: (path: string, received: string[]) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "forge-host-"));
  const path = join(dir, "host.sock");
  const received: string[] = [];
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => {
    sockets.push(s);
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      if (buf.includes("\n")) {
        received.push(buf.split("\n")[0]);
        if (reply !== null) s.write(reply + "\n");
      }
    });
    s.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(path, r));
  try {
    await fn(path, received);
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}

const mission: MissionSpec = {
  kind: "dev", ticket: "T-1", subtask: "a", repository: "r", branch: "agent/x", base: "main", instruction: "do it",
};

test("status renvoie les exécuteurs validés", async () => {
  const reply = JSON.stringify({
    ok: true,
    executors: [
      { name: "agent-executor-1", mission: null, session: "idle" },
      { name: "agent-executor-2", mission: { kind: "dev", ticket: "T-1", subtask: "a", repository: "r", branch: "b", base: "main" }, session: "working" },
    ],
  });
  await withServer(reply, async (path, received) => {
    const r = await socketHost(path).status();
    assert.equal(r.length, 2);
    assert.equal(r[1].mission?.branch, "b");
    assert.equal(received[0], '{"op":"status"}');
  });
});

test("assign envoie exactement la ligne attendue", async () => {
  await withServer('{"ok":true}', async (path, received) => {
    await socketHost(path).assign("agent-executor-1", mission);
    assert.equal(received[0], JSON.stringify({ op: "assign", to: "agent-executor-1", mission }));
  });
});

test("release et events", async () => {
  await withServer('{"ok":true}', async (path, received) => {
    await socketHost(path).release("e1");
    assert.equal(received[0], '{"op":"release","to":"e1"}');
  });
  const ev = { id: 3, kind: "done", executor: "e", ticket: "T", subtask: "s", branch: "b" };
  await withServer(JSON.stringify({ ok: true, events: [ev] }), async (path, received) => {
    assert.deepEqual(await socketHost(path).events(2), [ev]);
    assert.equal(received[0], '{"op":"events","after":2}');
  });
});

test("un refus de l'hôte devient une HostError", async () => {
  await withServer('{"ok":false,"error":"busy"}', async (path) => {
    await assert.rejects(socketHost(path).release("e"), (e) => e instanceof HostError && /busy/.test(e.message));
  });
});

test("une réponse mal formée est refusée", async () => {
  await withServer('{"ok":true,"events":[{"id":"1"}]}', async (path) => {
    await assert.rejects(socketHost(path).events(0), HostError);
  });
  await withServer('{"ok":true,"executors":[{"name":"a","mission":null,"session":"idle","extra":1}]}', async (path) => {
    await assert.rejects(socketHost(path).status(), HostError);
  });
  await withServer('{"ok":true,"executors":[{"name":"a","mission":null,"session":"nope"}]}', async (path) => {
    await assert.rejects(socketHost(path).status(), HostError);
  });
  await withServer("pas du json", async (path) => {
    await assert.rejects(socketHost(path).status(), /status/);
  });
});

test("un hôte muet déclenche le délai", async () => {
  await withServer(null, async (path) => {
    await assert.rejects(socketHost(path, { timeoutMs: 200 }).status(), (e) => e instanceof HostError && /status/.test(e.message));
  });
});

test("un socket absent est une HostError", async () => {
  await assert.rejects(socketHost("/nonexistent/forge.sock").status(), HostError);
});
