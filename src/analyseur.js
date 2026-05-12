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

  return `Tu es un assistant d'analyse de paris sportifs expert.
Tu analyses si un match à venir correspond aux patterns GAGNANTS de ${source}, tout en évitant les patterns PERDANTS identifiés.

Voici les paris GAGNANTS ${label} (les plus représentatifs, triés par confiance) :
${JSON.stringify(parisGagnants.slice(0, 25), null, 2)}
${sectionPerdants}
Statistiques clés ${label} (calculées sur toute la base) :
- Sport le plus rentable : ${stats.meileurSport} (ROI: ${stats.roiMeileurSport}%)
- Type de pari optimal : ${stats.meilleurTypePari}
- Tags les plus rentables : ${stats.meilleursTags.join(', ')}
- Tranche de cote optimale : ${stats.meilleureTrancheCote}
- Taux de réussite sur confiance 4-5 : ${stats.tauxReussiteHauteConfiance}%
- Paris gagnants : ${parisGagnants.length} | Paris perdants : ${parisPerdants.length}${lignePerdants}

Format de pari souhaité : ${instructionFormat}

IMPORTANT : si le match présente plusieurs tags ou un contexte similaire aux paris perdants, baisser le score_similarite et mettre envoyer_alerte à false.

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

  return `Tu es un assistant d'analyse de paris sportifs expert, spécialisé dans la détection de valeur (value betting).

Patterns gagnants ${source} (${parisGagnants.length} paris) :
${JSON.stringify(parisGagnants.slice(0, 20), null, 2)}
${sectionPerdants}
Statistiques ${source} : sport=${stats.meileurSport} | type=${stats.meilleurTypePari} | tranche cote=${stats.meilleureTrancheCote} | win rate haute confiance=${stats.tauxReussiteHauteConfiance}%${lignePerdants}

Tu dois évaluer si une anomalie de cote représente une vraie opportunité de value bet, ou si elle a une explication rationnelle (blessure majeure, suspension, erreur bookmaker, équipe B).
Si le contexte du match ressemble aux patterns perdants, baisser le score_valeur et mettre est_opportunite_reelle à false.
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

const construirePromptUtilisateur = (match) => `Analyse ce match à venir :

Rencontre : ${match.rencontre}
Compétition : ${match.competition}
Sport : ${match.sport}
Date : ${new Date(match.date_match).toLocaleString('fr-FR')}

Cotes actuelles sur le marché (médiane multi-bookmakers) :
${construireSectionCotes(match)}
${construireContexteApiFootball(match)}
Est-ce que ce match correspond aux patterns gagnants de l'expert ?

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans texte autour) :
{
  "score_similarite": nombre entre 0 et 100,
  "pari_recommande": "description courte du pari suggéré",
  "type_pari_recommande": "un des types: victoire_domicile | victoire_exterieur | nul | plus_de | moins_de | les_deux_marquent | handicap",
  "valeur_pari": "valeur précise ex: 2.5 pour over/under, nom équipe pour victoire, '${match.equipe_domicile} -1.5' pour handicap, 'oui'/'non' pour les_deux_marquent",
  "cote_suggeree": nombre (la cote correspondante parmi celles fournies),
  "tags_correspondants": ["tag1", "tag2"],
  "raisonnement": "2-3 phrases maximum expliquant pourquoi ce match correspond",
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
${construireContexteApiFootball(match)}

QUESTION : Cette cote anormale est-elle une vraie opportunité de value bet, ou existe-t-il une raison valable (blessure majeure récente, suspension, erreur de ligne bookmaker, équipe B alignée) ?
Est-elle cohérente avec les patterns de l'expert ?

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans texte autour) :
{
  "est_opportunite_reelle": true ou false,
  "score_valeur": nombre entre 0 et 100,
  "pari_recommande": "description courte du pari suggéré",
  "type_pari_recommande": "victoire_domicile | victoire_exterieur | nul | plus_de | moins_de | les_deux_marquent | handicap",
  "valeur_pari": "valeur précise ex: équipe, 2.5, oui, '${match.equipe_domicile} -1.5'",
  "cote_recommandee": nombre (la cote anormale trouvée),
  "tags_correspondants": ["tag1", "tag2"],
  "raisonnement": "2-3 phrases expliquant l'opportunité ou la raison de la fausse alerte",
  "confiance": "faible" ou "moyenne" ou "elevee",
  "raison_anomalie_probable": "genuine_value | erreur_bookmaker | blessure_non_integree | equipe_b | autre"
}`

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
      max_tokens: 1000,
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

export const analyserCoteAnomale = async (match, anomalie, parisGagnants, parisPerdants = [], stats, nbUtilisateurs = null) => {
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
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
    max_tokens: 1000,
    system: [{ type: 'text', text: promptSysteme, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: construirePromptUtilisateur(match) }],
  },
})

export const creerRequeteBatchAnomalie = (match, anomalie, promptSysteme, userId) => ({
  custom_id: `${idSafe(userId)}__ano__${idSafe(match.rencontre)}`,
  params: {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
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
    for await (const item of client.messages.batches.results(batchId)) {
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
