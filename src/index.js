import './index.css'
import { initStudio } from './javascript/studio.js'

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initStudio, { once: true })
} else {
  initStudio()
}
