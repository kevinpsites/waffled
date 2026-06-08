import { useEffect, useState, type ReactNode } from 'react'

// Scales the fixed 1280×800 kiosk canvas to fit the current viewport.
function computeScale(): number {
  return Math.min(window.innerWidth / 1280, window.innerHeight / 800)
}

export function KioskStage({ children }: { children: ReactNode }) {
  const [scale, setScale] = useState(1)

  useEffect(() => {
    const update = () => setScale(computeScale())
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])

  return (
    <div className="stage-wrap">
      <div className="stage" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  )
}
