// forge hc-exec <container> <line>   (on the host)
//
// The host end of Herdr App's transport: runs hc's own shell line in a project's
// container, as aiuser. The line comes from the human's hc client, through the
// human's SSH session: never from an agent. Only the containers of the host's
// project are served: no other container of the host, and no name that is not
// one, reaches `incus exec`.
//
// hc starts its core on first use, at the place its environment names. A
// container still being provisioned, or one that has just booted and has no
// /run/user/<uid> yet, would get its core somewhere forge's own hc never
// looks: both are refused (hc's client retries), and the line runs with the
// same variables as forge's hcArgv.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { loadConfig } from "../config.ts";
import { provisioningMarker } from "../containers.ts";
import { HC_ENV, HC_RUNTIME_DIR } from "../hc-session.ts";
import { incus } from "../incus.ts";
import { configPath } from "../paths.ts";
import { projectMemberNamed } from "../project.ts";
import { validateContainerName } from "../validate.ts";

export async function cmdHcExec(ctx: Context, container: string | undefined, line: string | undefined): Promise<number> {
  validateContainerName(container ?? "");
  if (line === undefined || line === "") throw new ForgeError("Usage: forge hc-exec <container> <line>");
  projectMemberNamed(loadConfig(configPath()).project, container as string);
  if (await provisioningMarker(ctx, container as string) !== null) {
    throw new ForgeError(`${container} is still being provisioned: try again when forge team converge has finished.`);
  }
  const ready = await ctx.exec(incus("exec", container as string, "--", "test", "-d", HC_RUNTIME_DIR));
  if (ready.code !== 0) {
    throw new ForgeError(`${container} is not ready: ${HC_RUNTIME_DIR} does not exist yet (the container is still booting).`);
  }
  // `su -` garde le shell de login (PATH, HOME) mais en perd l'environnement : les
  // variables de hc se posent dans la commande, pas devant `su`.
  const exports = Object.entries(HC_ENV).map(([k, v]) => `${k}='${v}'`).join(" ");
  return ctx.attach(incus("exec", "-T", container as string, "--", "su", "-", "aiuser", "-c", `export ${exports}; ${line}`));
}
