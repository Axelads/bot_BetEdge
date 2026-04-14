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
  const cote = alerte.cote_marche ? `~${echapperMarkdown(alerte.cote_marche)}` : 'à vérifier'

  return `🎯 *BetEdge — Opportunité détectée*

${emoji} *${echapperMarkdown(alerte.rencontre)}* — ${echapperMarkdown(alerte.competition)}
📅 ${echapperMarkdown(date)}

💡 *Pari suggéré :* ${echapperMarkdown(alerte.valeur_pari)}
💰 *Cote sur le marché :* ${cote}

📊 Similarité avec tes patterns : *${echapperMarkdown(alerte.score_similarite)}/100*
${tags ? `🏷️ ${tags}` : ''}

🤖 _${echapperMarkdown(alerte.raisonnement_bot)}_

→ Tu places ? Réponds *OUI* pour logger ou *NON* pour ignorer`
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
          chat_id: process.env.TELEGRAM_CHAT_ID,
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
