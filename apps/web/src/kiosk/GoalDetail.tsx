// Goal detail screen — built in GO-R4. Placeholder route target.
import { useNavigate } from 'react-router'

export function GoalDetail() {
  const navigate = useNavigate()
  return (
    <div style={{ padding: 30 }}>
      <button className="pill" onClick={() => navigate('/goals')}>← Goals</button>
    </div>
  )
}
