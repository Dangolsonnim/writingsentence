import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { startApp } from './app';
import { renderPrintPage } from './print';

registerSW({ immediate: true });

const root = document.getElementById('app')!;

if (location.hash === '#print') {
  void renderPrintPage(root);
} else {
  void startApp(root);
}

window.addEventListener('hashchange', () => location.reload());
