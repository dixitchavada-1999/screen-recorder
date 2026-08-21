import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { log } from './services/ipc'
import './index.css'

/* Renderer-side crash reporting: both land in the shared main.log file. */
window.addEventListener('error', (event) => {
  log.error('window', event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno
  })
})

window.addEventListener('unhandledrejection', (event) => {
  log.error('window', 'Unhandled promise rejection', String(event.reason))
})

const container = document.getElementById('root')
if (!container) throw new Error('Root container is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
