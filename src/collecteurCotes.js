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

// Marchés OddsAPI dynamiques par sport — `btts` n'existe que pour le football
// Chaque marché = 1 crédit OddsAPI par requête (× 1 région). Foot=4, autres=3.
const getMarchesPourSport = (cleSport) => {
  if (cleSport.startsWith('soccer')) return 'h2h,totals,spreads,btts'
  return 'h2h,totals,spreads'
}

const recupererMatchsSport = async (sport) => {
  const marches = getMarchesPourSport(sport.cle)
  const url = `https://api.the-odds-api.com/v4/sports/${sport.cle}/odds/?apiKey=${process.env.ODDS_API_KEY}&regions=eu&markets=${marches}&oddsFormat=decimal&dateFormat=iso`

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
      console.log(`[collecteur] OddsAPI — ${restantes} crédits restants ce mois (${utilisees} utilisés)`)
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

// ─── Extraction des cotes par marché ────────────────────────────────────────
// Stratégie : pour chaque marché, retenir la cote MÉDIANE (résistante aux outliers)
// + meilleur bookmaker. Les outliers sont déjà gérés par detecteurAnomalie.

const calculerMediane = (valeurs) => {
  if (valeurs.length === 0) return null
  const triees = [...valeurs].sort((a, b) => a - b)
  const milieu = Math.floor(triees.length / 2)
  return triees.length % 2 === 0
    ? (triees[milieu - 1] + triees[milieu]) / 2
    : triees[milieu]
}

// Mode statistique d'un tableau de valeurs numériques (la plus fréquente)
const calculerMode = (valeurs) => {
  if (valeurs.length === 0) return null
  const comptage = {}
  for (const v of valeurs) comptage[v] = (comptage[v] ?? 0) + 1
  let modeValeur = valeurs[0]
  let modeCount = 0
  for (const [v, n] of Object.entries(comptage)) {
    if (n > modeCount) { modeCount = n; modeValeur = parseFloat(v) }
  }
  return modeValeur
}

// H2H : extrait la cote médiane pour un outcome (nom d'équipe ou 'Draw')
const extraireCote = (bookmakers, nomOutcome) => {
  const cotes = []
  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'h2h')
    if (!marche) continue
    const outcome = marche.outcomes?.find(o => o.name === nomOutcome)
    if (outcome) cotes.push(outcome.price)
  }
  return cotes.length > 0 ? Math.round(calculerMediane(cotes) * 100) / 100 : null
}

// Totals : trouve la ligne (point) la plus offerte par les bookmakers,
// puis extrait la cote médiane Over/Under pour cette ligne.
const extraireCotesTotals = (bookmakers) => {
  const pointsOfferts = []
  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'totals')
    if (!marche) continue
    const over = marche.outcomes?.find(o => o.name === 'Over')
    if (over?.point !== undefined) pointsOfferts.push(over.point)
  }

  if (pointsOfferts.length === 0) return { ligne: null, over: null, under: null }

  const ligne = calculerMode(pointsOfferts)
  const cotesOver = []
  const cotesUnder = []

  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'totals')
    if (!marche) continue
    const over = marche.outcomes?.find(o => o.name === 'Over' && o.point === ligne)
    const under = marche.outcomes?.find(o => o.name === 'Under' && o.point === ligne)
    if (over) cotesOver.push(over.price)
    if (under) cotesUnder.push(under.price)
  }

  return {
    ligne,
    over: cotesOver.length > 0 ? Math.round(calculerMediane(cotesOver) * 100) / 100 : null,
    under: cotesUnder.length > 0 ? Math.round(calculerMediane(cotesUnder) * 100) / 100 : null,
  }
}

// Spreads (handicap) : trouve le point handicap le plus offert sur l'équipe domicile,
// puis extrait la cote médiane pour ce handicap (côté domicile et opposé extérieur).
const extraireCotesSpreads = (bookmakers, nomDomicile, nomExterieur) => {
  const pointsDomicile = []
  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'spreads')
    if (!marche) continue
    const dom = marche.outcomes?.find(o => o.name === nomDomicile)
    if (dom?.point !== undefined) pointsDomicile.push(dom.point)
  }

  if (pointsDomicile.length === 0) {
    return { handicap_domicile: null, cote_domicile: null, cote_exterieur: null }
  }

  const handicapDomicile = calculerMode(pointsDomicile)
  const handicapExterieur = -handicapDomicile

  const cotesDomicile = []
  const cotesExterieur = []

  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'spreads')
    if (!marche) continue
    const dom = marche.outcomes?.find(o => o.name === nomDomicile && o.point === handicapDomicile)
    const ext = marche.outcomes?.find(o => o.name === nomExterieur && o.point === handicapExterieur)
    if (dom) cotesDomicile.push(dom.price)
    if (ext) cotesExterieur.push(ext.price)
  }

  return {
    handicap_domicile: handicapDomicile,
    cote_domicile: cotesDomicile.length > 0 ? Math.round(calculerMediane(cotesDomicile) * 100) / 100 : null,
    cote_exterieur: cotesExterieur.length > 0 ? Math.round(calculerMediane(cotesExterieur) * 100) / 100 : null,
  }
}

// BTTS (les deux marquent) — soccer uniquement
const extraireCotesBtts = (bookmakers) => {
  const cotesOui = []
  const cotesNon = []
  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'btts')
    if (!marche) continue
    const oui = marche.outcomes?.find(o => o.name === 'Yes')
    const non = marche.outcomes?.find(o => o.name === 'No')
    if (oui) cotesOui.push(oui.price)
    if (non) cotesNon.push(non.price)
  }
  return {
    oui: cotesOui.length > 0 ? Math.round(calculerMediane(cotesOui) * 100) / 100 : null,
    non: cotesNon.length > 0 ? Math.round(calculerMediane(cotesNon) * 100) / 100 : null,
  }
}

const formaterMatch = (match, sport) => {
  const bookmakers = match.bookmakers ?? []
  const totals = extraireCotesTotals(bookmakers)
  const spreads = extraireCotesSpreads(bookmakers, match.home_team, match.away_team)
  const btts = sport.cle.startsWith('soccer') ? extraireCotesBtts(bookmakers) : { oui: null, non: null }

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
      // H2H (résultat sec)
      domicile:   extraireCote(bookmakers, match.home_team),
      nul:        extraireCote(bookmakers, 'Draw'),
      exterieur:  extraireCote(bookmakers, match.away_team),
      // Totals (over/under) — ligne dynamique (mode statistique)
      ligne_totals: totals.ligne,
      over:        totals.over,
      under:       totals.under,
      // Spreads (handicap) — handicap dynamique (mode statistique sur le domicile)
      handicap_domicile_point: spreads.handicap_domicile,
      handicap_domicile:       spreads.cote_domicile,
      handicap_exterieur:      spreads.cote_exterieur,
      // BTTS (foot uniquement)
      btts_oui: btts.oui,
      btts_non: btts.non,
    },
    bookmakers_bruts: bookmakers,
  }
}

const LIMITE_COMPETITIONS_PAR_CYCLE = 25

export const recupererMatchsAVenir = async () => {
  console.log('[collecteur] Récupération des matchs des prochaines 24h...')
  const tousLesMatchs = []

  const sportsActifs = SPORTS_SURVEILLES.filter(estCompetitionActive)
  const sportsIgnores = SPORTS_SURVEILLES.length - sportsActifs.length
  const sportsAInterroger = sportsActifs.slice(0, LIMITE_COMPETITIONS_PAR_CYCLE)

  console.log(`[collecteur] ${sportsActifs.length} compétitions actives (${sportsIgnores} hors saison) → interrogation des ${sportsAInterroger.length} premières`)

  for (const sport of sportsAInterroger) {
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
