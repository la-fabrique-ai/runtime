// forge api serve (DX 5, §5.4) : le service qui répond aux containers. Lancé par
// l'unité systemd de l'utilisateur forge, que le rôle Ansible forge_users installe.
import { readFileSync } from "node:fs";
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { loadConfig } from "../config.ts";
import { Journal, journalPath } from "../api/journal.ts";
import { listeners, serveApi } from "../api/server.ts";
import { configPath } from "../paths.ts";
import { requireClaudeToken } from "./provision.ts";

const USAGE = "Usage: forge api serve";

// Les secrets que forge a distribués : un texte qui en contient un est refusé,
// qu'il vienne d'un agent (l'API) ou de l'humain (`forge team answer`). Avant
// `forge install` (le service démarre avec l'hôte) il n'y a pas de token, donc
// rien à refuser : `team converge` relance le service quand il y en a un.
export function handedOutSecrets(_ctx: Context): string[] {
  try {
    return [readFileSync(requireClaudeToken(), "utf8").trim()];
  } catch (e) {
    if (!(e instanceof ForgeError)) throw e;
    return [];
  }
}

export async function cmdApi(ctx: Context, sub: string | undefined): Promise<number> {
  if (sub !== "serve") throw new ForgeError(USAGE);
  const cfg = loadConfig(configPath());
  // Refusés avant le journal et avant tout autre agent.
  const secrets = handedOutSecrets(ctx);
  if (secrets.length === 0) ctx.out("forge api: no Claude token on this host yet");
  const journal = Journal.open(journalPath());
  const stop = new AbortController();
  process.once("SIGTERM", () => stop.abort());
  process.once("SIGINT", () => stop.abort());
  const deps = { ctx, cfg, journal, secrets, now: () => new Date() };
  ctx.out(`forge api: serving ${listeners(deps).length} socket(s)`);
  await serveApi(deps, stop.signal);
  return 0;
}
