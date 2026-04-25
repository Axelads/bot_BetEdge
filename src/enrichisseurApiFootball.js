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
// Stratégie quota : 1 appel pour TOUS les matchs du jour + 1 H2H par match
// = max ~9 appels/cycle × 2 cycles = ~18 appels/jour (sur 100 disponibles)
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

      // 3 appels en parallèle — tous sans restriction season sur plan gratuit
      const [h2hData, blessuresData, predictionData] = await Promise.all([
        appelApiFootball(`/fixtures/headtohead?h2h=${idDomicile}-${idExterieur}`),
        appelApiFootball(`/injuries?fixture=${fixtureId}`),
        appelApiFootball(`/predictions?fixture=${fixtureId}`),
      ])

      const h2hResultats      = h2hData ? formaterH2H(h2hData) : []
      const formeDomicileH2H  = h2hData ? formaterFormeH2H(h2hData, idDomicile) : null
      const formeExterieurH2H = h2hData ? formaterFormeH2H(h2hData, idExterieur) : null

      const blessuresDomicile  = blessuresData ? formaterBlessures(blessuresData, idDomicile)  : []
      const blessuresExterieur = blessuresData ? formaterBlessures(blessuresData, idExterieur) : []

      const prediction = predictionData?.[0]
        ? formaterPrediction(predictionData[0])
        : null

      match.contexte_api_football = {
        fixture_id:              fixtureId,
        saison:                  fixture.league.season,
        journee:                 fixture.league.round,
        h2h_5_derniers:          h2hResultats,
        forme_domicile_h2h:      formeDomicileH2H,
        forme_exterieur_h2h:     formeExterieurH2H,
        blessures_domicile:      blessuresDomicile,
        blessures_exterieur:     blessuresExterieur,
        prediction_api:          prediction,
      }

      console.log(
        `[api-football] ✅ ${match.rencontre} — ${fixture.league.round} — ` +
        `H2H: ${h2hResultats.length} | ` +
        `blessés: ${blessuresDomicile.length}/${blessuresExterieur.length} | ` +
        `prédiction: ${prediction?.conseil ?? 'N/A'}`
      )
    }
  }

  return matchs
}
