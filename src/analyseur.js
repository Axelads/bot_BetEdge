import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'
dotenv.config()

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const construirePromptSysteme = (parisGagnants, stats, nbUtilisateurs = null) => {
  const source = nbUtilisateurs
    ? `une communauté de ${nbUtilisateurs} parieur(s) — données agrégées de toute la plateforme`
    : `un expert parieur`
  const label = nbUtilisateurs ? 'de la communauté' : "de l'expert"

  return `
Tu es un assistant d'analyse de paris sportifs expert.
Tu analyses si un match à venir correspond aux patterns gagnants de ${source}.

Voici les paris GAGNANTS ${label} (les plus représentatifs, triés par confiance) :
${JSON.stringify(parisGagnants.slice(0, 30), null, 2)}

Statistiques clés ${label} (calculées sur toute la base) :
- Sport le plus rentable : ${stats.meileurSport} (ROI: ${stats.roiMeileurSport}%)
- Type de pari optimal : ${stats.meilleurTypePari}
- Tags les plus rentables : ${stats.meilleursTags.join(', ')}
- Tranche de cote optimale : ${stats.meilleureTrancheCote}
- Taux de réussite sur confiance 4-5 : ${stats.tauxReussiteHauteConfiance}%
- Nombre de paris gagnants analysés : ${parisGagnants.length}

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans texte avant ou après.
`
}

const construirePromptUtilisateur = (match) => `
Analyse ce match à venir :

Rencontre : ${match.rencontre}
Compétition : ${match.competition}
Sport : ${match.sport}
Date : ${new Date(match.date_match).toLocaleString('fr-FR')}

Cotes actuelles sur le marché :
- Victoire domicile : ${match.cotes.domicile ?? 'N/A'}
- Nul : ${match.cotes.nul ?? 'N/A'}
- Victoire extérieur : ${match.cotes.exterieur ?? 'N/A'}
- Plus de 2.5 buts : ${match.cotes.over25 ?? 'N/A'}
- Moins de 2.5 buts : ${match.cotes.under25 ?? 'N/A'}

Est-ce que ce match correspond aux patterns gagnants de l'expert ?

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans texte autour) :
{
  "score_similarite": nombre entre 0 et 100,
  "pari_recommande": "description complète et sans ambiguïté — précise toujours le périmètre exact (ex: 'Plus de 2.5 buts au total dans le match entre les deux équipes', 'Victoire Liverpool à domicile', 'Les deux équipes marquent au moins un but')",
  "type_pari_recommande": "un des types: victoire_domicile | victoire_exterieur | nul | plus_de | moins_de | les_deux_marquent | double_chance | handicap | score_exact | buteur_a_tout_moment | premier_buteur | nombre_corners | nombre_cartons | qualification | vainqueur_tournoi | combiné",
  "valeur_pari": "valeur brute uniquement — ex: '2.5' pour over/under, 'Liverpool' pour victoire domicile, 'oui' pour BTTS, '1X' pour double chance (ne pas répéter le type ici)",
  "cote_suggeree": nombre (la cote correspondante parmi celles fournies),
  "tags_correspondants": ["tag1", "tag2"],
  "raisonnement": "2-3 phrases maximum expliquant pourquoi ce match correspond",
  "confiance": "faible" ou "moyenne" ou "elevee",
  "envoyer_alerte": true ou false
}
`

const construirePromptCoteAnomale = (match, anomalie, parisGagnants, stats, nbUtilisateurs = null) => {
  const source = nbUtilisateurs
    ? `de la communauté (${nbUtilisateurs} parieur(s) — données agrégées)`
    : `de l'expert`

  return `
Tu es un assistant d'analyse de paris sportifs expert, spécialisé dans la détection de valeur (value betting).

Patterns gagnants ${source} (${parisGagnants.length} paris) :
${JSON.stringify(parisGagnants.slice(0, 20), null, 2)}

Statistiques ${source} : sport=${stats.meileurSport} | type=${stats.meilleurTypePari} | tranche cote=${stats.meilleureTrancheCote} | win rate haute confiance=${stats.tauxReussiteHauteConfiance}%

ANOMALIE DE MARCHÉ DÉTECTÉE
Match : ${match.rencontre} (${match.competition}) — ${match.sport}
Date : ${new Date(match.date_match).toLocaleString('fr-FR')}

L'outcome "${anomalie.outcome}" affiche une cote anormalement haute :
- Médiane du marché (${anomalie.nb_bookmakers} bookmakers) : ${anomalie.cote_mediane}
- Cote anormale trouvée : ${anomalie.cote_anomalie} sur ${anomalie.bookmaker}
- Écart : +${anomalie.ecart_pourcent}% au-dessus du marché
- Toutes les cotes disponibles : ${anomalie.toutes_cotes.join(' / ')}
${anomalie.marge_marche !== null ? `- Marge best-available du marché : ${anomalie.marge_marche}% (normale : 4-7%)` : ''}

Cotes H2H du match :
- Domicile : ${match.cotes.domicile ?? 'N/A'}
- Nul : ${match.cotes.nul ?? 'N/A'}
- Extérieur : ${match.cotes.exterieur ?? 'N/A'}
- Over 2.5 : ${match.cotes.over25 ?? 'N/A'}
- Under 2.5 : ${match.cotes.under25 ?? 'N/A'}

QUESTION : Cette cote anormale est-elle une vraie opportunité de value bet, ou existe-t-il une raison valable (blessure majeure récente, suspension, erreur de ligne bookmaker, équipe B alignée) ?
Est-elle cohérente avec les patterns de l'expert ?

Réponds UNIQUEMENT avec ce JSON (sans markdown, sans texte autour) :
{
  "est_opportunite_reelle": true ou false,
  "score_valeur": nombre entre 0 et 100,
  "pari_recommande": "description complète et sans ambiguïté — précise toujours le périmètre exact (ex: 'Plus de 2.5 buts au total dans le match entre les deux équipes', 'Victoire Real Madrid à domicile', 'Les deux équipes marquent au moins un but')",
  "type_pari_recommande": "victoire_domicile | victoire_exterieur | nul | plus_de | moins_de | les_deux_marquent | double_chance | handicap | score_exact | buteur_a_tout_moment | premier_buteur | nombre_corners | qualification | vainqueur_tournoi | combiné",
  "valeur_pari": "valeur brute uniquement — ex: '2.5' pour over/under, 'Real Madrid' pour victoire, 'oui' pour BTTS (ne pas répéter le type ici)",
  "cote_recommandee": nombre (la cote anormale trouvée),
  "tags_correspondants": ["tag1", "tag2"],
  "raisonnement": "2-3 phrases expliquant l'opportunité ou la raison de la fausse alerte",
  "confiance": "faible" ou "moyenne" ou "elevee",
  "raison_anomalie_probable": "genuine_value | erreur_bookmaker | blessure_non_integree | equipe_b | autre"
}
`
}

export const analyserCoteAnomale = async (match, anomalie, parisGagnants, stats, nbUtilisateurs = null) => {
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: construirePromptCoteAnomale(match, anomalie, parisGagnants, stats, nbUtilisateurs),
        }
      ],
    })

    const texteReponse = message.content[0].text.trim()
    const jsonNettoye = texteReponse
      .replace(/^```json\n?/, '')
      .replace(/^```\n?/, '')
      .replace(/\n?```$/, '')
      .trim()

    return JSON.parse(jsonNettoye)
  } catch (erreur) {
    console.error(`[analyseur] Erreur analyse anomalie ${match.rencontre}:`, erreur.message)
    return null
  }
}

export const analyserMatch = async (match, parisGagnants, stats, nbUtilisateurs = null) => {
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: construirePromptSysteme(parisGagnants, stats, nbUtilisateurs),
      messages: [
        { role: 'user', content: construirePromptUtilisateur(match) }
      ],
    })

    const texteReponse = message.content[0].text.trim()

    // Nettoyer au cas où Claude ajouterait des backticks malgré les consignes
    const jsonNettoye = texteReponse
      .replace(/^```json\n?/, '')
      .replace(/^```\n?/, '')
      .replace(/\n?```$/, '')
      .trim()

    const analyse = JSON.parse(jsonNettoye)
    return analyse
  } catch (erreur) {
    console.error(`[analyseur] Erreur analyse ${match.rencontre}:`, erreur.message)
    return null
  }
}
