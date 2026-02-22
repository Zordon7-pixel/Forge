export function getUser() {
  const token = localStorage.getItem('forge_token')
  if (!token) return null
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch { return null }
}

export function isLoggedIn() { return !!getUser() }

export function logout() { localStorage.removeItem('forge_token') }
