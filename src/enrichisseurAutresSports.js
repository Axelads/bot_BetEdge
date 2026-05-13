import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

// Endpoints api-sports.io v1 — partagent la même structure pour basketball, hockey, rugby.
// La clé API_FOOTBALL_KEY est universelle sur api-sports.io (les 12 APIs sont activées avec une seule clé).
const BASES = {
  basketball: 'https://v1.basketball.api-sports.io',
  hockey:     'https://v1.hockey.api-sports.io',
  rugby:      'https://v1.rugby.api-sports.io',
}

// Mapping competition (label OddsAPI) → league ID api-sports.io (utilisé pour filtrage facultatif).
// Si l'ID est inconnu, le matching tombe sur la recherche par nom d'équipe.
const COMPETITION_VERS_LIGUE = {
  basketball: {
    'NBA':         12,
    'Euroleague':  120,
  },
  hockey: {
    'NHL':              57,
    'Mondial Hockey':   null, // ID variable selon édition annuelle
  },
  rugby: {
    'Top 14':                16,
    'Champions Cup (Rugby)':  9,
    'Internationaux Rugby':   null,
    'Coupe du Monde Rugby':   null,
  },
}

const appelApi = async (sport, endpoint) => {
  try {
    const reponse = await fetch(`${BASES[sport]}${endpoint}`, {
      headers: { 'x-apisports-key': process.env.API_FOOTBALL_KEY },
    })

    const restantes = reponse.headers.get('x-ratelimit-requests-remaining')
    if (restantes !== null) {
      console.log(`[api-${sport}] ${restantes} requêtes restantes aujourd'hui`)
    }

    if (!reponse.ok) throw new Error(`HTTP ${reponse.status}`)

    const data = await reponse.json()

    const aDesErreurs = Array.isArray(data.errors)
      ? data.errors.length > 0
      : (data.errors && Object.keys(data.errors).length > 0)

    if (aDesErreurs) {
      console.error(`[api-${sport}] Erreur API: ${JSON.stringify(data.errors)}`)
      return null
    }

    return data.response ?? []
  } catch (erreur) {
    console.error(`[api-${sport}] Erreur ${endpoint}: ${erreur.message}`)
    return null
  }
}

// Normalisation pour comparaison floue (5 premiers caractères suffisent)
const normaliserNom = (nom) => String(nom ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)

const trouverFixture = (fixtures, equipeDomicile, equipeExterieur) => {
  const n1 = normaliserNom(equipeDomicile)
  const n2 = normaliserNom(equipeExterieur)
  if (!n1 || !n2) return null

  return fixtures.find(f => {
    const dom = normaliserNom(f.teams?.home?.name)
    const ext = normaliserNom(f.teams?.away?.name)
    return (dom.includes(n1) || n1.includes(dom)) &&
           (ext.includes(n2) || n2.includes(ext))
  }) ?? null
}

// Extrait le score total pour basketball/hockey/rugby (structure scores.home.total)
const extraireScore = (jeu, cote) => {
  const s = jeu.scores?.[cote]
  if (s == null) return null
  if (typeof s === 'number') return s
  return s.total ?? null
}

// Calcule la chaîne de forme V/N/D sur les 5 derniers H2H pour une équipe
const formaterFormeH2H = (h2hData, teamId) => {
  return h2hData.slice(0, 5).map(jeu => {
    const home = jeu.teams?.home
    const away = jeu.teams?.away
    const estDomicile = home?.id === teamId
    const sDom = extraireScore(jeu, 'home')
    const sExt = extraireScore(jeu, 'away')
    if (sDom == null || sExt == null) return '?'
    if (sDom === sExt) return 'N'
    const gagneDomicile = sDom > sExt
    if ((estDomicile && gagneDomicile) || (!estDomicile && !gagneDomicile)) return 'V'
    return 'D'
  }).join('')
}

const formaterH2H = (h2hData) => {
  return h2hData.slice(0, 5).map(jeu => {
    const sDom = extraireScore(jeu, 'home') ?? '?'
    const sExt = extraireScore(jeu, 'away') ?? '?'
    const date = String(jeu.date ?? '').slice(0, 10)
    return `${jeu.teams?.home?.name} ${sDom}-${sExt} ${jeu.teams?.away?.name} (${date})`
  })
}

// Enrichit les matchs d'un sport donné — mode MINIMAL : 1 appel /games?date + 1 appel /games/h2h par match
// Budget : ~5 matchs/cycle × 2 cycles × (1 fixtures + 5 h2h) = ~60 req/jour < quota 100/jour par sport
const enrichirParSport = async (matchs, sport) => {
  if (matchs.length === 0) return
  if (!BASES[sport]) return

  if (!process.env.API_FOOTBALL_KEY) {
    console.log(`[api-${sport}] Clé API absente — enrichissement ignoré`)
    return
  }

  console.log(`[api-${sport}] Enrichissement de ${matchs.length} match(s)...`)

  const dates = [...new Set(
    matchs.map(m => new Date(m.date_match).toISOString().slice(0, 10))
  )]

  for (const date of dates) {
    const fixtures = await appelApi(sport, `/games?date=${date}`)
    if (!fixtures || fixtures.length === 0) {
      console.log(`[api-${sport}] Aucun fixture trouvé pour le ${date}`)
      continue
    }
    console.log(`[api-${sport}] ${fixtures.length} fixture(s) récupérés pour le ${date}`)

    const matchsDuJour = matchs.filter(
      m => new Date(m.date_match).toISOString().slice(0, 10) === date
    )

    for (const match of matchsDuJour) {
      const ligueId = COMPETITION_VERS_LIGUE[sport]?.[match.competition]
      const pool = ligueId
        ? fixtures.filter(f => f.league?.id === ligueId)
        : fixtures
      const fixture = trouverFixture(pool, match.equipe_domicile, match.equipe_exterieur)
        ?? trouverFixture(fixtures, match.equipe_domicile, match.equipe_exterieur)

      if (!fixture) {
        console.log(`[api-${sport}] Fixture non identifié: ${match.rencontre}`)
        continue
      }

      const idDomicile  = fixture.teams.home.id
      const idExterieur = fixture.teams.away.id

      const h2hData = await appelApi(sport, `/games/h2h?h2h=${idDomicile}-${idExterieur}`)
      const h2hResultats     = h2hData ? formaterH2H(h2hData) : []
      const formeDomicileH2H = h2hData ? formaterFormeH2H(h2hData, idDomicile)  : null
      const formeExterieurH2H= h2hData ? formaterFormeH2H(h2hData, idExterieur) : null

      match.contexte_api_sport = {
        sport,
        ligue:                fixture.league?.name ?? null,
        saison:               fixture.league?.season ?? null,
        h2h_5_derniers:       h2hResultats,
        forme_domicile_h2h:   formeDomicileH2H,
        forme_exterieur_h2h:  formeExterieurH2H,
      }

      console.log(
        `[api-${sport}] ✅ ${match.rencontre} — H2H: ${h2hResultats.length} | ` +
        `forme dom: ${formeDomicileH2H ?? 'N/A'} | forme ext: ${formeExterieurH2H ?? 'N/A'}`
      )
    }
  }
}

// Enrichit tous les matchs basketball, hockey et rugby de la liste (mutualisé entre utilisateurs)
export const enrichirAutresSports = async (matchs) => {
  const groupes = {
    basketball: matchs.filter(m => m.sport === 'basketball'),
    hockey:     matchs.filter(m => m.sport === 'hockey'),
    rugby:      matchs.filter(m => m.sport === 'rugby'),
  }

  for (const [sport, m] of Object.entries(groupes)) {
    if (m.length > 0) await enrichirParSport(m, sport)
  }

  return matchs
}
