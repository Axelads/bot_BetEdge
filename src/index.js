import cron from 'node-cron'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
dotenv.config()

import { recupererMatchsAVenir }                     from './collecteurCotes.js'
import { analyserMatch }                             from './analyseur.js'
import { calculerStats, doitEnvoyerAlerte, preparerAlerte } from './comparateurPatterns.js'
import { envoyerAlerte, envoyerMessageDemarrage }    from './telegram.js'

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

// ─── Cycle principal ──────────────────────────────────────────────────────────

const analyserPourUtilisateur = async (profil, matchsAVenir) => {
  const { user: userId, telegram_chat_id: telegramChatId } = profil
  console.log(`\n[bot] ── Utilisateur ${userId} ──`)

  const [parisGagnants, tousParis] = await Promise.all([
    recupererParisGagnantsUtilisateur(userId),
    recupererTousParisUtilisateur(userId),
  ])

  console.log(`[bot] ${parisGagnants.length} paris gagnants | ${tousParis.length} paris terminés`)

  if (parisGagnants.length < 3) {
    console.log(`[bot] Pas assez de paris gagnants (minimum 3). Passage au suivant.`)
    return 0
  }

  const stats = calculerStats(tousParis)
  console.log(`[bot] Stats — sport: ${stats.meileurSport} | type: ${stats.meilleurTypePari}`)

  let nbAlertes = 0

  for (const match of matchsAVenir) {
    const analyse = await analyserMatch(match, parisGagnants, stats)

    if (!analyse) continue

    console.log(`[bot] ${match.rencontre} → ${analyse.score_similarite}/100 (${analyse.confiance})`)

    if (doitEnvoyerAlerte(analyse)) {
      console.log(`[bot] ✅ Alerte: ${analyse.pari_recommande}`)

      const alerte = {
        ...preparerAlerte(match, analyse),
        sport: match.sport,
        user: userId,
      }

      const alerteSauvegardee = await sauvegarderAlerte(alerte)

      if (alerteSauvegardee) {
        // Envoyer sur le Telegram PERSONNEL de l'utilisateur
        const envoye = await envoyerAlerte({ ...alerte, telegramChatId })

        if (envoye) {
          await fetch(
            `${process.env.POCKETBASE_URL}/api/collections/alertes_bot/records/${alerteSauvegardee.id}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', Authorization: tokenAdmin },
              body: JSON.stringify({ telegram_envoye: true }),
            }
          )
          nbAlertes++
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
