import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

// Dates au format MMJJ (entier) : 810 = 10 août, 522 = 22 mai
// debut <= fin  → même année civile (ex: Roland Garros mai-juin)
// debut  > fin  → à cheval sur deux années (ex: Ligue 1 août-mai)
// periodes      → plusieurs fenêtres disjointes dans l'année (ex: Internationaux de rugby)
// annees        → compétition quadriennale — ignorée les autres années

const SPORTS_SURVEILLES = [
  // ── Football — Ligues nationales ──────────────────────────────────────────
  { cle: 'soccer_france_ligue1',                    label: 'Ligue 1',              debut: 810,  fin: 522 },
  { cle: 'soccer_epl',                              label: 'Premier League',        debut: 807,  fin: 524 },
  { cle: 'soccer_england_efl_champ',                label: 'Championship',          debut: 805,  fin: 510 },
  { cle: 'soccer_spain_la_liga',                    label: 'La Liga',              debut: 810,  fin: 530 },
  { cle: 'soccer_germany_bundesliga',               label: 'Bundesliga',            debut: 818,  fin: 522 },
  { cle: 'soccer_italy_serie_a',                    label: 'Serie A',              debut: 812,  fin: 530 },
  // ── Football — Coupes nationales (à partir des 8èmes de finale) ───────────
  { cle: 'soccer_france_coupe_de_france',           label: 'Coupe de France',      debut: 101,  fin: 525 },
  { cle: 'soccer_england_fa_cup',                   label: 'FA Cup',               debut: 201,  fin: 520 },
  { cle: 'soccer_spain_copa_del_rey',               label: 'Copa del Rey',          debut: 108,  fin: 512 },
  { cle: 'soccer_germany_dfb_pokal',                label: 'DFB Pokal',             debut: 128,  fin: 525 },
  { cle: 'soccer_italy_coppa_italia',               label: 'Coppa Italia',          debut: 108,  fin: 528 },
  // ── Football — Compétitions européennes (pause mi-déc → mi-jan) ──────────
  { cle: 'soccer_uefa_champs_league',            label: 'Ligue des Champions',
    periodes: [{ debut: 825, fin: 1212 }, { debut: 118, fin: 605 }] },
  { cle: 'soccer_uefa_europa_league',            label: 'Ligue Europa',
    periodes: [{ debut: 825, fin: 1212 }, { debut: 118, fin: 528 }] },
  { cle: 'soccer_uefa_europa_conference_league', label: 'Conference League',
    periodes: [{ debut: 825, fin: 1212 }, { debut: 118, fin: 528 }] },
  // ── Football — Compétitions internationales (quadriennales) ───────────────
  { cle: 'soccer_world_cup',                        label: 'Coupe du Monde FIFA',  debut: 607,  fin: 723, annees: [2026] },
  { cle: 'soccer_uefa_european_championship',       label: 'UEFA Euro',            debut: 608,  fin: 718, annees: [2028] },
  // ── Basketball ────────────────────────────────────────────────────────────
  { cle: 'basketball_nba',                          label: 'NBA',                  debut: 1010, fin: 625 },
  { cle: 'basketball_euroleague',                   label: 'Euroleague',            debut: 1001, fin: 525 },
  // ── Tennis ATP — Grands Chelems ───────────────────────────────────────────
  { cle: 'tennis_atp_australian_open',  label: "Open d'Australie (ATP)", debut: 108,  fin: 130 },
  { cle: 'tennis_atp_french_open',      label: 'Roland Garros (ATP)',    debut: 520,  fin: 613 },
  { cle: 'tennis_atp_wimbledon',        label: 'Wimbledon (ATP)',         debut: 626,  fin: 717 },
  { cle: 'tennis_atp_us_open',          label: 'US Open (ATP)',           debut: 821,  fin: 911 },
  // ── Tennis ATP — Masters 1000 ─────────────────────────────────────────────
  { cle: 'tennis_atp_indian_wells',     label: 'Indian Wells (ATP)',      debut: 301,  fin: 320 },
  { cle: 'tennis_atp_miami',            label: 'Miami Open (ATP)',         debut: 317,  fin: 403 },
  { cle: 'tennis_atp_monte_carlo',      label: 'Monte Carlo (ATP)',        debut: 403,  fin: 417 },
  { cle: 'tennis_atp_madrid',           label: 'Madrid Open (ATP)',        debut: 419,  fin: 508 },
  { cle: 'tennis_atp_rome',             label: 'Rome (ATP)',               debut: 504,  fin: 522 },
  { cle: 'tennis_atp_canada',           label: 'Canada Open (ATP)',        debut: 801,  fin: 814 },
  { cle: 'tennis_atp_cincinnati',       label: 'Cincinnati (ATP)',          debut: 809,  fin: 821 },
  { cle: 'tennis_atp_shanghai',         label: 'Shanghai (ATP)',            debut: 1003, fin: 1016 },
  { cle: 'tennis_atp_paris',            label: 'Paris Bercy (ATP)',         debut: 1024, fin: 1106 },
  // ── Tennis ATP — Fin de saison ────────────────────────────────────────────
  { cle: 'tennis_atp_finals',           label: 'ATP Finals',               debut: 1106, fin: 1120 },
  // ── Tennis WTA — Grands Chelems ───────────────────────────────────────────
  { cle: 'tennis_wta_australian_open',  label: "Open d'Australie (WTA)",  debut: 108,  fin: 130 },
  { cle: 'tennis_wta_french_open',      label: 'Roland Garros (WTA)',      debut: 520,  fin: 613 },
  { cle: 'tennis_wta_wimbledon',        label: 'Wimbledon (WTA)',           debut: 626,  fin: 717 },
  { cle: 'tennis_wta_us_open',          label: 'US Open (WTA)',             debut: 821,  fin: 911 },
  // ── Tennis WTA — Masters 1000 ─────────────────────────────────────────────
  { cle: 'tennis_wta_indian_wells',     label: 'Indian Wells (WTA)',        debut: 301,  fin: 320 },
  { cle: 'tennis_wta_miami',            label: 'Miami Open (WTA)',           debut: 317,  fin: 403 },
  { cle: 'tennis_wta_madrid',           label: 'Madrid Open (WTA)',          debut: 419,  fin: 508 },
  { cle: 'tennis_wta_rome',             label: 'Rome (WTA)',                 debut: 506,  fin: 521 },
  { cle: 'tennis_wta_canada',           label: 'Canada Open (WTA)',          debut: 801,  fin: 814 },
  { cle: 'tennis_wta_cincinnati',       label: 'Cincinnati (WTA)',            debut: 809,  fin: 821 },
  { cle: 'tennis_wta_beijing',          label: 'Beijing (WTA)',              debut: 928,  fin: 1010 },
  // ── Tennis WTA — Fin de saison ────────────────────────────────────────────
  { cle: 'tennis_wta_finals',           label: 'WTA Finals',                debut: 1023, fin: 1106 },
  // ── Rugby ─────────────────────────────────────────────────────────────────
  { cle: 'rugbyunion_france_top14',                 label: 'Top 14',               debut: 825,  fin: 620 },
  { cle: 'rugbyunion_internationals',               label: 'Internationaux Rugby',
    periodes: [
      { debut: 125, fin: 327 },   // 6 Nations (fin jan → fin mar)
      { debut: 1026, fin: 1212 }, // Autumn Tests (fin oct → mi-déc)
    ]
  },
  { cle: 'rugbyunion_champions_cup',                label: 'Champions Cup (Rugby)', debut: 1128, fin: 528 },
  { cle: 'rugbyunion_world_cup',                    label: 'Coupe du Monde Rugby', debut: 825,  fin: 1105, annees: [2027] },
  // ── Hockey sur glace ──────────────────────────────────────────────────────
  { cle: 'icehockey_nhl',                           label: 'NHL',                  debut: 1001, fin: 620 },
  { cle: 'icehockey_world_championship',            label: 'Mondial Hockey',       debut: 427,  fin: 530 },
]

// Vérifie si la compétition est dans sa fenêtre de saison active
const estCompetitionActive = (sport) => {
  const maintenant = new Date()
  const annee = maintenant.getFullYear()
  const mmjj = (maintenant.getMonth() + 1) * 100 + maintenant.getDate()

  if (sport.annees && !sport.annees.includes(annee)) return false

  const dansIntervalle = (debut, fin) => {
    if (debut <= fin) return mmjj >= debut && mmjj <= fin
    return mmjj >= debut || mmjj <= fin // à cheval sur deux années
  }

  if (sport.periodes) return sport.periodes.some(p => dansIntervalle(p.debut, p.fin))
  if (sport.debut !== undefined) return dansIntervalle(sport.debut, sport.fin)
  return true // pas de dates définies → toujours actif
}

const recupererMatchsSport = async (sport) => {
  const url = `https://api.the-odds-api.com/v4/sports/${sport.cle}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=eu&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`

  try {
    const reponse = await fetch(url)

    if (reponse.status === 422) {
      console.log(`[collecteur] ${sport.label} — sport inactif (pas de matchs en cours)`)
      return []
    }

    if (!reponse.ok) {
      throw new Error(`HTTP ${reponse.status}`)
    }

    const restantes = reponse.headers.get('x-requests-remaining')
    const utilisees  = reponse.headers.get('x-requests-used')
    if (restantes !== null) {
      console.log(`[collecteur] OddsAPI — ${restantes} requêtes restantes ce mois (${utilisees} utilisées)`)
    }

    const donnees = await reponse.json()
    return donnees
  } catch (erreur) {
    console.error(`[collecteur] Erreur ${sport.label}:`, erreur.message)
    return []
  }
}

const filtrerMatchsProchains24h = (matchs) => {
  const maintenant = new Date()
  const dans24h = new Date(maintenant.getTime() + 24 * 60 * 60 * 1000)

  return matchs.filter(match => {
    const dateMatch = new Date(match.commence_time)
    return dateMatch >= maintenant && dateMatch <= dans24h
  })
}

const extraireCote = (bookmakers, nomEquipe) => {
  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'h2h')
    if (!marche) continue
    const outcome = marche.outcomes?.find(o => o.name === nomEquipe)
    if (outcome) return outcome.price
  }
  return null
}

const extraireCoteTotal = (bookmakers, sens) => {
  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'totals')
    if (!marche) continue
    const outcome = marche.outcomes?.find(o => o.name === sens)
    if (outcome) return outcome.price
  }
  return null
}

const formaterMatch = (match, sport) => {
  const bookmakers = match.bookmakers ?? []

  return {
    id: match.id,
    sport: sport.cle.startsWith('soccer')      ? 'football'
         : sport.cle.startsWith('basketball')  ? 'basketball'
         : sport.cle.startsWith('tennis')      ? 'tennis'
         : sport.cle.startsWith('rugbyunion')  ? 'rugby'
         : sport.cle.startsWith('icehockey')   ? 'hockey'
         : 'autre',
    competition: sport.label,
    rencontre: `${match.home_team} vs ${match.away_team}`,
    equipe_domicile: match.home_team,
    equipe_exterieur: match.away_team,
    date_match: match.commence_time,
    cotes: {
      domicile:   extraireCote(bookmakers, match.home_team),
      nul:        extraireCote(bookmakers, 'Draw'),
      exterieur:  extraireCote(bookmakers, match.away_team),
      over25:     extraireCoteTotal(bookmakers, 'Over'),
      under25:    extraireCoteTotal(bookmakers, 'Under'),
    },
    bookmakers_bruts: bookmakers,
  }
}

export const recupererMatchsAVenir = async () => {
  console.log('[collecteur] Récupération des matchs des prochaines 24h...')
  const tousLesMatchs = []

  for (const sport of SPORTS_SURVEILLES) {
    if (!estCompetitionActive(sport)) {
      console.log(`[collecteur] ${sport.label} — hors saison, ignorée`)
      continue
    }

    const matchs = await recupererMatchsSport(sport)
    const matchsProchains = filtrerMatchsProchains24h(matchs)
    const matchsFormats = matchsProchains.map(m => formaterMatch(m, sport))

    if (matchsFormats.length > 0) {
      console.log(`[collecteur] ${sport.label}: ${matchsFormats.length} match(s)`)
    }

    tousLesMatchs.push(...matchsFormats)
  }

  console.log(`[collecteur] Total: ${tousLesMatchs.length} match(s) à analyser`)
  return tousLesMatchs
}
