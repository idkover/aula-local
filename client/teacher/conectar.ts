// Página para proyectar la dirección de la clase para los alumnos: sin código de sesión, con QR grande.
import { api, ApiError } from '../common/api.js';
import { $ } from '../common/socket.js';
import './conectar.css';

const primaryEl = $<HTMLElement>('#connect-primary');
const qrEl = $<HTMLElement>('#connect-qr');
const errorEl = $<HTMLElement>('#connect-error');
const altBox = $<HTMLElement>('#connect-alt-box');
const altList = $<HTMLUListElement>('#connect-alt');

async function load(): Promise<void> {
  try {
    const info = await api.appConnect();
    const [primary, ...others] = info.urls;
    primaryEl.textContent = primary ?? 'No se encontró la dirección de la laptop';
    // SVG generado por nuestro propio servidor a partir de la dirección (igual que el QR de la sesión).
    qrEl.innerHTML = info.qrSvg;
    if (others.length > 0) {
      altList.replaceChildren(...others.map((url) => {
        const li = document.createElement('li');
        li.textContent = url;
        return li;
      }));
      altBox.hidden = false;
    }
  } catch (err) {
    primaryEl.textContent = '';
    errorEl.textContent = err instanceof ApiError ? err.message : 'No se pudo cargar la dirección.';
    errorEl.hidden = false;
  }
}

void load();
