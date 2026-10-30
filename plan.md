# Plan de Desarrollo Agéntico: Somos Valle 2026 (Seguimiento Liga ECM)

## 1. Objetivo del Proyecto
Desarrollar y desplegar una **Web App en Google Apps Script** (embebible en **Google Sites**) que replique y mejore el diseño de **Somos Valle** (`https://sites.google.com/view/somosvalle/resultados-fase-1`), obteniendo en tiempo real los datos de **Resultados** y **Clasificación** desde el portal oficial de **Escuelas Católicas de Madrid (ECM)** para todos los grupos de la categoría, con seguimiento especial al equipo **El Valle Sanchinarro B**, navegación interactiva al calendario de cada equipo y simulación en vivo de la **Previsión de Fase 2**.

### Parámetros de la Competición
- **Organizador:** Escuelas Católicas de Madrid (ECM)
- **Deporte:** Fútbol Sala
- **Competición / Categoría:** Prebenjamín Mixto
- **Alcance:** Todos los grupos y jornadas de la liga (descubrimiento dinámico de Grupos 1..6 y Jornadas 1..N)
- **Equipo destacado (por defecto):** `El Valle Sanchinarro B`

---

## 2. Arquitectura de la Solución

```mermaid
flowchart LR
    subgraph GoogleSites["Google Sites (Somos Valle)"]
        Iframe["Iframe Web App"]
    end

    subgraph GAS["Google Apps Script (Somos Valle 2026)"]
        UI["Index.html (SPA: Resultados | Clasificación | Previsión Fase 2 | Calendario Equipo)"]
        Backend["Código.js (Conector ECM + Normalizador + Motor Fase 2)"]
        Cache["CacheService (TTL 5 min + Force Refresh)"]
    end

    subgraph ECM["Portal ECM (juegosdeportivos.ecmadrid.org)"]
        API_Res["Endpoints Resultados (/Resultados/...)"]
        API_Clas["Endpoints Clasificación (/Clasificacion/...)"]
    end

    Iframe --> UI
    UI <-->|"google.script.run"| Backend
    Backend <--> Cache
    Backend -->|"UrlFetchApp.fetchAll"| API_Res
    Backend -->|"UrlFetchApp.fetchAll"| API_Clas
```

---

## 3. Especificación Funcional de Vistas y Navegación

La aplicación contará con una barra de navegación principal (además de soporte por parámetro URL `?tab=...` por si se desea enlazar directamente a una sección) con **3 secciones principales** y **1 vista transversal de Calendario de Equipo**:

### 3.1. Sección "Resultados"
- **Selector de Grupo (Grupos 1 a 6):** Se abre **por defecto en el grupo de `El Valle Sanchinarro B`**, mostrando una insignia/estrella en la pestaña de su grupo.
- **Selector de Jornada (Jornadas 1 a N):** Detecta y selecciona por defecto la jornada actual (la última con resultados o la próxima a disputarse).
- **Tarjetas de Partido (Diseño Somos Valle):**
  - Marcador central destacado en **rojo** para partidos disputados (y fecha/hora/campo para partidos pendientes o en juego).
  - Resaltado visual especial en la tarjeta del partido de `El Valle Sanchinarro B`.
  - **Nombres de equipo interactivos (clicables):** Al pulsar en cualquier equipo (local o visitante), navega directamente al **Calendario completo de ese equipo**.

### 3.2. Sección "Clasificación"
- **Selector de Grupo (Grupos 1 a 6):** Sincronizado con el grupo activo (por defecto el de `El Valle Sanchinarro B`).
- **Tabla de Clasificación completa:**
  - Columnas: Posición (`Pos`), Equipo, Puntos (`Pts`), `PJ`, `PG`, `PE`, `PP`, `GF`, `GC`, `Dif` y **Destino virtual en Fase 2** (badge indicando a qué grupo de Fase 2 iría hoy según su posición/rendimiento).
  - Fila de `El Valle Sanchinarro B` destacada visualmente.
  - **Equipos clicables:** Pulsar sobre cualquier fila o nombre de equipo abre su **Calendario completo**.

### 3.3. Sección "Previsión de Fase 2" (Simulador en Tiempo Real)
Calcula y muestra las **6 tablas virtuales de los grupos de la 2ª Fase** (que comienza el 21 de febrero y acaba el 9 de mayo, a una vuelta) usando en vivo las clasificaciones actuales de la Fase 1 y arrastrando los datos actuales de cada equipo (Grupo de origen en Fase 1, Puesto en Fase 1, `Pts`, `PJ`, `PG`, `PE`, `PP`, `GF`, `GC`, `Dif`) para ver de un vistazo el nivel de los rivales que tocarían hoy.

#### Reglas de Asignación de Grupos de Fase 2 (según `fase2-reglas.png`)
| Grupo en Fase 2 | Puestos Globales | Equipos que lo componen (6 grupos en Fase 1) | Total Equipos |
| :--- | :---: | :--- | :---: |
| **Grupo Fase Final** | **1º al 10º** | • El **1º** de cada grupo (6)<br>• Los **4 mejores 2º** (4) | **10 equipos** |
| **Grupo 1 Fase Igualatoria** | **11º al 20º** | • Los **2 peores 2º** (2)<br>• El **3º** de cada grupo (6)<br>• Los **2 mejores 4º** (2) | **10 equipos** |
| **Grupo 2 Fase Igualatoria** | **21º al 30º** | • Los **4 peores 4º** (4)<br>• El **5º** de cada grupo (6) | **10 equipos** |
| **Grupo 3 Fase Igualatoria** | **31º al 40º** | • El **6º** de cada grupo (6)<br>• Los **4 mejores 7º** (4) | **10 equipos** |
| **Grupo 4 Fase Igualatoria** | **41º al 49º** | • Los **2 peores 7º** (2)<br>• El **8º** de cada grupo (6)<br>• El **mejor 9º** (1) | **9 equipos** |
| **Grupo 5 Fase Igualatoria** | **50º al 58º** | • Los **5 peores 9º** (5)<br>• El **10º** de cada grupo (4) | **9 equipos** |

- **Criterio de desempate entre grupos** (para determinar mejores/peores 2º, 4º, 7º y 9º):
  1. Mayor puntuación (`Pts`) — *con opción de conmutar/considerar coeficiente `Pts / PJ` si algún grupo tiene distinto número de partidos jugados*.
  2. Mayor diferencia de goles (`GF - GC`).
  3. Mayor número de goles a favor (`GF`).
  4. Menor número de goles en contra (`GC`).
- **Experiencia en la vista "Previsión de Fase 2":**
  - Se posiciona o resalta automáticamente el grupo de Fase 2 donde estaría clasificado hoy **`El Valle Sanchinarro B`**.
  - Cada tabla muestra los equipos ordenados con sus estadísticas de Fase 1, su medalla de procedencia (ej. `2º Grupo 3`) y permite hacer clic en cualquier equipo para ir a su **Calendario**.

### 3.4. Vista "Calendario de Equipo" (Navegación Recursiva entre Equipos)
- Accesible haciendo clic en **cualquier equipo** desde:
  - Una tarjeta de partido en **Resultados**
  - Una fila de **Clasificación**
  - Una fila de **Previsión de Fase 2**
  - **Otro partido dentro del propio Calendario de Equipo** (si estoy viendo el calendario del Equipo A y pulso sobre su rival Equipo B en la Jornada 5, navego inmediatamente al calendario del Equipo B).
- **Contenido de la ficha del equipo:**
  - Cabecera con nombre del equipo, grupo actual, posición actual, puntos, balance de goles (`GF`/`GC`) y grupo proyectado en Fase 2.
  - Botón rápido en cabecera para **"Ver El Valle Sanchinarro B"** y botón **"Volver"**.
  - **Listado cronológico de todas las jornadas (Jugadas y Pendientes):**
    - Partidos ya jugados: muestran el marcador en rojo e indicador visual de **Victoria (V - verde)**, **Empate (E - ámbar)** o **Derrota (D - rojo)** desde la perspectiva del equipo consultado.
    - Partidos pendientes: muestran fecha, hora, campo/instalación y la posición actual del rival en la tabla para anticipar la dificultad de lo que le queda por jugar.

---

## 4. Fases de Ejecución Autónoma

### Fase 1: Reconocimiento de la Web de Referencia ("Somos Valle")
1. Navegar por `https://sites.google.com/view/somosvalle/resultados-fase-1` y sus secciones para extraer estilos exactos, tipografías, colores, estructura de tarjetas y cabeceras.

### Fase 2: Ingeniería Inversa de los Endpoints de ECM
1. Inspeccionar el tráfico XHR/Fetch en `https://juegosdeportivos.ecmadrid.org/Resultados/ResultadosTemporada` y `https://juegosdeportivos.ecmadrid.org/Clasificacion/ClasificacionTemporada`.
2. Simular la selección de **Deporte: Fútbol Sala** y **Competición: Prebenjamín Mixto** y descubrir dinámicamente todos los grupos y jornadas activos.
3. Identificar URLs internas, métodos (`GET`/`POST`), payloads y estructura de respuesta para construir el parser y normalizador en Apps Script.

### Fase 3: Creación del Proyecto con `clasp`
1. Ejecutar `clasp create --type webapp --title "Somos Valle 2026"`.
2. Configurar `appsscript.json` con zona horaria `Europe/Madrid`, permisos de `UrlFetchApp` y acceso público (`ANYONE_ANONYMOUS`).

### Fase 4: Desarrollo del Backend (`Código.js`)
1. Implementar el descubrimiento dinámico y descarga paralela (`UrlFetchApp.fetchAll`) de clasificaciones y resultados de todas las jornadas de todos los grupos.
2. Implementar la capa de caché en `CacheService` (TTL de 5 minutos) con soporte para `forceRefresh`.
3. Implementar el normalizador de partidos, clasificaciones, calendarios por equipo y el motor de cálculo de **Previsión de Fase 2**.
4. Exponer `doGet(e)` con `XFrameOptionsMode.ALLOWALL` para Google Sites.

### Fase 5: Desarrollo del Frontend (`Index.html`)
1. Maquetar la interfaz con la estética de **Somos Valle** (pestañas de Grupo 1..N, selector de Jornadas, tarjetas de partido con marcador en rojo).
2. Construir las vistas de **Resultados**, **Clasificación**, **Previsión de Fase 2** y **Calendario de Equipo** con navegación fluida entre equipos al hacer clic.
3. Configurar la selección automática inicial en el grupo de **El Valle Sanchinarro B**.

### Fase 6: Despliegue y Entrega (`clasp push` & `clasp deploy`)
1. Subir los archivos mediante `clasp push`.
2. Publicar la Web App con permisos públicos mediante `clasp deploy`.
3. Verificar el funcionamiento de la URL desplegada y entregarla lista para incrustar en Google Sites.

---

## 5. Estado de Ejecución y Despliegue (Completado)

- **Script ID**: `13I0Kf7288UK-uwhvrf27UDkgnUtVCM9n-kY7bRb5CEtEYSL7UW-J4Bxa`
- **Deployment ID (`@1`)**: `AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY`
- **URL Pública de la Web App**: `https://script.google.com/macros/s/AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY/exec`
- **URLs directas por sección (opcional para páginas separadas en Google Sites)**:
  - Resultados: `https://script.google.com/macros/s/AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY/exec?page=resultados`
  - Clasificación: `https://script.google.com/macros/s/AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY/exec?page=clasificacion`
  - Previsión Fase 2: `https://script.google.com/macros/s/AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY/exec?page=fase2`

