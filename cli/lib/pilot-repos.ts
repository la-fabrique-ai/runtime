// La capacité `read-repos` du Pilote : le miroir d'origine de chaque équipe,
// monté en lecture seule, et un clone de chacun dans son /workspace. Le Pilote
// conçoit à partir du code, sans pouvoir le modifier ni le publier.
import type { Context } from "./context.ts";
import { mustSucceed } from "./context.ts";
import type { ForgeConfig } from "./config.ts";
import { deviceNames, execAsAgentArgv, incus } from "./incus.ts";
import { ensureMirror, originMirrorPath } from "./mirror.ts";
import type { Member } from "./team.ts";

export const PILOT_ORIGINS = "/forge/origins";
export const PILOT_DEPOTS = "/workspace/depots";
export const pilotOriginDevice = (team: string) => `origin-${team}`;

// Idempotent : le miroir est créé s'il manque, le device ajouté s'il manque, le
// clone fait s'il manque. Une équipe retirée de la config garde son device et son clone.
export async function ensurePilotRepos(ctx: Context, cfg: ForgeConfig, m: Member): Promise<void> {
  if (m.team !== null || !m.capabilities.includes("read-repos")) return;
  const present = new Set(await deviceNames(ctx, m.name));
  for (const team of Object.keys(cfg.teams)) {
    const mirror = originMirrorPath(team);
    await ensureMirror(ctx, mirror, cfg.teams[team].repo);
    const mount = `${PILOT_ORIGINS}/${team}.git`;
    // Dit seulement ce qui se fait : un converge sur un Pilote déjà prêt reste muet.
    if (!present.has(pilotOriginDevice(team))) {
      ctx.out(`Mounting the ${team} mirror in ${m.name} (read-only)...`);
      await mustSucceed(`mount the ${team} mirror`, ctx.exec(incus("config", "device", "add", m.name,
        pilotOriginDevice(team), "disk", `source=${mirror}`, `path=${mount}`, "readonly=true")));
    }
    const depot = `${PILOT_DEPOTS}/${team}`;
    const cloned = await execAsAgentArgv(ctx, m.name, ["test", "-d", `${depot}/.git`]);
    if (cloned.code !== 0) {
      ctx.out(`Cloning ${cfg.teams[team].repo} into ${m.name}:${depot}...`);
      // Sans smudge LFS : le miroir n'a aucun objet LFS et le container n'a pas de réseau vers eux.
      await mustSucceed(`clone ${team} in ${m.name}`, execAsAgentArgv(ctx, m.name,
        ["env", "GIT_LFS_SKIP_SMUDGE=1", "git", "clone", "--no-local", mount, depot]));
    }
  }
}
