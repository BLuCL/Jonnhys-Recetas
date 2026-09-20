/**
 * Jonnhys — Apps Script (backend de Google Sheets)
 *
 * Guarda los datos en las celdas de una hoja llamada "_datos", no en
 * ScriptProperties. Ventajas: no hay tope práctico de tamaño, los datos
 * se pueden mirar y el historial de versiones de Sheets sirve de respaldo.
 *
 * INSTRUCCIONES DE DESPLIEGUE:
 * 1. Abre la planilla de este negocio → Extensiones → Apps Script
 * 2. Pega todo este código (reemplaza lo que haya)
 * 3. Guarda (Ctrl+S)
 * 4. "Implementar" → "Nueva implementación" → Aplicación web
 *    · Ejecutar como: "Yo"
 *    · Quién tiene acceso: "Cualquier usuario"
 * 5. Copia la URL (termina en /exec) y pégala en la app,
 *    en Configuración → Google Sheets
 *
 * Si ya tenías una versión anterior desplegada, usa
 * "Implementar" → "Administrar implementaciones" → editar → subir la versión.
 *
 * MIGRACIÓN: la primera vez que corre, si encuentra datos guardados por la
 * versión antigua (en ScriptProperties) los copia a la hoja automáticamente.
 * La copia antigua NO se borra: queda como respaldo. Para eliminarla una vez
 * que verifiques que todo anda bien, ejecuta a mano borrarDatosAntiguos().
 *
 * IMPORTANTE: cada negocio necesita su PROPIO proyecto de Apps Script,
 * creado desde adentro de su propia planilla. Dos negocios en el mismo
 * proyecto comparten almacenamiento y se pisan los datos.
 */

// Claves que se sincronizan entre la app y Google Sheets
const SYNC_KEYS = [
  'jonnhys_insumos',
  'jonnhys_recetas',
  'jonnhys_gastos',
  'jonnhys_personal',
  'jonnhys_config',
  'jonnhys_cat_recetas',
];

const HOJA_DATOS = '_datos';
const ENCABEZADO = ['clave', 'parte', 'partes', 'ts', 'valor'];

/* Una celda de Sheets admite unas 50.000 caracteres. Troceamos bastante
   antes de ese tope para no quedar al borde. Un valor grande simplemente
   ocupa varias filas y se vuelve a unir al leer. */
const MAX_CELDA = 30000;

/* Marca de que ya se migró desde la versión antigua */
const FLAG_MIGRADO = '_migrado_a_hoja';


/* ── POST: la app envía datos → los guardamos en la hoja ─── */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // Sin esto, dos dispositivos sincronizando a la vez pueden
    // entrelazar sus escrituras y dejar la hoja inconsistente.
    lock.waitLock(20000);

    const data = JSON.parse(e.postData.contents);
    if (data.action !== 'saveAll') {
      return respond({ ok: false, error: 'Acción desconocida' });
    }

    const sh    = hojaDatos_();
    const mapa  = leerMapa_(sh);
    const ts    = new Date().toISOString();

    SYNC_KEYS.forEach(key => {
      if (data[key] !== undefined) {
        mapa[key] = { valor: JSON.stringify(data[key]), ts: ts };
      }
    });

    escribirMapa_(sh, mapa);
    return respond({ ok: true, ts: ts });

  } catch (err) {
    return respond({ ok: false, error: err.message });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}


/* ── GET: la app pide datos → devolvemos lo guardado ─────── */
function doGet(e) {
  try {
    if (e.parameter.action !== 'load') {
      return respond({ ok: false, error: 'Acción desconocida' });
    }

    const mapa   = leerMapa_(hojaDatos_());
    const result = {};

    SYNC_KEYS.forEach(key => {
      const fila = mapa[key];
      if (fila && fila.valor) {
        result[key] = { value: JSON.parse(fila.valor), ts: fila.ts };
      }
    });

    return respond({ ok: true, data: result });

  } catch (err) {
    return respond({ ok: false, error: err.message });
  }
}


/* ── La hoja de datos, creándola si no existe ────────────── */
function hojaDatos_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(HOJA_DATOS);

  if (!sh) {
    sh = ss.insertSheet(HOJA_DATOS);
    sh.getRange(1, 1, 1, ENCABEZADO.length)
      .setValues([ENCABEZADO])
      .setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.getRange(1, 1, sh.getMaxRows(), ENCABEZADO.length).setNumberFormat('@');
  }

  migrarSiHaceFalta_(sh);
  return sh;
}


/* ── Migración única desde ScriptProperties ──────────────── */
function migrarSiHaceFalta_(sh) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(FLAG_MIGRADO)) return;

  const mapa = {};
  SYNC_KEYS.forEach(key => {
    const raw = props.getProperty(key);
    if (raw) mapa[key] = { valor: raw, ts: props.getProperty(key + '_ts') || '' };
  });

  // Solo migra si la hoja está vacía: nunca pisa datos ya escritos.
  if (Object.keys(mapa).length && sh.getLastRow() < 2) {
    escribirMapa_(sh, mapa);
  }
  props.setProperty(FLAG_MIGRADO, new Date().toISOString());
}


/* ── Leer la hoja a {clave: {valor, ts}} ─────────────────── */
function leerMapa_(sh) {
  const ultima = sh.getLastRow();
  if (ultima < 2) return {};

  const filas = sh.getRange(2, 1, ultima - 1, ENCABEZADO.length).getValues();
  const acc   = {};

  filas.forEach(f => {
    const clave = String(f[0] || '');
    if (!clave) return;
    const parte = Number(f[1]) || 1;
    if (!acc[clave]) acc[clave] = { ts: String(f[3] || ''), trozos: [] };
    acc[clave].trozos[parte - 1] = String(f[4] == null ? '' : f[4]);
  });

  const mapa = {};
  Object.keys(acc).forEach(k => {
    mapa[k] = { valor: acc[k].trozos.join(''), ts: acc[k].ts };
  });
  return mapa;
}


/* ── Reescribir la hoja completa desde el mapa ───────────── */
function escribirMapa_(sh, mapa) {
  const filas = [];
  Object.keys(mapa).forEach(clave => {
    const trozos = partir_(mapa[clave].valor);
    trozos.forEach((t, i) => {
      filas.push([clave, String(i + 1), String(trozos.length), mapa[clave].ts, t]);
    });
  });

  if (sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, ENCABEZADO.length).clearContent();
  }
  if (filas.length) {
    // Formato texto: sin esto, un trozo que empiece con "=" o "+" se
    // guardaría como fórmula y el JSON quedaría corrupto al leerlo.
    sh.getRange(2, 1, filas.length, ENCABEZADO.length)
      .setNumberFormat('@')
      .setValues(filas);
  }
}


/* ── Partir un texto largo en trozos que quepan en una celda ── */
function partir_(s) {
  s = String(s == null ? '' : s);
  if (!s) return [''];
  const out = [];
  for (let i = 0; i < s.length; i += MAX_CELDA) {
    out.push(s.substring(i, i + MAX_CELDA));
  }
  return out;
}


/* ── Limpieza opcional de la copia antigua ───────────────── */
/* Ejecútala a mano desde el editor solo cuando hayas confirmado que la
   sincronización funciona bien con la hoja. Borra los datos que quedaron
   en ScriptProperties de la versión anterior. */
function borrarDatosAntiguos() {
  const props = PropertiesService.getScriptProperties();
  SYNC_KEYS.forEach(key => {
    props.deleteProperty(key);
    props.deleteProperty(key + '_ts');
  });
  Logger.log('Copia antigua en ScriptProperties eliminada.');
}


/* ── Helper ─────────────────────────────────────────────── */
function respond(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
