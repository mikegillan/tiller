import { createRoot } from 'react-dom/client';
import { App } from './App';
import { connect } from './conn';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
connect();
