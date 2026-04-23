import cron from 'node-cron'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

import { recupererMatchsAVenir }                              from './collecteurCotes.js'
import { analyserMatch, analyserCoteAnomale }                from './analyseur.js'
import { calculerStats, doitEnvoyerAlerte, preparerAlerte, doitEnvoyerAlerteAnomalie, preparerAlerteAnomalie } from './comparateurPatterns.js'
import { detecterAnomaliesCotes }                            from './detecteurAnomalie.js'
import { envoyerAlerte, envoyerAlerteAnomalie, envoyerMessageDemarrage } from './telegram.js'

// ─── PocketBase ───────────────────────────────────────────────────────────────

let tokenAdmin = null

const authentifierPocketBase = async () => {
  try {
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

    if (!reponse.ok) throw new Error(`Authentification échouée: HTTP ${reponse.status}`)

    const data = await reponse.json()
    tokenAdmin = data.token
    console.log('[pocketbase] Authentification admin réussie')
  } catch (erreur) {
    console.error('[pocketbase] Erreur authentification:', erreur.message)
    throw erreur
  }
}

const recupererUtilisateursActifs = async () => {
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/profils/records?perPage=200`,
    { headers: { Authorization: tokenAdmin } }
  )
  if (!reponse.ok) throw new Error(`PocketBase erreur profils: HTTP ${reponse.status}`)
  const data = await reponse.json()
  return (data.items ?? []).filter(p => p.telegram_chat_id)
}

const recupererParisGagnantsUtilisateur = async (userId) => {
  const filtre = encodeURIComponent(`statut="gagne" && user="${userId}"`)
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/paris/records?filter=${filtre}&sort=-created&perPage=50`,
    { headers: { Authorization: tokenAdmin } }
  )
  if (!reponse.ok) throw new Error(`PocketBase erreur paris gagnants: HTTP ${reponse.status}`)
  const data = await reponse.json()
  return data.items ?? []
}

const recupererTousParisUtilisateur = async (userId) => {
  const filtre = encodeURIComponent(`statut!="en_attente" && user="${userId}"`)
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/paris/records?filter=${filtre}&sort=-created&perPage=200`,
    { headers: { Authorization: tokenAdmin } }
  )
  if (!reponse.ok) throw new Error(`PocketBase erreur tous paris: HTTP ${reponse.status}`)
  const data = await reponse.json()
  return data.items ?? []
}

const sauvegarderAlerte = async (alerte) => {
  try {
    const reponse = await fetch(
      `${process.env.POCKETBASE_URL}/api/collections/alertes_bot/records`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: tokenAdmin,
        },
        body: JSON.stringify(alerte),
      }
    )

    if (!reponse.ok) {
      const erreur = await reponse.json()
      console.error('[pocketbase] Erreur sauvegarde alerte:', erreur)
      return null
    }

    return await reponse.json()
  } catch (erreur) {
    console.error('[pocketbase] Erreur réseau sauvegarde:', erreur.message)
    return null
  }
}

const marquerAlerteTelegramEnvoyee = async (alerteId) => {
  try {
    await fetch(
      `${process.env.POCKETBASE_URL}/api/collections/alertes_bot/records/${alerteId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: tokenAdmin },
        body: JSON.stringify({ telegram_envoye: true }),
      }
    )
  } catch (erreur) {
    console.error('[pocketbase] Erreur PATCH telegram_envoye:', erreur.message)
  }
}

// ─── Cycle principal ──────────────────────────────────────────────────────────

const analyserPourUtilisateur = async (profil, matchsAVenir) => {
  const { user: userId, telegram_chat_id: telegramChatId } = profil
  console.log(`\n[bot] ── Utilisateur ${userId} ──`)

  const [parisGagnants, tousParis] = await Promise.all([
    recupererParisGagnantsUtilisateur(userId),
    recupererTousParisUtilisateur(userId),
  ])

  console.log(`[bot] ${parisGagnants.length} paris gagnants | ${tousParis.length} paris terminés`)

  if (parisGagnants.length < 2) {
    console.log(`[bot] Pas assez de paris gagnants (minimum 2). Passage au suivant.`)
    return 0
  }

  const stats = calculerStats(tousParis)
  console.log(`[bot] Stats — sport: ${stats.meileurSport} | type: ${stats.meilleurTypePari}`)

  let nbAlertes = 0

  for (const match of matchsAVenir) {
    // ── Piste 1 : Pattern matching ──────────────────────────────────────────
    const analyse = await analyserMatch(match, parisGagnants, stats)

    if (analyse) {
      console.log(`[bot] ${match.rencontre} → patterns ${analyse.score_similarite}/100 (${analyse.confiance})`)
    }

    if (analyse && doitEnvoyerAlerte(analyse)) {
      console.log(`[bot] ✅ Alerte patterns: ${analyse.pari_recommande}`)

      const alerte = {
        ...preparerAlerte(match, analyse),
        sport: match.sport,
        user: userId,
      }

      const alerteSauvegardee = await sauvegarderAlerte(alerte)

      if (alerteSauvegardee) {
        const envoye = await envoyerAlerte({ ...alerte, telegramChatId, confiance: analyse.confiance })
        if (envoye) {
          await marquerAlerteTelegramEnvoyee(alerteSauvegardee.id)
          nbAlertes++
        }
      }
    }

    // ── Piste 2 : Anomalie de cotes ─────────────────────────────────────────
    const anomalie = detecterAnomaliesCotes(match)

    if (anomalie) {
      console.log(`[bot] 🔍 Anomalie ${match.rencontre}: "${anomalie.outcome}" +${anomalie.ecart_pourcent}% vs marché (${anomalie.bookmaker})`)

      const analyseAnomalie = await analyserCoteAnomale(match, anomalie, parisGagnants, stats)

      if (analyseAnomalie) {
        console.log(`[bot] ${match.rencontre} → valeur ${analyseAnomalie.score_valeur}/100 (${analyseAnomalie.confiance}) — ${analyseAnomalie.raison_anomalie_probable}`)
      }

      if (doitEnvoyerAlerteAnomalie(anomalie, analyseAnomalie)) {
        console.log(`[bot] ⚡ Alerte anomalie: ${analyseAnomalie.pari_recommande}`)

        const donneesAlertePB = {
          ...preparerAlerteAnomalie(match, anomalie, analyseAnomalie),
          sport: match.sport,
          user: userId,
        }

        // Champs extras pour le message Telegram uniquement (non envoyés à PocketBase)
        const alerteAnomalie = {
          ...donneesAlertePB,
          outcome_anomalie: anomalie.outcome,
          cote_mediane: anomalie.cote_mediane,
          bookmaker_anomalie: anomalie.bookmaker,
          ecart_pourcent: anomalie.ecart_pourcent,
          confiance: analyseAnomalie.confiance,
        }

        const alerteSauvegardee = await sauvegarderAlerte(donneesAlertePB)

        if (alerteSauvegardee) {
          const envoye = await envoyerAlerteAnomalie({ ...alerteAnomalie, telegramChatId })
          if (envoye) {
            await marquerAlerteTelegramEnvoyee(alerteSauvegardee.id)
            nbAlertes++
          }
        }
      }
    }
  }

  return nbAlertes
}

const lancerAnalyse = async () => {
  const debut = Date.now()
  console.log('\n═══════════════════════════════════════')
  console.log(`[bot] Cycle d'analyse — ${new Date().toLocaleString('fr-FR')}`)
  console.log('═══════════════════════════════════════')

  try {
    await authentifierPocketBase()

    // Récupérer tous les utilisateurs avec un Telegram configuré
    const utilisateurs = await recupererUtilisateursActifs()
    console.log(`[bot] ${utilisateurs.length} utilisateur(s) actif(s) avec Telegram`)

    if (utilisateurs.length === 0) {
      console.log('[bot] Aucun utilisateur avec Telegram configuré. En attente...')
      return
    }

    // Récupérer les matchs une seule fois pour tous les utilisateurs
    const matchsAVenir = await recupererMatchsAVenir()

    if (matchsAVenir.length === 0) {
      console.log('[bot] Aucun match à analyser dans les 24h.')
      return
    }

    // Analyser pour chaque utilisateur
    let nbAlertesTotal = 0
    for (const profil of utilisateurs) {
      const nb = await analyserPourUtilisateur(profil, matchsAVenir)
      nbAlertesTotal += nb
    }

    const duree = ((Date.now() - debut) / 1000).toFixed(1)
    console.log(`\n[bot] Cycle terminé en ${duree}s — ${nbAlertesTotal} alerte(s) envoyée(s)`)
    console.log('═══════════════════════════════════════\n')
  } catch (erreur) {
    console.error('[bot] Erreur critique dans le cycle:', erreur.message)
  }
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

console.log('🚀 BetEdge Bot — Démarrage...')

// Envoyer une notif Telegram au démarrage
await envoyerMessageDemarrage()

// Lancer une première analyse immédiatement au démarrage
await lancerAnalyse()

// Puis toutes les heures de 8h à 23h
// '0 8-23 * * *' = à l'heure pile, de 8h00 à 23h00
cron.schedule('0 8-23 * * *', () => {
  lancerAnalyse()
})

console.log('[bot] Cron actif — analyse toutes les heures de 8h à 23h')
