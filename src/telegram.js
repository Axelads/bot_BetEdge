import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

const EMOJI_SPORT = {
  football:   '⚽',
  tennis:     '🎾',
  basketball: '🏀',
  rugby:      '🏉',
}

// Échappe les caractères spéciaux pour HTML Telegram
const echapperHtml = (texte) => {
  return String(texte)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
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

  const tags = (alerte.tags_detectes ?? []).map(t => `#${echapperHtml(t)}`).join(' ')
  const cote = alerte.cote_marche ? echapperHtml(alerte.cote_marche) : 'à vérifier'
  const confiance = CONFIANCE_LABEL[alerte.confiance] ?? '🟡 Moyenne'

  return `🎯 <b>BetEdge — Opportunité détectée</b>

${emoji} <b>${echapperHtml(alerte.rencontre)}</b> — ${echapperHtml(alerte.competition)}
📅 ${echapperHtml(date)}

💡 <b>Pari suggéré :</b> ${echapperHtml(alerte.valeur_pari)}
💰 <b>Cote sur le marché :</b> ${cote}

📊 Similarité avec tes patterns : <b>${echapperHtml(alerte.score_similarite)}/100</b>
🔮 Confiance du bot : <b>${echapperHtml(confiance)}</b>
${tags ? `🏷️ ${tags}` : ''}

🤖 <i>${echapperHtml(alerte.raisonnement_bot)}</i>

→ Tu places ? Réponds <b>OUI</b> pour logger ou <b>NON</b> pour ignorer`
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

  const tags = (alerte.tags_detectes ?? []).map(t => `#${echapperHtml(t)}`).join(' ')
  const ecart = alerte.ecart_pourcent ? `+${echapperHtml(alerte.ecart_pourcent)}%` : ''
  const bookmaker = alerte.bookmaker_anomalie ? echapperHtml(alerte.bookmaker_anomalie) : 'un bookmaker'
  const coteMediane = alerte.cote_mediane ? echapperHtml(alerte.cote_mediane) : '?'
  const confiance = CONFIANCE_LABEL[alerte.confiance] ?? '🟡 Moyenne'

  return `⚡ <b>BetEdge — Cote Anormale Détectée</b>

${emoji} <b>${echapperHtml(alerte.rencontre)}</b> — ${echapperHtml(alerte.competition)}
📅 ${echapperHtml(date)}

🔍 <b>Anomalie de marché :</b>
"${echapperHtml(alerte.outcome_anomalie)}" → médiane ${coteMediane} → trouvée à <b>${echapperHtml(alerte.cote_marche)}</b> sur ${bookmaker} (${ecart})

💡 <b>Pari suggéré :</b> ${echapperHtml(alerte.valeur_pari)}
💰 <b>Cote disponible :</b> ${echapperHtml(alerte.cote_marche)} vs marché à ${coteMediane}

📊 Score de valeur : <b>${echapperHtml(alerte.score_valeur)}/100</b> | Anomalie : ${ecart}
🔮 Confiance du bot : <b>${echapperHtml(confiance)}</b>
${tags ? `🏷️ ${tags}` : ''}

🤖 <i>${echapperHtml(alerte.raisonnement_bot)}</i>

→ Tu places ? Réponds <b>OUI</b> pour logger ou <b>NON</b> pour ignorer`
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
          parse_mode: 'HTML',
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
          parse_mode: 'HTML',
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
          text: '🟢 <b>BetEdge Bot démarré</b>\nAnalyse des matchs en cours...',
          parse_mode: 'HTML',
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
