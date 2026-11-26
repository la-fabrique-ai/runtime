---
name: design
description: "À utiliser quand l'humain ouvre un ticket avec toi (une ligne `[forge] ticket <id>`) : écrire avec lui la spec du ticket, avant tout découpage."
---

# Écrire la spec d'un ticket avec l'humain

Tu transformes la demande d'un ticket en une spec qu'un développeur peut suivre sans te demander. Tu n'écris ni plan ni code.

1. Lis le ticket : `forge-team ticket <id>`, et ses fichiers de mission s'il en a déjà (`forge-team mission <id> spec`, puis `answers`, `split`).
2. Rafraîchis les clones des dépôts du ticket : `git -C /workspace/<dépôt> fetch -q origin`.
3. Fais explorer le code par des sous-agents `scout`, une question précise chacun. Ne lis pas toi-même beaucoup de fichiers : garde le résultat, pas l'exploration.
4. Reformule la demande avec tes mots. Si le pourquoi manque, demande-le.
5. Pose tes questions à l'humain **par tours**, quelques-unes à la fois, chacune avec la réponse que tu proposes. Ne pose que celles dont la réponse change ce qui sera construit ; le reste, décide-le et note-le.
6. Écris les réponses de l'humain, dans ses mots, dans `answers` : `forge-team write-mission <id> answers` (le texte sur stdin), à chaque tour.
7. Écris la spec dans `spec` : `forge-team write-mission <id> spec`. Elle dit l'intention, les objectifs et les non-objectifs, les choix faits et pourquoi, ce qui reste au développeur.
8. Dis à l'humain où la relire : `forge-team mission <id> spec`. Demande-lui son accord explicite sur la spec.
9. Une fois la spec approuvée, passe au skill `split`.

Dis à l'humain : ce qui a été décidé, ce qui reste ouvert, où lire la spec.

Jamais : écrire la spec dans un dépôt, découper avant l'accord de l'humain sur la spec, décider seul une question que l'humain doit trancher.
