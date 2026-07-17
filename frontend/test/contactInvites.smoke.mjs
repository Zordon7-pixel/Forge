import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const community = read('src/pages/Community.jsx')
const locale = JSON.parse(read('src/locales/en.json'))

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(community.includes("useState('handle')") && community.includes("setFriendDiscoveryMode('contacts')"), 'Friends includes Handle and Contacts modes')
check(community.includes("api.post('/social/friend-invites')"), 'contact invites reuse the existing one-time private token endpoint')
check(community.includes('navigator.share({') && community.includes("t('community.inviteShareText')"), 'contact invites use the native share sheet when available')
check(community.includes('copyWithFallback(invite.url)'), 'contact invites retain a copy fallback')
check(!community.includes('navigator.contacts') && !community.includes('Contacts.getContacts'), 'the app never reads or uploads the address book')
check(locale.community.contactPrivacy.includes('never reads or uploads your address book'), 'the Contacts tab states its privacy boundary')
check(locale.community.contactInviteBody.includes('phone number or email'), 'the Contacts tab explains phone and email delivery')
check(locale.community.inviteBody.includes('works once'), 'shared friend links remain one-use')

console.log(`CONTACT INVITES SMOKE OK (${passed})`)
