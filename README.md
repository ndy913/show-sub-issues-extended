# Show sub-issues extended

Extension Chrome pour [Linear](https://linear.app) qui complète l'option **Show sub-issues** des vues en liste : replier les sous-tickets sous leur parent, voir combien il y en a, et distinguer chaque niveau de l'arbre par une couleur.

![Démo de l'extension](docs/demo.gif)

## Le problème

Avec **Show sub-issues** et **Nested sub-issues** activés, Linear affiche les sous-tickets sous leur parent. Mais un ticket technique appliqué à tous les projets compte vite 20 à 40 sous-tickets, qui noient la liste du cycle. Et en vue liste, Linear ne permet pas de replier les sous-tickets d'un parent.

## Ce que fait l'extension

- **Un chevron devant le statut de chaque ticket parent** replie ou déplie ses sous-tickets. La ligne cliquée reste à sa place à l'écran.
- **Le clic droit sur un ticket parent** propose aussi « Replier les sous-tickets » ou « Déplier les sous-tickets ».
- **Alt + clic sur un chevron** replie ou déplie tous les parents de la liste, y compris ceux qui ne sont pas à l'écran.
- **Une pastille après le titre** donne le nombre de sous-tickets du parent dans la vue (« 20 », ou « 20 masqués » une fois replié).
- **Un fond pastel par niveau** de l'arbre, qui part du trait de l'arbre et change de teinte à chaque niveau.
- Les tickets repliés le restent après un rechargement, et d'un onglet à l'autre.

## Réglages

Dans la popup de l'extension (clic sur son icône) :

| Réglage | Effet |
| --- | --- |
| Extension active | Coupe tout d'un coup pour revoir Linear tel quel. L'allumer active aussi « Show sub-issues » et « Nested sub-issues » sur la vue ouverte. |
| Repli des sous-tickets | Chevron, entrée du clic droit et pastille. Avec les boutons **Tout replier** et **Tout déplier**. |
| Couleur par niveau | Fond pastel par niveau. Trois palettes neutres (Lavande, Ardoise, Sable) ou une palette personnalisée, avec un sélecteur de couleur par niveau. |
| Intensité du fond | Opacité du fond du premier niveau. |
| Écart entre niveaux | De combien le fond se renforce à chaque niveau. |

Les palettes évitent volontairement le vert, l'orange, le bleu et le rouge, qui ont déjà un sens dans Linear (statuts, priorités).

## Installation

L'extension n'est pas sur le Chrome Web Store : elle s'installe en mode développeur, en deux minutes.

1. **Télécharger** `show-sub-issues-extended.zip` depuis la [dernière release](https://github.com/ndy913/show-sub-issues-extended/releases/latest), puis le **décompresser**. On obtient un dossier `show-sub-issues-extended`. Le ranger dans un endroit où il restera, par exemple `Documents` : Chrome charge l'extension depuis ce dossier, le supprimer supprime l'extension.
2. Ouvrir **`chrome://extensions`** (à coller dans la barre d'adresse) et activer **Mode développeur**, en haut à droite.
3. Cliquer sur **Charger l'extension non empaquetée** et choisir le dossier décompressé.
4. Recharger l'onglet Linear. Pour l'avoir sous la main, épingler l'extension depuis l'icône puzzle de la barre d'outils.

Chrome 111 ou plus récent est nécessaire. Ça marche aussi dans les navigateurs basés sur Chrome (Brave, Edge, Arc, Vivaldi), avec leur propre page d'extensions.

**Mettre à jour** : télécharger le zip de la nouvelle release, remplacer le contenu du dossier, puis cliquer sur ↻ sous l'extension dans `chrome://extensions`. Les réglages et les tickets repliés sont conservés.

Avec git, on peut aussi cloner le dépôt (`git clone https://github.com/ndy913/show-sub-issues-extended.git`) et charger ce dossier : une mise à jour devient `git pull` puis ↻.

## Confidentialité

- L'extension ne s'active que sur `https://linear.app/*`. Elle ne demande que l'accès à ce site et la permission `storage`.
- Elle n'envoie rien sur le réseau. Les réglages sont dans `chrome.storage.local`, et la liste des tickets repliés dans le `localStorage` de linear.app.
- Le détail est dans [PRIVACY.md](PRIVACY.md).

## Comment ça marche, et ses limites

La liste de Linear est virtualisée : masquer des lignes dans le DOM laisserait des trous. L'extension agit donc sur les données de la liste, qu'elle lit dans les fibers React du composant de liste : replier un parent vide ses `subItems` et efface le cache de hauteurs `nestedHeights`, puis la liste est redessinée. Le détail est en commentaire dans [`content.js`](content.js).

Ça repose sur le fonctionnement interne de Linear, qui peut changer sans prévenir. Si Linear modifie ce composant, l'extension peut cesser de fonctionner. Dans ce cas, les chevrons n'apparaissent plus mais Linear reste utilisable normalement.

L'activation automatique de « Show sub-issues » repère les libellés anglais du panneau Display options : avec Linear dans une autre langue, elle ne fait rien.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `manifest.json` | Déclaration de l'extension (Manifest V3). |
| `content.js` | Script exécuté dans la page Linear : repli, chevrons, pastilles, menu clic droit. |
| `content.css` | Styles du chevron, de la pastille et des couleurs par niveau. |
| `bridge.js`, `options.js` | Relais entre la popup et la page : réglages et actions. |
| `popup.html`, `popup.js` | La popup de réglages. |
| `icons/` | L'icône, et sa source `icon.svg`. |
| `scripts/build-zip.sh` | Construit le zip joint à chaque release (`dist/show-sub-issues-extended.zip`). |
| `PRIVACY.md` | Ce que l'extension fait, et ne fait pas, des données. |
