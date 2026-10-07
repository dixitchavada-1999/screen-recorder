import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { QuickPanelRoot } from './pages/QuickPanel'
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

/*
 * The same bundle drives the quick panel's window too, picked by the query
 * string the main process loads it with. The panel's window is transparent so
 * its rounded corners show, which the app's solid page background would hide.
 */
const isPanel = new URLSearchParams(window.location.search).get('view') === 'panel'
if (isPanel) document.documentElement.classList.add('panel-view')

createRoot(container).render(
  <StrictMode>{isPanel ? <QuickPanelRoot /> : <App />}</StrictMode>
)
