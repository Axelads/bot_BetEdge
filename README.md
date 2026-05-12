# bot_BetEdge

Bot d'analyse de paris sportifs — Node.js (JavaScript pur), déployé sur Koyeb.

## Architecture

```
bot/
├── src/
│   ├── index.js               # Entry point — crons + orchestration multi-utilisateurs
│   ├── analyseur.js           # Appels Claude API (prompt caching + batch)
│   ├── collecteurCotes.js     # Récupération matchs/cotes (OddsAPI, 48 compétitions)
│   ├── comparateurPatterns.js # Stats Expert + seuils de déclenchement
│   ├── detecteurAnomalie.js   # Détection de cotes anormales (mathématique, sans API)
│   └── telegram.js            # Envoi des alertes Telegram (parse_mode HTML)
├── batch_state.json           # État temporaire du batch 9h (créé/supprimé automatiquement)
├── .env                       # Variables d'environnement (non commité)
└── package.json
```

## Cycles d'analyse — Plan OddsAPI $30/mois (20k crédits)

| Heure (Paris) | Type | Description |
|--------------|------|-------------|
| **09h00** | Batch | `lancerAnalyseBatch()` — soumet toutes les analyses au Batch API Anthropic (-50% coût). |
| **10h30** | Récupération | `verifierResultatsBatch()` — récupère les résultats du batch + envoie les alertes. |
| **18h00** | Synchrone | Analyse temps réel pour les matchs du soir, alertes Telegram immédiates. |
| **toutes les 5 min** (8h-23h) | Réponses | Lecture des boutons OUI/NON Telegram → log dans `alertes_bot.decision_expert`. |

> ⚠️ **Pas d'analyse au boot** — évite les requêtes OddsAPI imprévues à chaque redémarrage Koyeb.

**Budget OddsAPI :** max 25 compétitions actives × 2 cycles × 30j × ~3.3 marchés ≈ **5000 crédits/mois** (plan $30 = 20 000 crédits, marge ×4).

## Double piste d'analyse par match

Pour chaque match dans la plage de cotes ciblée :

1. **Pattern matching** — Claude compare le match aux paris gagnants de l'Expert et attribue un `score_similarite` (0–100). Alerte si ≥ 60 + confiance ≠ faible.
2. **Anomalie de cotes** — Détection mathématique d'une cote > médiane marché de +12% (≥ 3 bookmakers). **Scannée sur les 4 marchés OddsAPI** : H2H, Totals, Spreads (handicap), BTTS. Claude valide si c'est une vraie opportunité. Alerte si score_anomalie ≥ 60 + `est_opportunite_reelle` = true + score_valeur ≥ 65.

## Optimisations coût Anthropic (actives)

### 1. Prompt caching (`cache_control: ephemeral`)
Le prompt système (paris gagnants + stats ≈ 3 600 tokens) est mis en cache 5 minutes. Sur un cycle de 8 matchs, l'appel 1 écrit le cache, les appels 2–8 le lisent à 0,30$/M au lieu de 3$/M. **−58% sur le coût système.**

### 2. Batch API (cycle 9h)
Toutes les analyses (tous users × tous matchs) sont soumises en un seul batch Anthropic. **−50% sur input+output.** Fallback automatique sur analyse synchrone si la soumission échoue.

### 3. Pré-filtre des matchs (per-user)
Filtre en deux temps :
- **Global large** (1,10–20, max 25 matchs) — mutualisé pour l'enrichissement API-Football
- **Per-user** (plage de cotes selon `profil_risque`, sports sélectionnés, max 10) — appliqué dans la boucle par utilisateur

> Les champs `ligne_totals` et `handicap_domicile_point` sont exclus des filtres (ce sont des points de référence, pas des cotes) via `extraireCotesReelles()`.

**Impact cumulé : ~−72% sur le coût Claude.**

## Compétitions surveillées (48)

Chaque compétition définit sa fenêtre de saison (format MMJJ). Les compétitions hors saison sont **ignorées sans appel réseau**, ce qui réduit la consommation OddsAPI de ~65%.

### Football — Ligues nationales

| Compétition | Saison active |
|------------|--------------|
| Ligue 1 | 10 août → 22 mai |
| Premier League | 7 août → 24 mai |
| Championship (EFL) | 5 août → 10 mai |
| La Liga | 10 août → 30 mai |
| Bundesliga | 18 août → 22 mai |
| Serie A | 12 août → 30 mai |

### Football — Coupes nationales (à partir des 8èmes de finale)

| Compétition | Fenêtre (8ème → finale) |
|------------|------------------------|
| Coupe de France | 1er jan → 25 mai |
| FA Cup (Angleterre) | 1er fév → 20 mai |
| Copa del Rey (Espagne) | 8 jan → 12 mai |
| DFB Pokal (Allemagne) | 28 jan → 25 mai |
| Coppa Italia (Italie) | 8 jan → 28 mai |

### Football — Compétitions européennes

| Compétition | Saison active |
|------------|--------------|
| Ligue des Champions | 25 août → 12 déc · 18 jan → 5 juin |
| Ligue Europa | 25 août → 12 déc · 18 jan → 28 mai |
| Conference League | 25 août → 12 déc · 18 jan → 28 mai |

> Pause hivernale UEFA : ~13 déc → 17 jan (aucune requête OddsAPI pendant cette période).

### Football — Compétitions internationales

| Compétition | Fenêtre | Années |
|------------|---------|--------|
| Coupe du Monde FIFA | 7 juin → 23 juil | **2026** uniquement |
| UEFA Euro | 8 juin → 18 juil | **2028** uniquement |

### Basketball

| Compétition | Saison active |
|------------|--------------|
| NBA | 10 oct → 25 juin |
| Euroleague | 1er oct → 25 mai |

### Tennis — Grands Chelems

| Compétition | Fenêtre |
|------------|---------|
| Open d'Australie (ATP + WTA) | 8 jan → 30 jan |
| Roland Garros (ATP + WTA) | 20 mai → 13 juin |
| Wimbledon (ATP + WTA) | 26 juin → 17 juil |
| US Open (ATP + WTA) | 21 août → 11 sept |

### Tennis — Masters 1000 ATP + WTA

| Compétition | Fenêtre | ATP | WTA |
|------------|---------|-----|-----|
| Indian Wells | 1er mar → 20 mar | ✓ | ✓ |
| Miami Open | 17 mar → 3 avr | ✓ | ✓ |
| Monte Carlo | 3 avr → 17 avr | ✓ | — |
| Madrid Open | 19 avr → 8 mai | ✓ | ✓ |
| Rome | 4–6 mai → 21–22 mai | ✓ | ✓ |
| Canada Open | 1er aoû → 14 aoû | ✓ | ✓ |
| Cincinnati | 9 aoû → 21 aoû | ✓ | ✓ |
| Shanghai | 3 oct → 16 oct | ✓ | — |
| Beijing | 28 sept → 10 oct | — | ✓ |
| Paris Bercy | 24 oct → 6 nov | ✓ | — |

### Tennis — Fin de saison

| Compétition | Fenêtre |
|------------|---------|
| ATP Finals | 6 nov → 20 nov |
| WTA Finals | 23 oct → 6 nov |

### Rugby

| Compétition | Saison active | Note |
|------------|--------------|------|
| Top 14 | 25 août → 20 juin | |
| 6 Nations + Autumn Tests | 25 jan→27 mar · 26 oct→12 déc | |
| Champions Cup | 28 nov → 28 mai | |
| Coupe du Monde Rugby | 25 août → 5 nov | **2027** uniquement |

### Hockey sur glace

| Compétition | Saison active |
|------------|--------------|
| NHL | 1er oct → 20 juin |
| Championnat du Monde | 27 avr → 30 mai |

## OddsAPI — consommation estimée

Chaque requête HTTP consomme `nb_marchés × nb_régions` crédits.

**Marchés dynamiques par sport** via `getMarchesPourSport(cleSport)` :
- Foot : `h2h,totals,spreads,btts` → 4 crédits/appel
- Tennis / Basket / Rugby / Hockey : `h2h,totals,spreads` → 3 crédits/appel

| Scénario | Crédits/mois |
|---------|-------------|
| Sans filtrage saison (48 sports × 2 cycles × 30j × ~3.3 marchés) | ~9 500 |
| **Avec filtrage saison (~15 actifs en moyenne) + cap 25** | **~3 000–5 000** |

**Plan utilisé : OddsAPI Pro ($30/mois, 20 000 crédits/mois)** — marge confortable (×4) pour les périodes de haute activité (été, coupes européennes, multi-sports en parallèle).

## Préférences utilisateur (`preferences_bot` dans PocketBase)

Chaque utilisateur peut configurer le bot depuis l'app mobile (onglet Paramètres → "Paramètres du bot"). Les préférences sont lues à chaque cycle depuis le profil PocketBase.

| Champ | Valeurs | Effet sur le bot |
|-------|---------|-----------------|
| `sports` | `["football", "tennis", ...]` | Filtre les matchs aux sports sélectionnés |
| `profil_risque` | `securite` / `equilibre` / `risque` / `tres_risque` | Plage de cotes : 1.10–1.80 / 1.50–2.50 / 2.00–4.00 / 3.00+ |
| `types_analyse` | `["patterns"]` / `["anomalies"]` / les deux | Active ou désactive chaque piste d'analyse |
| `format_pari` | `sec` / `combine` / `les_deux` | Instruction Claude sur le format des suggestions |
| `source_donnees` | `perso` / `communaute` | Paris de l'utilisateur seul ou données agrégées de toute la plateforme |
| `consentement_donnees` | toujours `true` | Tous les utilisateurs alimentent le pool commun, quel que soit `source_donnees` |

**Valeurs par défaut** (si non configuré) : tous sports, profil `equilibre`, les deux types, paris secs, source `perso`.

## Mode superadmin / communauté

Le compte `ujotze4rf8qhs9k` utilise toujours les données agrégées (`sourceAgreee = true`).
Tout utilisateur ayant choisi `source_donnees = "communaute"` bénéficie du même dataset élargi.
Le prompt Claude mentionne "communauté de N parieurs — données agrégées" dans les deux cas.

## Gate Premium

Seuls les utilisateurs ayant `est_premium = true` dans leur profil PocketBase reçoivent des alertes Telegram.

Le filtre est appliqué dans `index.js` lors de la récupération des utilisateurs actifs :

```js
const utilisateursActifs = utilisateurs.filter(p => p.telegram_chat_id && p.est_premium)
```

Un utilisateur sans abonnement actif ne reçoit aucune alerte, même si le bot détecte une opportunité correspondant à ses patterns.

**Champ PocketBase requis :** collection `profils` → `est_premium` (Bool, default `false`)  
**Mise à jour :** automatique via `sauvegarderStatutPremium()` dans `app/src/services/pocketbase.js` après achat Apple IAP.

## Variables d'environnement requises (Koyeb)

```
POCKETBASE_URL
POCKETBASE_ADMIN_EMAIL
POCKETBASE_ADMIN_PASSWORD
ANTHROPIC_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
ODDS_API_KEY
API_FOOTBALL_KEY
```

## Commandes

```bash
# Développement
node src/index.js

# Production (PM2)
pm2 start src/index.js --name betedge-bot
pm2 logs betedge-bot
```
