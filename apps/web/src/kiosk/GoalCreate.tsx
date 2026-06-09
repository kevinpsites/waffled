// Full-screen create-a-goal flow — built in GO-R3. Placeholder route target.
import { useNavigate } from 'react-router'

export function GoalCreate() {
  const navigate = useNavigate()
  return (
    <div style={{ padding: 30 }}>
      <button className="pill" onClick={() => navigate('/goals')}>← Goals</button>
    </div>
  )
}
