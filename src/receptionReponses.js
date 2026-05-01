import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHEMIN_OFFSET = path.join(__dirname, '..', 'telegram_offset.json')

// ─── Gestion de l'offset Telegram ────────────────────────────────────────────

const lireOffset = () => {
  try {
    if (!fs.existsSync(CHEMIN_OFFSET)) return 0
    const data = JSON.parse(fs.readFileSync(CHEMIN_OFFSET, 'utf8'))
    return data.offset ?? 0
  } catch {
    return 0
  }
}

const sauvegarderOffset = (offset) => {
  try {
    fs.writeFileSync(CHEMIN_OFFSET, JSON.stringify({ offset }), 'utf8')
  } catch (erreur) {
    console.error('[reponses] Erreur sauvegarde offset:', erreur.message)
  }
}

// ─── PocketBase — auth + mise à jour décision ─────────────────────────────────

const authentifierPocketBase = async () => {
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/_superusers/auth-with-password`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identity: process.env.POCKETBASE_ADMIN_EMAIL,
        password: process.env.POCKETBASE_ADMIN_PASSWORD,
      }),
    }
  )
  if (!reponse.ok) throw new Error(`Auth PB échouée: HTTP ${reponse.status}`)
  const data = await reponse.json()
  return data.token
}

const mettreAJourDecision = async (alerteId, decision, token) => {
  try {
    const reponse = await fetch(
      `${process.env.POCKETBASE_URL}/api/collections/alertes_bot/records/${alerteId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: token },
        body: JSON.stringify({ decision_expert: decision }),
      }
    )
    if (!reponse.ok) {
      const erreur = await reponse.json()
      console.error(`[reponses] Erreur PATCH alerte ${alerteId}:`, erreur)
      return false
    }
    return true
  } catch (erreur) {
    console.error('[reponses] Erreur réseau PATCH:', erreur.message)
    return false
  }
}

// ─── Telegram — répondre au callback + retirer les boutons ───────────────────

const acquitterCallback = async (callbackQueryId, texte) => {
  try {
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text: texte }),
      }
    )
  } catch (erreur) {
    console.error('[reponses] Erreur answerCallbackQuery:', erreur.message)
  }
}

const retirerBoutons = async (chatId, messageId) => {
  try {
    await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        }),
      }
    )
  } catch (erreur) {
    console.error('[reponses] Erreur editMessageReplyMarkup:', erreur.message)
  }
}

// ─── Point d'entrée principal ─────────────────────────────────────────────────

export const traiterReponsesTelegram = async () => {
  const offset = lireOffset()

  let mises_a_jour

  try {
    const reponse = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getUpdates?offset=${offset}&timeout=0&allowed_updates=["callback_query"]`
    )
    const data = await reponse.json()

    if (!data.ok || !data.result?.length) return

    mises_a_jour = data.result
  } catch (erreur) {
    console.error('[reponses] Erreur getUpdates:', erreur.message)
    return
  }

  // Filtrer uniquement les callback_query liés à BetEdge (oui: ou non:)
  const callbacksBetEdge = mises_a_jour.filter(
    u => u.callback_query?.data?.startsWith('oui:') || u.callback_query?.data?.startsWith('non:')
  )

  if (callbacksBetEdge.length === 0) {
    // Mettre à jour l'offset même s'il n'y a pas de callbacks BetEdge
    const dernierUpdateId = mises_a_jour[mises_a_jour.length - 1].update_id
    sauvegarderOffset(dernierUpdateId + 1)
    return
  }

  let token
  try {
    token = await authentifierPocketBase()
  } catch (erreur) {
    console.error('[reponses] Auth PocketBase échouée:', erreur.message)
    return
  }

  for (const update of mises_a_jour) {
    const cq = update.callback_query
    if (!cq) {
      sauvegarderOffset(update.update_id + 1)
      continue
    }

    const { id: callbackId, data: callbackData, message } = cq

    if (!callbackData?.startsWith('oui:') && !callbackData?.startsWith('non:')) {
      sauvegarderOffset(update.update_id + 1)
      continue
    }

    const [prefixe, alerteId] = callbackData.split(':')
    const decision = prefixe === 'oui' ? 'place' : 'refuse'
    const labelDecision = decision === 'place' ? '✅ Pari loggé !' : '❌ Alerte ignorée'

    console.log(`[reponses] Décision "${decision}" reçue pour alerte ${alerteId}`)

    const ok = await mettreAJourDecision(alerteId, decision, token)

    if (ok) {
      console.log(`[reponses] Alerte ${alerteId} mise à jour → ${decision}`)
    }

    // Toujours acquitter le callback (sinon le bouton reste en loading côté Telegram)
    await acquitterCallback(callbackId, labelDecision)

    // Retirer les boutons du message pour éviter un double-clic
    if (message?.chat?.id && message?.message_id) {
      await retirerBoutons(message.chat.id, message.message_id)
    }

    sauvegarderOffset(update.update_id + 1)
  }
}
