# AGENTS.md — Guía Agéntica de Arquitectura y Mantenimiento (`Somos Valle 2026`)

Este documento contiene todo el contexto técnico, hallazgos de ingeniería inversa, arquitectura híbrida y flujos de despliegue necesarios para que cualquier agente de IA pueda entender, mantener e iterar autónomamente el proyecto **Somos Valle 2026**.

---

## 1. Contexto y Objetivo del Proyecto

- **Propósito**: Aplicación web interactiva (SPA) para el seguimiento en tiempo real de todos los grupos de la liga de **Escuelas Católicas de Madrid (ECM)** en la temporada **2026-2027**.
- **Deporte**: Fútbol Sala (`IdDeporte = 2`)
- **Competición / Categoría**: Prebenjamín Mixto (`IdCompeticion = 111`, `IdCategoria = 300`, `IdTemporada = 12`)
- **Equipo destacado**: `EL VALLE SANCHINARRO "B"` (`IdEquipo = 1068`), encuadrado en el **Grupo 2** (`IdGrupo = 160`).
- **Comportamiento de inicio**:
  - La aplicación abre siempre por defecto en la sección **⚽ Resultados**, con el **GRUPO 2 ★** seleccionado y posicionado en la **siguiente jornada a disputar**.
  - Todos los equipos de cualquier vista (*Resultados*, *Clasificación*, *Estadísticas*, *Previsión de Fase 2*, *Calendario*) son clicables y abren el calendario completo del equipo seleccionado.
- **Secciones (`?page=`)**: `resultados`, `clasificacion`, `estadisticas`, `fase2` (+ `?team=` y `?group=`).
- **📊 Estadísticas**: calculadas 100% en cliente por [`computeStats(scope)`](file:///Users/israelvinualeslopez/sources/Index.html) (`scope = 0` → Global Liga, `1..8` → grupo). Incluye KPIs (goles/partido, % local, % empates, mayor goleada), rankings (ataque, defensa, casa, fuera — con fila extra de El Valle B si no está en el top), rachas con forma de últimos 5 (`G/E/P`) y comparador Cara a Cara con enfrentamientos directos. Puntos casa/fuera y forma se derivan de los partidos jugados (`jugado && golesLocalNum != null`).
- **Responsive**: media queries `768px` / `576px` en `Index.html`; pestañas de sección, grupos y jornadas son carruseles horizontales con auto-centrado del elemento activo (`scrollActiveTabsIntoView`).

---

## 2. Estructura de Archivos del Repositorio

```text
/Users/israelvinualeslopez/sources/
├── AGENTS.md                        # Documentación agéntica de arquitectura y mantenimiento
├── plan.md                          # Plan de desarrollo e historial de iteraciones
├── Código.js                        # Backend de Google Apps Script (scraper paralelo ECM, normalizador, caché y API JSON)
├── Index.html                       # Frontend SPA híbrido (compatible con HtmlService de GAS y con GitHub Pages estático)
├── appsscript.json                  # Manifiesto de Google Apps Script (Europe/Madrid, ANYONE_ANONYMOUS)
├── .claspignore                     # Whitelist para que `clasp push` solo suba appsscript.json, Código.js e Index.html
├── .gitignore                       # Ignora .clasp.json, node_modules y .DS_Store en Git
├── fase2-reglas.png                 # Captura oficial de las reglas de distribución de grupos para la Fase 2
├── scripts/
│   └── update-data.mjs              # Script Node.js que ejecuta Código.js en una VM para generar docs/data.json y docs/index.html
├── docs/                            # Directorio publicado en GitHub Pages (rama main -> /docs)
│   ├── index.html                   # Copia generada de Index.html
│   ├── 404.html                     # Copia de Index.html para enrutamiento SPA
│   └── data.json                    # Snapshot precalculado con todos los grupos, jornadas, clasificaciones y Fase 2
└── .github/
    └── workflows/
        └── pages.yml                # GitHub Action que actualiza docs/data.json contra ECM cada 6 horas
```

---

## 3. Ingeniería Inversa de la Plataforma ECM (`juegosdeportivos.ecmadrid.org`)

La plataforma web de ECM está construida en **ASP.NET MVC** y expone tanto controladores Web API (`/api/...`) como controladores MVC que devuelven JSON doblemente serializado.

### 3.1. Identificadores Clave (Temporada 2026-2027)
| Concepto | Parámetro | Valor | Notas |
| :--- | :--- | :--- | :--- |
| Temporada 2026-2027 | `IdTemporada` | `12` | Descubierto en `/api/CompeticionesPorDeporte` |
| Fútbol Sala | `IdDeporte` | `2` | Nodo de clasificación `IdNodo = 68` |
| Prebenjamín Mixto (Competición) | `IdCompeticion` | `111` | |
| Prebenjamín Mixto (Categoría) | `IdCategoria` | `300` | |
| Grupos activos (Grupo 1 a Grupo 8) | `IdGrupo` | `159` a `166` | 8 grupos activos, 62 equipos en total |
| Grupo de `EL VALLE SANCHINARRO "B"` | `IdGrupo` | `160` | **Grupo 2** (`IdEquipo = 1068`) |

### 3.2. Endpoints Internos y Reglas Críticas

1. **Listado de Grupos por Categoría**:
   - `GET /api/GruposPorCategoria?action=ObtenerGruposCategoriaListado&IdCategoria=300&IdCompeticion=111`
   - Devuelve `{ status: "OK", data: [ { Id: 159, Nombre: "Grupo 1  ", Jerarquia: 1 }, ... ] }`.
   - ⚠️ **Nota**: Incluye un primer elemento placeholder con `Id: -1` (`"Seleccione un grupo"`), por lo que siempre debe filtrarse con `g.Id > 0`.

2. **Inicialización de Sesión para Clasificaciones (CRÍTICO)**:
   - El endpoint `/Clasificaciones/ObtenerClasificacionJornadaGrupo` falla con HTTP 500 (`System.NullReferenceException` en `ClasificacionesController.ObtenerClasificacionJornadaGrupo_FS`) si se invoca sin cookie de sesión porque el controlador lee `Session["IdNodo"]`.
   - **Solución implementada en [`initClassificationSession_`](file:///Users/israelvinualeslopez/sources/C%C3%B3digo.js#L398-L415)**:
     Hacer primero un `GET /Clasificaciones/MostrarClasificacion?IdDeporte=2`, extraer la cabecera `Set-Cookie` (`ASP.NET_SessionId=...`) y enviarla en la cabecera `Cookie` de las peticiones posteriores.

3. **Obtención de Clasificación + Jornadas Iniciales**:
   - `GET /Clasificaciones/ObtenerClasificacionJornadaGrupo?IdGrupo={idGrupo}&IdJornada=0&IdDeporte=2&IdEquipo=0` (con cabecera `Cookie: ASP.NET_SessionId=...`).
   - Devuelve un **JSON stringificado dentro de otro JSON string** (requiere doble `JSON.parse`, gestionado en [`parseEcmJsonResponse_`](file:///Users/israelvinualeslopez/sources/C%C3%B3digo.js#L964-L978)).
   - Estructura devuelta:
     - `clasificacionJornada`: Array oficial con `Posicion, IdEquipo, Equipo, URLEscudo, Puntos, Disputados, Ganados, Empatados, Perdidos, Favor, Contra, Diferencia`.
     - `previous`, `jornada`, `next`: Objetos de jornada con `Id`, `NumeroJornada`, `Fecha` y array `Enfrentamientos`.

4. **Descarga Paralela de Todas las Jornadas en 2 Rondas**:
   - `GET /Resultados/ObtenerResultadosJornadaGrupo?IdGrupo={idGrupo}&IdJornada={idJornada}&IdEquipo=0`
   - Cada llamada devuelve **3 jornadas completas a la vez**: `{ previous, jornada, next }`.
   - Sabiendo el `Id` de la Jornada 1 (`baseJornadaId`), en la Ronda 2 se solicitan en paralelo (`UrlFetchApp.fetchAll`) los offsets `baseJornadaId + 3` (devuelve J3, J4, J5), `baseJornadaId + 6` (devuelve J6, J7, J8) y `baseJornadaId + 8` (devuelve J8, J9, J10). Así se obtienen todas las jornadas de los 8 grupos en solo 2 lotes HTTP paralelos (~2.5 segundos en total).

---

## 4. Arquitectura Híbrida (Google Apps Script + GitHub Pages)

El mismo archivo [`Index.html`](file:///Users/israelvinualeslopez/sources/Index.html) funciona sin modificaciones tanto dentro del iframe de **Google Apps Script** como servido estáticamente en **GitHub Pages**:

1. **Inyección segura de plantillas GAS**:
   - Los datos iniciales de GAS se inyectan dentro de `<script id="gas-initial-data" type="application/json"><?!= ... ?></script>`.
   - Si el archivo se sirve en GitHub Pages sin pasar por `HtmlService`, el navegador ignora el contenido del bloque `type="application/json"` sin producir errores de sintaxis JavaScript.
2. **Sistema de Caché en 3 Capas**:
   - **Capa 1 (`localStorage` en navegador — 48 horas)**: Clave `SOMOS_VALLE_2026_LOCAL_CACHE_V2`. Proporciona carga en **0 ms** en visitas sucesivas.
   - **Capa 2 (`docs/data.json` en GitHub Pages)**: Si el usuario entra por primera vez a GitHub Pages con `localStorage` vacío, carga `./data.json` en **< 50 ms**.
   - **Capa 3 (`CacheService` en Google Apps Script — 6 horas)**: Fragmentada en bloques de 85 KB (`SOMOS_VALLE_2026_V3_CHUNK_i`) para superar el límite de 100 KB por clave de Apps Script.
3. **Actualización en Vivo (`🔄 Actualizar`)**:
   - En Apps Script usa `google.script.run.getLeagueData(true)`.
   - En GitHub Pages realiza un `fetch(GAS_API_URL + '?format=json&refresh=1&_t=' + Date.now())` contra el `doGet` de Apps Script, que devuelve `ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON)` con CORS abierto (`Access-Control-Allow-Origin: *`).

---

## 5. Flujo de Trabajo para Iterar y Desplegar (Runbook para Agentes)

Cada vez que un agente modifique [`Código.js`](file:///Users/israelvinualeslopez/sources/C%C3%B3digo.js) o [`Index.html`](file:///Users/israelvinualeslopez/sources/Index.html), debe ejecutar estos 3 pasos para mantener sincronizados tanto **Google Apps Script** como **GitHub Pages**:

### Paso 1: Regenerar el bundle estático de GitHub Pages (`docs/`)
```bash
node scripts/update-data.mjs
```
Esto ejecuta `Código.js` en una máquina virtual Node.js, regenera `docs/data.json` y copia `Index.html` a `docs/index.html` y `docs/404.html`.

### Paso 2: Subir y actualizar el despliegue en Google Apps Script (`clasp`)
```bash
clasp push -f
clasp deploy -i AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY -d "Descripción de la versión"
```
*(Mantener siempre el mismo Deployment ID `AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY` para que la constante `GAS_API_URL` y los iframes de Google Sites no cambien de URL).*

### Paso 3: Publicar en GitHub Pages (`git push`)
```bash
git add .
git commit --no-gpg-sign -m "feat: descripción de los cambios"
git push origin main
```
GitHub Pages publica automáticamente la carpeta `/docs` de la rama `main` en `https://landslore.github.io/somos-valle-2026/`.

