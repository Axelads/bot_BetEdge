import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

// Sport keys OddsAPI des 5 grands championnats européens — buteurs activés UNIQUEMENT sur ces matchs
// pour économiser les crédits (10 crédits/match via l'endpoint /events/{id}/odds, vs 1 crédit/marché normal).
const TOP_5_CHAMPIONNATS = new Set([
  'soccer_france_ligue1',
  'soccer_epl',
  'soccer_spain_la_liga',
  'soccer_germany_bundesliga',
  'soccer_italy_serie_a',
])

const calculerMediane = (valeurs) => {
  if (valeurs.length === 0) return null
  const triees = [...valeurs].sort((a, b) => a - b)
  const milieu = Math.floor(triees.length / 2)
  return triees.length % 2 === 0
    ? (triees[milieu - 1] + triees[milieu]) / 2
    : triees[milieu]
}

// Récupère les cotes "buteur à tout moment" pour un match via l'endpoint OddsAPI events.
// Coût : 10 crédits par appel (vs 1 crédit pour les marchés standards).
const recupererButeursMatch = async (match) => {
  const sportKey = match.oddsapi_sport_key
  const eventId  = match.id
  if (!sportKey || !eventId) return null

  const url = `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${eventId}/odds`
    + `?apiKey=${process.env.ODDS_API_KEY}`
    + `&regions=eu`
    + `&markets=player_goal_scorer_anytime`
    + `&oddsFormat=decimal`

  try {
    const reponse = await fetch(url)

    if (reponse.status === 404 || reponse.status === 422) {
      // Pas de cotes buteurs disponibles pour ce match — silencieux
      return null
    }

    if (!reponse.ok) {
      throw new Error(`HTTP ${reponse.status}`)
    }

    const restantes = reponse.headers.get('x-requests-remaining')
    if (restantes !== null) {
      console.log(`[buteurs] OddsAPI events — ${restantes} crédits restants`)
    }

    const data = await reponse.json()
    const bookmakers = data.bookmakers ?? []

    // Agrégation des cotes par joueur (médiane multi-bookmakers)
    const cotesParJoueur = {}
    for (const bm of bookmakers) {
      const marche = bm.markets?.find(m => m.key === 'player_goal_scorer_anytime')
      if (!marche) continue
      for (const outcome of marche.outcomes ?? []) {
        const joueur = outcome.description ?? outcome.name
        if (!joueur || joueur === 'Yes' || joueur === 'No') continue
        if (!cotesParJoueur[joueur]) cotesParJoueur[joueur] = []
        cotesParJoueur[joueur].push(outcome.price)
      }
    }

    const buteurs = Object.entries(cotesParJoueur)
      .filter(([, cotes]) => cotes.length > 0)
      .map(([joueur, cotes]) => ({
        joueur,
        cote: Math.round(calculerMediane(cotes) * 100) / 100,
        nb_bookmakers: cotes.length,
      }))
      .sort((a, b) => a.cote - b.cote)  // joueurs les plus probables d'abord

    return buteurs.length > 0 ? buteurs : null
  } catch (erreur) {
    console.error(`[buteurs] Erreur ${match.rencontre}:`, erreur.message)
    return null
  }
}

// Enrichit les matchs des 5 grands championnats avec les cotes "buteur à tout moment".
// Coût : 10 crédits/match × ~5-10 matchs top 5 / cycle × 2 cycles × 30 ≈ 3000-6000 crédits/mois.
export const enrichirButeurs = async (matchs) => {
  const matchsCibles = matchs.filter(m => TOP_5_CHAMPIONNATS.has(m.oddsapi_sport_key))

  if (matchsCibles.length === 0) {
    console.log('[buteurs] Aucun match top 5 — enrichissement ignoré')
    return matchs
  }

  console.log(`[buteurs] Enrichissement de ${matchsCibles.length} match(s) top 5 via OddsAPI events (10 crédits/match)`)

  for (const match of matchsCibles) {
    const buteurs = await recupererButeursMatch(match)
    if (buteurs && buteurs.length > 0) {
      match.buteurs = buteurs
      const top3 = buteurs.slice(0, 3).map(b => `${b.joueur} (${b.cote})`).join(', ')
      console.log(`[buteurs] ✅ ${match.rencontre} — ${buteurs.length} joueur(s) | top3: ${top3}`)
    } else {
      console.log(`[buteurs] ⚠️  ${match.rencontre} — aucune cote buteur disponible`)
    }
  }

  return matchs
}
