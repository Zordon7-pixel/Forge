function focusableElements(dialog) {
  return Array.from(dialog?.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  ) || [])
}

function backgroundBranches(dialog, body) {
  const branches = []
  const seen = new Set()
  let activeBranch = dialog

  while (activeBranch?.parentElement) {
    const parent = activeBranch.parentElement
    for (const sibling of Array.from(parent.children || [])) {
      if (sibling === activeBranch || seen.has(sibling)) continue
      seen.add(sibling)
      branches.push(sibling)
    }
    if (parent === body) break
    activeBranch = parent
  }
  return branches
}

export function activateModalDialog({ dialog, onClose, documentRef = globalThis.document } = {}) {
  if (!dialog || !documentRef?.body) return () => {}

  const previousFocus = documentRef.activeElement
  const previousOverflow = documentRef.body.style.overflow
  const backgroundNodes = backgroundBranches(dialog, documentRef.body).map((node) => ({
    node,
    inert: node.inert,
    ariaHidden: node.getAttribute('aria-hidden'),
  }))

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose?.()
      return
    }
    if (event.key !== 'Tab') return

    const focusable = focusableElements(dialog)
    if (!focusable.length) {
      event.preventDefault()
      dialog.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!dialog.contains(documentRef.activeElement)) {
      event.preventDefault()
      first.focus()
    } else if (event.shiftKey && (documentRef.activeElement === first || documentRef.activeElement === dialog)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && documentRef.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  backgroundNodes.forEach(({ node }) => {
    node.inert = true
    node.setAttribute('aria-hidden', 'true')
  })
  documentRef.body.style.overflow = 'hidden'
  documentRef.addEventListener('keydown', handleKeyDown)
  dialog.focus()

  return () => {
    documentRef.body.style.overflow = previousOverflow
    documentRef.removeEventListener('keydown', handleKeyDown)
    backgroundNodes.forEach(({ node, inert, ariaHidden }) => {
      node.inert = inert
      if (ariaHidden === null) node.removeAttribute('aria-hidden')
      else node.setAttribute('aria-hidden', ariaHidden)
    })
    previousFocus?.focus?.()
  }
}
