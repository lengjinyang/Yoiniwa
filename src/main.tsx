import { createRoot } from 'react-dom/client';
import App from './App';
import { PerformancePanel } from './PerformancePanel';
import './logger';
import { installTauriRefCanvasApi } from './platform/refCanvasTauri';

installTauriRefCanvasApi();

createRoot(document.getElementById('root')!).render(<><App /><PerformancePanel /></>);
