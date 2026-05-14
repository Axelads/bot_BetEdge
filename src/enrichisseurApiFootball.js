import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

const BASE_URL = 'https://v3.football.api-sports.io'

// Mapping compétition (label OddsAPI) → league ID API-Football
// Utilisé pour filtrer les fixtures retournés par l'endpoint /fixtures?date
const COMPETITION_VERS_LIGUE = {
  'Ligue 1':              61,
  'Premier League':       39,
  'Championship':         40,
  'La Liga':              140,
  'Bundesliga':           78,
  'Serie A':              135,
  'Coupe de France':      66,
  'FA Cup':               45,
  'Copa del Rey':         143,
  'DFB Pokal':            81,
  'Coppa Italia':         137,
  'Ligue des Champions':  2,
  'Ligue Europa':         3,
  'Conference League':    848,
}

// IDs API-Football des 5 grands championnats — passeurs décisifs activés UNIQUEMENT sur ces matchs
// (économie quota Free 100 req/jour : ne pas appeler /odds sur les coupes/europe)
const TOP_5_LIGUES_API = new Set([61, 39, 140, 78, 135])

// Calcul médiane (utilitaire local pour les cotes passeurs)
const calculerMediane = (valeurs) => {
  if (valeurs.length === 0) return null
  const triees = [...valeurs].sort((a, b) => a - b)
  const milieu = Math.floor(triees.length / 2)
  return triees.length % 2 === 0
    ? (triees[milieu - 1] + triees[milieu]) / 2
    : triees[milieu]
}

const appelApiFootball = async (endpoint) => {
  try {
    const reponse = await fetch(`${BASE_URL}${endpoint}`, {
      headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY },
    })

    const restantes = reponse.headers.get('x-ratelimit-requests-remaining')
    if (restantes !== null) {
      console.log(`[api-football] ${restantes} requêtes restantes aujourd'hui`)
    }

    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`)

    const data = await reponse.json()

    if (data.errors && Object.keys(data.errors).length > 0) {
      console.error(`[api-football] Erreur: ${JSON.stringify(data.errors)}`)
      return null
    }

    return data.response ?? []
  } catch (erreur) {
    console.error(`[api-football] Erreur ${endpoint}:`, erreur.message)
    return null
  }
}

// Normalise un nom d'équipe pour la comparaison floue (4 premiers caractères suffisent)
const normaliserNom = (nom) => nom.toLowerCase().replace(/[^a-z0-9]/g, '')

const noms4 = (nom) => normaliserNom(nom).slice(0, 5)

// Trouve un fixture dans la liste par noms d'équipes (comparaison floue)
const trouverFixture = (fixtures, equipe1, equipe2) => {
  const n1 = noms4(equipe1)
  const n2 = noms4(equipe2)

  return fixtures.find(f => {
    const dom = noms4(f.teams.home.name)
    const ext = noms4(f.teams.away.name)
    return (dom.includes(n1) || n1.includes(dom)) &&
           (ext.includes(n2) || n2.includes(ext))
  }) ?? null
}

// Formate les résultats H2H en liste lisible
const formaterH2H = (fixtures) => {
  return fixtures.slice(0, 5).map(f => {
    const gh = f.goals.home ?? '?'
    const ga = f.goals.away ?? '?'
    const date = f.fixture.date.slice(0, 10)
    return `${f.teams.home.name} ${gh}-${ga} ${f.teams.away.name} (${date})`
  })
}

// Calcule la forme H2H d'une équipe sur les 5 derniers face-à-face
const formaterFormeH2H = (fixtures, teamId) => {
  return fixtures.slice(0, 5).map(f => {
    const { home, away } = f.teams
    const estDomicile = home.id === teamId
    const gagnant = estDomicile ? home.winner : away.winner
    if (gagnant === true) return 'V'
    if (gagnant === false) return 'D'
    return 'N'
  }).join('')
}

// Formate les blessures d'une équipe : liste des joueurs absents/incertains
const formaterBlessures = (injuries, teamId) => {
  return injuries
    .filter(i => i.team.id === teamId)
    .slice(0, 6)
    .map(i => {
      const type = i.player.type === 'Missing Fixture' ? 'Absent' : i.player.type
      return `${i.player.name} (${type}: ${i.player.reason})`
    })
}

// Formate les statistiques d'un match H2H complété (possession, tirs, corners)
const formaterStatistiquesH2H = (statsData, fixture) => {
  if (!statsData || statsData.length < 2) return null

  const extraire = (statistiques, type) => {
    const stat = statistiques.find(s => s.type === type)
    return stat?.value ?? null
  }

  const domData = statsData[0]
  const extData = statsData[1]
  const score = `${fixture.goals.home ?? '?'}-${fixture.goals.away ?? '?'}`
  const date  = fixture.fixture.date.slice(0, 10)

  return {
    match_ref:   `${domData.team.name} ${score} ${extData.team.name} (${date})`,
    possession:  {
      domicile:  extraire(domData.statistics, 'Ball Possession'),
      exterieur: extraire(extData.statistics, 'Ball Possession'),
    },
    tirs_cadres: {
      domicile:  extraire(domData.statistics, 'Shots on Goal'),
      exterieur: extraire(extData.statistics, 'Shots on Goal'),
    },
    tirs_total:  {
      domicile:  extraire(domData.statistics, 'Total Shots'),
      exterieur: extraire(extData.statistics, 'Total Shots'),
    },
    corners:     {
      domicile:  extraire(domData.statistics, 'Corner Kicks'),
      exterieur: extraire(extData.statistics, 'Corner Kicks'),
    },
  }
}

// Formate les compositions officielles (disponibles 20-40 min avant le coup d'envoi)
const formaterLineup = (lineupData) => {
  if (!lineupData || lineupData.length === 0) return null

  return lineupData.map(equipe => ({
    equipe:     equipe.team.name,
    formation:  equipe.formation ?? null,
    titulaires: (equipe.startXI ?? []).map(p => `${p.player.name} (${p.player.pos})`),
    coach:      equipe.coach?.name ?? null,
  }))
}

// Récupère les cotes "passeur décisif" (Anytime Assist) via API-Football /odds.
// API-Football n'a pas de bet ID documenté pour les assists — on parse par nom de bet.
// Coverage variable selon les bookmakers retournés ; peut être vide pour de nombreux matchs.
const recupererPasseurs = async (fixtureId) => {
  const data = await appelApiFootball(`/odds?fixture=${fixtureId}`)
  if (!data || data.length === 0) return null

  // Patterns de noms de bet recherchés (insensible à la casse)
  const motifsAssist = /assist|passe(?:ur)?\s*d[ée]cisi/i

  const cotesParJoueur = {}
  let nbBetsAssistTrouves = 0

  for (const bookmakerData of data) {
    for (const bookmaker of bookmakerData.bookmakers ?? []) {
      for (const bet of bookmaker.bets ?? []) {
        if (!motifsAssist.test(bet.name ?? '')) continue
        // Exclure les combos goalscorer+assist (on veut le marché Anytime Assist pur)
        if (/goal\s*scorer|first|last/i.test(bet.name ?? '') && !motifsAssist.test(bet.name)) continue

        nbBetsAssistTrouves++
        for (const value of bet.values ?? []) {
          const joueur = value.value
          const cote = parseFloat(value.odd)
          if (!joueur || Number.isNaN(cote)) continue
          if (!cotesParJoueur[joueur]) cotesParJoueur[joueur] = []
          cotesParJoueur[joueur].push(cote)
        }
      }
    }
  }

  if (nbBetsAssistTrouves === 0) return null

  const passeurs = Object.entries(cotesParJoueur)
    .map(([joueur, cotes]) => ({
      joueur,
      cote: Math.round(calculerMediane(cotes) * 100) / 100,
      nb_bookmakers: cotes.length,
    }))
    .sort((a, b) => a.cote - b.cote)

  return passeurs.length > 0 ? passeurs : null
}

// Formate la prédiction de l'API en objet lisible pour Claude
const formaterPrediction = (pred) => {
  const p = pred.predictions
  const c = pred.comparison
  return {
    conseil:           p.advice ?? null,
    probabilites:      p.percent ?? null,       // { home: "45%", draw: "45%", away: "10%" }
    buts_prevus:       p.goals ?? null,          // { home: "-2.5", away: "-2.5" }
    comparaison_forme: c?.form ?? null,          // { home: "61%", away: "39%" }
    score_global:      c?.total ?? null,         // { home: "59.0%", away: "41.0%" }
  }
}

// Enrichit tous les matchs football de la liste avec données API-Football
// Stratégie quota : 1 appel fixtures/date + 5 appels par match (H2H, injuries, predictions, lineups, stats H2H)
//                 + 1 appel /odds pour passeurs sur les matchs top 5 ligues uniquement
// = max ~41 appels foot + ~5 passeurs top 5 par cycle × 2 cycles ≈ 92/jour (sous les 100 du plan gratuit, marge serrée)
export const enrichirMatchsFootball = async (matchs) => {
  const matchsFootball = matchs.filter(m => m.sport === 'football')

  if (matchsFootball.length === 0) return matchs

  if (!process.env.API_FOOTBALL_KEY) {
    console.log('[api-football] Clé API absente — enrichissement ignoré')
    return matchs
  }

  console.log(`[api-football] Enrichissement de ${matchsFootball.length} match(s) football...`)

  // Récupérer la date du premier match à venir
  const dates = [...new Set(
    matchsFootball.map(m => new Date(m.date_match).toISOString().slice(0, 10))
  )]

  for (const date of dates) {
    // 1 seul appel pour TOUS les fixtures de ce jour — pas de restriction plan gratuit
    const tousFixtures = await appelApiFootball(`/fixtures?date=${date}`)

    if (!tousFixtures || tousFixtures.length === 0) {
      console.log(`[api-football] Aucun fixture trouvé pour le ${date}`)
      continue
    }

    console.log(`[api-football] ${tousFixtures.length} fixture(s) récupérés pour le ${date}`)

    // Filtrer par league ID pour les compétitions surveillées
    const liguesConnues = new Set(Object.values(COMPETITION_VERS_LIGUE))
    const fixturesFiltres = tousFixtures.filter(f => liguesConnues.has(f.league?.id))

    const matchsDuJour = matchsFootball.filter(
      m => new Date(m.date_match).toISOString().slice(0, 10) === date
    )

    for (const match of matchsDuJour) {
      const ligueId = COMPETITION_VERS_LIGUE[match.competition]

      // Chercher d'abord dans la bonne ligue, puis dans tous les fixtures si non trouvé
      const fixturesLigue = ligueId
        ? fixturesFiltres.filter(f => f.league.id === ligueId)
        : fixturesFiltres

      const fixture = trouverFixture(fixturesLigue, match.equipe_domicile, match.equipe_exterieur)
        ?? trouverFixture(fixturesFiltres, match.equipe_domicile, match.equipe_exterieur)

      if (!fixture) {
        console.log(`[api-football] Fixture non identifié: ${match.rencontre}`)
        continue
      }

      const idDomicile = fixture.teams.home.id
      const idExterieur = fixture.teams.away.id
      const fixtureId   = fixture.fixture.id

      // 4 appels en parallèle — lineups disponibles 20-40 min avant le match
      const [h2hData, blessuresData, predictionData, lineupData] = await Promise.all([
        appelApiFootball(`/fixtures/headtohead?h2h=${idDomicile}-${idExterieur}`),
        appelApiFootball(`/injuries?fixture=${fixtureId}`),
        appelApiFootball(`/predictions?fixture=${fixtureId}`),
        appelApiFootball(`/fixtures/lineups?fixture=${fixtureId}`),
      ])

      // Statistiques du dernier H2H — appel séquentiel car on a besoin de l'ID H2H d'abord
      let statsH2HData = null
      if (h2hData && h2hData.length > 0) {
        statsH2HData = await appelApiFootball(`/fixtures/statistics?fixture=${h2hData[0].fixture.id}`)
      }

      const h2hResultats      = h2hData ? formaterH2H(h2hData) : []
      const formeDomicileH2H  = h2hData ? formaterFormeH2H(h2hData, idDomicile) : null
      const formeExterieurH2H = h2hData ? formaterFormeH2H(h2hData, idExterieur) : null

      const blessuresDomicile  = blessuresData ? formaterBlessures(blessuresData, idDomicile)  : []
      const blessuresExterieur = blessuresData ? formaterBlessures(blessuresData, idExterieur) : []

      const prediction = predictionData?.[0]
        ? formaterPrediction(predictionData[0])
        : null

      const statsH2H = (statsH2HData && h2hData && h2hData.length > 0)
        ? formaterStatistiquesH2H(statsH2HData, h2hData[0])
        : null

      const lineups = formaterLineup(lineupData)

      match.contexte_api_football = {
        fixture_id:              fixtureId,
        saison:                  fixture.league.season,
        journee:                 fixture.league.round,
        h2h_5_derniers:          h2hResultats,
        forme_domicile_h2h:      formeDomicileH2H,
        forme_exterieur_h2h:     formeExterieurH2H,
        stats_dernier_h2h:       statsH2H,
        blessures_domicile:      blessuresDomicile,
        blessures_exterieur:     blessuresExterieur,
        prediction_api:          prediction,
        lineups:                 lineups,
      }

      // Passeurs décisifs — top 5 ligues + match imminent (<30h) uniquement (économie quota Free)
      // La fenêtre de collecte est 72h, mais 1 appel /odds par match dépasserait le quota
      // API-Football Free (100/jour) si on enrichissait tous les matchs week-end dès le jeudi.
      const heuresAvantMatch = (new Date(match.date_match).getTime() - Date.now()) / (60 * 60 * 1000)
      if (TOP_5_LIGUES_API.has(fixture.league.id) && heuresAvantMatch >= 0 && heuresAvantMatch <= 30) {
        const passeurs = await recupererPasseurs(fixtureId)
        if (passeurs && passeurs.length > 0) {
          match.passeurs = passeurs
          const top3 = passeurs.slice(0, 3).map(p => `${p.joueur} (${p.cote})`).join(', ')
          console.log(`[api-football] ✅ ${match.rencontre} passeurs : ${passeurs.length} joueur(s) | top3: ${top3}`)
        } else {
          console.log(`[api-football] ⚠️  ${match.rencontre} passeurs : aucune cote disponible`)
        }
      }

      console.log(
        `[api-football] ✅ ${match.rencontre} — ${fixture.league.round} — ` +
        `H2H: ${h2hResultats.length} | ` +
        `stats H2H: ${statsH2H ? 'oui' : 'non'} | ` +
        `blessés: ${blessuresDomicile.length}/${blessuresExterieur.length} | ` +
        `lineups: ${lineups ? 'oui' : 'non'} | ` +
        `prédiction: ${prediction?.conseil ?? 'N/A'}`
      )
    }
  }

  return matchs
}
