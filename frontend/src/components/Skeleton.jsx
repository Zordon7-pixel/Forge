export default function Skeleton({ rows = 3 }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="card p-4">
          <div className="skeleton-shimmer h-4 w-24 rounded-full" />
          <div className="skeleton-shimmer mt-4 h-8 w-2/3 rounded-xl" />
          <div className="skeleton-shimmer mt-3 h-3 w-full rounded-full" />
          <div className="skeleton-shimmer mt-2 h-3 w-4/5 rounded-full" />
        </div>
      ))}
    </div>
  )
}
