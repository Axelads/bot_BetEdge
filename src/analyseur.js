import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'
dotenv.config()

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ─── Prompts système (cacheables — même contenu = cache hit sur les appels suivants du cycle) ──

export const construirePromptSysteme = (parisGagnants, parisPerdants = [], stats, nbUtilisateurs = null, options = {}) => {
  const source = nbUtilisateurs
    ? `une communauté de ${nbUtilisateurs} parieur(s) — données agrégées de toute la plateforme`
    : `un expert parieur`
  const label = nbUtilisateurs ? 'de la communauté' : "de l'expert"

  const instructionFormat = options.formatPari === 'combine'
    ? 'Préfère les suggestions de paris combinés (plusieurs sélections cohérentes en un même message).'
    : options.formatPari === 'les_deux'
    ? 'Tu peux proposer des paris secs ou des combinés selon l\'opportunité détectée.'
    : 'Propose uniquement des paris secs (une seule sélection par alerte).'

  // Sélection des champs utiles pour les perdants (éviter d'inflater le prompt)
  const perdantsSynthese = parisPerdants.slice(0, 15).map(p => ({
    sport: p.sport,
    type_pari: p.type_pari,
    cote: p.cote,
    confiance: p.confiance,
    tags_raisonnement: p.tags_raisonnement,
    raisonnement_libre: p.raisonnement_libre || null,
  }))

  const sectionPerdants = perdantsSynthese.length > 0
    ? `\nParis PERDANTS récents ${label} — contextes à NE PAS reproduire (${perdantsSynthese.length} exemples) :
${JSON.stringify(perdantsSynthese, null, 2)}
`
    : ''

  const lignePerdants = stats.tagsPerdants?.length > 0
    ? `\n- Tags fréquemment associés aux défaites ${label} : ${stats.tagsPerdants.join(', ')} — pénalise les matchs portant ces tags`
    : ''

  return `Tu es un analyste expert en paris sportifs, spécialisé en VALUE BETTING (méthodologie Kelly).
Ta mission : identifier les opportunités où la cote du marché SOUS-ESTIME la probabilité réelle d'un événement, en t'appuyant sur les patterns GAGNANTS de ${source} et en évitant les patterns PERDANTS.

═══ DOCTRINE PRO ═══
Un pari profitable sur le long terme requiert UN SEUL critère absolu : un EDGE positif et significatif.
  edge_pourcent = (probabilite_estimee × cote_marche − 1) × 100

  • edge ≥ 8%  → opportunité forte (rare, à privilégier)
  • edge 5-8%  → bonne opportunité
  • edge < 5%  → on passe, même si "ça sent bon" — sans edge mathématique, c'est du divertissement
  • edge < 0%  → la cote est trop basse pour la probabilité réelle → REJET

Tu dois donc estimer une probabilité RÉELLE et HONNÊTE (pas optimiste). Si tu n'as pas assez d'infos fiables, déclare le match comme "faible" et n'alerte pas — mieux vaut zéro alerte qu'une mauvaise.

═══ MÉTHODOLOGIE EN 5 ÉTAPES ═══
1. Forme récente — résultats, dynamique offensive/défensive, motivation
2. Face-à-face — historique direct, scores typiques
3. Compositions & absences — joueurs clés out, formations probables
4. Estimation de probabilité — sois conservateur ; un favori en bonne forme ≠ 90%, c'est 60-70% au mieux
5. Calcul Edge — applique la formule, sois mathématique

═══ PATTERNS GAGNANTS ${label.toUpperCase()} (${parisGagnants.length} paris, triés par confiance) ═══
${JSON.stringify(parisGagnants.slice(0, 25), null, 2)}
${sectionPerdants}
═══ STATISTIQUES ${label.toUpperCase()} ═══
- Sport le plus rentable : ${stats.meileurSport} (ROI: ${stats.roiMeileurSport}%)
- Type de pari optimal : ${stats.meilleurTypePari}
- Tags les plus rentables : ${stats.meilleursTags.join(', ')}
- Tranche de cote optimale : ${stats.meilleureTrancheCote}
- Taux de réussite sur confiance 4-5 : ${stats.tauxReussiteHauteConfiance}%
- Paris gagnants : ${parisGagnants.length} | Paris perdants : ${parisPerdants.length}${lignePerdants}

Format de pari souhaité : ${instructionFormat}

═══ RÈGLES D'ALERTE (envoyer_alerte = true UNIQUEMENT si TOUTES réunies) ═══
1. edge_pourcent ≥ 5
2. probabilite_estimee ≥ 0.45 (au moins 45% de chances — pas de cotes hasardeuses)
3. score_similarite ≥ 60 (cohérence avec patterns gagnants)
4. confiance ≠ "faible"
5. AUCUN tag perdant majeur identifié sur ce match

Si l'une de ces conditions n'est pas remplie → envoyer_alerte = false, point.

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans texte avant ou après.`
}

export const construirePromptSystemeAnomalie = (parisGagnants, parisPerdants = [], stats, nbUtilisateurs = null) => {
  const source = nbUtilisateurs
    ? `de la communauté (${nbUtilisateurs} parieur(s) — données agrégées)`
    : `de l'expert`

  const perdantsSynthese = parisPerdants.slice(0, 10).map(p => ({
    sport: p.sport,
    type_pari: p.type_pari,
    cote: p.cote,
    confiance: p.confiance,
    tags_raisonnement: p.tags_raisonnement,
  }))

  const sectionPerdants = perdantsSynthese.length > 0
    ? `\nContextes perdants ${source} (à éviter) :\n${JSON.stringify(perdantsSynthese, null, 2)}\n`
    : ''

  const lignePerdants = stats.tagsPerdants?.length > 0
    ? ` | Tags perdants récurrents : ${stats.tagsPerdants.join(', ')}`
    : ''

  return `Tu es un analyste expert en VALUE BETTING (méthodologie Kelly), spécialisé dans la détection d'anomalies de marché exploitables.

═══ DOCTRINE PRO ═══
Une anomalie de cote (un bookmaker qui propose une cote significativement plus haute que la médiane du marché) PEUT être :
  A. Une vraie opportunité de value (le bookmaker se trompe ou tarde à ajuster) → ALERTE
  B. Une réaction RATIONNELLE à une info que les autres ont déjà intégrée (blessure majeure, suspension, équipe B, météo) → REJET
  C. Une erreur de saisie ou un effet de marge agressive du bookmaker → REJET

Ta mission : déterminer A vs B vs C, et calculer l'EDGE mathématique réel.

  edge_pourcent = (probabilite_estimee × cote_anomalie − 1) × 100

  • edge ≥ 10% sur une anomalie → opportunité forte (très rare)
  • edge 5-10%               → bonne opportunité
  • edge < 5%                → on passe : l'anomalie n'a pas assez de marge pour absorber la variance
  • edge < 0%                → la cote est juste correctement valorisée par le marché (l'anomalie est une fausse alerte)

═══ PATTERNS GAGNANTS ${source.toUpperCase()} (${parisGagnants.length} paris) ═══
${JSON.stringify(parisGagnants.slice(0, 20), null, 2)}
${sectionPerdants}
═══ STATS ${source.toUpperCase()} ═══
sport=${stats.meileurSport} | type=${stats.meilleurTypePari} | tranche cote=${stats.meilleureTrancheCote} | win rate haute confiance=${stats.tauxReussiteHauteConfiance}%${lignePerdants}

═══ RÈGLES D'ALERTE (est_opportunite_reelle = true UNIQUEMENT si TOUTES réunies) ═══
1. edge_pourcent ≥ 5
2. probabilite_estimee ≥ 0.40
3. AUCUNE cause rationnelle identifiée (pas de blessure majeure non intégrée, pas d'équipe B avérée)
4. score_valeur ≥ 65
5. confiance ≠ "faible"

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans texte avant ou après.`
}

// ─── Prompts utilisateur (par match — non cacheables) ─────────────────────────

const construireContexteApiFootball = (match) => {
  const ctx = match.contexte_api_football
  if (!ctx) return ''

  const lignes = ['\nDonnées de contexte (source API-Football) :']

  if (ctx.journee) {
    lignes.push(`- Journée : ${ctx.journee}`)
  }

  // Face-à-face
  if (ctx.forme_domicile_h2h) {
    lignes.push(`- Forme ${match.equipe_domicile} en H2H (5 derniers) : ${ctx.forme_domicile_h2h} (V=victoire D=défaite N=nul, plus récent en premier)`)
  }
  if (ctx.forme_exterieur_h2h) {
    lignes.push(`- Forme ${match.equipe_exterieur} en H2H (5 derniers) : ${ctx.forme_exterieur_h2h}`)
  }
  if (ctx.h2h_5_derniers && ctx.h2h_5_derniers.length > 0) {
    lignes.push(`- Historique H2H (${ctx.h2h_5_derniers.length} derniers) :`)
    ctx.h2h_5_derniers.forEach(r => lignes.push(`  • ${r}`))
  }

  // Statistiques du dernier H2H (possession, tirs, corners)
  if (ctx.stats_dernier_h2h) {
    const s = ctx.stats_dernier_h2h
    lignes.push(`- Statistiques du dernier H2H (${s.match_ref}) :`)
    if (s.possession.domicile) {
      lignes.push(`  Possession : domicile ${s.possession.domicile} | extérieur ${s.possession.exterieur ?? 'N/A'}`)
    }
    if (s.tirs_cadres.domicile !== null) {
      lignes.push(`  Tirs cadrés : domicile ${s.tirs_cadres.domicile} | extérieur ${s.tirs_cadres.exterieur ?? 'N/A'}`)
    }
    if (s.tirs_total.domicile !== null) {
      lignes.push(`  Tirs total : domicile ${s.tirs_total.domicile} | extérieur ${s.tirs_total.exterieur ?? 'N/A'}`)
    }
    if (s.corners.domicile !== null) {
      lignes.push(`  Corners : domicile ${s.corners.domicile} | extérieur ${s.corners.exterieur ?? 'N/A'}`)
    }
  }

  // Blessures / absences
  if (ctx.blessures_domicile && ctx.blessures_domicile.length > 0) {
    lignes.push(`- Absents ${match.equipe_domicile} : ${ctx.blessures_domicile.join(', ')}`)
  } else if (ctx.blessures_domicile) {
    lignes.push(`- Absents ${match.equipe_domicile} : aucun signalé`)
  }
  if (ctx.blessures_exterieur && ctx.blessures_exterieur.length > 0) {
    lignes.push(`- Absents ${match.equipe_exterieur} : ${ctx.blessures_exterieur.join(', ')}`)
  } else if (ctx.blessures_exterieur) {
    lignes.push(`- Absents ${match.equipe_exterieur} : aucun signalé`)
  }

  // Compositions officielles (disponibles 20-40 min avant le coup d'envoi)
  if (ctx.lineups && ctx.lineups.length > 0) {
    lignes.push('- Compositions officielles :')
    for (const equipe of ctx.lineups) {
      const coach = equipe.coach ? ` — Coach : ${equipe.coach}` : ''
      lignes.push(`  ${equipe.equipe} (${equipe.formation ?? 'N/A'})${coach}`)
      if (equipe.titulaires.length > 0) {
        lignes.push(`    Titulaires : ${equipe.titulaires.join(', ')}`)
      }
    }
  }

  // Prédiction API-Football
  if (ctx.prediction_api) {
    const pred = ctx.prediction_api
    if (pred.conseil) lignes.push(`- Conseil API-Football : ${pred.conseil}`)
    if (pred.probabilites) {
      const p = pred.probabilites
      lignes.push(`- Probabilités statistiques : domicile ${p.home} | nul ${p.draw} | extérieur ${p.away}`)
    }
    if (pred.comparaison_forme) {
      lignes.push(`- Comparaison de forme : domicile ${pred.comparaison_forme.home} vs extérieur ${pred.comparaison_forme.away}`)
    }
  }

  return lignes.join('\n')
}

// Contexte minimal pour basketball / hockey / rugby (source api-sports.io v1)
const construireContexteAutreSport = (match) => {
  const ctx = match.contexte_api_sport
  if (!ctx) return ''

  const lignes = [`\nDonnées de contexte (source api-sports.io — ${ctx.sport}) :`]

  if (ctx.ligue)  lignes.push(`- Ligue : ${ctx.ligue}${ctx.saison ? ` (saison ${ctx.saison})` : ''}`)

  if (ctx.forme_domicile_h2h) {
    lignes.push(`- Forme ${match.equipe_domicile} en H2H (5 derniers) : ${ctx.forme_domicile_h2h} (V=victoire D=défaite N=nul, plus récent en premier)`)
  }
  if (ctx.forme_exterieur_h2h) {
    lignes.push(`- Forme ${match.equipe_exterieur} en H2H (5 derniers) : ${ctx.forme_exterieur_h2h}`)
  }
  if (ctx.h2h_5_derniers && ctx.h2h_5_derniers.length > 0) {
    lignes.push(`- Historique H2H (${ctx.h2h_5_derniers.length} derniers) :`)
    ctx.h2h_5_derniers.forEach(r => lignes.push(`  • ${r}`))
  }

  return lignes.join('\n')
}

// Dispatcher : foot → contexte riche (forme + H2H + blessures + lineups + prédictions API)
// Autres sports → contexte minimal (forme + H2H). Tennis et "autre" → aucun enrichissement.
const construireContexteSport = (match) => {
  if (match.sport === 'football') return construireContexteApiFootball(match)
  if (match.sport === 'basketball' || match.sport === 'hockey' || match.sport === 'rugby') {
    return construireContexteAutreSport(match)
  }
  return ''
}

// Construit la section "cotes actuelles" en n'affichant que les marchés disponibles
const construireSectionCotes = (match) => {
  const c = match.cotes ?? {}
  const lignes = []

  if (c.domicile != null) lignes.push(`- Victoire domicile (${match.equipe_domicile}) : ${c.domicile}`)
  if (c.nul != null)       lignes.push(`- Match nul : ${c.nul}`)
  if (c.exterieur != null) lignes.push(`- Victoire extérieur (${match.equipe_exterieur}) : ${c.exterieur}`)

  if (c.ligne_totals != null && (c.over != null || c.under != null)) {
    if (c.over != null)  lignes.push(`- Plus de ${c.ligne_totals} : ${c.over}`)
    if (c.under != null) lignes.push(`- Moins de ${c.ligne_totals} : ${c.under}`)
  }

  if (c.handicap_domicile_point != null) {
    const hd = c.handicap_domicile_point
    const he = -hd
    const signe = (v) => v > 0 ? `+${v}` : `${v}`
    if (c.handicap_domicile != null) lignes.push(`- Handicap ${match.equipe_domicile} (${signe(hd)}) : ${c.handicap_domicile}`)
    if (c.handicap_exterieur != null) lignes.push(`- Handicap ${match.equipe_exterieur} (${signe(he)}) : ${c.handicap_exterieur}`)
  }

  if (c.btts_oui != null) lignes.push(`- Les deux marquent (Oui) : ${c.btts_oui}`)
  if (c.btts_non != null) lignes.push(`- Les deux marquent (Non) : ${c.btts_non}`)

  return lignes.length > 0 ? lignes.join('\n') : '- Aucune cote disponible'
}

const construirePromptUtilisateur = (match) => `Analyse ce match à venir avec la méthodologie value betting en 5 étapes :

Rencontre : ${match.rencontre}
Compétition : ${match.competition}
Sport : ${match.sport}
Date : ${new Date(match.date_match).toLocaleString('fr-FR')}

Cotes actuelles sur le marché (médiane multi-bookmakers) :
${construireSectionCotes(match)}
${construireContexteSport(match)}

RAPPEL DE LA FORMULE EDGE :
  edge_pourcent = (probabilite_estimee × cote_suggeree − 1) × 100
  Ex : prob 0.62 × cote 1.90 = 1.178 → edge = +17.8% (excellente value)
  Ex : prob 0.55 × cote 1.70 = 0.935 → edge = -6.5% (cote trop basse, on passe)

CONSIGNES :
- Si tu n'as PAS assez d'infos contextuelles fiables (forme/blessures/H2H), mets confiance = "faible" et envoyer_alerte = false
- probabilite_estimee doit être HONNÊTE : un favori clair = 0.55-0.70 max, jamais 0.85+
- cote_suggeree doit être STRICTEMENT une des cotes affichées ci-dessus
- Si edge_pourcent < 5 → envoyer_alerte = false même si patterns OK

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans texte autour) :
{
  "analyse_forme": "1-2 phrases sur la dynamique récente des 2 équipes (ou 'données insuffisantes')",
  "analyse_h2h": "1-2 phrases sur le face-à-face historique (ou 'données insuffisantes')",
  "analyse_compositions": "1-2 phrases sur absences/blessures/compos (ou 'données insuffisantes')",
  "pari_recommande": "description courte du pari suggéré",
  "type_pari_recommande": "un des types: victoire_domicile | victoire_exterieur | nul | plus_de | moins_de | les_deux_marquent | handicap",
  "valeur_pari": "valeur précise ex: 2.5 pour over/under, nom équipe pour victoire, '${match.equipe_domicile} -1.5' pour handicap, 'oui'/'non' pour les_deux_marquent",
  "cote_suggeree": nombre (la cote correspondante parmi celles fournies),
  "probabilite_estimee": nombre entre 0.0 et 1.0 (estimation HONNÊTE de la probabilité réelle que ce pari gagne),
  "edge_pourcent": nombre (peut être négatif — applique la formule ci-dessus avec cote_suggeree),
  "risques_identifies": ["risque1", "risque2"] ou [],
  "score_similarite": nombre entre 0 et 100 (cohérence avec les patterns gagnants),
  "tags_correspondants": ["tag1", "tag2"],
  "raisonnement": "synthèse 2-3 phrases : pourquoi cette opportunité ET pourquoi cette cote a de la value",
  "confiance": "faible" ou "moyenne" ou "elevee",
  "envoyer_alerte": true ou false
}`

const construirePromptUtilisateurAnomalie = (match, anomalie) => `ANOMALIE DE MARCHÉ DÉTECTÉE

Match : ${match.rencontre} (${match.competition}) — ${match.sport}
Date : ${new Date(match.date_match).toLocaleString('fr-FR')}

Marché concerné : ${anomalie.marche?.toUpperCase() ?? 'H2H'}
L'outcome "${anomalie.outcome}" affiche une cote anormalement haute :
- Médiane du marché (${anomalie.nb_bookmakers} bookmakers) : ${anomalie.cote_mediane}
- Cote anormale trouvée : ${anomalie.cote_anomalie} sur ${anomalie.bookmaker}
- Écart : +${anomalie.ecart_pourcent}% au-dessus du marché
- Toutes les cotes disponibles : ${anomalie.toutes_cotes.join(' / ')}
${anomalie.marge_marche !== null ? `- Marge best-available du marché H2H : ${anomalie.marge_marche}% (normale : 4-7%)` : ''}

Cotes médianes de référence du match :
${construireSectionCotes(match)}
${construireContexteSport(match)}

QUESTION : Cette cote anormale est-elle une VRAIE opportunité de value bet, ou existe-t-il une raison rationnelle (blessure majeure récente, suspension, erreur ligne bookmaker, équipe B alignée, motivation nulle) ?

CONSIGNES :
- probabilite_estimee = ta meilleure estimation HONNÊTE de la probabilité réelle (pas optimiste)
- edge_pourcent = (probabilite_estimee × ${anomalie.cote_anomalie} − 1) × 100
- Si edge < 5% → est_opportunite_reelle = false (l'anomalie n'a pas assez de value mathématique)
- Si tu identifies une cause rationnelle à l'anomalie → est_opportunite_reelle = false

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans texte autour) :
{
  "analyse_forme": "1-2 phrases sur la dynamique récente (ou 'données insuffisantes')",
  "analyse_h2h": "1-2 phrases sur le face-à-face (ou 'données insuffisantes')",
  "analyse_compositions": "1-2 phrases sur absences/blessures (ou 'données insuffisantes')",
  "est_opportunite_reelle": true ou false,
  "score_valeur": nombre entre 0 et 100,
  "pari_recommande": "description courte du pari suggéré",
  "type_pari_recommande": "victoire_domicile | victoire_exterieur | nul | plus_de | moins_de | les_deux_marquent | handicap",
  "valeur_pari": "valeur précise ex: équipe, 2.5, oui, '${match.equipe_domicile} -1.5'",
  "cote_recommandee": nombre (la cote anormale trouvée = ${anomalie.cote_anomalie}),
  "probabilite_estimee": nombre entre 0.0 et 1.0 (probabilité réelle estimée que ce pari gagne),
  "edge_pourcent": nombre (peut être négatif),
  "risques_identifies": ["risque1", "risque2"] ou [],
  "tags_correspondants": ["tag1", "tag2"],
  "raisonnement": "2-3 phrases : pourquoi c'est de la value ou pourquoi c'est une fausse alerte",
  "confiance": "faible" ou "moyenne" ou "elevee",
  "raison_anomalie_probable": "genuine_value | erreur_bookmaker | blessure_non_integree | equipe_b | autre"
}`

// ─── Prompt critique (avocat du diable — 2ème passe) ─────────────────────────

const construirePromptCritique = (match, analyseInitiale, options = {}) => {
  const estAnomalie = options.type === 'anomalie'
  const anomalieContexte = estAnomalie && options.anomalie
    ? `\nL'analyse initiale concerne une COTE ANORMALE :
- Outcome : ${options.anomalie.outcome}
- Cote anormale : ${options.anomalie.cote_anomalie} sur ${options.anomalie.bookmaker}
- Médiane marché : ${options.anomalie.cote_mediane} (écart +${options.anomalie.ecart_pourcent}%)\n`
    : ''

  return `Tu es un parieur expert SCEPTIQUE et EXIGEANT. Un autre analyste a produit l'avis ci-dessous et veut envoyer une alerte. Ton job : critiquer cet avis en cherchant ACTIVEMENT toutes les raisons pour lesquelles ce pari pourrait PERDRE.

Tu joues l'avocat du diable. Ton rôle n'est PAS d'être consensuel — c'est de protéger le bankroll en éliminant les alertes faibles ou trop optimistes. Sois rigoureux, conservateur, factuel.

═══ AVIS INITIAL À CRITIQUER ═══
${JSON.stringify(analyseInitiale, null, 2)}

═══ CONTEXTE DU MATCH ═══
Rencontre : ${match.rencontre}
Compétition : ${match.competition}
Sport : ${match.sport}
Date : ${new Date(match.date_match).toLocaleString('fr-FR')}
${anomalieContexte}
Cotes du marché (médiane multi-bookmakers) :
${construireSectionCotes(match)}
${construireContexteSport(match)}

═══ QUESTIONS DE CRITIQUE OBLIGATOIRES ═══
1. La probabilité estimée (${analyseInitiale.probabilite_estimee}) est-elle réaliste ou trop OPTIMISTE ? Quels biais cognitifs pourraient l'avoir gonflée ?
2. Les risques identifiés sont-ils suffisants ? Quels risques MAJEURS ont été OMIS (variance, contexte, motivation, blessure, météo, arbitre, etc.) ?
3. Le raisonnement résiste-t-il à un examen rigoureux ? Y a-t-il des contradictions ou raccourcis logiques ?
4. L'edge (${analyseInitiale.edge_pourcent}%) est-il vraiment exploitable, ou la variance court terme peut-elle le détruire ?
5. Un pro du value betting placerait-il ce pari ? Ou attendrait-il une meilleure opportunité ?

═══ VERDICTS POSSIBLES ═══
- "valider" : l'analyse tient debout sur tous les points → on alerte
- "ajuster" : l'analyse a des raisons d'être moins optimiste → on baisse la confiance + recalcule la prob
- "rejeter" : l'analyse a des failles majeures → on N'ALERTE PAS

Par DÉFAUT, sois prudent : en cas de doute, "ajuster" plutôt que "valider".

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks :
{
  "verdict": "valider" | "ajuster" | "rejeter",
  "failles_majeures": ["faille1", "faille2"] ou [],
  "biais_detectes": ["surconfiance" ou "recency_bias" ou "ignorance_variance" etc., ou vide],
  "probabilite_critique": nombre 0.0-1.0 (TA propre estimation, plus conservatrice que l'avis initial),
  "raison_critique": "1-2 phrases factuelles expliquant ton verdict"
}`
}

// Prompt système critique — court et cacheable
const PROMPT_SYSTEME_CRITIQUE = `Tu es un parieur professionnel sceptique. Ta seule mission : challenger les analyses de pari et protéger le bankroll. Tu privilégies toujours la prudence à l'optimisme. Tu rejettes les paris dont la probabilité est gonflée ou les risques sous-estimés. Tu réponds toujours en JSON valide sans markdown.`

// ─── Utilitaire ───────────────────────────────────────────────────────────────

const nettoyerJson = (texte) =>
  texte.replace(/^```json\n?/, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim()

// Génère un identifiant safe pour les custom_id du batch (alphanumérique + underscores, max 64 chars)
export const idSafe = (texte) => texte.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 64)

// ─── API synchrone (cycle 18h — temps réel) ───────────────────────────────────

export const analyserMatch = async (match, parisGagnants, parisPerdants = [], stats, nbUtilisateurs = null, options = {}) => {
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1800,
      system: [
        {
          type: 'text',
          text: construirePromptSysteme(parisGagnants, parisPerdants, stats, nbUtilisateurs, options),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: construirePromptUtilisateur(match) }],
    })

    return JSON.parse(nettoyerJson(message.content[0].text.trim()))
  } catch (erreur) {
    console.error(`[analyseur] Erreur analyse ${match.rencontre}:`, erreur.message)
    return null
  }
}

// ─── Critique (2ème passe) — synchrone, faible volume (uniquement candidats alerte) ─────────

export const critiquerAnalyse = async (match, analyseInitiale, options = {}) => {
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      system: [
        {
          type: 'text',
          text: PROMPT_SYSTEME_CRITIQUE,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: construirePromptCritique(match, analyseInitiale, options) }],
    })

    return JSON.parse(nettoyerJson(message.content[0].text.trim()))
  } catch (erreur) {
    console.error(`[analyseur] Erreur critique ${match.rencontre}:`, erreur.message)
    return null
  }
}

export const analyserCoteAnomale = async (match, anomalie, parisGagnants, parisPerdants = [], stats, nbUtilisateurs = null) => {
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1800,
      system: [
        {
          type: 'text',
          text: construirePromptSystemeAnomalie(parisGagnants, parisPerdants, stats, nbUtilisateurs),
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: construirePromptUtilisateurAnomalie(match, anomalie) }],
    })

    return JSON.parse(nettoyerJson(message.content[0].text.trim()))
  } catch (erreur) {
    console.error(`[analyseur] Erreur analyse anomalie ${match.rencontre}:`, erreur.message)
    return null
  }
}

// ─── Helpers batch — construction des requêtes individuelles ──────────────────
// Utilisés dans lancerAnalyseBatch (index.js) pour construire le contexte en parallèle

export const creerRequeteBatchPattern = (match, promptSysteme, userId) => ({
  custom_id: `${idSafe(userId)}__pat__${idSafe(match.rencontre)}`,
  params: {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1800,
    system: [{ type: 'text', text: promptSysteme, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: construirePromptUtilisateur(match) }],
  },
})

export const creerRequeteBatchAnomalie = (match, anomalie, promptSysteme, userId) => ({
  custom_id: `${idSafe(userId)}__ano__${idSafe(match.rencontre)}`,
  params: {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1800,
    system: [{ type: 'text', text: promptSysteme, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: construirePromptUtilisateurAnomalie(match, anomalie) }],
  },
})

// ─── API Batch (cycle 9h — asynchrone, -50% coût Anthropic) ─────────────────

export const soumettreRequetesBatch = async (requetes) => {
  try {
    const batch = await client.messages.batches.create({ requests: requetes })
    console.log(`[analyseur] Batch soumis : ${batch.id} (${requetes.length} requêtes)`)
    return batch.id
  } catch (erreur) {
    console.error('[analyseur] Erreur soumission batch:', erreur.message)
    return null
  }
}

export const verifierStatutBatch = async (batchId) => {
  try {
    const batch = await client.messages.batches.retrieve(batchId)
    return batch.processing_status
  } catch (erreur) {
    console.error(`[analyseur] Erreur vérification batch ${batchId}:`, erreur.message)
    return null
  }
}

export const recupererResultatsBatch = async (batchId) => {
  try {
    const resultats = {}
    const decoder = await client.messages.batches.results(batchId)
    for await (const item of decoder) {
      if (item.result.type === 'succeeded') {
        const texte = item.result.message.content[0].text.trim()
        try {
          resultats[item.custom_id] = JSON.parse(nettoyerJson(texte))
        } catch {
          console.error(`[analyseur] Parsing JSON échoué pour ${item.custom_id}`)
        }
      } else {
        console.warn(`[analyseur] Requête batch ${item.custom_id} — statut: ${item.result.type}`)
      }
    }
    return resultats
  } catch (erreur) {
    console.error(`[analyseur] Erreur récupération résultats batch ${batchId}:`, erreur.message)
    return null
  }
}
