# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es este proyecto

Panel de control de costos para **Jonnhys**, restaurante de comida italiana. Calcula el costo de recetas a partir de insumos, controla gastos fijos y personal, y calcula el punto de equilibrio mensual.

Toda la aplicación vive en **un solo archivo**: `index.html` (~5000 líneas, HTML + CSS + JS inline, sin dependencias ni build step). Los otros dos archivos son:

- `Code.gs` — backend de Google Apps Script (se copia/pega manualmente en el editor de Apps Script; **no se despliega desde este repo**).
- `.github/workflows/static.yml` — publica el repo completo en GitHub Pages en cada push a `main`.

Es una derivación de un panel hecho para otro local (Makyta Sushi), con la base de datos vaciada y la marca cambiada. Si algo parece heredado de un negocio de sushi, probablemente lo sea.

## Comandos

No hay build, tests, ni linter. Para desarrollar:

```bash
python3 -m http.server 8000    # luego abrir http://localhost:8000
```

Cualquier push a `main` despliega automáticamente a https://blucl.github.io/Jonnhys-Recetas/ (~1–2 min).

Para revisar sintaxis después de editar, los bloques `<script>` se pueden extraer y pasar por `node --check`; el archivo entero no es JS válido.

## Arquitectura de `index.html`

El archivo está dividido en bloques `<script>` numerados por comentarios `PART N`, cada uno con un módulo funcional. Para ubicarse rápido, buscar `PART ` o los banners `<!-- ===== -->`:

| Bloque | Contenido | Claves de localStorage |
|---|---|---|
| (HTML) | Lock screen, header, 5 pestañas, modales | — |
| Part 1 | Navegación, modales, toasts, formato CLP, **stubs** | — |
| Part 2 | Módulo Insumos | `jonnhys_insumos` |
| Part 3 | Módulo Recetas + categorías + exportaciones | `jonnhys_recetas`, `jonnhys_cat_recetas` |
| Part 4 | Gastos fijos, Personal, valor UF | `jonnhys_gastos`, `jonnhys_personal`, `jonnhys_uf` |
| Part 5 | Punto de equilibrio + facturas del mes | `jonnhys_eq_mes` |
| Part 6 | Sincronización con Google Sheets | `jonnhys_sheets_url`, `jonnhys_last_sync`, `*_ts` |
| Part 7 | Contraseña, auto-sync, configuración | `jonnhys_config` |

Las 5 pestañas son `#tab-insumos`, `#tab-recetas`, `#tab-gastos`, `#tab-equilibrio`, `#tab-config`.

### El prefijo `jonnhys_` no es cosmético

GitHub Pages sirve todos los proyectos del usuario desde el **mismo origen** (`blucl.github.io`), y `localStorage` se aísla por origen, no por ruta. Cualquier otro panel del mismo dueño alojado ahí comparte el almacén. Si una clave se renombrara a un prefijo que otro panel también use, las dos apps se pisarían los datos en el mismo navegador — incluido `sessionStorage.jonnhys_auth`, que haría que entrar a una desbloquee la otra. **Toda clave nueva debe llevar el prefijo `jonnhys_`.**

### Trampa importante: los stubs de Part 1

Part 1 termina con una lista de funciones vacías (`saveReceta()`, `exportRecetas()`, etc.) que existen para que los `onclick` del HTML no fallen antes de que carguen los bloques posteriores. Las implementaciones reales están más abajo y **ganan por hoisting de `function`**. Al modificar el comportamiento hay que editar la definición real (la última del archivo), no el stub. Buscar con `grep -n "^function nombreFn"` y quedarse con la coincidencia de mayor número de línea.

### Capa de datos

Cada módulo define su propio par `getX()` / `setX()` sobre `localStorage` con `JSON.parse` en try/catch. `getX()` devuelve `null` (no `[]`) cuando no hay nada guardado, y los llamadores hacen `getX() || DEFAULTS_X`.

En este proyecto **`DEFAULTS_INSUMOS`, `DEFAULTS_RECETAS` y `DEFAULTS_GASTOS` están vacíos a propósito**: el cliente parte de cero y no debe ver datos de muestra de otro local. El patrón `|| DEFAULTS_X` se conserva porque el resto del código lo asume; no hay que simplificarlo a `|| []` ni volver a poblar los arreglos. `DEFAULTS_CONFIG` sí tiene valores (lunes a viernes, 12:00–23:00) porque es configuración, no datos del negocio.

Part 7 envuelve `setInsumos`, `setRecetas`, `setGastos` y `setPersonal` en `window[name]` para disparar `scheduleSync()` (auto-sync con debounce de 2.5 s) en cada escritura. Si se agrega un nuevo setter que deba sincronizar, hay que añadirlo a ese array en `wrapSetters()`.

### Recetas anidadas

Un ingrediente es `{insumoId, cantidad}` **o** `{recetaId, cantidad}` (una sub-receta). `calcCostoReceta()` resuelve la cadena recursivamente y lleva un `Set` `_seen` para no colgarse si los datos tuvieran un ciclo. `recetaContieneA()` hace la comprobación inversa y se usa para impedir que una receta se incluya a sí misma. Al borrar una receta hay que limpiar las referencias `recetaId` en las demás.

El semáforo de margen (`semaforoData`) usa % de costo sobre precio: <25 % verde, 25–35 % amarillo, >35 % rojo. **El precio de venta 0 es válido** — hay recetas internas que solo sirven para controlar costos y no se cobran al cliente; las validaciones usan `precio < 0`, nunca `<= 0`.

Las categorías de recetas no tienen defaults: `syncCatsConRecetas()` las deriva de las recetas realmente guardadas. Es deliberado — los ejemplos hardcodeados reaparecían en dispositivos nuevos.

### Sincronización con Google Sheets

`SHEETS_URL` arranca **vacía a propósito**: cada negocio despliega su propio Apps Script y pega la URL en Configuración. No hay que hardcodear un endpoint por defecto — apuntar a la hoja de otro local mezclaría los datos de los dos negocios.

`syncData()` hace PUSH de todo el estado; `loadFromSheets()` hace PULL al arrancar. La resolución de conflictos es por timestamp ISO: se compara `localStorage[key + '_ts']` contra el `ts` remoto y **gana el más reciente**, clave por clave.

`SYNC_SOURCES` (Part 6) es la **fuente única** de qué claves viajan: mapea cada clave a la función que produce su valor, y de ahí salen el payload del PUSH, los timestamps, el PULL y la limpieza de `disconnectSheets()`. Para agregar una clave a la sincronización bastan **dos** cambios:

1. Sumarla a `SYNC_SOURCES` (Part 6)
2. Sumarla a `SYNC_KEYS` en `Code.gs` — y después **volver a desplegar el Apps Script** ("Implementar → Administrar implementaciones → Nueva versión"), porque el script no se actualiza solo.

Antes las cuatro listas estaban escritas a mano por separado y se desincronizaron: a la de timestamps le faltaba `jonnhys_cat_recetas`, así que tras un PUSH su `_ts` local quedaba viejo y el siguiente PULL pisaba las categorías locales aunque fueran más nuevas. Si vuelves a escribir una lista de claves a mano, reintroduces esa clase de bug.

El backend (`Code.gs`) guarda en las celdas de una hoja `_datos`, con columnas `clave | parte | partes | ts | valor`. Un valor que no cabe en una celda se parte en varias filas y se vuelve a unir al leer, así que no hay tope práctico de tamaño. Detalles que no hay que romper:

- La columna `valor` se escribe con formato `@` (texto). Sin eso, un trozo que empiece con `=` o `+` se guardaría como fórmula y corrompería el JSON.
- `doPost` toma un `LockService`: dos dispositivos sincronizando a la vez entrelazarían sus escrituras.
- `migrarSiHaceFalta_()` copia una sola vez lo que hubiera en `ScriptProperties` (donde guardaba la versión anterior) y deja esa copia como respaldo. `borrarDatosAntiguos()` la elimina, y se ejecuta a mano desde el editor.

El contrato HTTP con la app no cambió — `POST {action:'saveAll', …}` y `GET ?action=load` → `{ok, data:{clave:{value, ts}}}` —, así que el backend se puede reescribir sin tocar `index.html`.

### Autenticación

`checkPin()` compara el SHA-256 de lo ingresado (vía `crypto.subtle.digest`) contra un hash literal en el código, y guarda `sessionStorage.jonnhys_auth = '1'`. Es ofuscación del lado cliente, no seguridad real: solo evita que la contraseña sea legible en el fuente público de GitHub. **No hay que reintroducir la contraseña en texto plano**, ni moverla a un GitHub Secret con placeholder (se intentó en el proyecto original y rompió el login cuando el Secret no estaba configurado). Para cambiarla: `printf '%s' 'nueva' | sha256sum` y reemplazar el literal.

## Convenciones

- **Todo el texto de la interfaz, los comentarios y los mensajes de commit van en español.**
- Moneda: siempre vía `clp(n)` para mostrar, `fmtInput(el)` para formatear mientras se escribe y `parseInputVal(id)` para leer. Nunca parsear un input de moneda a mano — llevan separadores de miles `es-CL`.
- Ordenamientos alfabéticos con `localeCompare(x, 'es')`.
- **Visibilidad:** existe `.hidden { display: none !important }`. Usar `classList.add/remove('hidden')`; asignar `style.display` no funciona porque el `!important` lo pisa.
- Escapar siempre con `esc()` al construir HTML por `innerHTML` con datos del usuario.
- Los avisos al usuario van por `showToast(msg, type)`; los borrados por `confirmDelete(title, text, onConfirm)` (hay un `confirm()` nativo suelto en `disconnectSheets`).
- Tema oscuro: la escala `--gray-*` de `:root` está **invertida** respecto a la convención habitual — `--gray-900` es el texto más claro y `--gray-50` el fondo más oscuro.

## Dependencias externas

- `mindicador.cl/api/uf` — valor UF del día para gastos indexados. Falla en silencio y cae al último valor cacheado o a `UF_FALLBACK`.
- El Apps Script del cliente, configurable desde la app (sin valor por defecto).
