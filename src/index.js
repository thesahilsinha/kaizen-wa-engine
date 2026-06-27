// cat > src/index.js << 'EOF'
import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { getClientConfig, masterSupabase, getClientSupabase } from './utils/supabase.js'
import { handleIncoming } from './handlers/chatbot.js'
import { runCampaign } from './handlers/campaign.js'

const app = express()
const httpServer = createServer(app)
const io = new Server(httpServer, { cors: { origin: '*' } })

app.use(cors())
app.use(express.json())

const sessions = {}
const qrStore = {}

function authGuard(req, res, next) {
  const secret = req.headers['x-engine-secret']
  if (secret !== process.env.ENGINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

async function connectClient(clientId, clientConfig, socketRoom) {
  const sessionPath = `./sessions/${clientId}`
  if (!existsSync(sessionPath)) await mkdir(sessionPath, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Kaizen WA 360', 'Chrome', '1.0.0']
  })

  // Always update sessions map with latest socket
  sessions[clientId] = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrStore[clientId] = qr
      io.to(socketRoom).emit('qr', qr)
      const supabase = getClientSupabase(clientConfig.supabase_url, clientConfig.supabase_service_key)
      await supabase.from('wa_sessions').upsert({
        session_id: clientId,
        status: 'qr_pending',
        updated_at: new Date().toISOString()
      }, { onConflict: 'session_id' })
    }

    if (connection === 'open') {
      delete qrStore[clientId]
      sessions[clientId] = sock
      io.to(socketRoom).emit('connected', { clientId })
      const supabase = getClientSupabase(clientConfig.supabase_url, clientConfig.supabase_service_key)
      await supabase.from('wa_sessions').upsert({
        session_id: clientId,
        status: 'connected',
        wa_number: sock.user?.id?.split(':')[0] || '',
        last_seen: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'session_id' })
      console.log(`✅ Client ${clientId} connected`)
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
      const supabase = getClientSupabase(clientConfig.supabase_url, clientConfig.supabase_service_key)
      await supabase.from('wa_sessions').upsert({
        session_id: clientId,
        status: 'disconnected',
        updated_at: new Date().toISOString()
      }, { onConflict: 'session_id' })
      if (reason !== DisconnectReason.loggedOut) {
        console.log(`🔄 Reconnecting ${clientId}...`)
        setTimeout(() => connectClient(clientId, clientConfig, socketRoom), 5000)
      } else {
        console.log(`❌ Client ${clientId} logged out`)
        delete sessions[clientId]
        delete qrStore[clientId]
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      if (msg.key.fromMe) continue
      const senderPhone = msg.key.remoteJid?.replace('@s.whatsapp.net', '').replace('@lid', '')
      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text || ''
      if (!text || !senderPhone) continue
      // Pass clientId and sessions map — chatbot always uses latest socket
      await handleIncoming(clientId, sessions, clientConfig, senderPhone, text)
    }
  })

  return sock
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', active_sessions: Object.keys(sessions).length })
})

app.get('/qr/:clientId', authGuard, (req, res) => {
  const { clientId } = req.params
  const sock = sessions[clientId]
  if (sock?.user) return res.json({ status: 'connected' })
  const qr = qrStore[clientId]
  if (qr) return res.json({ qr })
  return res.json({ status: 'waiting' })
})

app.post('/connect/:clientId', authGuard, async (req, res) => {
  const { clientId } = req.params
  try {
    const clientConfig = await getClientConfig(clientId)
    const socketRoom = `room_${clientId}`
    connectClient(clientId, clientConfig, socketRoom)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/disconnect/:clientId', authGuard, async (req, res) => {
  const { clientId } = req.params
  const sock = sessions[clientId]
  if (sock) { await sock.logout(); delete sessions[clientId] }
  res.json({ success: true })
})

app.get('/status/:clientId', authGuard, (req, res) => {
  const sock = sessions[req.params.clientId]
  res.json({ connected: !!sock })
})

app.post('/campaign/:clientId/:campaignId', authGuard, async (req, res) => {
  const { clientId, campaignId } = req.params
  const sock = sessions[clientId]
  if (!sock) return res.status(400).json({ error: 'Client not connected' })
  try {
    const clientConfig = await getClientConfig(clientId)
    runCampaign(clientConfig, campaignId, sock)
    res.json({ success: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

io.on('connection', (socket) => {
  socket.on('join', (clientId) => { socket.join(`room_${clientId}`) })
})

async function restoreActiveSessions() {
  const { data: clients } = await masterSupabase
    .from('master_clients')
    .select('*')
    .eq('is_active', true)
  if (!clients) return
  for (const client of clients) {
    const sessionPath = `./sessions/${client.id}`
    if (existsSync(sessionPath)) {
      console.log(`🔄 Restoring ${client.business_name}`)
      connectClient(client.id, client, `room_${client.id}`)
    }
  }
}

const PORT = process.env.PORT || 3001
httpServer.listen(PORT, async () => {
  console.log(`🚀 Kaizen WA Engine running on port ${PORT}`)
  await restoreActiveSessions()
})
// EOF