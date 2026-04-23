import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

const EMOJI_SPORT = {
  football:   '⚽',
  tennis:     '🎾',
  basketball: '🏀',
  rugby:      '🏉',
}

// Échappe les caractères spéciaux pour MarkdownV2 Telegram
const echapperMarkdown = (texte) => {
  return String(texte).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&')
}

const CONFIANCE_LABEL = {
  elevee:  '🟢 Élevée',
  moyenne: '🟡 Moyenne',
  faible:  '🔴 Faible',
}

const formaterMessage = (alerte) => {
  const emoji = EMOJI_SPORT[alerte.sport] ?? '🏆'
  const date = new Date(alerte.date_match).toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  const tags = (alerte.tags_detectes ?? []).map(t => `\\#${echapperMarkdown(t)}`).join(' ')
  const cote = alerte.cote_marche ? echapperMarkdown(alerte.cote_marche) : 'à vérifier'
  const confiance = CONFIANCE_LABEL[alerte.confiance] ?? '🟡 Moyenne'

  return `🎯 *BetEdge — Opportunité détectée*

${emoji} *${echapperMarkdown(alerte.rencontre)}* — ${echapperMarkdown(alerte.competition)}
📅 ${echapperMarkdown(date)}

💡 *Pari suggéré :* ${echapperMarkdown(alerte.valeur_pari)}
💰 *Cote sur le marché :* ${cote}

📊 Similarité avec tes patterns : *${echapperMarkdown(alerte.score_similarite)}/100*
🔮 Confiance du bot : *${echapperMarkdown(confiance)}*
${tags ? `🏷️ ${tags}` : ''}

🤖 _${echapperMarkdown(alerte.raisonnement_bot)}_

→ Tu places ? Réponds *OUI* pour logger ou *NON* pour ignorer`
}

const formaterMessageAnomalie = (alerte) => {
  const emoji = EMOJI_SPORT[alerte.sport] ?? '🏆'
  const date = new Date(alerte.date_match).toLocaleString('fr-FR', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })

  const tags = (alerte.tags_detectes ?? []).map(t => `\\#${echapperMarkdown(t)}`).join(' ')
  const ecart = alerte.ecart_pourcent ? `\\+${echapperMarkdown(alerte.ecart_pourcent)}%` : ''
  const bookmaker = alerte.bookmaker_anomalie ? echapperMarkdown(alerte.bookmaker_anomalie) : 'un bookmaker'
  const coteMediane = alerte.cote_mediane ? echapperMarkdown(alerte.cote_mediane) : '?'
  const confiance = CONFIANCE_LABEL[alerte.confiance] ?? '🟡 Moyenne'

  return `⚡ *BetEdge — Cote Anormale Détectée*

${emoji} *${echapperMarkdown(alerte.rencontre)}* — ${echapperMarkdown(alerte.competition)}
📅 ${echapperMarkdown(date)}

🔍 *Anomalie de marché :*
"${echapperMarkdown(alerte.outcome_anomalie)}" → médiane ${coteMediane} → trouvée à *${echapperMarkdown(alerte.cote_marche)}* sur ${bookmaker} \\(${ecart}\\)

💡 *Pari suggéré :* ${echapperMarkdown(alerte.valeur_pari)}
💰 *Cote disponible :* ${echapperMarkdown(alerte.cote_marche)} vs marché à ${coteMediane}

📊 Score de valeur : *${echapperMarkdown(alerte.score_valeur)}/100* \\| Anomalie : ${ecart}
🔮 Confiance du bot : *${echapperMarkdown(confiance)}*
${tags ? `🏷️ ${tags}` : ''}

🤖 _${echapperMarkdown(alerte.raisonnement_bot)}_

→ Tu places ? Réponds *OUI* pour logger ou *NON* pour ignorer`
}

export const envoyerAlerteAnomalie = async (alerte) => {
  const message = formaterMessageAnomalie(alerte)

  try {
    const reponse = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: alerte.telegramChatId ?? process.env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'MarkdownV2',
        }),
      }
    )

    const resultat = await reponse.json()

    if (!resultat.ok) {
      console.error('[telegram] Erreur envoi anomalie:', resultat.description)
      return false
    }

    console.log(`[telegram] Alerte anomalie envoyée — ${alerte.rencontre}`)
    return true
  } catch (erreur) {
    console.error('[telegram] Erreur réseau anomalie:', erreur.message)
    return false
  }
}

export const envoyerAlerte = async (alerte) => {
  const message = formaterMessage(alerte)

  try {
    const reponse = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: alerte.telegramChatId ?? process.env.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: 'MarkdownV2',
        }),
      }
    )

    const resultat = await reponse.json()

    if (!resultat.ok) {
      console.error('[telegram] Erreur envoi:', resultat.description)
      return false
    }

    console.log(`[telegram] Alerte envoyée — ${alerte.rencontre}`)
    return true
  } catch (erreur) {
    console.error('[telegram] Erreur réseau:', erreur.message)
    return false
  }
}

// Envoie un message de démarrage pour confirmer que le bot fonctionne
export const envoyerMessageDemarrage = async () => {
  try {
    const reponse = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: '🟢 *BetEdge Bot démarré*\nAnalyse des matchs en cours\\.\\.\\.',
          parse_mode: 'MarkdownV2',
        }),
      }
    )
    const resultat = await reponse.json()
    if (!resultat.ok) {
      console.error('[telegram] Erreur message démarrage:', resultat.description)
    }
  } catch (erreur) {
    console.error('[telegram] Erreur réseau démarrage:', erreur.message)
  }
}
