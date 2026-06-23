import { getClientSupabase } from '../utils/supabase.js'
import { sendWithDelay } from '../utils/queue.js'

export async function runCampaign(clientConfig, campaignId, sock) {
  const supabase = getClientSupabase(
    clientConfig.supabase_url,
    clientConfig.supabase_service_key
  )

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single()

  if (!campaign) throw new Error('Campaign not found')

  // Fetch contacts (filtered by tag if set)
  let query = supabase.from('contacts').select('*').eq('opted_out', false)
  if (campaign.target_tags && campaign.target_tags.length > 0) {
    query = query.overlaps('tags', campaign.target_tags)
  }
  const { data: contacts } = await query

  if (!contacts || contacts.length === 0) return

  // Respect daily limit
  const toSend = contacts.slice(0, campaign.daily_limit - campaign.sent_count)

  // Mark running
  await supabase.from('campaigns').update({ status: 'running' }).eq('id', campaignId)

  await sendWithDelay(toSend, (campaign.delay_seconds || 10) * 1000, async (contact) => {
    const message = campaign.message_template.replace('{{name}}', contact.name || '')
    try {
      await sock.sendMessage(contact.phone + '@s.whatsapp.net', { text: message })
      await supabase.from('messages_log').insert({
        contact_phone: contact.phone,
        direction: 'outbound',
        content: message,
        source: 'campaign',
        campaign_id: campaignId,
        status: 'sent'
      })
      await supabase.from('campaigns')
        .update({ sent_count: campaign.sent_count + 1 })
        .eq('id', campaignId)
    } catch (e) {
      console.error('Failed to send to', contact.phone, e.message)
    }
  })

  await supabase.from('campaigns').update({ status: 'done' }).eq('id', campaignId)
}