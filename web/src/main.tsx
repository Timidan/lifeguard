import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppPage } from './App';
import { Landing } from './Landing';
import './index.css';

const page = location.pathname.startsWith('/app') ? <AppPage /> : <Landing />;
createRoot(document.getElementById('root')!).render(<StrictMode>{page}</StrictMode>);
