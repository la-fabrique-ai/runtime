// The `.env` of a role (DX 5, part 3): a strict subset of dotenv, parsed the same
// way here and in container/forge-agent, and never executed. No `source`, no
// `eval`, no interpolation, no escapes, no multi-line value.
import { readFileSync, statSync } from "node:fs";
import { ForgeError } from "./context.ts";

// Where the file lands in a role's containers (uid 1001, mode 600).
export const CONTAINER_ENV_PATH = "/home/aiuser/.config/forge/env";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
// forge's own: the agent's token, the user's identity, forge's variables.
const REFUSED = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "HOME", "PATH", "USER"]);

// Blank lines and `#` lines are skipped; otherwise `[export ]KEY=VALUE`, the
// value being the rest of the line taken literally, one pair of surrounding
// quotes removed. A refusal names the line number, never the line: it may hold a secret.
export function parseDotenv(path: string, text: string): [string, string][] {
  const out: [string, string][] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) return;
    const fail = (why: string) => new ForgeError(`${path} line ${i + 1}: ${why}`);
    const eq = line.indexOf("=");
    if (eq < 0) throw fail("expected KEY=VALUE");
    const key = line.slice(0, eq).trimStart().replace(/^export\s+/, "").trim();
    if (!KEY.test(key)) throw fail("the key must be letters, digits and underscores, not starting with a digit");
    if (REFUSED.has(key) || key.startsWith("FORGE_")) throw fail("this variable is forge's own and cannot be set here");
    let value = line.slice(eq + 1);
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) value = value.slice(1, -1);
    out.push([key, value]);
  });
  return out;
}

// The role's file on the host, checked before anything is pushed: it exists, is
// not readable by group or others (it may hold a token), and parses.
export function readEnvFile(path: string): string {
  let text: string;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      throw new ForgeError(`${path} is readable by group or others: chmod 600 ${path}`);
    }
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof ForgeError) throw e;
    throw new ForgeError(`cannot read the .env ${path}: ${(e as Error).message}`);
  }
  parseDotenv(path, text);
  return text;
}
