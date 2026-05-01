// Calcule les statistiques de performance de l'Expert à partir de ses paris passés
export const calculerStats = (paris) => {
  const parisTermines = paris.filter(p => p.statut === 'gagne' || p.statut === 'perdu')

  if (parisTermines.length === 0) {
    return {
      meileurSport: 'football',
      roiMeileurSport: 0,
      meilleurTypePari: 'inconnu',
      meilleursTags: [],
      meilleureTrancheCote: '1.50 - 2.50',
      tauxReussiteHauteConfiance: 0,
    }
  }

  // ROI par sport
  const roiParSport = {}
  for (const pari of parisTermines) {
    if (!roiParSport[pari.sport]) roiParSport[pari.sport] = { totalMises: 0, totalProfitPerte: 0 }
    roiParSport[pari.sport].totalMises += pari.mise
    roiParSport[pari.sport].totalProfitPerte += pari.profit_perte
  }

  let meileurSport = 'football'
  let roiMeileurSport = 0
  for (const [sport, data] of Object.entries(roiParSport)) {
    if (data.totalMises === 0) continue
    const roi = (data.totalProfitPerte / data.totalMises) * 100
    if (roi > roiMeileurSport) {
      roiMeileurSport = Math.round(roi)
      meileurSport = sport
    }
  }

  // Meilleur type de pari (par taux de réussite)
  const statsTypePari = {}
  for (const pari of parisTermines) {
    if (!statsTypePari[pari.type_pari]) statsTypePari[pari.type_pari] = { gagnes: 0, total: 0 }
    statsTypePari[pari.type_pari].total++
    if (pari.statut === 'gagne') statsTypePari[pari.type_pari].gagnes++
  }

  let meilleurTypePari = 'victoire_domicile'
  let meilleurTauxType = 0
  for (const [type, data] of Object.entries(statsTypePari)) {
    if (data.total < 2) continue // Ignorer les types avec trop peu d'échantillon
    const taux = data.gagnes / data.total
    if (taux > meilleurTauxType) {
      meilleurTauxType = taux
      meilleurTypePari = type
    }
  }

  // Tags les plus rentables (présents dans les paris gagnants)
  const comptageTagsGagnants = {}
  const parisGagnants = parisTermines.filter(p => p.statut === 'gagne')
  for (const pari of parisGagnants) {
    const tags = Array.isArray(pari.tags_raisonnement) ? pari.tags_raisonnement : []
    for (const tag of tags) {
      comptageTagsGagnants[tag] = (comptageTagsGagnants[tag] ?? 0) + 1
    }
  }

  const meilleursTags = Object.entries(comptageTagsGagnants)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag]) => tag)

  // Meilleure tranche de cote
  const tranches = [
    { label: '1.20 - 1.50', min: 1.20, max: 1.50 },
    { label: '1.50 - 1.80', min: 1.50, max: 1.80 },
    { label: '1.80 - 2.20', min: 1.80, max: 2.20 },
    { label: '2.20 - 3.00', min: 2.20, max: 3.00 },
    { label: '3.00 et plus', min: 3.00, max: Infinity },
  ]

  let meilleureTrancheCote = '1.80 - 2.20'
  let meilleurRoiTranche = -Infinity
  for (const tranche of tranches) {
    const parisInTranche = parisTermines.filter(p => p.cote >= tranche.min && p.cote < tranche.max)
    if (parisInTranche.length < 2) continue
    const totalMises = parisInTranche.reduce((s, p) => s + p.mise, 0)
    const totalPP = parisInTranche.reduce((s, p) => s + p.profit_perte, 0)
    const roi = totalMises > 0 ? totalPP / totalMises : -Infinity
    if (roi > meilleurRoiTranche) {
      meilleurRoiTranche = roi
      meilleureTrancheCote = tranche.label
    }
  }

  // Taux de réussite confiance 4-5
  const parisHauteConfiance = parisTermines.filter(p => p.confiance >= 4)
  const tauxReussiteHauteConfiance = parisHauteConfiance.length > 0
    ? Math.round((parisHauteConfiance.filter(p => p.statut === 'gagne').length / parisHauteConfiance.length) * 100)
    : 0

  // Tags les plus fréquents dans les paris PERDANTS (patterns à éviter)
  const parisPerdus = parisTermines.filter(p => p.statut === 'perdu')
  const comptageTagsPerdants = {}
  for (const pari of parisPerdus) {
    const tags = Array.isArray(pari.tags_raisonnement) ? pari.tags_raisonnement : []
    for (const tag of tags) {
      comptageTagsPerdants[tag] = (comptageTagsPerdants[tag] ?? 0) + 1
    }
  }
  const tagsPerdants = Object.entries(comptageTagsPerdants)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([tag]) => tag)

  return {
    meileurSport,
    roiMeileurSport,
    meilleurTypePari,
    meilleursTags,
    meilleureTrancheCote,
    tauxReussiteHauteConfiance,
    tagsPerdants,
  }
}

// Détermine si une alerte doit être envoyée
export const doitEnvoyerAlerte = (analyse) => {
  return (
    analyse !== null &&
    analyse.score_similarite >= 60 &&
    analyse.confiance !== 'faible' &&
    analyse.envoyer_alerte === true
  )
}

// Prépare l'objet alerte à sauvegarder dans PocketBase
export const preparerAlerte = (match, analyse) => {
  return {
    rencontre: match.rencontre,
    competition: match.competition,
    date_match: match.date_match,
    type_pari: analyse.type_pari_recommande,
    valeur_pari: analyse.valeur_pari ?? analyse.pari_recommande,
    cote_marche: analyse.cote_suggeree ?? null,
    score_similarite: analyse.score_similarite,
    score_valeur: analyse.score_similarite,
    raisonnement_bot: analyse.raisonnement,
    tags_detectes: analyse.tags_correspondants ?? [],
    telegram_envoye: false,
    decision_expert: 'en_attente',
  }
}

// Détermine si une alerte de type "cote anormale" doit être envoyée
export const doitEnvoyerAlerteAnomalie = (anomalie, analyseAI) => {
  return (
    anomalie !== null &&
    anomalie.score_anomalie >= 60 &&
    analyseAI !== null &&
    analyseAI.est_opportunite_reelle === true &&
    analyseAI.confiance !== 'faible' &&
    analyseAI.score_valeur >= 65
  )
}

// Prépare l'objet alerte "cote anormale" pour PocketBase
export const preparerAlerteAnomalie = (match, anomalie, analyseAI) => {
  return {
    rencontre: match.rencontre,
    competition: match.competition,
    date_match: match.date_match,
    type_pari: analyseAI.type_pari_recommande,
    valeur_pari: analyseAI.valeur_pari ?? analyseAI.pari_recommande,
    cote_marche: anomalie.cote_anomalie,
    score_similarite: anomalie.score_anomalie,
    score_valeur: analyseAI.score_valeur,
    raisonnement_bot: `[Cote anormale +${anomalie.ecart_pourcent}% vs marché] ${analyseAI.raisonnement}`,
    tags_detectes: analyseAI.tags_correspondants ?? [],
    telegram_envoye: false,
    decision_expert: 'en_attente',
  }
}
