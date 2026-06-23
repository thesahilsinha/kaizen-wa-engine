import { getClientSupabase } from '../utils/supabase.js'

export async function handleIncoming(clientConfig, senderPhone, messageText, sock) {
  const supabase = getClientSupabase(
    clientConfig.supabase_url,
    clientConfig.supabase_service_key
  )

  // Log inbound message
  await supabase.from('messages_log').insert({
    contact_phone: senderPhone,
    direction: 'inbound',
    content: messageText,
    source: 'chatbot'
  })

  // Fetch active flows ordered by priority
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

    // Support multiple keywords separated by /
    const keywords = kw.split('/').map(k => k.trim())
    const hit = keywords.some(k => {
      if (flow.match_type === 'exact') return text === k
      if (flow.match_type === 'starts_with') return text.startsWith(k)
      return text.includes(k) // default: contains
    })

    if (hit) { matched = flow; break }
  }

  if (!matched) return

  // Simulate typing
  await sock.sendPresenceUpdate('composing', senderPhone + '@s.whatsapp.net')
  await new Promise(r => setTimeout(r, 1200))

  // Send reply
  await sock.sendMessage(senderPhone + '@s.whatsapp.net', { text: matched.reply })

  // Log outbound
  await supabase.from('messages_log').insert({
    contact_phone: senderPhone,
    direction: 'outbound',
    content: matched.reply,
    source: 'chatbot'
  })
}