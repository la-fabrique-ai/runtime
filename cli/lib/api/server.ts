// Le serveur de l'API : une socket Unix de l'hôte par container du projet.
// L'appelant est le container dont la socket a reçu la connexion, jamais ce que
// la requête dit de lui ; un device `proxy` d'Incus place cette socket dans le
// container (api/access.ts). Les requêtes sont des verbes de mission (missions.ts).
import { type Server, type Socket, createServer } from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ForgeError } from "../context.ts";
import { apiRuntimeDir } from "../paths.ts";
import { projectMembers } from "../project.ts";
import { handleMission, type ApiDeps, type ApiReply } from "./missions.ts";
import { REQUEST_MAX } from "./protocol.ts";

// Une socket Unix tient en 107 octets (sun_path de Linux, moins le zéro final).
const SOCKET_PATH_MAX = 107;
// Une connexion qui n'a pas fini sa ligne en 10 s est coupée.
const LINE_TIMEOUT_MS = 10_000;

// `lineTimeoutMs` : pour les tests, qui n'attendent pas 10 s.
export type ServeDeps = ApiDeps & { lineTimeoutMs?: number };

export function hostSocketPath(container: string): string {
  const path = join(apiRuntimeDir(), `${container}.sock`);
  if (Buffer.byteLength(path) > SOCKET_PATH_MAX) {
    throw new ForgeError(`the API socket path ${path} is longer than ${SOCKET_PATH_MAX} bytes: ` +
      "shorten FORGE_API_RUNTIME");
  }
  return path;
}

const reply = (socket: Socket, r: unknown) => socket.end(`${JSON.stringify(r)}\n`);

// Ce qu'une socket sert : le nom du container appelant et le traitement d'une ligne.
type Listener = { name: string; handle: (line: string) => Promise<ApiReply> };

// Les sockets à ouvrir : une par container du projet, aucune sans projet.
export function listeners(d: ApiDeps): Listener[] {
  if (d.cfg.project === null) return [];
  return projectMembers(d.cfg.project).map((m) => ({ name: m.name, handle: (line: string) => handleMission(d, m, line) }));
}

// Une requête par connexion : la première ligne, la réponse, puis la fermeture.
function onConnection(d: ServeDeps, caller: Listener, socket: Socket): void {
  const chunks: Buffer[] = [];
  let size = 0;
  socket.setTimeout(d.lineTimeoutMs ?? LINE_TIMEOUT_MS, () => socket.destroy());
  socket.on("error", () => socket.destroy());
  const onData = (chunk: Buffer) => {
    chunks.push(chunk);
    size += chunk.length;
    const all = Buffer.concat(chunks);
    const eol = all.indexOf(0x0a);
    if (eol < 0 && size <= REQUEST_MAX) return;
    socket.off("data", onData);
    socket.pause();
    // La ligne est lue : le délai ne vaut plus. Armé, il couperait une demande
    // plus lente que lui (un `assign` sur un hôte chargé) qui aboutirait quand
    // même, sa réponse perdue : l'agent la croirait échouée et la referait.
    socket.setTimeout(0);
    if (eol < 0 || eol > REQUEST_MAX) return reply(socket, { ok: false, error: "request too long" });
    caller.handle(all.subarray(0, eol).toString("utf8")).then(
      (r) => reply(socket, r),
      (e) => {
        d.ctx.err(`forge api: ${caller.name}: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
        reply(socket, { ok: false, error: "internal error" });
      });
  };
  socket.on("data", onData);
}

// Résout quand chaque socket est fermée (le signal), leurs fichiers retirés.
export async function serveApi(d: ServeDeps, signal: AbortSignal): Promise<void> {
  const dir = apiRuntimeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const open = new Set<Socket>();
  const servers: { server: Server; path: string }[] = [];
  const close = () => Promise.all(servers.map(({ server, path }) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    for (const s of open) s.destroy();
    rmSync(path, { force: true });
  })));
  try {
    for (const m of listeners(d)) {
      const path = hostSocketPath(m.name);
      // Une socket d'un arrêt brutal : listen refuserait l'adresse.
      rmSync(path, { force: true });
      const server = createServer((socket) => {
        open.add(socket);
        socket.on("close", () => open.delete(socket));
        onConnection(d, m, socket);
      });
      servers.push({ server, path });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(path, () => {
          server.off("error", reject);
          resolve();
        });
      });
      chmodSync(path, 0o600);
    }
  } catch (e) {
    await close();
    throw e;
  }
  // Sans container qui ait besoin d'une socket (un hôte sans projet), rien ne
  // retiendrait le process : un minuteur le garde en vie jusqu'au signal.
  const alive = setInterval(() => {}, 2 ** 30);
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  clearInterval(alive);
  await close();
}
