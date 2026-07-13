// Forged Hybrid H6 — single shared inline note for surfaces that render
// AI-generated coaching, plan rationale, or recommendation prose.
// Keep the copy in ONE place so every AI surface reads identically and the
// route-scan smoke can assert it. Do NOT attach this to deterministic metrics,
// ordinary forms, or static navigation.
export const AI_GUIDANCE_TEXT = 'AI guidance — not medical advice.'

export default function AiGuidanceNote({ className = '', style }) {
  return (
    <p
      className={className}
      role="note"
      style={{
        margin: '8px 0 0',
        fontSize: 11,
        lineHeight: 1.4,
        color: 'var(--text-muted)',
        opacity: 0.85,
        ...style,
      }}
    >
      {AI_GUIDANCE_TEXT}
    </p>
  )
}
