import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Recharts from 'recharts';
import PipeHealthDashboard from './App';

window.React = React;
window.Recharts = Recharts;

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<PipeHealthDashboard />);