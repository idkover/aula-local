// Empaqueta aula-local para Windows: compila, prepara build/win/stage, prueba el servidor y genera el instalador.
// Uso: npm run package:win   (opcional: variable ISCC con la ruta a ISCC.exe)
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escribirIco } from '../packaging/windows/make-icon.mjs';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WIN = path.join(RAIZ, 'packaging', 'windows');
const BUILD = path.join(RAIZ, 'build', 'win');
const STAGE = path.join(BUILD, 'stage');
const APP = path.join(STAGE, 'app');
const PUERTO_PRUEBA = 3955;
const ISCC_POR_DEFECTO = 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe';
const TOTAL_PASOS = 6;

class ErrorEmpaquetado extends Error {}

const fallar = (mensaje) => { throw new ErrorEmpaquetado(mensaje); };
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const esperar = (ms) => new Promise((resolver) => { setTimeout(resolver, ms).unref(); });
const paso = (n, texto) => console.log(`\n[${n}/${TOTAL_PASOS}] ${texto}`);

// Ejecuta un comando de shell fijo (npm). Un solo string, sin argumentos separados, para evitar avisos de Node.
function ejecutarShell(comando, cwd) {
  const r = spawnSync(comando, { cwd, shell: true, stdio: 'inherit' });
  if (r.error) fallar(`No se pudo ejecutar "${comando}": ${r.error.message}`);
  if (r.status !== 0) fallar(`"${comando}" terminó con código ${r.status}.`);
}

// Tamaño total de una carpeta (en bytes), recorriendo subcarpetas.
function tamanoCarpeta(ruta) {
  let total = 0;
  for (const ent of readdirSync(ruta, { withFileTypes: true })) {
    const hijo = path.join(ruta, ent.name);
    if (ent.isDirectory()) total += tamanoCarpeta(hijo);
    else if (ent.isFile()) total += statSync(hijo).size;
  }
  return total;
}

// Recorre archivos bajo `dir`; `saltar(ruta)` permite omitir subcarpetas enteras.
function recorrerArchivos(dir, visitar, saltar = () => false) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const ruta = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!saltar(ruta)) recorrerArchivos(ruta, visitar, saltar);
    } else if (ent.isFile()) {
      visitar(ruta);
    }
  }
}

// Espera a que el servidor de prueba responda 200 en /api/pin/status (máximo 20 s).
async function esperarServidor(base, hijo) {
  const limite = Date.now() + 20_000;
  while (Date.now() < limite) {
    if (hijo.exitCode !== null) return false;
    try {
      const r = await fetch(`${base}/api/pin/status`, { signal: AbortSignal.timeout(1000) });
      await r.text();
      if (r.status === 200) return true;
    } catch {
      // Todavía no escucha: se reintenta.
    }
    await esperar(300);
  }
  return false;
}

// Arranca el servidor empaquetado, comprueba que responde, pide el apagado y verifica que sale.
async function pruebaHumo() {
  const node = path.join(STAGE, 'node', 'node.exe');
  const script = path.join(APP, 'dist', 'server', 'index.js');
  const datos = mkdtempSync(path.join(os.tmpdir(), 'aula-humo-'));
  const token = randomBytes(24).toString('hex');
  const base = `http://127.0.0.1:${PUERTO_PRUEBA}`;
  const salida = [];

  const hijo = spawn(node, [script], {
    cwd: APP,
    env: {
      ...process.env,
      PORT: String(PUERTO_PRUEBA),
      AULA_DATA_DIR: datos,
      AULA_SHUTDOWN_TOKEN: token,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const recoger = (trozo) => salida.push(trozo.toString('utf8'));
  hijo.stdout.on('data', recoger);
  hijo.stderr.on('data', recoger);
  const terminado = new Promise((resolver) => hijo.once('exit', (codigo) => resolver(codigo)));

  try {
    if (!(await esperarServidor(base, hijo))) {
      fallar(`El servidor no respondió 200 en /api/pin/status en 20 s.\n${salida.join('')}`);
    }
    console.log('  El servidor responde 200.');

    const apagado = await fetch(`${base}/api/app/shutdown`, {
      method: 'POST',
      headers: { 'X-Aula-Token': token },
      signal: AbortSignal.timeout(5000),
    });
    await apagado.text();
    if (apagado.status !== 202) fallar(`El apagado respondió ${apagado.status} (se esperaba 202).`);

    const codigo = await Promise.race([terminado, esperar(10_000).then(() => 'tiempo')]);
    if (codigo === 'tiempo') fallar(`El servidor no terminó en 10 s tras pedir el apagado.\n${salida.join('')}`);
    if (codigo !== 0) fallar(`El servidor terminó con código ${codigo}.\n${salida.join('')}`);
    console.log('  Apagado correcto (202 y salida con código 0).');
  } catch (err) {
    if (err instanceof ErrorEmpaquetado) throw err;
    fallar(`Fallo en la prueba del servidor: ${err.message}\n${salida.join('')}`);
  } finally {
    if (hijo.exitCode === null) {
      hijo.kill('SIGKILL');
      await Promise.race([terminado, esperar(5000)]);
    }
    try {
      rmSync(datos, { recursive: true, force: true });
    } catch (err) {
      console.warn(`  AVISO: no se pudo borrar ${datos}: ${err.message}`);
    }
  }
}

// Quita lo que no se usa en tiempo de ejecución. Devuelve la lista de lo borrado.
function limpiarStage() {
  const quitados = [];
  const nodeModules = path.join(APP, 'node_modules');
  const pdfjs = path.join(nodeModules, 'pdfjs-dist');
  const quitar = (ruta) => {
    const relativa = path.relative(STAGE, ruta).split(path.sep).join('/');
    const bytes = statSync(ruta).isDirectory() ? tamanoCarpeta(ruta) : statSync(ruta).size;
    rmSync(ruta, { recursive: true, force: true });
    quitados.push({ relativa, bytes });
  };

  // 1. Mapas de origen del servidor y del cliente.
  recorrerArchivos(path.join(APP, 'dist'), (archivo) => {
    if (archivo.endsWith('.map')) quitar(archivo);
  });

  // 2. Documentación de paquetes npm (los LICENSE se conservan). pdfjs-dist no se toca.
  recorrerArchivos(nodeModules, (archivo) => {
    const nombre = path.basename(archivo);
    if (/\.md$/i.test(nombre) && !/^licen[cs]e/i.test(nombre)) quitar(archivo);
  }, (carpeta) => carpeta === pdfjs);

  // 3. Carpetas de pruebas justo bajo la raíz de cada paquete (no dentro de pdfjs-dist).
  const raicesPaquete = [];
  for (const ent of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('@')) {
      for (const sub of readdirSync(path.join(nodeModules, ent.name), { withFileTypes: true })) {
        if (sub.isDirectory()) raicesPaquete.push(path.join(nodeModules, ent.name, sub.name));
      }
    } else {
      raicesPaquete.push(path.join(nodeModules, ent.name));
    }
  }
  for (const raiz of raicesPaquete) {
    if (raiz === pdfjs) continue;
    for (const nombre of ['test', 'tests', '__tests__']) {
      const carpeta = path.join(raiz, nombre);
      if (existsSync(carpeta) && statSync(carpeta).isDirectory()) quitar(carpeta);
    }
  }

  return quitados;
}

async function main() {
  // 1. Versión.
  paso(1, 'Leyendo la versión de package.json');
  const pkg = JSON.parse(readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const version = pkg.version;
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) fallar(`La versión "${version}" no tiene formato x.y.z.`);
  console.log(`  aula-local ${version}`);

  // 2. Compilación.
  paso(2, 'Compilando (npm run build)');
  ejecutarShell('npm run build', RAIZ);
  for (const requerido of [path.join(RAIZ, 'dist', 'server', 'index.js'), path.join(RAIZ, 'dist', 'client')]) {
    if (!existsSync(requerido)) fallar(`Falta ${requerido} tras la compilación.`);
  }

  // 3. Preparación del stage.
  paso(3, 'Preparando build/win/stage');
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(APP, { recursive: true });

  const pkgProduccion = { ...pkg };
  delete pkgProduccion.devDependencies;
  delete pkgProduccion.scripts;
  writeFileSync(path.join(APP, 'package.json'), `${JSON.stringify(pkgProduccion, null, 2)}\n`);
  copyFileSync(path.join(RAIZ, 'package-lock.json'), path.join(APP, 'package-lock.json'));
  cpSync(path.join(RAIZ, 'dist'), path.join(APP, 'dist'), { recursive: true });
  console.log('  Copiados package.json, package-lock.json y dist/.');

  console.log('  Instalando solo dependencias de producción (npm ci --omit=dev)...');
  ejecutarShell('npm ci --omit=dev --no-audit --no-fund', APP);
  const canvasWindows = path.join(APP, 'node_modules', '@napi-rs', 'canvas-win32-x64-msvc');
  if (!existsSync(canvasWindows)) {
    fallar('Falta node_modules/@napi-rs/canvas-win32-x64-msvc en el stage: sin él el canvas no funciona en Windows.');
  }

  const antes = tamanoCarpeta(STAGE);
  console.log('  Limpiando archivos innecesarios:');
  const quitados = limpiarStage();
  for (const { relativa, bytes } of quitados) console.log(`    - ${relativa} (${(bytes / 1024).toFixed(1)} KB)`);
  const liberado = quitados.reduce((suma, q) => suma + q.bytes, 0);
  console.log(`  Quitados ${quitados.length} elementos, ${mb(liberado)} (tamaño antes de limpiar: ${mb(antes)}).`);

  console.log('  Copiando Node.js...');
  mkdirSync(path.join(STAGE, 'node'), { recursive: true });
  copyFileSync(process.execPath, path.join(STAGE, 'node', 'node.exe'));
  // La licencia de Node.js viaja con su node.exe. NODE-LICENSE.txt es la de v24.15.0
  // (github.com/nodejs/node/blob/v24.15.0/LICENSE): al cambiar de Node, reemplázala por la de esa versión.
  const licenciaNode = [path.join(path.dirname(process.execPath), 'LICENSE'), path.join(WIN, 'NODE-LICENSE.txt')].find(existsSync);
  if (!licenciaNode) fallar('Falta la licencia de Node.js (packaging/windows/NODE-LICENSE.txt).');
  if (process.version !== 'v24.15.0' && licenciaNode.endsWith('NODE-LICENSE.txt')) {
    console.warn(`  AVISO: NODE-LICENSE.txt es de v24.15.0 y se empaqueta ${process.version}; actualízala.`);
  }
  copyFileSync(licenciaNode, path.join(STAGE, 'node', 'LICENSE'));

  console.log('  Generando el icono...');
  escribirIco(path.join(STAGE, 'aula-local.ico'));

  console.log('  Compilando el lanzador (build.ps1)...');
  const resultado = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(WIN, 'launcher', 'build.ps1'),
    '-OutDir', STAGE,
    '-Icon', path.join(STAGE, 'aula-local.ico'),
  ], { stdio: 'inherit', windowsHide: true });
  if (resultado.error) fallar(`No se pudo ejecutar PowerShell: ${resultado.error.message}`);
  if (resultado.status !== 0) fallar(`build.ps1 terminó con código ${resultado.status}.`);

  copyFileSync(path.join(WIN, 'LICENSES.txt'), path.join(STAGE, 'LICENSES.txt'));
  copyFileSync(path.join(RAIZ, 'LICENSE'), path.join(STAGE, 'LICENSE.txt'));

  for (const requerido of ['aula-local.exe', 'aula-local.ico', path.join('node', 'node.exe'), path.join('app', 'dist', 'server', 'index.js')]) {
    if (!existsSync(path.join(STAGE, requerido))) fallar(`Falta ${requerido} en el stage.`);
  }
  console.log(`  Tamaño del stage: ${mb(tamanoCarpeta(STAGE))}`);

  // 4. Prueba de humo del servidor empaquetado.
  paso(4, 'Prueba del servidor empaquetado');
  await pruebaHumo();

  // 5. Instalador.
  paso(5, 'Generando el instalador (Inno Setup)');
  const iscc = process.env.ISCC || ISCC_POR_DEFECTO;
  if (!existsSync(iscc)) fallar(`No se encontró ISCC.exe en "${iscc}". Instala Inno Setup 6 o define la variable ISCC.`);
  mkdirSync(BUILD, { recursive: true });
  const iss = path.join(WIN, 'aula-local.iss');
  const inno = spawnSync(iscc, [
    `/DAppVersion=${version}`,
    `/DStageDir=${STAGE}`,
    `/DOutputDir=${BUILD}`,
    iss,
  ], { encoding: 'utf8', windowsHide: true });
  process.stdout.write(inno.stdout ?? '');
  process.stderr.write(inno.stderr ?? '');
  if (inno.error) fallar(`No se pudo ejecutar ISCC: ${inno.error.message}`);
  if (inno.status !== 0) fallar(`ISCC terminó con código ${inno.status}.`);

  // 6. Resultado.
  paso(6, 'Resultado');
  const instalador = path.join(BUILD, `aula-local-setup-${version}.exe`);
  if (!existsSync(instalador)) fallar(`No se generó ${instalador}.`);
  console.log(`  Instalador: ${instalador}`);
  console.log(`  Tamaño del instalador: ${mb(statSync(instalador).size)}`);
  console.log(`  Tamaño del stage: ${mb(tamanoCarpeta(STAGE))}`);
}

main().catch((err) => {
  if (err instanceof ErrorEmpaquetado) {
    console.error(`\nERROR: ${err.message}`);
  } else {
    console.error('\nERROR inesperado:', err);
  }
  process.exit(1);
});
