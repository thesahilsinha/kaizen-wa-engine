import { createClient } from '@supabase/supabase-js'

// Master DB client (your Supabase)
export const masterSupabase = createClient(
  process.env.MASTER_SUPABASE_URL,
  process.env.MASTER_SUPABASE_SERVICE_KEY
)

// Dynamically create client Supabase per client
export function getClientSupabase(url, serviceKey) {
  return createClient(url, serviceKey)
}

// Fetch client config from master DB by clientId
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