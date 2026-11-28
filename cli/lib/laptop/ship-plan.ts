// The ship plan: from the recorded bases and the fetched refs of the
// developer's clone, which commits of a task to replay, onto what, and the base
// of its PR. Pure planning: nothing is signed or pushed here.
//
// Every ref handed to git is a full refs/remotes/… name: git looks a short
// name up in refs/tags/ first, so a tag named origin/main would otherwise
// decide what is replayed, and onto what. And a full name only reaches git
// once refExists has seen that very ref: missing, git would fall back to
// refs/tags/<the full name>.
import { ForgeError, mustSucceed, type Context } from "../context.ts";

export type Base =
  | { kind: "task"; task: string }
  | { kind: "branch"; branch: string; assumed: boolean };

const MAIN: Base = { kind: "branch", branch: "main", assumed: true };

// Turns the base `forge task-base` recorded into what it designates. A tag, a
// SHA or a branch that is gone cannot be a PR base: assume main.
export function resolveBase(recorded: string | undefined, tasks: Set<string>, onGithub: (branch: string) => boolean): Base {
  if (!recorded) return MAIN;
  if (recorded.startsWith("origin/")) return { kind: "branch", branch: recorded.slice("origin/".length), assumed: false };
  const task = recorded.startsWith("agent/") ? recorded.slice("agent/".length) : undefined;
  if (task !== undefined && tasks.has(task)) return { kind: "task", task };
  return onGithub(recorded) ? { kind: "branch", branch: recorded, assumed: false } : MAIN;
}

// The tasks from the lowest of the stack up to `task`, bottom first.
export function chainFor(task: string, bases: Map<string, Base>): string[] {
  const chain = [task];
  for (let base = bases.get(task); base?.kind === "task"; base = bases.get(base.task)) {
    if (chain.includes(base.task)) {
      // chain is top first: the cycle runs from base.task down to the last entry.
      const cycle = [...chain.slice(chain.indexOf(base.task)), base.task];
      throw new ForgeError(`tasks base on each other in a cycle: ${cycle.join(" -> ")}`);
    }
    chain.push(base.task);
  }
  return chain.reverse();
}

// A task's PR base: its base branch, or the branch of the task below, unless
// that task's PR is merged: then the base that PR had.
export function prBaseFor(base: Base, below?: { prBase: string; merged: boolean }): string {
  if (base.kind === "branch") return base.branch;
  return below?.merged ? below.prBase : `agent/${base.task}`;
}

// The refs of the developer's clone: a task's branch as fetched from the
// remote, a branch as fetched from GitHub.
export const agentRef = (remote: string, task: string): string => `refs/remotes/${remote}/agent/${task}`;
export const githubRef = (branch: string): string => `refs/remotes/origin/${branch}`;

// What a task started from, in the clone.
export function limitRef(remote: string, base: Base): string {
  return base.kind === "task" ? agentRef(remote, base.task) : githubRef(base.branch);
}

export type TaskPlan = {
  task: string;
  tip: string;            // refs/remotes/<remote>/agent/<task>
  limit: string;          // what the task started from, as a full ref name
  commits: string[];      // to replay, oldest first
  onto: string;           // a full ref name; the merge-base SHA on the first ship of a branch-based task
  prBase: string;
  shipped: boolean;       // refs/remotes/origin/agent/<task> exists
  // A rewrite replaces GitHub's branch (a cascade rebased it): every own
  // commit of the task, onto the branch below, pushed under a lease.
  rewrite: boolean;
  // The commit GitHub's branch must still be at: the last ship's, recorded in
  // the clone, when it is what GitHub has. null: not a rewrite, or no lease.
  lease: string | null;
  // A rewrite without a lease: the commits of GitHub's branch it would replace.
  foreign: string[];
};

// What this clone pushed last for each branch (replayAndPush records it): the
// lease of the next rewrite.
export const shippedRef = (task: string): string => `refs/forge/shipped/agent/${task}`;

// `below`: the task this one is stacked on. `merged`: its PR is merged, the
// task then goes onto that PR's base instead. `changes`: this ship pushes it
// (it grows or is rewritten), so this task is rewritten onto it.
// `opts.spec`: the ticket and the file the ship writes its spec to, on the top
// branch: forge's own commit of that file on GitHub is not a divergence.
export async function planTask(
  ctx: Context, root: string, remote: string, task: string, base: Base,
  below?: { prBase: string; merged: boolean; changes?: boolean },
  opts: { spec?: { ticket: string; path: string } } = {},
): Promise<TaskPlan> {
  const git = async (...args: string[]) =>
    (await mustSucceed(`git ${args[0]}`, ctx.exec(["git", ...args], { cwd: root }))).stdout.trim();
  const exists = (ref: string) => refExists(ctx, root, ref);

  const tip = agentRef(remote, task);
  const own = githubRef(`agent/${task}`);
  const limit = limitRef(remote, base);
  if (!(await exists(limit))) {
    throw new ForgeError(base.kind === "task"
      ? `agent/${task}: its base agent/${base.task} is gone from the team mirror`
      : `agent/${task}: its base ${base.branch} is gone from GitHub`);
  }
  const shipped = await exists(own);
  const upstream = shipped ? own : limit;

  // git cherry skips merge commits, so they are looked for on their own.
  const merges = await git("rev-list", "--merges", tip, `^${upstream}`, `^${limit}`);
  if (merges) throw new ForgeError(`agent/${task} has a merge commit (${merges.split("\n")[0].slice(0, 12)}): rebase it, forge ship replays commits one by one`);

  const prBase = prBaseFor(base, below);
  const last = shipped ? await resolveRef(ctx, root, shippedRef(task)) : null;
  const isAncestor = async (a: string, b: string) =>
    (await ctx.exec(["git", "merge-base", "--is-ancestor", a, b], { cwd: root })).code === 0;
  // A commit of forge's spec (its trailer, that file alone) is forge's own: it
  // is made again after a rewrite.
  const spec = opts.spec;
  const forgeOwn = async (c: string): Promise<boolean> => {
    if (!spec) return false;
    const trailer = await git("log", "-1", "--format=%(trailers:key=Forge-Spec,valueonly)", c);
    if (trailer.trim() !== spec.ticket) return false;
    return (await git("diff-tree", "--no-commit-id", "--name-only", "-r", c)) === spec.path;
  };
  if (shipped && await needsRewrite(git, exists, { tip, own, limit, base, prBase, last, below }, isAncestor, forgeOwn)) {
    // Every own commit of the task, onto the branch below as this ship leaves
    // it (the bottom: onto the merge base of its base and its tip).
    const list = await git("rev-list", "--reverse", tip, `^${limit}`);
    const commits = list === "" ? [] : list.split("\n");
    const onto = base.kind === "task" ? githubRef(prBase) : await git("merge-base", limit, tip);
    const ontoCommit = /^[0-9a-f]{40,64}$/.test(onto) ? onto : await resolveRef(ctx, root, onto);
    const github = await resolveRef(ctx, root, own);
    const lease = last !== null && last === github ? last : null;
    let foreign: string[] = [];
    if (lease === null) {
      const replaced = await git("rev-list", "--reverse", own, ...(ontoCommit ? [`^${ontoCommit}`] : []));
      foreign = replaced === "" ? [] : replaced.split("\n");
    }
    return { task, tip, limit, commits, onto, prBase, shipped, rewrite: true, lease, foreign };
  }

  // "+" lines: the commits that have no equivalent patch upstream yet.
  const cherry = await git("cherry", upstream, tip, limit);
  const commits = cherry.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2));

  let onto: string;
  if (base.kind === "task") {
    onto = shipped ? own : githubRef(prBase);
  } else {
    // The first ship signs in place (same parents, same content) onto the
    // merge base, unless cherry dropped a commit whose patch is already
    // upstream: replaying the others without it could conflict for no reason,
    // so they go onto the branch itself.
    const dropped = cherry.split("\n").some((l) => l.startsWith("- "));
    onto = shipped ? own : dropped ? limit : await git("merge-base", limit, tip);
  }
  return { task, tip, limit, commits, onto, prBase, shipped, rewrite: false, lease: null, foreign: [] };
}

// A branch already on GitHub only grew when (a) stacked, the branch below as
// this ship leaves it is still under it, and (b) every commit GitHub has beyond
// what the branch stands on, and that an earlier ship of this clone pushed,
// has a patch-equivalent among the task's own commits in the team mirror.
// Otherwise the cascade rewrote it. A commit someone else pushed on GitHub
// (never pushed by this clone) does not make a rewrite: the replay goes on
// top of it, as before. Without a record of the last ship (another clone),
// any commit without an equivalent makes a rewrite, whose foreign commits the
// human sees before anything is replaced.
async function needsRewrite(
  git: (...args: string[]) => Promise<string>, exists: (ref: string) => Promise<boolean>,
  p: { tip: string; own: string; limit: string; base: Base; prBase: string; last: string | null;
    below?: { merged: boolean; changes?: boolean } },
  isAncestor: (a: string, b: string) => Promise<boolean>,
  forgeOwn: (c: string) => Promise<boolean>,
): Promise<boolean> {
  if (p.base.kind === "task" && p.below && !p.below.merged) {
    if (p.below.changes) return true;
    const under = githubRef(p.prBase);
    if (await exists(under)) {
      const r = await git("merge-base", p.own, under);
      if (r !== (await git("rev-parse", under))) return true;
    }
  }
  const cherry = await git("cherry", p.tip, p.own, p.limit);
  const missing: string[] = [];
  for (const l of cherry.split("\n")) if (l.startsWith("+ ") && !(await forgeOwn(l.slice(2)))) missing.push(l.slice(2));
  if (missing.length === 0) return false;
  if (p.last === null) return true;
  for (const c of missing) if (await isAncestor(c, p.last)) return true;
  return false;
}

// How many commits of a merged task GitHub has no patch-equivalent of: on its
// own branch while it is there, else on the branch its PR went into. null when
// that cannot be told (a branch gone). A PR squash-merged from several commits
// and its branch deleted counts them all: the squash matches none of them.
export async function notShipped(
  ctx: Context, root: string, remote: string, task: string, base: Base,
  below?: { prBase: string; merged: boolean },
): Promise<number | null> {
  const own = githubRef(`agent/${task}`);
  const upstream = (await refExists(ctx, root, own)) ? own : githubRef(prBaseFor(base, below));
  const limit = limitRef(remote, base);
  if (!(await refExists(ctx, root, upstream)) || !(await refExists(ctx, root, limit))) return null;
  const r = await ctx.exec(["git", "cherry", upstream, agentRef(remote, task), limit], { cwd: root });
  return r.code === 0 ? r.stdout.split("\n").filter((l) => l.startsWith("+ ")).length : null;
}

// show-ref --verify takes the exact ref only: rev-parse --verify would, for a
// missing refs/remotes/origin/agent/<t>, answer with a tag of that name.
export async function refExists(ctx: Context, root: string, ref: string): Promise<boolean> {
  return (await resolveRef(ctx, root, ref)) !== null;
}

// The commit a full ref name points at, or null when that very ref is missing.
export async function resolveRef(ctx: Context, root: string, ref: string): Promise<string | null> {
  const r = await ctx.exec(["git", "show-ref", "--verify", "--hash", ref], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : null;
}

// A short name for messages: refs/remotes/origin/main reads origin/main.
export const shortRef = (ref: string): string =>
  /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 12) : ref.replace(/^refs\/remotes\//, "");
