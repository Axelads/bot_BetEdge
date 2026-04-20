// Détecte les cotes anormalement hautes en comparant tous les bookmakers entre eux.
// Une cote est "anormale" si elle dépasse la médiane du marché de plus de SEUIL_ECART_MIN.

const SEUIL_ECART_MIN = 0.12     // 12% au-dessus de la médiane → suspect
const SEUIL_SCORE_MIN = 60       // score minimum pour envoyer à Claude

const calculerMediane = (valeurs) => {
  const triees = [...valeurs].sort((a, b) => a - b)
  const milieu = Math.floor(triees.length / 2)
  return triees.length % 2 === 0
    ? (triees[milieu - 1] + triees[milieu]) / 2
    : triees[milieu]
}

// Retourne la marge "best available" du marché H2H (somme des probas implicites - 1).
// Plus elle est basse, plus le marché est compétitif / potentiellement mal pricé.
const calculerMargeMarche = (bookmakers) => {
  const meilleureParOutcome = {}

  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'h2h')
    if (!marche) continue
    for (const outcome of (marche.outcomes ?? [])) {
      if (!meilleureParOutcome[outcome.name] || outcome.price > meilleureParOutcome[outcome.name]) {
        meilleureParOutcome[outcome.name] = outcome.price
      }
    }
  }

  const cotes = Object.values(meilleureParOutcome)
  if (cotes.length === 0) return null
  const sommeProbas = cotes.reduce((sum, cote) => sum + (1 / cote), 0)
  return Math.round((sommeProbas - 1) * 1000) / 10  // en %, 1 décimale
}

// Analyse le marché H2H et retourne les outcomes dont la meilleure cote
// dépasse significativement la médiane.
const detecterAnomaliesH2H = (bookmakers) => {
  const cotesParOutcome = {}
  const meilleurParOutcome = {}

  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === 'h2h')
    if (!marche) continue
    for (const outcome of (marche.outcomes ?? [])) {
      if (!cotesParOutcome[outcome.name]) cotesParOutcome[outcome.name] = []
      cotesParOutcome[outcome.name].push(outcome.price)

      if (
        !meilleurParOutcome[outcome.name] ||
        outcome.price > meilleurParOutcome[outcome.name].cote
      ) {
        meilleurParOutcome[outcome.name] = {
          cote: outcome.price,
          bookmaker: bookmaker.title,
        }
      }
    }
  }

  const anomalies = []

  for (const [outcome, cotes] of Object.entries(cotesParOutcome)) {
    if (cotes.length < 3) continue  // Pas assez de bookmakers pour comparer

    const mediane = calculerMediane(cotes)
    const meilleur = meilleurParOutcome[outcome]
    const ecart = (meilleur.cote - mediane) / mediane

    if (ecart >= SEUIL_ECART_MIN) {
      anomalies.push({
        outcome,
        cote_anomalie: meilleur.cote,
        cote_mediane: Math.round(mediane * 100) / 100,
        bookmaker: meilleur.bookmaker,
        ecart_pourcent: Math.round(ecart * 100),
        nb_bookmakers: cotes.length,
        toutes_cotes: cotes.sort((a, b) => a - b),
      })
    }
  }

  return anomalies.sort((a, b) => b.ecart_pourcent - a.ecart_pourcent)
}

// Point d'entrée principal. Reçoit un match avec bookmakers_bruts.
// Retourne null si aucune anomalie significative, sinon l'anomalie la plus forte.
export const detecterAnomaliesCotes = (match) => {
  const bookmakers = match.bookmakers_bruts ?? []
  if (bookmakers.length < 3) return null

  const anomalies = detecterAnomaliesH2H(bookmakers)
  if (anomalies.length === 0) return null

  const margeMarche = calculerMargeMarche(bookmakers)

  // Score basé sur l'écart le plus fort détecté
  const anomaliePrincipale = anomalies[0]
  let scoreAnomalie = Math.min(100, anomaliePrincipale.ecart_pourcent * 5)
  // Bonus si la marge globale du marché est anormalement basse (bookmaker peu sûr de lui)
  if (margeMarche !== null && margeMarche < 3) scoreAnomalie = Math.min(100, scoreAnomalie + 15)

  if (scoreAnomalie < SEUIL_SCORE_MIN) return null

  return {
    score_anomalie: Math.round(scoreAnomalie),
    outcome: anomaliePrincipale.outcome,
    cote_anomalie: anomaliePrincipale.cote_anomalie,
    cote_mediane: anomaliePrincipale.cote_mediane,
    bookmaker: anomaliePrincipale.bookmaker,
    ecart_pourcent: anomaliePrincipale.ecart_pourcent,
    nb_bookmakers: anomaliePrincipale.nb_bookmakers,
    toutes_cotes: anomaliePrincipale.toutes_cotes,
    marge_marche: margeMarche,
    autres_anomalies: anomalies.slice(1),
  }
}
