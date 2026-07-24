const BODY_LOCK_PROPERTIES = [
  'overflow',
  'position',
  'top',
  'left',
  'right',
  'width',
  'touchAction',
]

const ROOT_LOCK_PROPERTIES = [
  'overflow',
  'overscrollBehavior',
  'touchAction',
]

function captureInlineStyles(style, properties) {
  return Object.fromEntries(properties.map((property) => [property, style[property]]))
}

function restoreInlineStyles(style, snapshot) {
  Object.entries(snapshot).forEach(([property, value]) => {
    style[property] = value
  })
}

export function lockDocumentScroll({
  documentRef = document,
  windowRef = window,
} = {}) {
  const body = documentRef.body
  const root = documentRef.documentElement
  const scrollX = Number(windowRef.scrollX || windowRef.pageXOffset || 0)
  const scrollY = Number(windowRef.scrollY || windowRef.pageYOffset || 0)
  const previousBodyStyles = captureInlineStyles(body.style, BODY_LOCK_PROPERTIES)
  const previousRootStyles = captureInlineStyles(root.style, ROOT_LOCK_PROPERTIES)
  let released = false

  root.style.overflow = 'hidden'
  root.style.overscrollBehavior = 'none'
  root.style.touchAction = 'pan-y'
  body.style.overflow = 'hidden'
  body.style.position = 'fixed'
  body.style.top = `${-scrollY}px`
  body.style.left = `${-scrollX}px`
  body.style.right = '0'
  body.style.width = '100%'
  body.style.touchAction = 'pan-y'

  return () => {
    if (released) return
    released = true
    restoreInlineStyles(body.style, previousBodyStyles)
    restoreInlineStyles(root.style, previousRootStyles)
    windowRef.scrollTo(scrollX, scrollY)
  }
}
