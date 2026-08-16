import { createRoot } from 'react-dom/client';
import App from './App';
import { PerformancePanel } from './app/components/PerformancePanel';
import './runtime/logger';
import { installTauriRefCanvasApi } from './platform/refCanvasTauri';

installTauriRefCanvasApi();

createRoot(document.getElementById('root')!).render(<><App /><PerformancePanel /></>);
