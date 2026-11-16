import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// The report kit is only needed on its own page, so it is not in the map's bundle.
const ReportPage = lazy(() => import('./report/ReportPage.tsx'))

// The Field Report is its own page at /report/<municipality code>, so the map page is untouched
// by it and the report survives a reload or a link. Any other path is the map.
const report = window.location.pathname.match(/^\/report\/(\d+)\/?$/)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {report ? (
      <Suspense fallback={null}>
        <ReportPage code={Number(report[1])} />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
