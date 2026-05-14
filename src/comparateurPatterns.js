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

// Seuils value betting — alignés avec la doctrine du prompt système
export const EDGE_MIN = 5            // Edge minimum (%) pour déclencher une alerte
export const PROB_MIN_PATTERN = 0.45 // Probabilité estimée minimum (pattern matching)
export const PROB_MIN_ANOMALIE = 0.40 // Probabilité estimée minimum (anomalies)

// Seuils pré-filtre contexte (avant tout appel Claude)
export const MARGE_BOOKMAKER_MAX = 9   // %  — au-dessus = juice excessive
export const COTE_FAVORI_MIN = 1.10    // cote min pour qu'un favori soit "exploitable"
export const NB_BLESSURES_MAX = 6      // total dom + ext, au-delà = chaos analytique

// Tiers d'alertes — classement visuel par conviction (Phase 4)
export const TIERS = {
  FORTE: 'forte',          // 🔥🔥🔥 score ≥ 85 ET edge ≥ 10 ET confiance=elevee
  BONNE: 'bonne',          // 🔥🔥  score ≥ 70 ET edge ≥ 7
  SURVEILLE: 'surveille',  // 🔥    minimum (seuils Phase 1)
}

// Classe une alerte dans un tier de conviction.
// `score` = score_similarite (patterns) OU score_valeur (anomalies).
// `edge` = edge_pourcent recalculé côté JS.
export const calculerTier = ({ score, edge, confiance }) => {
  const s = Number(score) || 0
  const e = Number(edge) || 0

  if (s >= 85 && e >= 10 && confiance === 'elevee') return TIERS.FORTE
  if (s >= 70 && e >= 7) return TIERS.BONNE
  return TIERS.SURVEILLE
}

// Calcule la marge bookmaker d'un marché H2H (vigorish / overround)
// marge = (somme des proba implicites − 1) × 100
// Foot : 3-way (dom + nul + ext) | autres : 2-way (dom + ext)
const calculerMargeH2H = (cotes) => {
  if (!cotes) return null
  const c = cotes
  const inv = (v) => (v != null && v > 0) ? 1 / Number(v) : null

  const pDom = inv(c.domicile)
  const pNul = inv(c.nul)
  const pExt = inv(c.exterieur)

  // 3-way (avec nul)
  if (pDom != null && pNul != null && pExt != null) {
    return Math.round((pDom + pNul + pExt - 1) * 1000) / 10
  }
  // 2-way (sans nul)
  if (pDom != null && pExt != null) {
    return Math.round((pDom + pExt - 1) * 1000) / 10
  }
  return null
}

// Retourne null si le match peut être analysé, sinon une chaîne décrivant le motif de rejet.
// Filtre éliminatoire AVANT tout appel Claude — économise tokens et améliore qualité.
export const filtreContexteCritique = (match) => {
  const c = match.cotes ?? {}

  // 1. Aucune cote analysable
  const aDesCotesH2H = c.domicile != null || c.exterieur != null
  const aDesTotals = c.over != null || c.under != null
  if (!aDesCotesH2H && !aDesTotals) {
    return 'aucune cote H2H ni totals disponible'
  }

  // 2. Marge bookmaker H2H excessive (juice trop forte)
  const marge = calculerMargeH2H(c)
  if (marge != null && marge > MARGE_BOOKMAKER_MAX) {
    return `marge bookmaker H2H ${marge}% > ${MARGE_BOOKMAKER_MAX}%`
  }

  // 3. Match écrasé — cote favori trop basse pour qu'un edge soit exploitable
  const cotesH2H = [c.domicile, c.nul, c.exterieur].filter(v => v != null && v > 0)
  if (cotesH2H.length > 0) {
    const coteMin = Math.min(...cotesH2H.map(Number))
    if (coteMin < COTE_FAVORI_MIN) {
      return `match déséquilibré (cote min ${coteMin} < ${COTE_FAVORI_MIN})`
    }
  }

  // 4. Trop de blessures connues = chaos analytique
  const ctx = match.contexte_api_football
  if (ctx) {
    const nbDom = Array.isArray(ctx.blessures_domicile) ? ctx.blessures_domicile.length : 0
    const nbExt = Array.isArray(ctx.blessures_exterieur) ? ctx.blessures_exterieur.length : 0
    if (nbDom + nbExt >= NB_BLESSURES_MAX) {
      return `trop d'absences (${nbDom + nbExt} blessures, seuil=${NB_BLESSURES_MAX})`
    }
  }

  return null
}

// Recalcule l'edge à partir de la prob estimée et de la cote, pour blinder l'arithmétique de Claude
// edge_pourcent = (probabilite_estimee × cote − 1) × 100
export const calculerEdge = (probabiliteEstimee, cote) => {
  if (probabiliteEstimee == null || cote == null) return null
  const edge = (Number(probabiliteEstimee) * Number(cote) - 1) * 100
  return Math.round(edge * 10) / 10 // arrondi 0.1
}

// Détermine si une alerte pattern doit être envoyée
// Mode permissif activable via MODE_PERMISSIF=true (env var) — pour générer des alertes
// même quand le pipeline value-betting strict rejette tout (typique fin de saison foot).
// ⚠️ Le mode permissif ignore confiance='faible' et envoyer_alerte=false, et abaisse les seuils.
// La doctrine value-betting n'est PAS respectée — utiliser uniquement en mode démo/test.
export const doitEnvoyerAlerte = (analyse) => {
  if (!analyse) return false

  const permissif = process.env.MODE_PERMISSIF === 'true'
  const seuilScore = permissif ? 45 : 60
  const seuilProb  = permissif ? 0.35 : PROB_MIN_PATTERN
  const seuilEdge  = permissif ? 0   : EDGE_MIN

  // En mode strict : Claude doit explicitement valider via envoyer_alerte + confiance ≠ faible
  if (!permissif) {
    if (analyse.envoyer_alerte !== true) return false
    if (analyse.confiance === 'faible') return false
  }

  if (analyse.score_similarite < seuilScore) return false

  const prob = Number(analyse.probabilite_estimee)
  if (!Number.isFinite(prob) || prob < seuilProb) return false

  const edge = calculerEdge(analyse.probabilite_estimee, analyse.cote_suggeree)
  if (edge == null || edge < seuilEdge) return false

  return true
}

// Applique le verdict de la 2ème passe Claude (avocat du diable)
// Retourne :
//   - null si la critique rejette l'alerte
//   - analyseInitiale inchangée si verdict = "valider"
//   - analyse ajustée (prob plus basse, score divisé, confiance baissée) si verdict = "ajuster"
// Si la critique a échoué (null), on garde l'analyse initiale par défaut sécurisé.
export const appliquerCritique = (analyseInitiale, critique) => {
  if (!critique) return analyseInitiale
  if (critique.verdict === 'rejeter') return null
  if (critique.verdict === 'valider') return analyseInitiale

  // verdict === 'ajuster' (ou valeur inconnue → on traite comme un ajustement prudent)
  const probCritique = Number(critique.probabilite_critique)
  const probFinale = Number.isFinite(probCritique)
    ? Math.min(probCritique, Number(analyseInitiale.probabilite_estimee ?? 1))
    : analyseInitiale.probabilite_estimee

  // Pénalité score adoucie de ×0.7 → ×0.85 : un "ajuster" n'est pas un quasi-rejet.
  // Score 75 → 64 (passe le seuil 60), score 70 → 60 (limite), score 65 → 55 (bloqué).
  const scoreAjuste = Math.round((analyseInitiale.score_similarite ?? 0) * 0.85)

  // Si après ajustement de prob l'edge reste ≥ 7% (marge confortable au-dessus du seuil 5%),
  // on NE baisse PAS la confiance d'un cran. Sinon double pénalité (prob baissée + conf baissée)
  // élimine des paris où le Critique reste mesuré (ex: Buffalo NHL, edge ajusté 9% mais conf moy→faible).
  const coteSugg = Number(analyseInitiale.cote_suggeree)
  const edgeAjuste = calculerEdge(probFinale, coteSugg) ?? 0
  const confianceAjustee = edgeAjuste >= 7
    ? analyseInitiale.confiance
    : (analyseInitiale.confiance === 'elevee' ? 'moyenne' : 'faible')
  const raison = critique.raison_critique ? ` [Critique: ${critique.raison_critique}]` : ''

  return {
    ...analyseInitiale,
    probabilite_estimee: probFinale,
    score_similarite: scoreAjuste,
    confiance: confianceAjustee,
    raisonnement: `${analyseInitiale.raisonnement ?? ''}${raison}`.trim(),
    risques_identifies: [
      ...(analyseInitiale.risques_identifies ?? []),
      ...(critique.failles_majeures ?? []),
    ],
  }
}

// Prépare l'objet alerte à sauvegarder dans PocketBase
export const preparerAlerte = (match, analyse) => {
  const edgeRecalcule = calculerEdge(analyse.probabilite_estimee, analyse.cote_suggeree)
  return {
    rencontre: match.rencontre,
    competition: match.competition,
    date_match: match.date_match,
    type_pari: analyse.type_pari_recommande,
    valeur_pari: analyse.valeur_pari ?? analyse.pari_recommande,
    cote_marche: analyse.cote_suggeree ?? null,
    score_similarite: analyse.score_similarite,
    score_valeur: analyse.score_similarite,
    probabilite_estimee: analyse.probabilite_estimee ?? null,
    edge_pourcent: edgeRecalcule,
    raisonnement_bot: analyse.raisonnement,
    tags_detectes: analyse.tags_correspondants ?? [],
    telegram_envoye: false,
    decision_expert: 'en_attente',
  }
}

// Détermine si une alerte de type "cote anormale" doit être envoyée
export const doitEnvoyerAlerteAnomalie = (anomalie, analyseAI) => {
  const permissif = process.env.MODE_PERMISSIF === 'true'
  const seuilAnomalie = permissif ? 45 : 60
  const seuilValeur   = permissif ? 40 : 65

  if (!anomalie || anomalie.score_anomalie < seuilAnomalie) return false
  if (!analyseAI) return false
  if (!permissif) {
    if (analyseAI.est_opportunite_reelle !== true) return false
    if (analyseAI.confiance === 'faible') return false
  }
  if (analyseAI.score_valeur < seuilValeur) return false

  const prob = Number(analyseAI.probabilite_estimee)
  if (!Number.isFinite(prob) || prob < PROB_MIN_ANOMALIE) return false

  const edge = calculerEdge(analyseAI.probabilite_estimee, anomalie.cote_anomalie)
  if (edge == null || edge < EDGE_MIN) return false

  return true
}

// Prépare l'objet alerte "cote anormale" pour PocketBase
export const preparerAlerteAnomalie = (match, anomalie, analyseAI) => {
  const edgeRecalcule = calculerEdge(analyseAI.probabilite_estimee, anomalie.cote_anomalie)
  return {
    rencontre: match.rencontre,
    competition: match.competition,
    date_match: match.date_match,
    type_pari: analyseAI.type_pari_recommande,
    valeur_pari: analyseAI.valeur_pari ?? analyseAI.pari_recommande,
    cote_marche: anomalie.cote_anomalie,
    score_similarite: anomalie.score_anomalie,
    score_valeur: analyseAI.score_valeur,
    probabilite_estimee: analyseAI.probabilite_estimee ?? null,
    edge_pourcent: edgeRecalcule,
    raisonnement_bot: `[Cote anormale +${anomalie.ecart_pourcent}% vs marché] ${analyseAI.raisonnement}`,
    tags_detectes: analyseAI.tags_correspondants ?? [],
    telegram_envoye: false,
    decision_expert: 'en_attente',
  }
}
