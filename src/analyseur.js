import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'
dotenv.config()

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const construirePromptSysteme = (parisGagnants, stats) => `
Tu es un assistant d'analyse de paris sportifs expert.
Tu analyses si un match à venir correspond aux patterns gagnants d'un expert parieur.

Voici les paris GAGNANTS de l'expert (les plus représentatifs) :
${JSON.stringify(parisGagnants.slice(0, 20), null, 2)}

Statistiques clés de l'expert :
- Sport le plus rentable : ${stats.meileurSport} (ROI: ${stats.roiMeileurSport}%)
- Type de pari optimal : ${stats.meilleurTypePari}
- Tags les plus rentables : ${stats.meilleursTags.join(', ')}
- Tranche de cote optimale : ${stats.meilleureTrancheCote}
- Taux de réussite sur confiance 4-5 : ${stats.tauxReussiteHauteConfiance}%
- Nombre de paris gagnants analysés : ${parisGagnants.length}

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans texte avant ou après.
`

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
  "pari_recommande": "description courte du pari suggéré",
  "type_pari_recommande": "un des types: victoire_domicile | victoire_exterieur | nul | plus_de | moins_de | les_deux_marquent",
  "valeur_pari": "valeur précise ex: 2.5 pour over/under, ou nom équipe pour victoire",
  "cote_suggeree": nombre (la cote correspondante parmi celles fournies),
  "tags_correspondants": ["tag1", "tag2"],
  "raisonnement": "2-3 phrases maximum expliquant pourquoi ce match correspond",
  "confiance": "faible" ou "moyenne" ou "elevee",
  "envoyer_alerte": true ou false
}
`

export const analyserMatch = async (match, parisGagnants, stats) => {
  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: construirePromptSysteme(parisGagnants, stats),
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
