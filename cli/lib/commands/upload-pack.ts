// forge upload-pack <container> [<path>]
//
// Invoked by the dev machine's `git fetch` through
// remote.<c>.uploadpack = "forge upload-pack <c>": over SSH, git runs
// `forge upload-pack <c> '<path>'` on the host. forge then execs
// git-upload-pack inside the container as aiuser, so the host never runs git
// in a repository the agent writes. For a team container the path git appends
// is ignored: the repository served is always /workspace. A project executor
// (user.forge.role=executor) has one clone per repository: the path names the
// clone, and only the form /workspace/<repository> is accepted.
//
// stdout carries the git protocol. This command must never write to it, not
// even a progress line: errors go through forge.ts's catch, on stderr.
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { loadConfig } from "../config.ts";
import { containerRepo, isRunning } from "../containers.ts";
import { configGet, startInstance, uploadPackArgv } from "../incus.ts";
import { configPath } from "../paths.ts";
import { validateContainerName } from "../validate.ts";

// Le clone d'un dépôt chez un exécuteur : un nom de dépôt de projet, rien d'autre.
const EXECUTOR_CLONE = /^\/workspace\/[a-z][a-z0-9-]*$/;

// Les dépôts que déclare le projet de la config, quand elle se lit et en a un ;
// sinon null, et seule la forme du chemin compte.
function declaredRepositories(): string[] | null {
  try {
    const project = loadConfig(configPath()).project;
    return project === null ? null : Object.keys(project.repositories);
  } catch {
    return null;
  }
}

export async function cmdUploadPack(
  ctx: Context,
  container: string | undefined,
  gitProtocol: string | undefined = process.env.GIT_PROTOCOL,
  path?: string,
): Promise<number> {
  // The name comes from an SSH client: validated before any call.
  validateContainerName(container ?? "");
  const name = container as string;

  let dir = "/workspace";
  if (!(await containerRepo(ctx, name))) {
    if ((await configGet(ctx, name, "user.forge.role")) !== "executor") {
      throw new ForgeError(`${name} is not a forge container (no user.forge.repo)`);
    }
    const declared = declaredRepositories();
    if (path === undefined || !EXECUTOR_CLONE.test(path) ||
      (declared !== null && !declared.includes(path.slice("/workspace/".length)))) {
      throw new ForgeError(`${name} is a project executor: the path must be /workspace/<repository>, a repository of the project`);
    }
    dir = path;
  }
  if (!(await isRunning(ctx, name))) {
    await mustSucceed("incus start", startInstance(ctx, name));
  }
  return ctx.attach(uploadPackArgv(name, gitProtocol, dir));
}
