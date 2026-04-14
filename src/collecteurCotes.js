import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

// Sports surveillés sur OddsAPI
const SPORTS_SURVEILLES = [
  { cle: 'soccer_france_ligue1',          label: 'Ligue 1' },
  { cle: 'soccer_epl',                    label: 'Premier League' },
  { cle: 'soccer_spain_la_liga',          label: 'La Liga' },
  { cle: 'soccer_germany_bundesliga',     label: 'Bundesliga' },
  { cle: 'soccer_italy_serie_a',          label: 'Serie A' },
  { cle: 'soccer_uefa_champs_league',     label: 'Ligue des Champions' },
  { cle: 'soccer_uefa_europa_league',     label: 'Ligue Europa' },
  { cle: 'basketball_nba',               label: 'NBA' },
  { cle: 'basketball_euroleague',         label: 'Euroleague' },
]

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
    sport: sport.cle.startsWith('soccer') ? 'football' : sport.cle.startsWith('basketball') ? 'basketball' : 'autre',
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
  }
}

export const recupererMatchsAVenir = async () => {
  console.log('[collecteur] Récupération des matchs des prochaines 24h...')
  const tousLesMatchs = []

  for (const sport of SPORTS_SURVEILLES) {
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
