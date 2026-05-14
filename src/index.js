import cron from 'node-cron'
import fetch from 'node-fetch'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
dotenv.config()

import { recupererMatchsAVenir } from './collecteurCotes.js'
import { enrichirMatchsFootball } from './enrichisseurApiFootball.js'
import { enrichirAutresSports } from './enrichisseurAutresSports.js'
import { enrichirButeurs } from './enrichisseurButeurs.js'
import {
  analyserMatch, analyserCoteAnomale, critiquerAnalyse,
  construirePromptSysteme, construirePromptSystemeAnomalie,
  creerRequeteBatchPattern, creerRequeteBatchAnomalie,
  idSafe, soumettreRequetesBatch, verifierStatutBatch, recupererResultatsBatch,
} from './analyseur.js'
import { calculerStats, doitEnvoyerAlerte, preparerAlerte, doitEnvoyerAlerteAnomalie, preparerAlerteAnomalie, appliquerCritique, filtreContexteCritique, calculerTier } from './comparateurPatterns.js'
import { detecterAnomaliesCotes } from './detecteurAnomalie.js'
import { envoyerAlerte, envoyerAlerteAnomalie, envoyerMessageDemarrage } from './telegram.js'
import { traiterReponsesTelegram } from './receptionReponses.js'

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

// ─── Plages de cotes par profil de risque ────────────────────────────────────

const PLAGES_RISQUE = {
  securite:    { min: 1.10, max: 1.80 },
  equilibre:   { min: 1.50, max: 2.50 },
  risque:      { min: 2.00, max: 4.00 },
  tres_risque: { min: 3.00, max: 20.0 },
}

// Champs de `match.cotes` qui ne sont PAS des cotes (lignes/points de référence, ou objets imbriqués)
const CHAMPS_NON_COTE = new Set([
  'ligne_totals',
  'handicap_domicile_point',
  'tt_dom_ligne',
  'tt_ext_ligne',
  'scores_exacts',  // objet imbriqué {[score]: cote}, traité à part
])

// Extrait uniquement les vraies cotes d'un match (exclut lignes/points de référence et objets).
// `scores_exacts` (objet) est aplati : on inclut ses valeurs dans la liste des cotes.
const extraireCotesReelles = (match) => {
  const cotes = []
  for (const [cle, val] of Object.entries(match.cotes ?? {})) {
    if (val == null) continue
    if (CHAMPS_NON_COTE.has(cle)) {
      if (cle === 'scores_exacts' && typeof val === 'object') {
        cotes.push(...Object.values(val).filter(v => typeof v === 'number'))
      }
      continue
    }
    if (typeof val === 'number') cotes.push(val)
  }
  return cotes
}

// Pré-filtre global (large) — réduit les appels API-Football tout en couvrant tous les profils
const filtrerMatchsGlobal = (matchs, limite = 25) => {
  return matchs
    .filter(match => {
      const cotes = extraireCotesReelles(match)
      return cotes.some(c => c >= 1.10 && c <= 20)
    })
    .slice(0, limite)
}

// Filtre par utilisateur — applique son profil de risque + ses sports + limite à 10
const filtrerMatchsUtilisateur = (matchs, prefBot, limite = 10) => {
  const plage = PLAGES_RISQUE[prefBot?.profil_risque] ?? PLAGES_RISQUE.equilibre
  const sports = prefBot?.sports?.length > 0 ? prefBot.sports : null
  return matchs
    .filter(match => {
      if (sports && !sports.includes(match.sport)) return false
      const cotes = extraireCotesReelles(match)
      return cotes.some(c => c >= plage.min && c <= plage.max)
    })
    .slice(0, limite)
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

// Essai gratuit 20 jours après inscription : on lit `users.created` via expand=user.
// Décision business 2026-05-13 (cf. post-mortem-6mois.md, Priorité 1).
const DUREE_ESSAI_JOURS = 20
const MS_ESSAI = DUREE_ESSAI_JOURS * 24 * 60 * 60 * 1000

const estEnEssai = (profil) => {
  const created = profil?.expand?.user?.created
  if (!created) return false
  const debut = new Date(created).getTime()
  if (Number.isNaN(debut)) return false
  return (Date.now() - debut) <= MS_ESSAI
}

const recupererUtilisateursActifs = async () => {
  const reponse = await fetch(
    `${process.env.POCKETBASE_URL}/api/collections/profils/records?perPage=200&expand=user`,
    { headers: { Authorization: tokenAdmin } }
  )
  if (!reponse.ok) throw new Error(`PocketBase erreur profils: HTTP ${reponse.status}`)
  const data = await reponse.json()
  return (data.items ?? []).filter(
    p => p.telegram_chat_id && (p.est_premium || estEnEssai(p))
  )
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

// ─── Analyse par utilisateur (cycle synchrone) ───────────────────────────────
// Gère tous les cas : admin, communauté, perso, préférences de risque/sport/format

const analyserPourUtilisateur = async (profil, tousMatchsAVenir) => {
  const { user: userId, telegram_chat_id: telegramChatId, preferences_bot: prefBot } = profil
  const estAdmin = userId === ID_SUPERUSER

  // Lecture des préférences (valeurs par défaut si non configuré)
  const sourceAgreee = estAdmin || prefBot?.source_donnees === 'communaute'
  const typesAnalyse = prefBot?.types_analyse ?? ['patterns', 'anomalies']
  const analyserPatterns = typesAnalyse.includes('patterns')
  const analyserAnomalies = typesAnalyse.includes('anomalies')
  const formatPari = prefBot?.format_pari ?? 'sec'

  // Filtre des matchs selon les préférences de l'utilisateur
  const matchsAVenir = filtrerMatchsUtilisateur(tousMatchsAVenir, prefBot)

  const modeLabel = estAdmin ? 'SUPERADMIN — agrégé' : sourceAgreee ? 'communauté' : 'perso'
  console.log(`\n[bot] ── ${userId} (${modeLabel}) — ${matchsAVenir.length} match(s) retenus ──`)

  // Chargement des données selon la source choisie
  const [parisGagnants, tousParis] = sourceAgreee
    ? await Promise.all([recupererTousParisGagnantsAggrege(), recupererTousParisTerminesAggrege()])
    : await Promise.all([recupererParisGagnantsUtilisateur(userId), recupererTousParisUtilisateur(userId)])

  const nbUtilisateurs = sourceAgreee
    ? new Set(parisGagnants.map(p => p.user).filter(Boolean)).size
    : null

  const parisPerdants = tousParis.filter(p => p.statut === 'perdu')

  console.log(`[bot] ${parisGagnants.length} paris gagnants | ${parisPerdants.length} perdants | ${tousParis.length} terminés${nbUtilisateurs ? ` | ${nbUtilisateurs} parieur(s)` : ''}`)

  if (parisGagnants.length < 2) {
    console.log(`[bot] Pas assez de paris gagnants (minimum 2). Passage au suivant.`)
    return 0
  }

  const stats = calculerStats(tousParis)
  console.log(`[bot] Stats — sport: ${stats.meileurSport} | type: ${stats.meilleurTypePari} | format: ${formatPari}`)

  let nbAlertes = 0
  let nbRejetesPreFiltre = 0

  for (const match of matchsAVenir) {
    // ── Pré-filtre Phase 3 — rejet AVANT tout appel Claude ─────────────────
    const motifRejet = filtreContexteCritique(match)
    if (motifRejet) {
      console.log(`[bot] ⏭️  Pré-filtre rejette ${match.rencontre} — ${motifRejet}`)
      nbRejetesPreFiltre++
      continue
    }

    // ── Piste 1 : Pattern matching ──────────────────────────────────────────
    if (analyserPatterns) {
      const analyse = await analyserMatch(match, parisGagnants, parisPerdants, stats, nbUtilisateurs, { formatPari })

      if (analyse) {
        console.log(`[bot] ${match.rencontre} → patterns ${analyse.score_similarite}/100 (${analyse.confiance})`)
      }

      if (analyse && doitEnvoyerAlerte(analyse)) {
        // Phase 2 — Critique avocat du diable (2ème passe Claude)
        const critique = await critiquerAnalyse(match, analyse, { type: 'pattern' })
        const analyseFinale = appliquerCritique(analyse, critique)

        if (!analyseFinale) {
          console.log(`[bot] ❌ Critique rejette: ${match.rencontre} — ${critique?.raison_critique ?? 'verdict rejeter'}`)
        } else if (!doitEnvoyerAlerte(analyseFinale)) {
          const probIni = Number(analyse.probabilite_estimee).toFixed(2)
          const probFin = Number(analyseFinale.probabilite_estimee).toFixed(2)
          const cote = Number(analyse.cote_suggeree).toFixed(2)
          const edgeIni = ((Number(analyse.probabilite_estimee) * Number(analyse.cote_suggeree) - 1) * 100).toFixed(1)
          const edgeFin = ((Number(analyseFinale.probabilite_estimee) * Number(analyse.cote_suggeree) - 1) * 100).toFixed(1)
          console.log(`[bot] ❌ Après ajustement critique, seuils non atteints: ${match.rencontre}`)
          console.log(`[bot]    Pari: ${analyse.pari_recommande} @ cote ${cote}`)
          console.log(`[bot]    Verdict critique: ${critique?.verdict} — "${critique?.raison_critique ?? ''}"`)
          console.log(`[bot]    Prob: ${probIni} → ${probFin} | Edge: ${edgeIni}% → ${edgeFin}% | Score: ${analyse.score_similarite} → ${analyseFinale.score_similarite} | Confiance: ${analyse.confiance} → ${analyseFinale.confiance}`)
        } else {
          const alerte = { ...preparerAlerte(match, analyseFinale), sport: match.sport, user: userId }
          const tier = calculerTier({ score: alerte.score_similarite, edge: alerte.edge_pourcent, confiance: analyseFinale.confiance })
          console.log(`[bot] ✅ Alerte patterns [${tier}] (critique=${critique?.verdict ?? 'no-op'}): ${analyseFinale.pari_recommande}`)
          const alerteSauvegardee = await sauvegarderAlerte(alerte)
          if (alerteSauvegardee) {
            const envoye = await envoyerAlerte({ ...alerte, telegramChatId, tier, confiance: analyseFinale.confiance, alerteId: alerteSauvegardee.id })
            if (envoye) { await marquerAlerteTelegramEnvoyee(alerteSauvegardee.id); nbAlertes++ }
          }
        }
      }
    }

    // ── Piste 2 : Anomalie de cotes ─────────────────────────────────────────
    if (analyserAnomalies) {
      const anomalie = detecterAnomaliesCotes(match)

      if (anomalie) {
        console.log(`[bot] Anomalie ${match.rencontre}: "${anomalie.outcome}" +${anomalie.ecart_pourcent}% vs marché (${anomalie.bookmaker})`)

        const analyseAnomalie = await analyserCoteAnomale(match, anomalie, parisGagnants, parisPerdants, stats, nbUtilisateurs)

        if (analyseAnomalie) {
          console.log(`[bot] ${match.rencontre} → valeur ${analyseAnomalie.score_valeur}/100 (${analyseAnomalie.confiance})`)
        }

        if (doitEnvoyerAlerteAnomalie(anomalie, analyseAnomalie)) {
          // Phase 2 — Critique avocat du diable (2ème passe Claude)
          const critique = await critiquerAnalyse(match, analyseAnomalie, { type: 'anomalie', anomalie })
          const analyseFinale = appliquerCritique(analyseAnomalie, critique)

          if (!analyseFinale) {
            console.log(`[bot] ❌ Critique rejette anomalie: ${match.rencontre} — ${critique?.raison_critique ?? 'verdict rejeter'}`)
          } else if (!doitEnvoyerAlerteAnomalie(anomalie, analyseFinale)) {
            console.log(`[bot] ❌ Après ajustement critique, seuils anomalie non atteints: ${match.rencontre}`)
          } else {
            const donneesAlertePB = { ...preparerAlerteAnomalie(match, anomalie, analyseFinale), sport: match.sport, user: userId }
            const tier = calculerTier({ score: donneesAlertePB.score_valeur, edge: donneesAlertePB.edge_pourcent, confiance: analyseFinale.confiance })
            console.log(`[bot] ✅ Alerte anomalie [${tier}] (critique=${critique?.verdict ?? 'no-op'}): ${analyseFinale.pari_recommande}`)
            const alerteAnomalie = {
              ...donneesAlertePB,
              outcome_anomalie: anomalie.outcome,
              cote_mediane: anomalie.cote_mediane,
              bookmaker_anomalie: anomalie.bookmaker,
              ecart_pourcent: anomalie.ecart_pourcent,
              confiance: analyseFinale.confiance,
              tier,
            }
            const alerteSauvegardee = await sauvegarderAlerte(donneesAlertePB)
            if (alerteSauvegardee) {
              const envoye = await envoyerAlerteAnomalie({ ...alerteAnomalie, telegramChatId, alerteId: alerteSauvegardee.id })
              if (envoye) { await marquerAlerteTelegramEnvoyee(alerteSauvegardee.id); nbAlertes++ }
            }
          }
        }
      }
    }
  }

  if (nbRejetesPreFiltre > 0) {
    console.log(`[bot] ${userId} — ${nbRejetesPreFiltre} match(s) écarté(s) par le pré-filtre contexte`)
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

    // Pré-filtre global large (1.10-20) — couvre tous les profils de risque, max 20 matchs
    const matchsFiltres = filtrerMatchsGlobal(matchsAVenir)
    console.log(`[bot] Pré-filtre global : ${matchsAVenir.length} → ${matchsFiltres.length} match(s) retenus`)

    if (matchsFiltres.length === 0) {
      console.log('[bot] Aucun match disponible.')
      return
    }

    // Enrichissement mutualisé (tous les utilisateurs en profitent)
    await enrichirMatchsFootball(matchsFiltres)
    await enrichirButeurs(matchsFiltres)
    await enrichirAutresSports(matchsFiltres)

    let nbAlertesTotal = 0
    for (const profil of utilisateurs) {
      const nb = await analyserPourUtilisateur(profil, matchsFiltres)
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

    // Pré-filtre global large — couvre tous les profils de risque, max 20 matchs
    const matchsFiltres = filtrerMatchsGlobal(matchsAVenir)
    console.log(`[bot] Pré-filtre global : ${matchsAVenir.length} → ${matchsFiltres.length} match(s) retenus`)

    if (matchsFiltres.length === 0) {
      console.log('[bot] Aucun match disponible.')
      return
    }

    // Enrichissement mutualisé entre tous les utilisateurs (foot + basket + hockey + rugby)
    await enrichirMatchsFootball(matchsFiltres)
    await enrichirButeurs(matchsFiltres)
    await enrichirAutresSports(matchsFiltres)

    const toutesRequetes = []
    const contexte = {}

    for (const profil of utilisateurs) {
      const { user: userId, telegram_chat_id: telegramChatId, preferences_bot: prefBot } = profil
      const estAdmin = userId === ID_SUPERUSER
      const sourceAgreee = estAdmin || prefBot?.source_donnees === 'communaute'
      const typesAnalyse = prefBot?.types_analyse ?? ['patterns', 'anomalies']
      const formatPari = prefBot?.format_pari ?? 'sec'

      // Filtre des matchs selon les préférences de l'utilisateur
      const matchsUtilisateur = filtrerMatchsUtilisateur(matchsFiltres, prefBot)

      const [parisGagnants, tousParis] = sourceAgreee
        ? await Promise.all([recupererTousParisGagnantsAggrege(), recupererTousParisTerminesAggrege()])
        : await Promise.all([recupererParisGagnantsUtilisateur(userId), recupererTousParisUtilisateur(userId)])

      if (parisGagnants.length < 2) {
        console.log(`[bot] ${userId} — Pas assez de paris gagnants, ignoré.`)
        continue
      }

      const parisPerdants = tousParis.filter(p => p.statut === 'perdu')
      const stats = calculerStats(tousParis)
      const nbUtilisateurs = sourceAgreee ? new Set(parisGagnants.map(p => p.user).filter(Boolean)).size : null

      const promptPattern = construirePromptSysteme(parisGagnants, parisPerdants, stats, nbUtilisateurs, { formatPari })
      const promptAnomalie = construirePromptSystemeAnomalie(parisGagnants, parisPerdants, stats, nbUtilisateurs)

      let nbRejetesPreFiltreBatch = 0
      for (const match of matchsUtilisateur) {
        // ── Pré-filtre Phase 3 — économise les requêtes batch ──────────────
        const motifRejet = filtreContexteCritique(match)
        if (motifRejet) {
          console.log(`[bot] ⏭️  Pré-filtre rejette ${match.rencontre} (${userId.slice(0,8)}…) — ${motifRejet}`)
          nbRejetesPreFiltreBatch++
          continue
        }

        const { bookmakers_bruts, ...matchSansBrut } = match

        if (typesAnalyse.includes('patterns')) {
          const reqPattern = creerRequeteBatchPattern(match, promptPattern, userId)
          toutesRequetes.push(reqPattern)
          contexte[reqPattern.custom_id] = { type: 'pattern', match: matchSansBrut, userId, telegramChatId }
        }

        if (typesAnalyse.includes('anomalies')) {
          const anomalie = detecterAnomaliesCotes(match)
          if (anomalie) {
            const reqAnomalie = creerRequeteBatchAnomalie(match, anomalie, promptAnomalie, userId)
            toutesRequetes.push(reqAnomalie)
            contexte[reqAnomalie.custom_id] = { type: 'anomalie', match: matchSansBrut, anomalie, userId, telegramChatId }
          }
        }
      }

      const matchsAnalyses = matchsUtilisateur.length - nbRejetesPreFiltreBatch
      const nbPatterns = typesAnalyse.includes('patterns') ? matchsAnalyses : 0
      const nbAnomalies = typesAnalyse.includes('anomalies')
        ? matchsUtilisateur.filter(m => !filtreContexteCritique(m) && detecterAnomaliesCotes(m) !== null).length
        : 0
      console.log(`[bot] ${userId} — ${nbPatterns} requêtes pattern + ${nbAnomalies} requêtes anomalie (${matchsAnalyses}/${matchsUtilisateur.length} matchs après pré-filtre)`)
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
        // Phase 2 — Critique avocat du diable (synchrone, faible volume = quelques alertes max)
        const critique = await critiquerAnalyse(match, analyse, { type: 'pattern' })
        const analyseFinale = appliquerCritique(analyse, critique)

        if (!analyseFinale) {
          console.log(`[batch] ❌ Critique rejette: ${match.rencontre} — ${critique?.raison_critique ?? 'verdict rejeter'}`)
        } else if (!doitEnvoyerAlerte(analyseFinale)) {
          console.log(`[batch] ❌ Après ajustement critique, seuils non atteints: ${match.rencontre}`)
        } else {
          const alerte = { ...preparerAlerte(match, analyseFinale), sport: match.sport, user: userId }
          const tier = calculerTier({ score: alerte.score_similarite, edge: alerte.edge_pourcent, confiance: analyseFinale.confiance })
          console.log(`[batch] ✅ Alerte patterns [${tier}] (critique=${critique?.verdict ?? 'no-op'}): ${analyseFinale.pari_recommande}`)

          const alerteSauvegardee = await sauvegarderAlerte(alerte)

          if (alerteSauvegardee) {
            const envoye = await envoyerAlerte({ ...alerte, telegramChatId, tier, confiance: analyseFinale.confiance, alerteId: alerteSauvegardee.id })
            if (envoye) {
              await marquerAlerteTelegramEnvoyee(alerteSauvegardee.id)
              nbAlertes++
            }
          }
        }
      }
    }

    if (type === 'anomalie') {
      if (analyse) {
        console.log(`[batch] ${match.rencontre} → valeur ${analyse.score_valeur}/100 (${analyse.confiance})`)
      }

      if (doitEnvoyerAlerteAnomalie(anomalie, analyse)) {
        // Phase 2 — Critique avocat du diable
        const critique = await critiquerAnalyse(match, analyse, { type: 'anomalie', anomalie })
        const analyseFinale = appliquerCritique(analyse, critique)

        if (!analyseFinale) {
          console.log(`[batch] ❌ Critique rejette anomalie: ${match.rencontre} — ${critique?.raison_critique ?? 'verdict rejeter'}`)
        } else if (!doitEnvoyerAlerteAnomalie(anomalie, analyseFinale)) {
          console.log(`[batch] ❌ Après ajustement critique, seuils anomalie non atteints: ${match.rencontre}`)
        } else {
          const donneesAlertePB = { ...preparerAlerteAnomalie(match, anomalie, analyseFinale), sport: match.sport, user: userId }
          const tier = calculerTier({ score: donneesAlertePB.score_valeur, edge: donneesAlertePB.edge_pourcent, confiance: analyseFinale.confiance })
          console.log(`[batch] ⚡ Alerte anomalie [${tier}] (critique=${critique?.verdict ?? 'no-op'}): ${analyseFinale.pari_recommande}`)

          const alerteAnomalie = {
            ...donneesAlertePB,
            outcome_anomalie: anomalie.outcome,
            cote_mediane: anomalie.cote_mediane,
            bookmaker_anomalie: anomalie.bookmaker,
            ecart_pourcent: anomalie.ecart_pourcent,
            confiance: analyseFinale.confiance,
            tier,
          }

          const alerteSauvegardee = await sauvegarderAlerte(donneesAlertePB)

          if (alerteSauvegardee) {
            const envoye = await envoyerAlerteAnomalie({ ...alerteAnomalie, telegramChatId, alerteId: alerteSauvegardee.id })
            if (envoye) {
              await marquerAlerteTelegramEnvoyee(alerteSauvegardee.id)
              nbAlertes++
            }
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
console.log('[bot] Optimisations actives : prompt caching + batch 9h + pré-filtre cotes + 2 cycles/jour')
console.log('[bot] Marchés OddsAPI : h2h+totals+spreads (3 crédits/appel — endpoint bulk ne supporte plus les marchés foot avancés depuis 2026-05-14)')
console.log('[bot] OddsAPI : max 25 compétitions × 2 cycles × ~6.5 marchés ≈ 10500 crédits/mois (plan $30/mois = 20k crédits)')
console.log('[bot] Buteurs (top 5 ligues UE) : OddsAPI /events/{id}/odds — 10 crédits/match × ~5-10 matchs/cycle × 2 ≈ 3000-6000 crédits/mois')
console.log('[bot] Passeurs décisifs (top 5 ligues UE) : API-Football /odds — ~10-20 req/jour additionnels (plan Free 100/jour)')

await envoyerMessageDemarrage()

// PAS d'analyse au démarrage — évite les requêtes OddsAPI imprévues à chaque redémarrage Koyeb

// Trigger manuel : `node src/index.js --force-cycle` lance immédiatement un cycle synchrone
// puis exit. Utile en local pour tester un fix entre 2 crons. À NE PAS activer sur Koyeb.
if (process.argv.includes('--force-cycle')) {
  console.log('[bot] --force-cycle détecté → lancement immédiat du cycle synchrone')
  await lancerAnalyse()
  process.exit(0)
}

// 9h Paris (7h UTC) → cycle BATCH (-50% coût Anthropic, résultats traités à 10h30)
cron.schedule('0 7 * * *', () => {
  lancerAnalyseBatch()
})

// 10h30 Paris (8h30 UTC) → vérification des résultats du batch 9h
cron.schedule('30 8 * * *', () => {
  verifierResultatsBatch()
})

// 18h Paris (16h UTC) → analyse synchrone temps réel (matchs du soir)
cron.schedule('0 16 * * *', () => {
  lancerAnalyse()
})

// Toutes les 5 min (8h-23h Paris) → lecture des réponses OUI/NON aux alertes Telegram
cron.schedule('*/5 6-21 * * *', () => {
  traiterReponsesTelegram()
})

console.log('[bot] Crons actifs :')
console.log('  09h00 Paris → cycle batch asynchrone (-50% coût Claude)')
console.log('  10h30 Paris → vérification résultats batch + envoi alertes')
console.log('  18h00 Paris → cycle synchrone temps réel (matchs du soir)')
console.log('  */5   Paris (8h-23h) → lecture réponses OUI/NON Telegram')
