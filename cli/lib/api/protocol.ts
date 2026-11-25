// Les règles communes des textes qui arrivent à l'hôte : les plafonds d'une
// requête de l'API et d'une consigne, la vérification d'une consigne, et le
// jeu de caractères d'un avis tapé dans une session (`forge notify`). Les
// verbes de mission et leur lecture sont dans missions.ts. Un refus dit sa
// règle et ne répète jamais un secret.
import { ForgeError } from "../context.ts";

// Des plafonds contre un client emballé, pas une règle sur le contenu : le
// JSON peut multiplier un texte par six en l'échappant.
export const REQUEST_MAX = 2097152;
export const INSTRUCTION_MAX = 65536; // des octets UTF-8

// Un texte tapé dans le terminal d'un agent, derrière le préfixe de forge :
// cette liste n'a ni `[` `]` `@`, ni accent grave, `$`, `\`, `<` `>`, ni
// caractère de contrôle. Il ne peut donc ni imiter le préfixe, ni joindre un
// fichier, ni appuyer sur une touche.
const SUMMARY_CHARS = String.raw`[\p{L}\p{M}\p{N} .,;:!?'"()\-_/#+=%&*’«»]`;
export const SUMMARY_ALLOWED = new RegExp(`^${SUMMARY_CHARS}+$`, "u");

const PUT_IN_A_FILE = "put it in a file of your branch and send its path";

export const hasSecret = (text: string, secrets: readonly string[]) => secrets.some((s) => s !== "" && text.includes(s));

// Une consigne : tout contenu, caractères de contrôle compris, sauf le vide,
// ce qui dépasse le plafond et un secret.
export function checkText(text: string, maxBytes: number, what: string, secrets: readonly string[]): void {
  if (text.trim() === "") throw new ForgeError(`the ${what} is empty`);
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ForgeError(`the ${what} is longer than ${maxBytes} bytes: ${PUT_IN_A_FILE}`);
  }
  if (hasSecret(text, secrets)) throw new ForgeError(`the ${what} holds a secret forge handed out: remove it`);
}
