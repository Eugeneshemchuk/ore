import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import { Experience } from './Experience'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Experience />
  </StrictMode>,
)
