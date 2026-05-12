// Détecte les cotes anormalement hautes en comparant tous les bookmakers entre eux.
// Une cote est "anormale" si elle dépasse la médiane du marché de plus de SEUIL_ECART_MIN.
// Scan généralisé sur 4 marchés : H2H, Totals (over/under), Spreads (handicap), BTTS.

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

// Détection générique : pour un marché donné, regroupe les outcomes par clé,
// calcule la médiane, repère la meilleure cote, retourne les anomalies trouvées.
// `keyFn(outcome)` produit la clé d'agrégation (ex: name, ou name+point pour spreads/totals).
// `labelFn(outcome)` produit le libellé lisible affiché dans l'anomalie.
const detecterAnomaliesMarche = (bookmakers, marketKey, keyFn, labelFn) => {
  const cotesParCle = {}
  const meilleurParCle = {}
  const labelParCle = {}

  for (const bookmaker of bookmakers) {
    const marche = bookmaker.markets?.find(m => m.key === marketKey)
    if (!marche) continue
    for (const outcome of (marche.outcomes ?? [])) {
      const cle = keyFn(outcome)
      if (cle == null) continue
      if (!cotesParCle[cle]) cotesParCle[cle] = []
      cotesParCle[cle].push(outcome.price)

      if (!meilleurParCle[cle] || outcome.price > meilleurParCle[cle].cote) {
        meilleurParCle[cle] = { cote: outcome.price, bookmaker: bookmaker.title }
      }
      if (!labelParCle[cle]) labelParCle[cle] = labelFn(outcome)
    }
  }

  const anomalies = []

  for (const [cle, cotes] of Object.entries(cotesParCle)) {
    if (cotes.length < 3) continue  // Pas assez de bookmakers pour comparer

    const mediane = calculerMediane(cotes)
    const meilleur = meilleurParCle[cle]
    const ecart = (meilleur.cote - mediane) / mediane

    if (ecart >= SEUIL_ECART_MIN) {
      anomalies.push({
        marche: marketKey,
        outcome: labelParCle[cle],
        cote_anomalie: meilleur.cote,
        cote_mediane: Math.round(mediane * 100) / 100,
        bookmaker: meilleur.bookmaker,
        ecart_pourcent: Math.round(ecart * 100),
        nb_bookmakers: cotes.length,
        toutes_cotes: cotes.sort((a, b) => a - b),
      })
    }
  }

  return anomalies
}

// Point d'entrée principal. Reçoit un match avec bookmakers_bruts.
// Scanne H2H, Totals, Spreads, BTTS et retourne l'anomalie la plus forte.
export const detecterAnomaliesCotes = (match) => {
  const bookmakers = match.bookmakers_bruts ?? []
  if (bookmakers.length < 3) return null

  const anomaliesH2H = detecterAnomaliesMarche(
    bookmakers, 'h2h',
    o => o.name,
    o => o.name === 'Draw' ? 'Match nul' : o.name,
  )

  const anomaliesTotals = detecterAnomaliesMarche(
    bookmakers, 'totals',
    o => `${o.name}_${o.point}`,
    o => `${o.name === 'Over' ? 'Plus de' : 'Moins de'} ${o.point} buts`,
  )

  const anomaliesSpreads = detecterAnomaliesMarche(
    bookmakers, 'spreads',
    o => `${o.name}_${o.point}`,
    o => `${o.name} (handicap ${o.point > 0 ? '+' : ''}${o.point})`,
  )

  const anomaliesBtts = detecterAnomaliesMarche(
    bookmakers, 'btts',
    o => o.name,
    o => o.name === 'Yes' ? 'Les deux équipes marquent — Oui' : 'Les deux équipes marquent — Non',
  )

  const toutes = [...anomaliesH2H, ...anomaliesTotals, ...anomaliesSpreads, ...anomaliesBtts]
  if (toutes.length === 0) return null

  // Trier par écart décroissant
  toutes.sort((a, b) => b.ecart_pourcent - a.ecart_pourcent)
  const anomaliePrincipale = toutes[0]
  const margeMarche = calculerMargeMarche(bookmakers)

  let scoreAnomalie = Math.min(100, anomaliePrincipale.ecart_pourcent * 5)
  if (margeMarche !== null && margeMarche < 3) scoreAnomalie = Math.min(100, scoreAnomalie + 15)

  if (scoreAnomalie < SEUIL_SCORE_MIN) return null

  return {
    score_anomalie: Math.round(scoreAnomalie),
    marche: anomaliePrincipale.marche,
    outcome: anomaliePrincipale.outcome,
    cote_anomalie: anomaliePrincipale.cote_anomalie,
    cote_mediane: anomaliePrincipale.cote_mediane,
    bookmaker: anomaliePrincipale.bookmaker,
    ecart_pourcent: anomaliePrincipale.ecart_pourcent,
    nb_bookmakers: anomaliePrincipale.nb_bookmakers,
    toutes_cotes: anomaliePrincipale.toutes_cotes,
    marge_marche: margeMarche,
    autres_anomalies: toutes.slice(1, 4),  // top 3 autres anomalies (tous marchés confondus)
  }
}
