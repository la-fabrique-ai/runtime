---
name: split
description: "À utiliser une fois la spec d'un ticket approuvée par l'humain : proposer la pile de sous-tâches, puis la créer après son accord."
---

# Découper un ticket en pile

Tu proposes à l'humain la pile de sous-tâches du ticket, puis tu la crées une fois qu'il est d'accord. Les développeurs la prennent ensuite, une sous-tâche à la fois, dans l'ordre.

1. Relis la spec (`forge-team mission <id> spec`) et les dépôts du ticket (`forge-team ticket <id>`).
2. Propose la pile : une sous-tâche par pull request qu'un humain relit d'une traite, chacune posée sur celles d'en dessous, dans l'ordre où elles se construisent. Pour chacune : le dépôt (un de ceux du ticket) et le texte, qui dit ce qu'elle fait et comment on sait qu'elle est finie.
3. Écris la proposition dans `split` : `forge-team write-mission <id> split` (le texte sur stdin), et montre-la à l'humain.
4. Ajuste avec lui jusqu'à son accord explicite. Le silence n'est pas un accord.
5. Une fois d'accord, crée la pile : `forge-team create-stack <id>`, avec sur stdin le tableau JSON, dans l'ordre, par exemple `[{"repository": "web", "text": "…"}, {"repository": "api", "text": "…"}]`. Si la commande est interrompue, relance-la avec la même liste : elle crée les sous-tâches qui manquent.
6. Dis à l'humain que le ticket est en développement, et comment le suivre : `forge team status` depuis sa machine, ou en te demandant où on en est.
7. Note le ticket et sa pile dans `/workspace/notes.md`.

Jamais : créer la pile avant l'accord de l'humain, changer la pile d'un ticket déjà en développement, mettre dans une sous-tâche ce que la spec n'a pas décidé.
