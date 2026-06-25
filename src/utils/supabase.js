import { createClient } from '@supabase/supabase-js'
import ws from 'ws'

const supabaseOptions = {
  realtime: { transport: ws }
}

export const masterSupabase = createClient(
  process.env.MASTER_SUPABASE_URL,
  process.env.MASTER_SUPABASE_SERVICE_KEY,
  supabaseOptions
)

export function getClientSupabase(url, serviceKey) {
  return createClient(url, serviceKey, supabaseOptions)
}

export async function getClientConfig(clientId) {
  const { data, error } = await masterSupabase
    .from('master_clients')
    .select('*')
    .eq('id', clientId)
    .eq('is_active', true)
    .single()
  if (error) throw new Error('Client not found: ' + error.message)
  return data
}