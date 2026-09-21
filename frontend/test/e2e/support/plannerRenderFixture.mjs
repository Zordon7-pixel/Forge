// Preserve Vite/Rollup's exports (including an aliased module namespace) and
// dependencies. Replacing the entire chunk with `export default` can make the
// lazy import resolve to undefined before the synthetic component ever renders.
export function injectPlannerRenderFailure(source) {
  const namespaceDefault = source.match(/default:\s*([\w$]+)\s*},\s*Symbol\.toStringTag/)
  const directDefault = source.match(/export\s+default\s+function\s+([\w$]+)/)
  const name = namespaceDefault?.[1] ?? directDefault?.[1]
  if (!name) throw new Error('Cannot identify RoutePlanner default component in built chunk')
  const escapedName = name.replace(/[$]/g, '\\$&')
  const declaration = new RegExp(`function\\s+${escapedName}\\s*\\([^)]*\\)\\s*{`, 'g')
  const matches = [...source.matchAll(declaration)]
  if (matches.length !== 1) throw new Error('Expected one RoutePlanner function declaration in built chunk')
  const offset = matches[0].index + matches[0][0].length
  return source.slice(0, offset) + `
    if (!window.syntheticPlannerReady) throw new Error('Synthetic planner render failure');
    return 'Synthetic planner recovered';
  ` + source.slice(offset)
}
