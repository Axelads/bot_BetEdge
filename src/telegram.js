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

// En-têtes par tier de conviction (Phase 4)
const TIER_HEADER_PATTERN = {
  forte:     '🔥🔥🔥 <b>CONVICTION FORTE — Opportunité Premium</b>',
  bonne:     '🔥🔥 <b>Bonne Opportunité</b>',
  surveille: '🔥 <b>À Surveiller</b>',
}

const TIER_HEADER_ANOMALIE = {
  forte:     '🔥🔥🔥 <b>CONVICTION FORTE — Anomalie Premium</b>',
  bonne:     '🔥🔥 <b>Bonne Anomalie de Marché</b>',
  surveille: '🔥 <b>Anomalie à Surveiller</b>',
}

// Construit un libellé explicite sans ambiguïté à partir du type et de la valeur du pari
const labelliserPari = (typePari, valeurPari) => {
  const v = echapperHtml(valeurPari ?? '')
  switch (typePari) {
    case 'plus_de':
      return `Plus de ${v} buts dans le match (total des deux équipes)`
    case 'moins_de':
      return `Moins de ${v} buts dans le match (total des deux équipes)`
    case 'victoire_domicile':
      return `Victoire à domicile${v ? ` — ${v}` : ''}`
    case 'victoire_exterieur':
      return `Victoire à l'extérieur${v ? ` — ${v}` : ''}`
    case 'nul':
      return `Match nul`
    case 'les_deux_marquent':
      return `Les deux équipes marquent au moins un but`
    case 'double_chance':
      return `Double chance${v ? ` (${v})` : ''}`
    case 'handicap':
      return `Handicap${v ? ` — ${v}` : ''}`
    case 'score_exact':
      return `Score exact${v ? ` — ${v}` : ''}`
    case 'buteur_a_tout_moment':
      return `Buteur à tout moment${v ? ` — ${v}` : ''}`
    case 'premier_buteur':
      return `Premier buteur${v ? ` — ${v}` : ''}`
    case 'dernier_buteur':
      return `Dernier buteur${v ? ` — ${v}` : ''}`
    case 'mi_temps_resultat':
      return `Résultat à la mi-temps${v ? ` — ${v}` : ''}`
    case 'mi_temps_final':
      return `Mi-temps / Final${v ? ` — ${v}` : ''}`
    case 'nombre_corners':
      return `Corners${v ? ` — ${v}` : ''}`
    case 'nombre_cartons':
      return `Cartons${v ? ` — ${v}` : ''}`
    case 'qualification':
      return `Qualification${v ? ` — ${v}` : ''}`
    case 'vainqueur_tournoi':
      return `Vainqueur du tournoi${v ? ` — ${v}` : ''}`
    case 'combiné':
      return `Combiné${v ? ` — ${v}` : ''}`
    default:
      return v || echapperHtml(typePari ?? '') || 'Voir détails'
  }
}

// Format compact d'un nombre signé en %, avec couleur via emoji
const formaterEdge = (edge) => {
  if (edge == null || !Number.isFinite(Number(edge))) return null
  const valeur = Number(edge)
  const signe = valeur > 0 ? '+' : ''
  return `${signe}${valeur.toFixed(1)}%`
}

const formaterProbabilite = (prob) => {
  if (prob == null || !Number.isFinite(Number(prob))) return null
  return `${Math.round(Number(prob) * 100)}%`
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
  const libellePari = labelliserPari(alerte.type_pari, alerte.valeur_pari)

  const edgeStr = formaterEdge(alerte.edge_pourcent)
  const probStr = formaterProbabilite(alerte.probabilite_estimee)
  const ligneValue = (edgeStr && probStr)
    ? `\n💎 <b>Edge : ${echapperHtml(edgeStr)}</b> (probabilité estimée ${echapperHtml(probStr)} vs cote ${cote})`
    : ''

  const headerTier = TIER_HEADER_PATTERN[alerte.tier] ?? TIER_HEADER_PATTERN.surveille

  return `${headerTier}
🎯 <i>BetEdge — Pattern matching</i>

${emoji} <b>${echapperHtml(alerte.rencontre)}</b> — ${echapperHtml(alerte.competition)}
📅 ${echapperHtml(date)}

💡 <b>Pari suggéré :</b> ${libellePari}
💰 <b>Cote sur le marché :</b> ${cote}${ligneValue}

📊 Similarité avec tes patterns : <b>${echapperHtml(alerte.score_similarite)}/100</b>
🔮 Confiance du bot : <b>${echapperHtml(confiance)}</b>
${tags ? `🏷️ ${tags}` : ''}

🤖 <i>${echapperHtml(alerte.raisonnement_bot)}</i>`
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
  const libellePari = labelliserPari(alerte.type_pari, alerte.valeur_pari)

  const edgeStr = formaterEdge(alerte.edge_pourcent)
  const probStr = formaterProbabilite(alerte.probabilite_estimee)
  const ligneValue = (edgeStr && probStr)
    ? `\n💎 <b>Edge : ${echapperHtml(edgeStr)}</b> (probabilité estimée ${echapperHtml(probStr)} vs cote ${echapperHtml(alerte.cote_marche)})`
    : ''

  const headerTier = TIER_HEADER_ANOMALIE[alerte.tier] ?? TIER_HEADER_ANOMALIE.surveille

  return `${headerTier}
⚡ <i>BetEdge — Détection d'anomalie</i>

${emoji} <b>${echapperHtml(alerte.rencontre)}</b> — ${echapperHtml(alerte.competition)}
📅 ${echapperHtml(date)}

🔍 <b>Anomalie de marché :</b>
"${echapperHtml(alerte.outcome_anomalie)}" → médiane ${coteMediane} → trouvée à <b>${echapperHtml(alerte.cote_marche)}</b> sur ${bookmaker} (${ecart})

💡 <b>Pari suggéré :</b> ${libellePari}
💰 <b>Cote disponible :</b> ${echapperHtml(alerte.cote_marche)} vs marché à ${coteMediane}${ligneValue}

📊 Score de valeur : <b>${echapperHtml(alerte.score_valeur)}/100</b> | Anomalie : ${ecart}
🔮 Confiance du bot : <b>${echapperHtml(confiance)}</b>
${tags ? `🏷️ ${tags}` : ''}

🤖 <i>${echapperHtml(alerte.raisonnement_bot)}</i>`
}

export const envoyerAlerteAnomalie = async (alerte) => {
  const message = formaterMessageAnomalie(alerte)

  const replyMarkup = alerte.alerteId
    ? {
        inline_keyboard: [[
          { text: '✅ Je place', callback_data: `oui:${alerte.alerteId}` },
          { text: '❌ Je passe', callback_data: `non:${alerte.alerteId}` },
        ]],
      }
    : undefined

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
          ...(replyMarkup && { reply_markup: replyMarkup }),
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

  const replyMarkup = alerte.alerteId
    ? {
        inline_keyboard: [[
          { text: '✅ Je place', callback_data: `oui:${alerte.alerteId}` },
          { text: '❌ Je passe', callback_data: `non:${alerte.alerteId}` },
        ]],
      }
    : undefined

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
          ...(replyMarkup && { reply_markup: replyMarkup }),
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
