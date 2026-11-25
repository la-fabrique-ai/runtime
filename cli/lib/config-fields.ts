// The helpers every config parser shares (config.ts, project-config.ts): one
// error shape, "<file>: <key> must be …", one way to read an object while
// refusing the keys forge does not know, and the readers of the small values
// (plugins, a .env path, a boolean, a memory size).
import { ForgeError } from "./context.ts";

// An Incus size: "50GiB", "12GB", "512MiB".
export const SIZE = /^[0-9]+(\.[0-9]+)?(B|[kKMGTPE]i?B)$/;

export type ConfigHelpers = {
  invalid: (key: string, expected: string, got: unknown) => ForgeError;
  fields: (value: unknown, key: string, known: string[]) => Record<string, unknown>;
};

export function configHelpers(path: string): ConfigHelpers {
  const invalid = (key: string, expected: string, got: unknown) =>
    new ForgeError(`${path}: ${key} must be ${expected}, got ${JSON.stringify(got)}`);

  // An object's own keys, after refusing any key forge does not know. `key`
  // is the object's dotted path, "" at the top level.
  const fields = (value: unknown, key: string, known: string[]): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalid(key || "the file's content", "a JSON object", value);
    }
    for (const k of Object.keys(value)) {
      if (!known.includes(k)) {
        throw new ForgeError(`${path}: unknown key ${key ? `${key}.${k}` : k} (known: ${known.join(", ")})`);
      }
    }
    return value as Record<string, unknown>;
  };
  return { invalid, fields };
}

type Invalid = ConfigHelpers["invalid"];

// A plugin as `claude plugin install` names it: name, or name@marketplace.
const PLUGIN = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

export function plugins(invalid: Invalid, key: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && PLUGIN.test(p))) {
    throw invalid(key, "a list of plugin names such as name or name@marketplace", v);
  }
  return v as string[];
}

export function envPath(invalid: Invalid, key: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !(v.startsWith("/") || v.startsWith("~/"))) throw invalid(key, "null or an absolute path (or ~/…) to a dotenv file", v);
  return v;
}

export function bool(invalid: Invalid, key: string, v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw invalid(key, "true or false", v);
  return v;
}

export function memory(invalid: Invalid, key: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !SIZE.test(v)) throw invalid(key, 'null or a size (such as "8GiB")', v);
  return v;
}
