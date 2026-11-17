# Spike Git LFS en lecture pour les équipes

**Date :** 2026-11-17
**Question :** un container d'équipe peut-il lire le contenu LFS d'un repo depuis le miroir en lecture seule, sans réseau ni credential, quand l'hôte a récupéré les objets avec `git lfs fetch` ? (Refs #89)
**Statut :** terminé pour la lecture. L'écriture est hors périmètre (#168). Un point reste non validé : le fetch par SSH avec l'agent transmis (voir « Ce que le spike n'a pas couvert »). Travail jetable : ce rapport est le livrable. Aucun changement de code.

## Montage

| Élément | Version |
|---|---|
| git-lfs (hôte et container) | 3.7.1 |
| git (hôte) | 2.53.0 |
| Incus | 7.0.2 |

- **Hôte :** une VM Lima jetable (`ansible/tests/vm-test.sh --lima --keep`, puis `forge setup` et `forge image build`). `git-lfs` n'y est pas installé par le rôle Ansible : il a été extrait du paquet Ubuntu dans un dossier utilisateur.
- **Dépôt amont :** d'abord un dépôt nu local qui tient lieu de GitHub (un fichier `*.bin` suivi par LFS), puis un vrai dépôt public qui utilise LFS pour un seul fichier (`mission-apprentissage/labonnealternance`, 342 Mo pour la version de `main`).
- **Container :** `agent-base`, profil `agent-forge`, le miroir monté en `/forge/origin.git` avec `readonly=true`.

## Résultats

| Vérification | Résultat |
|---|---|
| `git lfs fetch` dans un miroir nu (`git --git-dir=<miroir> lfs fetch origin main`) | **OK** : l'objet arrive dans `<miroir>/lfs/objects`. |
| Clone depuis le miroir en lecture seule, avec `-c lfs.url=file://<miroir> -c lfs.standalonetransferagent=lfs-standalone-file` | **OK** : le contenu est là, sans réseau. Dans le container, sur le vrai dépôt : 342 148 689 octets en 8 s, arbre de travail propre, `git lfs ls-files` marque le fichier comme présent (`*`). |
| `.lfsconfig` hostile du dépôt (`lfs.url` vers un autre hôte) avec l'option en ligne de commande | **OK** : l'option l'emporte, le contenu vient du miroir. |
| Le même `.lfsconfig` sans l'option | **Échec** du checkout : `.lfsconfig` redirige bien l'URL. L'option est donc indispensable. |
| Clone avec `GIT_LFS_SKIP_SMUDGE=1`, puis `lfs.url` et l'agent écrits dans `.git/config`, puis `git lfs pull` | **OK**. Un checkout ultérieur d'une autre branche, y compris la branche au `.lfsconfig` hostile, lit encore le miroir : la configuration locale l'emporte sur `.lfsconfig`. |
| Nouvel objet ajouté plus tard : `git fetch` du miroir, `git lfs fetch`, puis `git fetch origin` et checkout dans le clone | **OK** : le contenu arrive par le miroir. |

## Ce qu'il faut retenir pour le plan

1. **Le paquet `git-lfs` manque sur l'hôte.** Il s'ajoute au rôle Ansible de l'hôte ; `forge setup` peut vérifier sa présence en lecture seule.
2. **La configuration doit être persistée dans le clone.** `-c` ne dure que le temps du clone. Après `clone`, écrire `lfs.url=file:///forge/origin.git` et `lfs.standalonetransferagent=lfs-standalone-file` dans le `.git/config` de `/workspace` : sans cela, un checkout ultérieur ou un `git lfs pull` retombe sur l'URL du `.lfsconfig`, qu'un dépôt contrôle. La même configuration vaut pour `pointOriginAtMirror` sur un workspace réutilisé.
3. **Ne pas utiliser `fetch --all` côté hôte.** Un fichier LFS a une version par commit qui le change : sur le vrai dépôt, `--all` ramènerait tout l'historique. Fetcher les pointes (branche de base, branches d'agents), comme la spec le suggère.
4. **L'hôte fetche toujours avec l'URL en ligne de commande**, comme `refreshMirror` le fait pour git, et jamais celle que le miroir ou un `.lfsconfig` porte.
5. **Taille :** un objet LFS est un fichier entier, copié du miroir dans le workspace. Prévoir le disque du pool pour la copie (le miroir garde la sienne).

## Ce que le spike n'a pas couvert

- **Le fetch depuis GitHub par SSH avec l'agent transmis.** La VM n'a pas de clé GitHub : le fetch du vrai dépôt s'est fait en HTTPS anonyme, celui du dépôt local par le transfert de fichier. Git LFS sur SSH passe par `git-lfs-authenticate`, puis par HTTPS avec un jeton court ; `protocol.allow=never` de `GITHUB` (`mirror.ts`) ne vise que git, pas ce second appel, à vérifier sur un dépôt réel avec l'agent.
- **Le worktree temporaire de `forge ship`** (piste de #89, `GIT_LFS_SKIP_SMUDGE=1`) : il relève de l'écriture, donc de #168.
- **Un container strict** : le fetch d'objets passe par le miroir, sans réseau, donc aucune entrée de liste blanche n'est attendue ; non exécuté.
