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

const recupererParisGagnants = async () => {
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/paris/records?filter=statut%3D%22gagne%22&sort=-created&perPage=50`,
    {
      headers: { Authorization: tokenAdmin },
    }
  )

  if (!reponse.ok) throw new Error(`PocketBase erreur: HTTP ${reponse.status}`)

  const data = await reponse.json()
  return data.items ?? []
}

const recupererTousParis = async () => {
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/paris/records?filter=statut!%3D%22en_attente%22&sort=-created&perPage=200`,
    {
      headers: { Authorization: tokenAdmin },
    }
  )

  if (!reponse.ok) throw new Error(`PocketBase erreur: HTTP ${reponse.status}`)

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

const lancerAnalyse = async () => {
  const debut = Date.now()
  console.log('\n═══════════════════════════════════════')
  console.log(`[bot] Cycle d'analyse — ${new Date().toLocaleString('fr-FR')}`)
  console.log('═══════════════════════════════════════')

  try {
    // 1. Authentification PocketBase
    await authentifierPocketBase()

    // 2. Récupération des données de l'Expert
    const [parisGagnants, tousParis] = await Promise.all([
      recupererParisGagnants(),
      recupererTousParis(),
    ])

    console.log(`[bot] ${parisGagnants.length} paris gagnants | ${tousParis.length} paris terminés`)

    if (parisGagnants.length < 3) {
      console.log('[bot] Pas assez de paris gagnants pour analyser (minimum 3). En attente...')
      return
    }

    // 3. Calcul des stats de l'Expert
    const stats = calculerStats(tousParis)
    console.log(`[bot] Stats — meilleur sport: ${stats.meileurSport} | meilleur type: ${stats.meilleurTypePari}`)

    // 4. Récupération des matchs à venir
    const matchsAVenir = await recupererMatchsAVenir()

    if (matchsAVenir.length === 0) {
      console.log('[bot] Aucun match à analyser dans les 24h.')
      return
    }

    // 5. Analyse de chaque match
    let nbAlertes = 0

    for (const match of matchsAVenir) {
      console.log(`\n[bot] Analyse: ${match.rencontre}...`)

      const analyse = await analyserMatch(match, parisGagnants, stats)

      if (!analyse) {
        console.log(`[bot] → Analyse impossible (erreur API)`)
        continue
      }

      console.log(`[bot] → Score: ${analyse.score_similarite}/100 | Confiance: ${analyse.confiance}`)

      if (doitEnvoyerAlerte(analyse)) {
        console.log(`[bot] → ✅ Alerte déclenchée! ${analyse.pari_recommande}`)

        // Préparer et sauvegarder l'alerte
        const alerte = {
          ...preparerAlerte(match, analyse),
          sport: match.sport,
        }

        const alerteSauvegardee = await sauvegarderAlerte(alerte)

        if (alerteSauvegardee) {
          // Envoyer sur Telegram
          const envoye = await envoyerAlerte(alerte)

          if (envoye) {
            // Marquer comme envoyé dans PocketBase
            await fetch(
              `${process.env.POCKETBASE_URL}/api/collections/alertes_bot/records/${alerteSauvegardee.id}`,
              {
                method: 'PATCH',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: tokenAdmin,
                },
                body: JSON.stringify({ telegram_envoye: true }),
              }
            )
            nbAlertes++
          }
        }
      } else {
        console.log(`[bot] → ❌ Score insuffisant ou confiance faible`)
      }
    }

    const duree = ((Date.now() - debut) / 1000).toFixed(1)
    console.log(`\n[bot] Cycle terminé en ${duree}s — ${nbAlertes} alerte(s) envoyée(s)`)
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
