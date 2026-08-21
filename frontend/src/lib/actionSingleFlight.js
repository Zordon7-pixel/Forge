export function createActionSingleFlight() {
  let claimed = false

  return async function runAction(action) {
    if (claimed) return false
    claimed = true
    try {
      await action()
      return true
    } finally {
      claimed = false
    }
  }
}
