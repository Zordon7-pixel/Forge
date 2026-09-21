import { Component, lazy, Suspense, useState } from 'react'

export class RoutePlannerBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.error('[RoutePlanner] preview failed:', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <section className="mt-4 rounded-lg border p-3" aria-label="Route planner unavailable">
        <p role="alert" className="text-sm">The route planner could not open. You can retry, start your run without a planned route, or log it manually.</p>
        <button type="button" className="mt-3 min-h-11 rounded-lg border px-3 font-bold" onClick={() => {
          this.props.onRetry()
          this.setState({ failed: false })
        }}>Retry route planner</button>
      </section>
    )
  }
}

const loadPlanner = () => lazy(() => import('./RoutePlanner'))

export default function RoutePlannerLoader(props) {
  const [Planner, setPlanner] = useState(loadPlanner)
  return (
    <RoutePlannerBoundary onRetry={() => setPlanner(() => loadPlanner())}>
      <Suspense fallback={<p className="mt-4 text-sm" role="status">Loading route planner...</p>}>
        <Planner {...props} />
      </Suspense>
    </RoutePlannerBoundary>
  )
}
