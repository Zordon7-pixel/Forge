import { useEffect, useState } from 'react'
import { getCurrentWaiver } from '../lib/api'
import { getToken } from '../lib/tokenStore'

export const WAIVER_VERSION = '2026-07-07'

export const WAIVER_TEXT = `Forge Medical Disclaimer, Assumption of Risk, and Health Screening

Forge provides training plans, readiness information, activity tracking, coaching prompts, and related fitness content for general informational and wellness purposes. Forge is not medical advice, diagnosis, treatment, or a substitute for care from a qualified health professional. Consult a physician or other qualified healthcare provider before beginning or changing any exercise, running, strength training, breathwork, recovery, or nutrition program.

Physical activity has inherent risks. Running, walking, interval training, strength training, mobility work, breathwork, and other training activities can cause injury, illness, fainting, abnormal breathing responses, cardiovascular events, or death. You choose to participate voluntarily and you assume the risks of using Forge and following any training, workout, recovery, or breathwork suggestion.

Consult a doctor before using Forge if you have any of the following:
- High blood pressure.
- Heart disease, cardiovascular problems, irregular heartbeat, or a history of stroke.
- Chest pain, chest pressure, fainting, unexplained shortness of breath, or dizziness during activity.
- Epilepsy, seizures, or loss-of-consciousness episodes.
- Diabetes or blood-sugar regulation issues.
- Asthma, COPD, or other respiratory or breathing conditions.
- Aneurysm or a family history of aneurysm.
- Kidney disease.
- Pregnancy or recent childbirth.
- Recent surgery, injury, concussion, illness, infection, or hospitalization.
- Any medical condition, medication, limitation, or symptom that could affect your ability to exercise safely.

If Forge includes breathwork or breathing exercises, practice only while seated or in another safe position, never while driving, swimming, operating equipment, or in any situation where dizziness or loss of focus could cause harm. Stop immediately if you feel dizzy, faint, short of breath, numbness, tingling, pain, panic, or other discomfort.

Stop exercising and seek medical care promptly if you experience chest pain or pressure, severe shortness of breath, fainting, sudden weakness, severe headache, irregular heartbeat, severe dizziness, unusual pain, confusion, signs of allergic reaction, or any symptom that feels unsafe or concerning.

By continuing, you confirm that you have read this notice, understand that Forge is not providing medical advice, accept responsibility for deciding whether any activity is appropriate for you, and agree to stop and seek care when needed.

Forge processes account, health, fitness, device, and training information in the United States as described in the Forge Privacy Policy. By using Forge, you consent to that data processing.`

export default function ConsentWaiver({ version, text, onAgree, onCancel, loading = false }) {
  const [checked, setChecked] = useState(false)
  const [waiver, setWaiver] = useState({
    version: version || WAIVER_VERSION,
    text: text || WAIVER_TEXT
  })

  useEffect(() => {
    if (version && text) return
    if (!getToken()) return

    let active = true
    getCurrentWaiver()
      .then(({ data }) => {
        if (!active) return
        setWaiver({
          version: data?.version || WAIVER_VERSION,
          text: data?.text || WAIVER_TEXT
        })
      })
      .catch(() => {})

    return () => { active = false }
  }, [version, text])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6" style={{ background: 'rgba(0,0,0,0.78)', color: 'var(--text-primary)' }}>
      <div className="w-full max-w-[720px] rounded-2xl border p-5 shadow-xl" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}>
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Medical Disclaimer</h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>Version {waiver.version}</p>

        <div className="mt-4 max-h-[52vh] overflow-y-auto whitespace-pre-wrap rounded-xl border p-4 text-sm leading-6" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-input)', color: 'var(--text-primary)' }}>
          {waiver.text}
        </div>

        <label className="mt-4 flex items-start gap-3 text-sm" style={{ color: 'var(--text-primary)' }}>
          <input
            type="checkbox"
            className="mt-1 h-4 w-4"
            checked={checked}
            onChange={e => setChecked(e.target.checked)}
          />
          <span>I have read and agree to the medical disclaimer, assumption of risk, health screening, and data processing notice.</span>
        </label>

        <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-xl border px-4 py-3 font-semibold transition hover:opacity-90 disabled:opacity-70"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          >
            I don't agree
          </button>
          <button
            type="button"
            onClick={() => onAgree?.(waiver.version)}
            disabled={!checked || loading}
            className="rounded-xl px-4 py-3 font-semibold transition hover:opacity-90 disabled:opacity-70"
            style={{ background: 'var(--accent)', color: 'black' }}
          >
            {loading ? 'Saving...' : 'Agree & Continue'}
          </button>
        </div>
      </div>
    </div>
  )
}
