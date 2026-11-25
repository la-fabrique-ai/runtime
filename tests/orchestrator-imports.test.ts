import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Les dossiers orchestrator/ et tickets/ sont copiés tels quels dans un container
// et lancés avec Node : ils ne doivent importer que `node:*` et eux-mêmes.
const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "cli");
const folders = [join(cli, "lib", "orchestrator"), join(cli, "lib", "tickets")];

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listTs(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

const files = [...folders.flatMap(listTs), ...(existsSync(join(cli, "orchestrator.ts")) ? [join(cli, "orchestrator.ts")] : [])];

// import … from "x", import type … from "x", export … from "x", import("x")
const SPECIFIER = /(?:\b(?:import|export)\b[^"';]*?\bfrom\s*|\bimport\s*\(\s*|^\s*import\s*)["']([^"']+)["']/gm;

test("les dossiers à copier existent et sont listés", () => assert.ok(files.length > 0));

for (const file of files) {
  test(`${file.slice(cli.length + 1)} n'importe que node:* et les dossiers orchestrator/ et tickets/`, () => {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) continue;
      assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${spec} : ni node:* ni relatif`);
      const target = resolve(dirname(file), spec);
      assert.ok(
        folders.some((f) => target.startsWith(f + "/")),
        `${spec} sort de orchestrator/ et tickets/`,
      );
    }
  });
}
