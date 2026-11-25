import { ConnectorError } from "./model.ts";

const KEY = /^[a-z][a-z-]*$/;
const LINE = /^([a-z][a-z-]*): ([^\n]*)$|^([a-z][a-z-]*):$/;

// En-tête `clé: valeur`, une ligne vide, puis le corps tel quel.
export function parseDocument(text: string): { fields: Record<string, string>; body: string } {
  const cut = text.indexOf("\n\n");
  const head = cut === -1 ? text : text.slice(0, cut);
  const body = cut === -1 ? "" : text.slice(cut + 2);
  const fields: Record<string, string> = {};
  if (head !== "") {
    for (const [i, line] of head.split("\n").entries()) {
      const m = LINE.exec(line);
      // Le numéro, pas la ligne : elle peut être du texte libre (un corps sans
      // ligne vide), qui finirait dans le journal de l'orchestrateur.
      if (!m) throw new ConnectorError(`header line ${i + 1} is not "key: value"`);
      const key = m[1] ?? m[3];
      if (Object.hasOwn(fields, key)) throw new ConnectorError(`header key repeated: ${key}`);
      fields[key] = m[2] ?? "";
    }
  }
  return { fields, body };
}

export function formatDocument(fields: Record<string, string>, body: string): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!KEY.test(key)) throw new ConnectorError(`invalid header key: ${JSON.stringify(key)}`);
    if (/[\r\n]/.test(value)) throw new ConnectorError(`header value has a newline: ${key}`);
    lines.push(`${key}: ${value}`);
  }
  return `${lines.join("\n")}\n\n${body}`;
}
