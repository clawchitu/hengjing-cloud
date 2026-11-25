import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import '@fontsource/noto-sans-sc/400.css'
import '@fontsource/noto-sans-sc/500.css'
import '@fontsource/noto-sans-sc/700.css'
import '@fontsource/barlow/400.css'
import '@fontsource/barlow/500.css'
import '@fontsource/barlow/600.css'
import '@fontsource/barlow/700.css'
import './styles/tailwind.css'
import './styles/global.css'
import './styles/pages.css'
import { AppProvider } from './app/store'
import { Guard, LoginRoute } from './app/routes'
import { OrgGate } from './app/OrgGate'
import { QueryProvider } from './api/QueryProvider'
import Layout from './components/Layout'
import Home from './pages/Home'
import Groups from './pages/Groups'
import Control from './pages/Control'
import Sensors from './pages/Sensors'
import Thermostat from './pages/Thermostat'
import FreshAir from './pages/FreshAir'
import Connections from './pages/Connections'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route element={<Guard><OrgGate><Layout /></OrgGate></Guard>}>
            <Route path="/home" element={<Home />} />
            <Route path="/groups" element={<Groups />} />
            <Route path="/control" element={<Control />} />
            <Route path="/sensors" element={<Sensors />} />
            <Route path="/thermostat" element={<Thermostat />} />
            <Route path="/fresh-air" element={<FreshAir />} />
            <Route path="/connections" element={<Connections />} />
          </Route>
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Routes>
      </BrowserRouter>
    </AppProvider>
    </QueryProvider>
  </StrictMode>,
)
