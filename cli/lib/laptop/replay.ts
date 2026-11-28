// Replays a task's commits in a temporary worktree of the developer's clone,
// signs them with the developer's own git configuration, and pushes
// agent/<task> to GitHub. The developer's checkout is never touched. A push
// never forces, but a rewrite (a branch the cascade rebased), of a branch of
// the ticket being shipped only, under a lease on the exact commit the last
// ship pushed: if GitHub's branch moved, it is refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { printable } from "../printable.ts";
import { shippedRef, shortRef, type TaskPlan } from "./ship-plan.ts";

// No hook runs in or around the temporary worktree: its tree is the agent's.
// A relative core.hooksPath (.githooks, husky's .husky/_) resolves inside it,
// a hook manager in .git/hooks (lefthook, pre-commit) runs what that tree
// configures, and a pre-push running the tests runs the agent's code. So every
// git command here runs without hooks, which also skips git-lfs's pre-push:
// the LFS write path is designed separately.
const gitIn = (dir: string, ...args: string[]): string[] => ["git", "-C", dir, "-c", "core.hooksPath=/dev/null", ...args];

// The spec the ship commits on the top branch: `path` in the repository,
// `text` the file's whole content (the laptop holds it, from the ticket base).
export type SpecFile = { ticket: string; path: string; text: string };

// `ticket`: the ticket being shipped and its branches, the only ones a rewrite
// may replace. `spec`: for the top branch, the spec to commit on top of it,
// unless the file already holds that exact text.
export async function replayAndPush(
  ctx: Context, root: string, plan: TaskPlan,
  opts: { sign: boolean; ticket?: { id: string; branches: string[] }; spec?: SpecFile },
): Promise<"pushed" | "nothing"> {
  const branch = `agent/${plan.task}`;
  if (plan.rewrite) {
    if (!opts.ticket) throw new ForgeError(`${branch} was rewritten by a cascade: forge ship <ticket> replaces it, nothing was pushed`);
    if (!opts.ticket.branches.includes(branch)) throw new ForgeError(`${branch} is not a branch of ${opts.ticket.id}: not forced`);
    if (plan.lease === null) throw new ForgeError(`${branch}: no lease on GitHub's branch: not forced`);
  } else if (plan.commits.length === 0 && (!opts.spec || await specUnchanged(ctx, root, plan.onto, opts.spec))) {
    return "nothing";
  }

  // onto is a merge-base SHA or a full ref name, the latter read exactly: a
  // missing ref (origin/agent/<below> not fetched, a base gone) must not fall
  // back to a tag of that name.
  let start = plan.onto;
  if (!/^[0-9a-f]{40,64}$/.test(start)) {
    const r = await ctx.exec(gitIn(root, "show-ref", "--verify", "--hash", plan.onto));
    if (r.code !== 0) throw new ForgeError(`agent/${plan.task}: ${shortRef(plan.onto)} is not in this clone: nothing was pushed`);
    start = r.stdout.trim();
  }

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "forge-ship-")), "wt");
  // Ctrl-C is the natural way out of a signing prompt (a terminal pinentry, a
  // touch on a hardware key) and of an SSH key's touch at the push: a no-op
  // handler keeps node alive, so the signal still reaches git and ssh (same
  // process group), which exit non-zero, and the abort and cleanup below run
  // instead of leaking the worktree.
  const ignoreSigint = () => {};
  process.on("SIGINT", ignoreSigint);
  try {
    await mustSucceed("git worktree add", ctx.exec(gitIn(root, "worktree", "add", "--detach", tmp, start)));

    // attach, not exec: a signing key may need a terminal pinentry or a touch
    // on a hardware key, which only an inherited terminal can show.
    // --allow-empty keeps an originally empty commit; a commit that becomes
    // empty on `onto` still stops like a conflict.
    // The advice texts tell how to continue a pick in a worktree about to be deleted.
    if (plan.commits.length > 0) {
      const code = await ctx.attach(gitIn(tmp,
        "-c", "advice.mergeConflict=false", "-c", "advice.resolveConflict=false",
        "cherry-pick", "--allow-empty", ...(opts.sign ? ["-S"] : []), ...plan.commits,
      ));
      if (code !== 0) throw new ForgeError(await stoppedAt(ctx, tmp, plan));
    }
    if (opts.spec) await commitSpec(ctx, tmp, branch, opts.spec, opts.sign);

    // The push's output is captured to read a rejection: an SSH key's touch
    // prompt would go unseen, so this line says what is waiting. A rewrite
    // goes under the lease, never a bare --force.
    ctx.out(`Pushing ${branch}${plan.rewrite ? " (rewritten)" : ""}…`);
    const lease = plan.rewrite ? [`--force-with-lease=refs/heads/${branch}:${plan.lease}`] : [];
    const push = await ctx.exec(gitIn(tmp, "push", ...lease, "origin", `HEAD:refs/heads/${branch}`));
    if (push.code !== 0) {
      if (plan.rewrite && /\[rejected\][^\n]*\((stale info|fetch first|non-fast-forward)\)/.test(push.stderr)) {
        throw new ForgeError(`GitHub's ${branch} moved since the last ship: nothing was overwritten. ` +
          `Run forge fetch ${opts.ticket!.id} and look at it.`);
      }
      throw new ForgeError(/\[rejected\][^\n]*\((fetch first|non-fast-forward)\)/.test(push.stderr)
        ? `GitHub's ${branch} moved since the fetch: run forge ship again.`
        : `git push failed: ${push.stderr.trim() || push.stdout.trim()}`);
    }
    // What this clone pushed: the lease of the next rewrite.
    const pushed = await mustSucceed("git rev-parse", ctx.exec(gitIn(tmp, "rev-parse", "HEAD")));
    await mustSucceed("record the ship", ctx.exec(gitIn(root, "update-ref", shippedRef(plan.task), pushed.stdout.trim())));
    return "pushed";
  } finally {
    // --force only discards the temporary worktree, which may be mid cherry-pick.
    const removed = await ctx.exec(gitIn(root, "worktree", "remove", "--force", tmp));
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    // Never a repository-wide prune: it would also drop the developer's other worktrees.
    if (removed.code !== 0) await ctx.exec(gitIn(root, "worktree", "remove", "--force", tmp));
    process.off("SIGINT", ignoreSigint);
  }
}

// The spec file at `at` (a full ref or a commit) already holds `spec.text`.
async function specUnchanged(ctx: Context, root: string, at: string, spec: SpecFile): Promise<boolean> {
  const r = await ctx.exec(gitIn(root, "cat-file", "blob", `${at}:${spec.path}`));
  return r.code === 0 && r.stdout === spec.text;
}

// Writes the spec in the replay's worktree, by Node, never through a shell,
// then one commit of that file alone with its trailer, signed like the others.
// A folder of the path that is a file or a symbolic link in the agent's tree is
// refused: Node would write through a link, out of the worktree.
async function commitSpec(ctx: Context, tmp: string, branch: string, spec: SpecFile, sign: boolean): Promise<void> {
  const parts = spec.path.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join("/");
    let st: fs.Stats;
    try {
      st = fs.lstatSync(path.join(tmp, rel));
    } catch {
      break;
    }
    const last = i === parts.length;
    if (st.isSymbolicLink() || (!last && !st.isDirectory()) || (last && !st.isFile())) {
      throw new ForgeError(`${branch}: ${rel} is ${st.isSymbolicLink() ? "a symbolic link" : last ? "not a file" : "a file"} ` +
        `in the tree: the spec cannot go to ${spec.path}`);
    }
  }
  const file = path.join(tmp, spec.path);
  if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === spec.text) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, spec.text);
  await mustSucceed("git add", ctx.exec(gitIn(tmp, "add", "--", spec.path)));
  const code = await ctx.attach(gitIn(tmp, "commit", "--no-verify", ...(sign ? ["-S"] : []),
    "-m", `docs: spec of ${spec.ticket}`, "-m", `Forge-Spec: ${spec.ticket}`));
  if (code !== 0) throw new ForgeError(`${branch}: the commit of the spec stopped (the signing failed?): nothing was pushed`);
}

// Names the commit the cherry-pick stopped on, then abandons the pick. Without
// a CHERRY_PICK_HEAD (a signing failure), rev-parse could find a tag of that
// name: only one of the commits being replayed is named. Its subject is the
// agent's: no control character reaches the error message.
async function stoppedAt(ctx: Context, tmp: string, plan: TaskPlan): Promise<string> {
  const head = await ctx.exec(gitIn(tmp, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"));
  let what = "a commit";
  if (head.code === 0 && plan.commits.includes(head.stdout.trim())) {
    const sha = head.stdout.trim();
    const subject = await ctx.exec(gitIn(tmp, "log", "-1", "--format=%h %s", sha));
    if (subject.code === 0) what = printable(subject.stdout.trim());
  }
  await ctx.exec(gitIn(tmp, "cherry-pick", "--abort"));
  return `agent/${plan.task}: replaying ${what} onto ${shortRef(plan.onto)} stopped (conflict, or the signing failed): nothing was pushed`;
}
