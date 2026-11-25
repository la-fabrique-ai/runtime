// Le canal de l'API dans chaque container d'un projet : un device `proxy`
// d'Incus, qui fait de la socket de l'hôte une socket du container, et
// `forge-team`, le client qu'un exécuteur lance.
//
// La socket est dans /var/lib/forge, un dossier de root : l'agent ne peut pas
// la supprimer, et le tmpfs que systemd monte sur /run au démarrage ne peut pas
// la cacher.
import { join } from "node:path";
import type { Context } from "../context.ts";
import { mustSucceed } from "../context.ts";
import { pushFile } from "../commands/provision.ts";
import { deviceNames, incus } from "../incus.ts";
import { repoRoot } from "../paths.ts";
import { hostSocketPath } from "./server.ts";

export const API_DEVICE = "forge-api";
export const CONTAINER_SOCKET = "/var/lib/forge/api.sock";
const API_SERVICE = "forge-api.service";

// Le propriétaire de la socket dans le container : aiuser (1001) dans un
// exécuteur, l'utilisateur de l'orchestrateur (forge-orch, 1002) dans le
// container de contrôle.
export type SocketOwner = { uid: number; gid: number };
export const AIUSER_SOCKET: SocketOwner = { uid: 1001, gid: 1001 };
export const ORCH_SOCKET: SocketOwner = { uid: 1002, gid: 1002 };

export async function ensureApiAccess(ctx: Context, name: string, owner: SocketOwner): Promise<void> {
  const devices = await deviceNames(ctx, name);
  await mustSucceed(`create /var/lib/forge in ${name}`, ctx.exec(incus("exec", name, "--", "mkdir", "-p", "/var/lib/forge")));
  if (!devices.includes(API_DEVICE)) {
    // `bind=instance` : la socket d'écoute est dans le container, la connexion
    // part vers la socket de l'hôte. uid, gid et mode : seul `owner` s'y connecte.
    await mustSucceed(`add the API channel to ${name}`, ctx.exec(incus("config", "device", "add", name, API_DEVICE, "proxy",
      "bind=instance", `listen=unix:${CONTAINER_SOCKET}`, `connect=unix:${hostSocketPath(name)}`,
      `uid=${owner.uid}`, `gid=${owner.gid}`, "mode=0600")));
  }
  await pushFile(ctx, "push forge-team", join(repoRoot(), "container", "forge-team"), name, "/usr/local/bin/forge-team", 0, "755");
}

// Le service lit la config au démarrage : un container ajouté n'a sa socket
// qu'après un redémarrage. `try-restart` ne démarre pas un service arrêté, et
// un échec n'arrête pas converge : les containers sont prêts, le service se
// relance à la main.
export async function restartApiService(ctx: Context): Promise<void> {
  const runtime = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid!()}`;
  const r = await ctx.exec(["systemctl", "--user", "try-restart", API_SERVICE], { env: { XDG_RUNTIME_DIR: runtime } });
  if (r.code !== 0) {
    ctx.err(`WARNING: could not restart ${API_SERVICE} (${r.stderr.trim() || `exit code ${r.code}`}): ` +
      `the API will not know the new containers until it restarts (systemctl --user restart ${API_SERVICE}).`);
  }
}
