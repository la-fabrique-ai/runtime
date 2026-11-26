// Le processus de l'orchestrateur : un tour toutes les `--poll-seconds`
// secondes, jusqu'à SIGTERM ou SIGINT. Il tourne dans un container et
// n'importe que node:* et ses dossiers (tests/orchestrator-imports.test.ts).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMarkdownBase } from "./lib/tickets/markdown-base.ts";
import { socketHost } from "./lib/orchestrator/host.ts";
import { fileQuestions } from "./lib/orchestrator/questions.ts";
import { fileCursor, tick } from "./lib/orchestrator/tick.ts";

export type Args = { base: string; socket: string; state: string; prefix: string; pollSeconds: number };

const USAGE =
  "usage: orchestrator.ts --base <dir> --socket <path> --state <dir> [--prefix <p>] [--poll-seconds <n>]";

export function parseArgs(argv: string[]): Args {
  const known = ["--base", "--socket", "--state", "--prefix", "--poll-seconds"];
  const v = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!;
    const val = argv[i + 1];
    if (!known.includes(k) || val === undefined || val === "" || v.has(k)) throw new Error(USAGE);
    v.set(k, val);
  }
  const need = (k: string): string => {
    const x = v.get(k);
    if (x === undefined) throw new Error(`${k} is required\n${USAGE}`);
    return x;
  };
  const raw = v.get("--poll-seconds") ?? "10";
  const pollSeconds = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(pollSeconds) || pollSeconds < 2) {
    throw new Error(`--poll-seconds must be an integer >= 2\n${USAGE}`);
  }
  return { base: need("--base"), socket: need("--socket"), state: need("--state"), prefix: v.get("--prefix") ?? "T", pollSeconds };
}

async function main(): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    return 64;
  }

  let stopping = false;
  let wake: () => void = () => {};
  const onSignal = (): void => {
    stopping = true;
    wake();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  // Sommeil interrompu par un signal ; un signal déjà reçu l'annule d'emblée.
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (stopping) return resolve();
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  try {
    mkdirSync(args.state, { recursive: true, mode: 0o700 });
    const tickets = openMarkdownBase(args.base, { prefix: args.prefix });
    const host = socketHost(args.socket);
    const cursor = fileCursor(join(args.state, "cursor"));
    // Les questions en cours (questions.ts) : le perdre coûte un second examen.
    const questions = fileQuestions(join(args.state, "questions.json"));
    // Les problèmes du dernier tour, que le canal local sert (plan 2c).
    let lastProblems: string[] = [];
    // Les problèmes du tour précédent : une ligne identique n'est imprimée
    // qu'une fois, jusqu'à ce que l'ensemble change.
    let previous = new Set<string>();
    // Les sous-tâches refusées par l'hôte, et l'instant où les retenter.
    const refusals = new Map<string, number>();
    // Depuis quand chaque mission tenue n'annonce aucun état de session.
    const silent = new Map<string, number>();
    while (!stopping) {
      const r = await tick({ tickets, host, cursor, questions, refusals, silent });
      lastProblems = r.problems;
      for (const a of r.assigned) console.log(`[orchestrator] assigned ${a.subtask} to ${a.executor}`);
      for (const s of r.completed) console.log(`[orchestrator] completed ${s}`);
      for (const s of r.recovered) console.log(`[orchestrator] recovered ${s}`);
      const now = new Set(r.problems);
      for (const p of now) if (!previous.has(p)) console.log(`[orchestrator] problem: ${p}`);
      previous = now;
      await sleep(args.pollSeconds * 1000);
    }
    return 0;
  } catch (e) {
    console.error(`[orchestrator] fatal: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

// `import.meta.main` n'existe pas dans toutes les versions de Node (VM, image).
const isMain = import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main();
