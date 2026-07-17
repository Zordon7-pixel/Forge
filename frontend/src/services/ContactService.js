import { Capacitor, registerPlugin } from '@capacitor/core'

const ForgeContacts = registerPlugin('ForgeContacts')

export function isContactMatchingAvailable() {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('ForgeContacts')
}

export async function readPermittedContactEmails() {
  if (!isContactMatchingAvailable()) {
    throw new Error('Contact matching requires the next TestFlight update.')
  }
  try {
    const result = await ForgeContacts.requestEmailAccess()
    return [...new Set((result?.emails || [])
      .map((email) => String(email || '').trim().toLowerCase())
      .filter(Boolean))]
  } catch (error) {
    const message = String(error?.message || error || '')
    if (/not implemented|plugin is not implemented|unavailable/i.test(message)) {
      throw new Error('Contact matching requires the next TestFlight update.')
    }
    throw error
  }
}
