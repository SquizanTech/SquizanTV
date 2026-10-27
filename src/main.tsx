import { createRoot } from 'react-dom/client'
import { DbProvider } from './store'
import App from './App'
import { installMockBridge } from './lib/mockBridge'
import './styles.css'

installMockBridge()

const container = document.getElementById('root')
if (!container) throw new Error('No se encontro el contenedor #root')

createRoot(container).render(
  <DbProvider>
    <App />
  </DbProvider>,
)
