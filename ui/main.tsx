import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './conn';
import './theme.css';
import './layout.css';
import './sidebar.css';
import './controls.css';
import './activity.css';

createRoot(document.getElementById('root')!).render(<App />);
connect();
