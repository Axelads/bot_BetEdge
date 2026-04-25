# bot_BetEdge

Bot d'analyse de paris sportifs — Node.js (JavaScript pur), déployé sur Koyeb.

## Architecture

```
bot/
├── src/
│   ├── index.js               # Entry point — crons + orchestration multi-utilisateurs
│   ├── analyseur.js           # Appels Claude API (prompt caching + batch)
│   ├── collecteurCotes.js     # Récupération matchs/cotes (OddsAPI, 29 compétitions)
│   ├── comparateurPatterns.js # Stats Expert + seuils de déclenchement
│   ├── detecteurAnomalie.js   # Détection de cotes anormales (mathématique, sans API)
│   └── telegram.js            # Envoi des alertes Telegram (parse_mode HTML)
├── batch_state.json           # État temporaire du batch 9h (créé/supprimé automatiquement)
├── .env                       # Variables d'environnement (non commité)
└── package.json
```

## Cycles d'analyse

| Heure (Paris) | Type | Description |
|--------------|------|-------------|
| **9h00** | Batch (asynchrone) | Soumet toutes les analyses à l'API Batch Anthropic (−50% coût). Contexte sauvegardé dans `batch_state.json`. |
| **10h30** | Vérification batch | Récupère les résultats du batch 9h et envoie les alertes Telegram. |
| **18h00** | Synchrone | Analyse en temps réel, alertes Telegram immédiates. |
| **Démarrage** | Synchrone | Une analyse synchrone est lancée immédiatement au boot. |

## Double piste d'analyse par match

Pour chaque match dans la plage de cotes ciblée :

1. **Pattern matching** — Claude compare le match aux paris gagnants de l'Expert et attribue un `score_similarite` (0–100). Alerte si ≥ 60 + confiance ≠ faible.
2. **Anomalie de cotes** — Détection mathématique d'une cote > médiane marché de +12% (≥ 3 bookmakers). Claude valide si c'est une vraie opportunité. Alerte si score_anomalie ≥ 60 + `est_opportunite_reelle` = true + score_valeur ≥ 65.

## Optimisations coût Anthropic (actives)

### 1. Prompt caching (`cache_control: ephemeral`)
Le prompt système (paris gagnants + stats ≈ 3 600 tokens) est mis en cache 5 minutes. Sur un cycle de 8 matchs, l'appel 1 écrit le cache, les appels 2–8 le lisent à 0,30$/M au lieu de 3$/M. **−58% sur le coût système.**

### 2. Batch API (cycle 9h)
Toutes les analyses (tous users × tous matchs) sont soumises en un seul batch Anthropic. **−50% sur input+output.** Fallback automatique sur analyse synchrone si la soumission échoue.

### 3. Pré-filtre des matchs (1,50–3,00, max 8)
Avant tout appel Claude, les matchs dont aucune cote n'est dans la plage historique de l'Expert sont ignorés. **−33% de calls Claude.**

**Impact cumulé : ~−72% sur le coût Claude.**

## Compétitions surveillées (29)

Chaque compétition définit sa fenêtre de saison (format MMJJ). Les compétitions hors saison sont **ignorées sans appel réseau**, ce qui réduit la consommation OddsAPI de ~58%.

### Football — Ligues nationales

| Compétition | Saison active |
|------------|--------------|
| Ligue 1 | 10 août → 22 mai |
| Coupe de France | 20 juil → 22 mai |
| Premier League | 7 août → 24 mai |
| FA Cup | 28 juil → 22 mai |
| Championship (EFL) | 5 août → 10 mai |
| La Liga | 10 août → 30 mai |
| Bundesliga | 18 août → 22 mai |
| Serie A | 12 août → 30 mai |

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

| Compétition | Saison active |
|------------|--------------|
| Top 14 | 25 août → 20 juin |
| 6 Nations + Autumn Tests | 25 jan→27 mar · 26 oct→12 déc |
| Champions Cup | 28 nov → 28 mai |
| Coupe du Monde Rugby | 25 août → 5 nov | **2027** uniquement |

### Hockey sur glace

| Compétition | Saison active |
|------------|--------------|
| NHL | 1er oct → 20 juin |
| Championnat du Monde | 27 avr → 30 mai |

## OddsAPI — consommation estimée

| Scénario | Req/mois |
|---------|---------|
| Sans filtrage saison (29 sports × 2 cycles × 30j) | ~1 740 |
| **Avec filtrage (12–15 actifs en moyenne)** | **~720–900** |

Le filtrage par saison économise environ **~900 req/mois** par rapport à un appel systématique.
Plan Basic OddsAPI requis ($39,99/mois, 10 000 req/mois).

## Mode superadmin

Le compte `ujotze4rf8qhs9k` reçoit une analyse basée sur les données agrégées de **tous les utilisateurs** de la plateforme (au lieu de ses paris uniquement). Le prompt Claude mentionne "communauté de N parieurs — données agrégées".

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
