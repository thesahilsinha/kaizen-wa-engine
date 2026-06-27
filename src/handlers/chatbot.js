// cat > src/handlers/chatbot.js << 'EOF'
import { getClientSupabase } from '../utils/supabase.js'

export async function handleIncoming(clientId, sessions, clientConfig, senderPhone, messageText) {
  console.log(`📨 Message from ${senderPhone}: ${messageText}`)
  
  try {
    // Always get LATEST socket from sessions map
    const sock = sessions[clientId]
    if (!sock) {
      console.log('❌ No active socket for client')
      return
    }

    const supabase = getClientSupabase(
      clientConfig.supabase_url,
      clientConfig.supabase_service_key
    )

    await supabase.from('messages_log').insert({
      contact_phone: senderPhone,
      direction: 'inbound',
      content: messageText,
      source: 'chatbot'
    })

    const { data: flows } = await supabase
      .from('chatbot_flows')
      .select('*')
      .eq('is_active', true)
      .order('priority', { ascending: true })

    if (!flows || flows.length === 0) return

    const text = messageText.toLowerCase().trim()
    let matched = null

    for (const flow of flows) {
      if (flow.type === 'default') {
        if (!matched) matched = flow
        continue
      }
      const kw = (flow.trigger_keyword || '').toLowerCase()
      if (!kw) continue
      const keywords = kw.split('/').map(k => k.trim())
      const hit = keywords.some(k => {
        if (flow.match_type === 'exact') return text === k
        if (flow.match_type === 'starts_with') return text.startsWith(k)
        return text.includes(k)
      })
      if (hit) { matched = flow; break }
    }

    console.log(`✅ Matched: ${matched?.reply || 'none'}`)
    if (!matched) return

    await sock.sendPresenceUpdate('composing', senderPhone + '@s.whatsapp.net')
    await new Promise(r => setTimeout(r, 1200))
    await sock.sendMessage(senderPhone + '@s.whatsapp.net', { text: matched.reply })
    console.log(`📤 Reply sent to ${senderPhone}`)

    await supabase.from('messages_log').insert({
      contact_phone: senderPhone,
      direction: 'outbound',
      content: matched.reply,
      source: 'chatbot'
    })

  } catch (e) {
    console.error('❌ Chatbot error:', e.message)
  }
}
