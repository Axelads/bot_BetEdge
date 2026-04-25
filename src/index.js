import cron from 'node-cron'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
dotenv.config()

import { recupererMatchsAVenir } from './collecteurCotes.js'
import {
  analyserMatch, analyserCoteAnomale,
  construirePromptSysteme, construirePromptSystemeAnomalie,
  creerRequeteBatchPattern, creerRequeteBatchAnomalie,
  idSafe, soumettreRequetesBatch, verifierStatutBatch, recupererResultatsBatch,
} from './analyseur.js'
import { calculerStats, doitEnvoyerAlerte, preparerAlerte, doitEnvoyerAlerteAnomalie, preparerAlerteAnomalie } from './comparateurPatterns.js'
import { detecterAnomaliesCotes } from './detecteurAnomalie.js'
import { envoyerAlerte, envoyerAlerteAnomalie, envoyerMessageDemarrage } from './telegram.js'

// ─── Constantes ──────────────────────────────────────────────────────────────

const ID_SUPERUSER = 'ujotze4rf8qhs9k'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CHEMIN_ETAT_BATCH = path.join(__dirname, '..', 'batch_state.json')

// ─── État Batch (fichier JSON persistant entre les crons 9h et 10h30) ────────

const lireEtatBatch = () => {
  try {
    if (!fs.existsSync(CHEMIN_ETAT_BATCH)) return null
    return JSON.parse(fs.readFileSync(CHEMIN_ETAT_BATCH, 'utf8'))
  } catch {
    return null
  }
}

const sauvegarderEtatBatch = (etat) => {
  try {
    fs.writeFileSync(CHEMIN_ETAT_BATCH, JSON.stringify(etat, null, 2), 'utf8')
  } catch (erreur) {
    console.error('[batch] Erreur sauvegarde état:', erreur.message)
  }
}

const effacerEtatBatch = () => {
  try {
    if (fs.existsSync(CHEMIN_ETAT_BATCH)) fs.unlinkSync(CHEMIN_ETAT_BATCH)
  } catch (erreur) {
    console.error('[batch] Erreur suppression état:', erreur.message)
  }
}

// ─── Pré-filtre des matchs (Priorité 3 marketing.md) ────────────────────────
// Garde uniquement les matchs dont au moins une cote est dans la plage historique
// rentable de l'Expert (1.50-3.00). Limite à 8 matchs → -33% de calls Claude.

const filtrerMatchsParCote = (matchs, coteMini = 1.50, coteMax = 3.00, limite = 8) => {
  const filtres = matchs.filter(match => {
    const cotes = Object.values(match.cotes).filter(c => c !== null && c !== undefined)
    return cotes.some(c => c >= coteMini && c <= coteMax)
  })
  return filtres.slice(0, limite)
}

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

const recupererTousParisGagnantsAggrege = async () => {
  const filtre = encodeURIComponent('statut="gagne"')
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/paris/records?filter=${filtre}&sort=-confiance,-created&perPage=500`,
    { headers: { Authorization: tokenAdmin } }
  )
  if (!reponse.ok) throw new Error(`PocketBase erreur paris gagnants agrégés: HTTP ${reponse.status}`)
  const data = await reponse.json()
  return data.items ?? []
}

const recupererTousParisTerminesAggrege = async () => {
  const filtre = encodeURIComponent('statut!="en_attente"')
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/paris/records?filter=${filtre}&sort=-created&perPage=500`,
    { headers: { Authorization: tokenAdmin } }
  )
  if (!reponse.ok) throw new Error(`PocketBase erreur paris terminés agrégés: HTTP ${reponse.status}`)
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

// ─── Cycle synchrone — analyse d'un utilisateur (cycle 18h) ──────────────────

const analyserPourAdmin = async (profil, matchsAVenir, nbUtilisateurs) => {
  const { user: userId, telegram_chat_id: telegramChatId } = profil
  console.log(`\n[bot] ── SUPERADMIN ${userId} — MODE AGGRÉGÉ ──`)
  console.log(`[bot] Chargement des paris gagnants de toute la communauté...`)

  const [parisGagnants, tousParis] = await Promise.all([
    recupererTousParisGagnantsAggrege(),
    recupererTousParisTerminesAggrege(),
  ])

  const usersRepresentes = new Set(parisGagnants.map(p => p.user).filter(Boolean))

  console.log(`[bot] ${parisGagnants.length} paris gagnants | ${tousParis.length} paris terminés | ${usersRepresentes.size} parieur(s) représenté(s)`)

  if (parisGagnants.length < 2) {
    console.log(`[bot] Pas assez de données sur la plateforme (minimum 2 paris gagnants).`)
    return 0
  }

  const stats = calculerStats(tousParis)
  console.log(`[bot] Stats agrégées — sport: ${stats.meileurSport} | type: ${stats.meilleurTypePari}`)

  let nbAlertes = 0

  for (const match of matchsAVenir) {
    // ── Piste 1 : Pattern matching agrégé ──────────────────────────────────
    const analyse = await analyserMatch(match, parisGagnants, stats, usersRepresentes.size)

    if (analyse) {
      console.log(`[bot] ${match.rencontre} → patterns ${analyse.score_similarite}/100 (${analyse.confiance})`)
    }

    if (analyse && doitEnvoyerAlerte(analyse)) {
      console.log(`[bot] ✅ Alerte patterns agrégée: ${analyse.pari_recommande}`)

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

    // ── Piste 2 : Anomalie de cotes (données agrégées) ──────────────────────
    const anomalie = detecterAnomaliesCotes(match)

    if (anomalie) {
      console.log(`[bot] 🔍 Anomalie ${match.rencontre}: "${anomalie.outcome}" +${anomalie.ecart_pourcent}% vs marché (${anomalie.bookmaker})`)

      const analyseAnomalie = await analyserCoteAnomale(match, anomalie, parisGagnants, stats, usersRepresentes.size)

      if (analyseAnomalie) {
        console.log(`[bot] ${match.rencontre} → valeur ${analyseAnomalie.score_valeur}/100 (${analyseAnomalie.confiance})`)
      }

      if (doitEnvoyerAlerteAnomalie(anomalie, analyseAnomalie)) {
        console.log(`[bot] ⚡ Alerte anomalie agrégée: ${analyseAnomalie.pari_recommande}`)

        const donneesAlertePB = {
          ...preparerAlerteAnomalie(match, anomalie, analyseAnomalie),
          sport: match.sport,
          user: userId,
        }

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

// ─── Cycle synchrone 18h — temps réel ────────────────────────────────────────

const lancerAnalyse = async () => {
  const debut = Date.now()
  console.log('\n═══════════════════════════════════════')
  console.log(`[bot] Cycle synchrone 18h — ${new Date().toLocaleString('fr-FR')}`)
  console.log('═══════════════════════════════════════')

  try {
    await authentifierPocketBase()

    const utilisateurs = await recupererUtilisateursActifs()
    console.log(`[bot] ${utilisateurs.length} utilisateur(s) actif(s) avec Telegram`)

    if (utilisateurs.length === 0) {
      console.log('[bot] Aucun utilisateur avec Telegram configuré. En attente...')
      return
    }

    const matchsAVenir = await recupererMatchsAVenir()

    // Pré-filtre : cotes 1.50-3.00, max 8 matchs → -33% de calls Claude
    const matchsFiltres = filtrerMatchsParCote(matchsAVenir)
    console.log(`[bot] Pré-filtre : ${matchsAVenir.length} → ${matchsFiltres.length} match(s) retenus (cotes 1.50-3.00, max 8)`)

    if (matchsFiltres.length === 0) {
      console.log('[bot] Aucun match dans la plage de cotes ciblée.')
      return
    }

    let nbAlertesTotal = 0
    for (const profil of utilisateurs) {
      const estAdmin = profil.user === ID_SUPERUSER
      const nb = estAdmin
        ? await analyserPourAdmin(profil, matchsFiltres, utilisateurs.length)
        : await analyserPourUtilisateur(profil, matchsFiltres)
      nbAlertesTotal += nb
    }

    const duree = ((Date.now() - debut) / 1000).toFixed(1)
    console.log(`\n[bot] Cycle 18h terminé en ${duree}s — ${nbAlertesTotal} alerte(s) envoyée(s)`)
    console.log('═══════════════════════════════════════\n')
  } catch (erreur) {
    console.error('[bot] Erreur critique dans le cycle:', erreur.message)
  }
}

// ─── Cycle batch 9h — asynchrone, -50% coût Anthropic ───────────────────────

const lancerAnalyseBatch = async () => {
  const debut = Date.now()
  console.log('\n═══════════════════════════════════════')
  console.log(`[bot] Cycle BATCH 9h — ${new Date().toLocaleString('fr-FR')}`)
  console.log('═══════════════════════════════════════')

  try {
    await authentifierPocketBase()

    const utilisateurs = await recupererUtilisateursActifs()
    console.log(`[bot] ${utilisateurs.length} utilisateur(s) actif(s) avec Telegram`)

    if (utilisateurs.length === 0) return

    const matchsAVenir = await recupererMatchsAVenir()

    // Pré-filtre : cotes 1.50-3.00, max 8 matchs
    const matchsFiltres = filtrerMatchsParCote(matchsAVenir)
    console.log(`[bot] Pré-filtre : ${matchsAVenir.length} → ${matchsFiltres.length} match(s) retenus (cotes 1.50-3.00, max 8)`)

    if (matchsFiltres.length === 0) {
      console.log('[bot] Aucun match dans la plage de cotes ciblée.')
      return
    }

    const toutesRequetes = []
    const contexte = {}

    for (const profil of utilisateurs) {
      const { user: userId, telegram_chat_id: telegramChatId } = profil
      const estAdmin = userId === ID_SUPERUSER

      const [parisGagnants, tousParis] = estAdmin
        ? await Promise.all([recupererTousParisGagnantsAggrege(), recupererTousParisTerminesAggrege()])
        : await Promise.all([recupererParisGagnantsUtilisateur(userId), recupererTousParisUtilisateur(userId)])

      if (parisGagnants.length < 2) {
        console.log(`[bot] ${userId} — Pas assez de paris gagnants, ignoré.`)
        continue
      }

      const stats = calculerStats(tousParis)
      const nbUtilisateurs = estAdmin ? new Set(parisGagnants.map(p => p.user).filter(Boolean)).size : null

      // Prompt système construit une fois par utilisateur (même pour tous ses matchs)
      const promptPattern = construirePromptSysteme(parisGagnants, stats, nbUtilisateurs)
      const promptAnomalie = construirePromptSystemeAnomalie(parisGagnants, stats, nbUtilisateurs)

      for (const match of matchsFiltres) {
        // Requête pattern matching
        const reqPattern = creerRequeteBatchPattern(match, promptPattern, userId)
        toutesRequetes.push(reqPattern)
        const { bookmakers_bruts, ...matchSansBrut } = match
        contexte[reqPattern.custom_id] = { type: 'pattern', match: matchSansBrut, userId, telegramChatId, estAdmin }

        // Requête anomalie (si détectée)
        const anomalie = detecterAnomaliesCotes(match)
        if (anomalie) {
          const reqAnomalie = creerRequeteBatchAnomalie(match, anomalie, promptAnomalie, userId)
          toutesRequetes.push(reqAnomalie)
          contexte[reqAnomalie.custom_id] = { type: 'anomalie', match: matchSansBrut, anomalie, userId, telegramChatId, estAdmin }
        }
      }

      const nbAnomalies = matchsFiltres.filter(m => detecterAnomaliesCotes(m) !== null).length
      console.log(`[bot] ${userId} — ${matchsFiltres.length} requêtes pattern + ${nbAnomalies} requêtes anomalie préparées`)
    }

    if (toutesRequetes.length === 0) {
      console.log('[bot] Aucune requête à soumettre.')
      return
    }

    const batchId = await soumettreRequetesBatch(toutesRequetes)

    if (!batchId) {
      console.error('[bot] Soumission batch échouée — bascule sur analyse synchrone')
      return lancerAnalyse()
    }

    sauvegarderEtatBatch({ batchId, soumisLe: new Date().toISOString(), contexte })

    const duree = ((Date.now() - debut) / 1000).toFixed(1)
    console.log(`\n[bot] Batch 9h soumis en ${duree}s — ${toutesRequetes.length} requête(s) | résultats vérifiés à 10h30`)
    console.log('═══════════════════════════════════════\n')
  } catch (erreur) {
    console.error('[bot] Erreur critique cycle batch:', erreur.message)
  }
}

// ─── Vérification résultats batch (10h30) ────────────────────────────────────

const verifierResultatsBatch = async () => {
  console.log('\n═══════════════════════════════════════')
  console.log(`[bot] Vérification résultats batch — ${new Date().toLocaleString('fr-FR')}`)
  console.log('═══════════════════════════════════════')

  const etat = lireEtatBatch()
  if (!etat) {
    console.log('[batch] Pas d\'état batch en cours.')
    return
  }

  const statut = await verifierStatutBatch(etat.batchId)
  console.log(`[batch] Statut batch ${etat.batchId}: ${statut}`)

  if (statut !== 'ended') {
    console.log('[batch] Batch pas encore terminé — nouvelle vérification au prochain cycle.')
    return
  }

  const resultats = await recupererResultatsBatch(etat.batchId)
  if (!resultats) {
    console.error('[batch] Impossible de récupérer les résultats.')
    effacerEtatBatch()
    return
  }

  await authentifierPocketBase()

  let nbAlertes = 0

  for (const [customId, analyse] of Object.entries(resultats)) {
    const ctx = etat.contexte[customId]
    if (!ctx) {
      console.warn(`[batch] Contexte manquant pour ${customId}`)
      continue
    }

    const { type, match, anomalie, userId, telegramChatId } = ctx

    if (type === 'pattern') {
      if (analyse) {
        console.log(`[batch] ${match.rencontre} → patterns ${analyse.score_similarite}/100 (${analyse.confiance})`)
      }

      if (analyse && doitEnvoyerAlerte(analyse)) {
        console.log(`[batch] ✅ Alerte patterns: ${analyse.pari_recommande}`)

        const alerte = { ...preparerAlerte(match, analyse), sport: match.sport, user: userId }
        const alerteSauvegardee = await sauvegarderAlerte(alerte)

        if (alerteSauvegardee) {
          const envoye = await envoyerAlerte({ ...alerte, telegramChatId, confiance: analyse.confiance })
          if (envoye) {
            await marquerAlerteTelegramEnvoyee(alerteSauvegardee.id)
            nbAlertes++
          }
        }
      }
    }

    if (type === 'anomalie') {
      if (analyse) {
        console.log(`[batch] ${match.rencontre} → valeur ${analyse.score_valeur}/100 (${analyse.confiance})`)
      }

      if (doitEnvoyerAlerteAnomalie(anomalie, analyse)) {
        console.log(`[batch] ⚡ Alerte anomalie: ${analyse.pari_recommande}`)

        const donneesAlertePB = { ...preparerAlerteAnomalie(match, anomalie, analyse), sport: match.sport, user: userId }
        const alerteAnomalie = {
          ...donneesAlertePB,
          outcome_anomalie: anomalie.outcome,
          cote_mediane: anomalie.cote_mediane,
          bookmaker_anomalie: anomalie.bookmaker,
          ecart_pourcent: anomalie.ecart_pourcent,
          confiance: analyse.confiance,
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

  effacerEtatBatch()
  console.log(`\n[batch] Traitement terminé — ${nbAlertes} alerte(s) envoyée(s)`)
  console.log('═══════════════════════════════════════\n')
}

// ─── Démarrage ────────────────────────────────────────────────────────────────

console.log('🚀 BetEdge Bot — Démarrage...')
console.log('[bot] Optimisations actives : prompt caching + batch 9h + pré-filtre cotes 1.50-3.00')

await envoyerMessageDemarrage()

// Lancer une première analyse synchrone au démarrage (pas de batch au boot)
await lancerAnalyse()

// 9h Paris (7h UTC) → batch asynchrone (-50% coût Anthropic)
// 840 req OddsAPI/mois → nécessite plan payant Basic ($39,99)
cron.schedule('0 7 * * *', () => {
  lancerAnalyseBatch()
})

// 10h30 Paris (8h30 UTC) → vérification et traitement des résultats du batch 9h
cron.schedule('30 8 * * *', () => {
  verifierResultatsBatch()
})

// 18h Paris (16h UTC) → analyse synchrone temps réel (alertes immédiates)
cron.schedule('0 16 * * *', () => {
  lancerAnalyse()
})

console.log('[bot] Crons actifs :')
console.log('  9h00  Paris → batch asynchrone (économique)')
console.log('  10h30 Paris → vérification résultats batch')
console.log('  18h00 Paris → analyse synchrone (temps réel)')
console.log('[bot] OddsAPI : 840 req/mois → plan Basic requis ($39,99/mois)')
