/**
 * Somos Valle 2026 - Backend Google Apps Script
 * Seguimiento en tiempo real de la Liga de Fútbol Sala Prebenjamín Mixto
 * Escuelas Católicas de Madrid (ECM) - https://juegosdeportivos.ecmadrid.org
 */

const CONFIG = {
  ECM_BASE_URL: 'https://juegosdeportivos.ecmadrid.org',
  ID_DEPORTE: 2,          // Fútbol Sala
  ID_TEMPORADA: 12,       // Temporada 2026-2027
  ID_COMPETICION: 111,    // PREBENJAMÍN MIXTO
  ID_CATEGORIA: 300,      // PREBENJAMÍN MIXTO
  TEAM_HIGHLIGHT: 'EL VALLE SANCHINARRO "B"',
  CACHE_KEY_PREFIX: 'SOMOS_VALLE_2026_V3_',
  CACHE_TTL_SECONDS: 21600, // 6 horas en CacheService (máximo permitido por Apps Script)
  CACHE_CHUNK_SIZE: 85000 // < 100 KB límite por clave en CacheService
};

/**
 * Punto de entrada HTTP GET de la Web App.
 * Soporta ?format=json para servir como API en GitHub Pages y HTML embebido para Google Sites.
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const forceRefresh = params.refresh === '1' || params.refresh === 'true';

  if (params.format === 'json' || params.action === 'json') {
    const data = getLeagueData(forceRefresh);
    return ContentService
      .createTextOutput(JSON.stringify(data))
      .setMimeType(ContentService.MimeType.JSON);
  }

  const template = HtmlService.createTemplateFromFile('Index');
  template.initialView = params.page || params.view || 'resultados';
  template.initialGroup = params.group ? parseInt(params.group, 10) : 0;
  template.initialTeam = params.team || '';

  // Si ya existe en caché y no se pide forzar refresco, inyectamos los datos de inmediato
  let cachedData = null;
  if (!forceRefresh) {
    cachedData = getFromChunkedCache_(CONFIG.CACHE_KEY_PREFIX);
  }
  template.initialDataJson = cachedData ? JSON.stringify(cachedData) : 'null';

  return template
    .evaluate()
    .setTitle('Somos Valle 2026 - Resultados y Clasificación ECM')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Alias en español para ejecutar/autorizar desde el editor de Apps Script.
 */
function obtenerDatosLiga(forceRefresh) {
  return getLeagueData(forceRefresh);
}

/**
 * Función expuesta al cliente mediante google.script.run.getLeagueData(forceRefresh)
 * Devuelve todos los grupos, jornadas, clasificaciones, calendarios por equipo y previsión de Fase 2.
 */
function getLeagueData(forceRefresh) {
  if (!forceRefresh) {
    const cached = getFromChunkedCache_(CONFIG.CACHE_KEY_PREFIX);
    if (cached) {
      cached.fromCache = true;
      return cached;
    }
  }

  const freshData = fetchAndBuildLeagueData_();
  saveToChunkedCache_(CONFIG.CACHE_KEY_PREFIX, freshData, CONFIG.CACHE_TTL_SECONDS);
  return freshData;
}

/**
 * Descarga en paralelo las clasificaciones y todas las jornadas de todos los grupos de ECM,
 * normaliza los datos y calcula el calendario por equipo y la Previsión de Fase 2.
 */
function fetchAndBuildLeagueData_() {
  const startMs = new Date().getTime();

  // 1. Descubrir dinámicamente competición, categoría y grupos activos
  const discovery = discoverCompetitionAndGroups_();
  const groupsMeta = discovery.groups;

  // 2. Obtener cookie de sesión ASP.NET inicializando el nodo de clasificación de Fútbol Sala
  const sessionCookie = initClassificationSession_(CONFIG.ID_DEPORTE);

  // 3. Ronda 1 (Paralela): Obtener Clasificación + Jornadas iniciales (1 y 2) de todos los grupos
  const round1Requests = groupsMeta.map(function(g) {
    const req = {
      url: CONFIG.ECM_BASE_URL + '/Clasificaciones/ObtenerClasificacionJornadaGrupo?IdGrupo=' + g.id + '&IdJornada=0&IdDeporte=' + CONFIG.ID_DEPORTE + '&IdEquipo=0',
      method: 'get',
      muteHttpExceptions: true
    };
    if (sessionCookie) {
      req.headers = { Cookie: sessionCookie };
    }
    return req;
  });

  const round1Responses = round1Requests.length > 0 ? UrlFetchApp.fetchAll(round1Requests) : [];

  // Mapa temporal por grupo: { meta, clasificacionRaw, jornadasMap: { [numJornada]: jornadaObj }, seenJornadaIds: Set, baseJornadaId }
  const groupBuckets = {};
  const fallbackGroupIds = [];

  groupsMeta.forEach(function(g, idx) {
    groupBuckets[g.id] = {
      meta: g,
      clasificacionRaw: [],
      jornadasMap: {},
      seenJornadaIds: {},
      baseJornadaId: 0
    };

    const parsed = parseEcmJsonResponse_(round1Responses[idx]);
    if (parsed && (parsed.jornada || parsed.clasificacionJornada)) {
      if (Array.isArray(parsed.clasificacionJornada)) {
        groupBuckets[g.id].clasificacionRaw = parsed.clasificacionJornada;
      }
      collectJornadasFromResponse_(groupBuckets[g.id], parsed);
    } else {
      fallbackGroupIds.push(g.id);
    }
  });

  // Si algún grupo no devolvió datos en Clasificaciones (p.ej. sin sesión), consultar ResultadosJornadaGrupo
  if (fallbackGroupIds.length > 0) {
    const fbRequests = fallbackGroupIds.map(function(gid) {
      return {
        url: CONFIG.ECM_BASE_URL + '/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=' + gid + '&IdJornada=0&IdEquipo=0',
        method: 'get',
        muteHttpExceptions: true
      };
    });
    const fbResponses = UrlFetchApp.fetchAll(fbRequests);
    fallbackGroupIds.forEach(function(gid, idx) {
      const parsed = parseEcmJsonResponse_(fbResponses[idx]);
      if (parsed) {
        collectJornadasFromResponse_(groupBuckets[gid], parsed);
      }
    });
  }

  // 4. Ronda 2 (Paralela): Como cada llamada a ObtenerResultadosJornadaGrupo devuelve 3 jornadas
  // (previous, jornada, next), pidiendo baseId+3 (Jornadas 3,4,5), baseId+6 (Jornadas 6,7,8)
  // y baseId+8 (por si hay 9 o 10 jornadas) cubrimos todas las jornadas de todos los grupos de golpe.
  const round2Requests = [];
  const round2Meta = [];

  groupsMeta.forEach(function(g) {
    const bucket = groupBuckets[g.id];
    if (bucket.baseJornadaId > 0) {
      // Offsets +3 (J4 -> devuelve J3,J4,J5), +6 (J7 -> devuelve J6,J7,J8), +8 (J9 -> devuelve J8,J9,J10)
      [3, 6, 8].forEach(function(offset) {
        const targetId = bucket.baseJornadaId + offset;
        if (!bucket.seenJornadaIds[targetId]) {
          round2Requests.push({
            url: CONFIG.ECM_BASE_URL + '/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=' + g.id + '&IdJornada=' + targetId + '&IdEquipo=0',
            method: 'get',
            muteHttpExceptions: true
          });
          round2Meta.push({ groupId: g.id, jornadaId: targetId });
        }
      });
    }
  });

  if (round2Requests.length > 0) {
    const round2Responses = UrlFetchApp.fetchAll(round2Requests);
    round2Responses.forEach(function(resp, idx) {
      const gid = round2Meta[idx].groupId;
      const parsed = parseEcmJsonResponse_(resp);
      if (parsed) {
        collectJornadasFromResponse_(groupBuckets[gid], parsed);
      }
    });
  }

  // 5. Normalizar Grupos, Jornadas, Partidos, Clasificaciones y Calendarios de Equipos
  let defaultGroupNumber = 1;
  let highlightTeamName = CONFIG.TEAM_HIGHLIGHT;
  const normalizedGroups = [];
  const teamsIndex = {}; // key: normalizedTeamKey -> { nombre, idEquipo, escudo, grupoNumero, grupoNombre, stats, matches: [] }

  groupsMeta.forEach(function(g, gIdx) {
    const groupNumber = gIdx + 1;
    const bucket = groupBuckets[g.id];

    // Ordenar jornadas por número (1..N)
    const jornadaNumbers = Object.keys(bucket.jornadasMap)
      .map(function(n) { return parseInt(n, 10); })
      .filter(function(n) { return !isNaN(n) && n > 0; })
      .sort(function(a, b) { return a - b; });

    const jornadas = [];
    jornadaNumbers.forEach(function(numJ) {
      const rawJ = bucket.jornadasMap[numJ];
      const matchesRaw = Array.isArray(rawJ.Enfrentamientos) ? rawJ.Enfrentamientos : [];
      const matches = matchesRaw.map(function(m) {
        return normalizeMatch_(m, groupNumber, g.nombreCorto, numJ);
      });

      // Registrar si en este grupo está EL VALLE SANCHINARRO "B"
      matches.forEach(function(m) {
        if (m.esValleB) {
          defaultGroupNumber = groupNumber;
          if (isHighlightTeam_(m.equipoLocal)) highlightTeamName = m.equipoLocal;
          if (isHighlightTeam_(m.equipoVisitante)) highlightTeamName = m.equipoVisitante;
        }
      });

      jornadas.push({
        id: rawJ.Id || 0,
        numero: numJ,
        fecha: formatDateShort_(rawJ.Fecha),
        fechaIso: rawJ.Fecha || '',
        partidos: matches
      });
    });

    // Normalizar clasificación del grupo
    const clasificacion = normalizeGroupClassification_(
      bucket.clasificacionRaw,
      jornadas,
      groupNumber,
      g.nombreCorto
    );

    clasificacion.forEach(function(row) {
      if (row.esValleB) {
        defaultGroupNumber = groupNumber;
        highlightTeamName = row.equipo;
      }
      const tKey = normalizeTeamKey_(row.equipo);
      if (!teamsIndex[tKey]) {
        teamsIndex[tKey] = {
          key: tKey,
          idEquipo: row.idEquipo,
          nombre: row.equipo,
          escudo: row.escudo,
          grupoNumero: groupNumber,
          grupoNombre: g.nombreCorto,
          esValleB: row.esValleB,
          esFamiliaValle: row.esFamiliaValle,
          stats: row,
          partidos: []
        };
      } else {
        teamsIndex[tKey].stats = row;
        teamsIndex[tKey].grupoNumero = groupNumber;
        teamsIndex[tKey].grupoNombre = g.nombreCorto;
      }
    });

    // Añadir todos los partidos del grupo al calendario individual de cada equipo
    jornadas.forEach(function(j) {
      j.partidos.forEach(function(m) {
        if (m.descansa) {
          const restKey = normalizeTeamKey_(m.equipoDescansa);
          ensureTeamInIndex_(teamsIndex, restKey, m.idEquipoDescansa, m.equipoDescansa, m.escudoDescansa, groupNumber, g.nombreCorto);
          teamsIndex[restKey].partidos.push(m);
        } else {
          const localKey = normalizeTeamKey_(m.equipoLocal);
          const visitKey = normalizeTeamKey_(m.equipoVisitante);
          ensureTeamInIndex_(teamsIndex, localKey, m.idEquipoLocal, m.equipoLocal, m.escudoLocal, groupNumber, g.nombreCorto);
          ensureTeamInIndex_(teamsIndex, visitKey, m.idEquipoVisitante, m.equipoVisitante, m.escudoVisitante, groupNumber, g.nombreCorto);
          teamsIndex[localKey].partidos.push(m);
          teamsIndex[visitKey].partidos.push(m);
        }
      });
    });

    // Determinar la jornada activa por defecto del grupo (la última con algún partido jugado, o la próxima por fecha, o la 1)
    const defaultJornada = detectCurrentJornada_(jornadas);

    normalizedGroups.push({
      id: g.id,
      numero: groupNumber,
      nombre: g.nombreCorto,
      nombreCompleto: g.nombreCompleto,
      esGrupoValleB: groupNumber === defaultGroupNumber,
      jornadaActual: defaultJornada,
      jornadas: jornadas,
      clasificacion: clasificacion
    });
  });

  // Asegurar que la marca esGrupoValleB esté correctamente asignada
  normalizedGroups.forEach(function(ng) {
    ng.esGrupoValleB = (ng.numero === defaultGroupNumber);
  });

  // 6. Construir Previsión de Fase 2 (ambos modos: bloques de 10 estilo Somos Valle + reglas literales circular)
  const previsionFase2 = buildPrevisionFase2_(normalizedGroups, teamsIndex);

  // Ordenar calendarios de cada equipo por número de jornada y enriquecer con posición del rival
  Object.keys(teamsIndex).forEach(function(tKey) {
    const teamObj = teamsIndex[tKey];
    teamObj.partidos.sort(function(a, b) {
      return a.numeroJornada - b.numeroJornada;
    });
  });

  const nowObj = new Date();
  const nowMs = nowObj.getTime();
  const elapsedMs = nowMs - startMs;

  return {
    ok: true,
    fromCache: false,
    fetchedAtMs: nowMs,
    updatedAt: Utilities.formatDate(nowObj, 'Europe/Madrid', 'dd/MM/yyyy HH:mm:ss'),
    elapsedMs: elapsedMs,
    deporte: 'Fútbol Sala',
    competicion: discovery.competicionNombre || 'PREBENJAMÍN MIXTO',
    temporada: 'Temporada 2026-2027',
    highlightTeam: highlightTeamName,
    highlightTeamKey: normalizeTeamKey_(highlightTeamName),
    defaultGroup: defaultGroupNumber,
    groups: normalizedGroups,
    previsionFase2: previsionFase2,
    teams: teamsIndex
  };
}

/**
 * Descubre dinámicamente los grupos activos de Prebenjamín Mixto en ECM.
 */
function discoverCompetitionAndGroups_() {
  let idCompeticion = CONFIG.ID_COMPETICION;
  let idCategoria = CONFIG.ID_CATEGORIA;
  let competicionNombre = 'PREBENJAMÍN MIXTO';

  let groups = fetchGroupsList_(idCategoria, idCompeticion);

  // Si por cambio de temporada/IDs no devuelve grupos, descubrir desde CompeticionesPorDeporte
  if (groups.length === 0) {
    const compUrl = CONFIG.ECM_BASE_URL + '/api/CompeticionesPorDeporte?action=ObtenerCompeticionesDeporteListado&IdDeporte=' + CONFIG.ID_DEPORTE + '&IdTemporada=' + CONFIG.ID_TEMPORADA + '&soloActivas=false';
    const compResp = UrlFetchApp.fetch(compUrl, { muteHttpExceptions: true });
    const compJson = safeJsonParse_(compResp.getContentText());
    if (compJson && Array.isArray(compJson.data)) {
      const foundComp = compJson.data.find(function(c) {
        return c && c.Nombre && removeAccents_(c.Nombre.toUpperCase()).indexOf('PREBENJAMIN') !== -1;
      });
      if (foundComp) {
        idCompeticion = foundComp.Id;
        competicionNombre = foundComp.Nombre;
        const catUrl = CONFIG.ECM_BASE_URL + '/api/CategoriasPorCompeticion?action=ObtenerCategoriasCompeticionListado&IdCompeticion=' + idCompeticion;
        const catResp = UrlFetchApp.fetch(catUrl, { muteHttpExceptions: true });
        const catJson = safeJsonParse_(catResp.getContentText());
        if (catJson && Array.isArray(catJson.data)) {
          const validCats = catJson.data.filter(function(cat) { return cat && cat.Id > 0; });
          if (validCats.length > 0) {
            idCategoria = validCats[0].Id;
          }
        }
        groups = fetchGroupsList_(idCategoria, idCompeticion);
      }
    }
  }

  return {
    idCompeticion: idCompeticion,
    idCategoria: idCategoria,
    competicionNombre: competicionNombre,
    groups: groups
  };
}

function fetchGroupsList_(idCategoria, idCompeticion) {
  const url = CONFIG.ECM_BASE_URL + '/api/GruposPorCategoria?action=ObtenerGruposCategoriaListado&IdCategoria=' + idCategoria + '&IdCompeticion=' + idCompeticion;
  const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  const json = safeJsonParse_(resp.getContentText());
  if (!json || !Array.isArray(json.data)) return [];

  return json.data
    .filter(function(g) { return g && g.Id > 0; })
    .map(function(g, idx) {
      const rawName = (g.Nombre || ('Grupo ' + (idx + 1))).trim();
      const shortMatch = rawName.match(/Grupo\s*\d+/i);
      return {
        id: g.Id,
        nombreCorto: shortMatch ? shortMatch[0].toUpperCase() : ('GRUPO ' + (idx + 1)),
        nombreCompleto: rawName,
        jerarquia: g.Jerarquia || (idx + 1)
      };
    });
}

/**
 * Inicializa la sesión en Clasificaciones para que ObtenerClasificacionJornadaGrupo_FS tenga IdNodo en Session.
 */
function initClassificationSession_(idDeporte) {
  try {
    const resp = UrlFetchApp.fetch(
      CONFIG.ECM_BASE_URL + '/Clasificaciones/MostrarClasificacion?IdDeporte=' + idDeporte,
      { muteHttpExceptions: true, followRedirects: true }
    );
    const headers = resp.getAllHeaders();
    const setCookie = headers['Set-Cookie'] || headers['set-cookie'];
    if (!setCookie) return '';
    const cookiesArr = Array.isArray(setCookie) ? setCookie : [setCookie];
    return cookiesArr
      .map(function(c) { return String(c).split(';')[0].trim(); })
      .filter(Boolean)
      .join('; ');
  } catch (e) {
    return '';
  }
}

/**
 * Extrae y guarda las jornadas contenidas en { previous, jornada, next } de una respuesta de ECM.
 */
function collectJornadasFromResponse_(bucket, parsed) {
  ['previous', 'jornada', 'next'].forEach(function(key) {
    const jObj = parsed[key];
    if (jObj && jObj.Id && jObj.Id > 0 && jObj.NumeroJornada && jObj.NumeroJornada > 0) {
      bucket.seenJornadaIds[jObj.Id] = true;
      if (Array.isArray(jObj.Enfrentamientos) && jObj.Enfrentamientos.length > 0) {
        bucket.jornadasMap[jObj.NumeroJornada] = jObj;
      }
      if (bucket.baseJornadaId === 0) {
        bucket.baseJornadaId = jObj.Id - (jObj.NumeroJornada - 1);
      }
    }
  });
}

/**
 * Normaliza un enfrentamiento devuelto por ECM al modelo de tarjeta de Somos Valle.
 */
function normalizeMatch_(m, groupNumber, groupName, numJornada) {
  const idLocal = m.IdEquipoLocal || 0;
  const idVisit = m.IdEquipoVisitante || 0;
  const descansa = (idLocal === 0 || idVisit === 0);

  const nombreLocal = cleanTeamName_(m.EquipoLocal || '');
  const nombreVisit = cleanTeamName_(m.EquipoVisitante || '');
  const escudoLocal = resolveShieldUrl_(m.URLEscudoEquipoLocal);
  const escudoVisit = resolveShieldUrl_(m.URLEscudoEquipoVisitante);

  const estado = (m.EstadoPartido || '').trim();
  const cerrado = Boolean(m.Cerrado);
  const idGanador = m.IdEquipoGanador || 0;
  const resLocal = m.ResultadoEquipoLocal != null ? m.ResultadoEquipoLocal : 0;
  const resVisit = m.ResultadoEquipoVisitante != null ? m.ResultadoEquipoVisitante : 0;

  // Un partido se considera disputado si está cerrado, tiene ganador, tiene goles o su estado no es Pendiente de Jugar
  const jugado = !descansa && (
    cerrado ||
    idGanador > 0 ||
    resLocal > 0 ||
    resVisit > 0 ||
    (m.IdEstadoPartido && m.IdEstadoPartido !== 0 && estado.toLowerCase().indexOf('pendiente') === -1)
  );

  const campoJuego = m.CampoJuego || {};
  const direccion = (campoJuego.Direccion || m.Campo || '').trim();
  const municipio = (campoJuego.Municipio || '').trim();
  const campoNombre = (campoJuego.Nombre || '').trim();
  const displayAddress = direccion
    ? (direccion + (campoNombre && direccion.indexOf(campoNombre) === -1 ? ' (' + campoNombre + ')' : '') + (municipio && municipio.toUpperCase() !== 'MADRID' ? ' - ' + municipio : ''))
    : (m.Campo || 'Campo por determinar');

  const mapsQuery = direccion
    ? encodeURIComponent(direccion + (municipio ? ', ' + municipio : ', Madrid'))
    : encodeURIComponent(displayAddress);
  const mapsUrl = 'https://www.google.es/maps/place/' + mapsQuery;

  const dtInfo = formatDateTimeParts_(m.FechaHora || m.FechaJornada);

  const esValleB = isHighlightTeam_(nombreLocal) || isHighlightTeam_(nombreVisit) ||
    (descansa && isHighlightTeam_(idLocal !== 0 ? nombreLocal : nombreVisit));
  const esFamiliaValle = isValleFamilyTeam_(nombreLocal) || isValleFamilyTeam_(nombreVisit);

  return {
    id: m.Id || 0,
    grupoNumero: groupNumber,
    grupoNombre: groupName,
    numeroJornada: numJornada,
    fechaHoraIso: m.FechaHora || m.FechaJornada || '',
    fechaCorta: dtInfo.dateStr,
    horaTexto: dtInfo.timeStr,
    fechaHoraTexto: dtInfo.fullStr,
    idEquipoLocal: idLocal,
    equipoLocal: nombreLocal,
    equipoLocalKey: normalizeTeamKey_(nombreLocal),
    escudoLocal: escudoLocal,
    idEquipoVisitante: idVisit,
    equipoVisitante: nombreVisit,
    equipoVisitanteKey: normalizeTeamKey_(nombreVisit),
    escudoVisitante: escudoVisit,
    golesLocal: jugado ? String(resLocal) : '',
    golesVisitante: jugado ? String(resVisit) : '',
    golesLocalNum: jugado ? Number(resLocal) : null,
    golesVisitanteNum: jugado ? Number(resVisit) : null,
    idEquipoGanador: idGanador,
    jugado: jugado,
    cerrado: cerrado,
    estadoPartido: estado || (jugado ? 'Finalizado' : 'Pendiente de Jugar'),
    descansa: descansa,
    idEquipoDescansa: descansa ? (idLocal !== 0 ? idLocal : idVisit) : 0,
    equipoDescansa: descansa ? (idLocal !== 0 ? nombreLocal : nombreVisit) : '',
    equipoDescansaKey: descansa ? normalizeTeamKey_(idLocal !== 0 ? nombreLocal : nombreVisit) : '',
    escudoDescansa: descansa ? (idLocal !== 0 ? escudoLocal : escudoVisit) : '',
    direccion: displayAddress,
    mapsUrl: mapsUrl,
    esValleB: esValleB,
    esFamiliaValle: esFamiliaValle
  };
}

/**
 * Normaliza la tabla de clasificación de un grupo (o la calcula desde los partidos si ECM no la devuelve).
 */
function normalizeGroupClassification_(clasifRaw, jornadas, groupNumber, groupName) {
  if (Array.isArray(clasifRaw) && clasifRaw.length > 0) {
    return clasifRaw.map(function(r, idx) {
      const nombre = cleanTeamName_(r.Equipo || '');
      const pj = Number(r.Disputados != null ? r.Disputados : (r.Jugados || 0));
      const pg = Number(r.Ganados || 0);
      const pe = Number(r.Empatados || 0);
      const pp = Number(r.Perdidos || 0);
      const gf = Number(r.Favor || 0);
      const gc = Number(r.Contra || 0);
      const diff = Number(r.Diferencia != null ? r.Diferencia : (gf - gc));
      const ptos = Number(r.Puntos || 0);
      const pos = Number(r.Posicion || (idx + 1));

      return {
        posicion: pos,
        idEquipo: r.IdEquipo || 0,
        equipo: nombre,
        equipoKey: normalizeTeamKey_(nombre),
        escudo: resolveShieldUrl_(r.URLEscudo),
        puntos: ptos,
        pj: pj,
        pg: pg,
        pe: pe,
        pp: pp,
        gf: gf,
        gc: gc,
        diff: diff,
        ratio: pj > 0 ? (ptos / pj) : 0,
        grupoNumero: groupNumber,
        grupoNombre: groupName,
        origenTag: pos + 'º - G' + groupNumber,
        esValleB: isHighlightTeam_(nombre),
        esFamiliaValle: isValleFamilyTeam_(nombre)
      };
    });
  }

  // Fallback: construir tabla de clasificación a partir de los equipos y partidos de las jornadas
  const statsByTeam = {};
  jornadas.forEach(function(j) {
    j.partidos.forEach(function(m) {
      if (m.descansa) {
        initTeamStatsFallback_(statsByTeam, m.equipoDescansa, m.idEquipoDescansa, m.escudoDescansa, groupNumber, groupName);
        return;
      }
      initTeamStatsFallback_(statsByTeam, m.equipoLocal, m.idEquipoLocal, m.escudoLocal, groupNumber, groupName);
      initTeamStatsFallback_(statsByTeam, m.equipoVisitante, m.idEquipoVisitante, m.escudoVisitante, groupNumber, groupName);

      if (m.jugado && m.golesLocalNum != null && m.golesVisitanteNum != null) {
        const stL = statsByTeam[normalizeTeamKey_(m.equipoLocal)];
        const stV = statsByTeam[normalizeTeamKey_(m.equipoVisitante)];
        stL.pj += 1;
        stV.pj += 1;
        stL.gf += m.golesLocalNum;
        stL.gc += m.golesVisitanteNum;
        stL.diff = stL.gf - stL.gc;
        stV.gf += m.golesVisitanteNum;
        stV.gc += m.golesLocalNum;
        stV.diff = stV.gf - stV.gc;

        if (m.golesLocalNum > m.golesVisitanteNum) {
          stL.pg += 1;
          stL.puntos += 2; // En ECM Fútbol Sala escolar la victoria suma 2 o 3 ptos según reglamento (ECM envía Puntos oficial en clasificacionRaw)
          stV.pp += 1;
        } else if (m.golesLocalNum < m.golesVisitanteNum) {
          stV.pg += 1;
          stV.puntos += 2;
          stL.pp += 1;
        } else {
          stL.pe += 1;
          stV.pe += 1;
          stL.puntos += 1;
          stV.puntos += 1;
        }
      }
    });
  });

  const rows = Object.keys(statsByTeam).map(function(k) { return statsByTeam[k]; });
  rows.sort(comparePhase1Teams_);
  rows.forEach(function(r, i) {
    r.posicion = i + 1;
    r.origenTag = r.posicion + 'º - G' + groupNumber;
  });
  return rows;
}

function initTeamStatsFallback_(map, nombre, idEquipo, escudo, groupNumber, groupName) {
  const k = normalizeTeamKey_(nombre);
  if (!k || map[k]) return;
  map[k] = {
    posicion: 0,
    idEquipo: idEquipo || 0,
    equipo: nombre,
    equipoKey: k,
    escudo: escudo,
    puntos: 0,
    pj: 0,
    pg: 0,
    pe: 0,
    pp: 0,
    gf: 0,
    gc: 0,
    diff: 0,
    ratio: 0,
    grupoNumero: groupNumber,
    grupoNombre: groupName,
    origenTag: '',
    esValleB: isHighlightTeam_(nombre),
    esFamiliaValle: isValleFamilyTeam_(nombre)
  };
}

/**
 * Construye la Previsión de Fase 2 según las reglas de fase2-reglas.png.
 * Devuelve tanto:
 *  - gruposBloques (división en 6 grupos de ~10 equipos: Puestos 1-10, 11-20, 21-30, 31-40, 41-50, 51-N, idéntico al formato de Somos Valle del año pasado)
 *  - gruposCircularLiteral (aplicación literal de las cantidades por puesto descritas en la circular de Fase 2)
 */
function buildPrevisionFase2_(normalizedGroups, teamsIndex) {
  // Agrupar equipos por su posición (1º, 2º, 3º...) en su grupo de Fase 1
  const byPosition = {};
  const allTeams = [];

  normalizedGroups.forEach(function(g) {
    g.clasificacion.forEach(function(row) {
      const copy = Object.assign({}, row);
      allTeams.push(copy);
      if (!byPosition[copy.posicion]) {
        byPosition[copy.posicion] = [];
      }
      byPosition[copy.posicion].push(copy);
    });
  });

  // Ordenar cada puesto (todos los 1º, todos los 2º, etc.) de mejor a peor según puntos, diferencia de goles y goles a favor
  Object.keys(byPosition).forEach(function(posKey) {
    byPosition[posKey].sort(comparePhase1Teams_);
  });

  // Orden global por (Posición en su grupo ASC, luego mejor rendimiento Puntos/Diff/GF)
  const globalOrdered = [];
  Object.keys(byPosition)
    .map(function(k) { return parseInt(k, 10); })
    .sort(function(a, b) { return a - b; })
    .forEach(function(pos) {
      byPosition[pos].forEach(function(t) {
        globalOrdered.push(Object.assign({}, t));
      });
    });

  // MODO 1: Reglas Literales de la Circular (fase2-reglas.png)
  // - Fase Final (1º al 10º): 1º de cada grupo + 4 mejores 2º
  // - Grupo 1 Igualatoria (11º al 20º): Peores 2º + 3º de cada grupo + 2 mejores 4º
  // - Grupo 2 Igualatoria (21º al 30º): Peores 4º + 5º de cada grupo
  // - Grupo 3 Igualatoria (31º al 40º): 6º de cada grupo + 4 mejores 7º
  // - Grupo 4 Igualatoria (41º al 49º): Peores 7º + 8º de cada grupo + mejor 9º
  // - Grupo 5 Igualatoria (50º al 58º): Peores 9º + 10º de cada grupo
  const p1 = byPosition[1] || [];
  const p2 = byPosition[2] || [];
  const p3 = byPosition[3] || [];
  const p4 = byPosition[4] || [];
  const p5 = byPosition[5] || [];
  const p6 = byPosition[6] || [];
  const p7 = byPosition[7] || [];
  const p8 = byPosition[8] || [];
  const p9 = byPosition[9] || [];
  const p10 = byPosition[10] || [];

  const literalRawBuckets = [
    {
      id: 1,
      codigo: 'GRUPO 1 - 10',
      titulo: 'Grupo Fase Final (Puestos 1º al 10º)',
      regla: 'El 1º de cada grupo y los 4 mejores 2º jugarán en el grupo de Fase Final a una vuelta (21 feb – 9 may).',
      equipos: [].concat(p1, p2.slice(0, 4))
    },
    {
      id: 2,
      codigo: 'GRUPO 11 - 20',
      titulo: 'Grupo 1 Fase Igualatoria (Puestos 11º al 20º)',
      regla: 'Los peores 2º, el 3º de cada grupo y los 2 mejores 4º jugarán en el Grupo 1 de Fase Igualatoria a una vuelta.',
      equipos: [].concat(p2.slice(4), p3, p4.slice(0, 2))
    },
    {
      id: 3,
      codigo: 'GRUPO 21 - 30',
      titulo: 'Grupo 2 Fase Igualatoria (Puestos 21º al 30º)',
      regla: 'Los peores 4º y el 5º de cada grupo jugarán en el Grupo 2 de Fase Igualatoria a una vuelta.',
      equipos: [].concat(p4.slice(2), p5)
    },
    {
      id: 4,
      codigo: 'GRUPO 31 - 40',
      titulo: 'Grupo 3 Fase Igualatoria (Puestos 31º al 40º)',
      regla: 'El 6º de cada grupo y los 4 mejores 7º jugarán en el Grupo 3 de Fase Igualatoria a una vuelta.',
      equipos: [].concat(p6, p7.slice(0, 4))
    },
    {
      id: 5,
      codigo: 'GRUPO 41 - 49',
      titulo: 'Grupo 4 Fase Igualatoria (Puestos 41º al 49º)',
      regla: 'Los peores 7º, el 8º de cada grupo y el mejor 9º jugarán en el Grupo 4 de Fase Igualatoria a una vuelta.',
      equipos: [].concat(p7.slice(4), p8, p9.slice(0, 1))
    },
    {
      id: 6,
      codigo: 'GRUPO 50 - 58',
      titulo: 'Grupo 5 Fase Igualatoria (Puestos 50º al 58º)',
      regla: 'Los peores 9º y el 10º de cada grupo jugarán en el Grupo 5 de Fase Igualatoria a una vuelta.',
      equipos: [].concat(p9.slice(1), p10)
    }
  ].filter(function(b) { return b.equipos.length > 0; });

  let rankCounterLiteral = 1;
  let defaultFase2LiteralGroup = 1;
  const gruposCircular = literalRawBuckets.map(function(b, idx) {
    const startRank = rankCounterLiteral;
    const sorted = b.equipos.map(function(t) { return Object.assign({}, t); }).sort(comparePhase1Teams_);
    let hasValleB = false;
    sorted.forEach(function(t, i) {
      t.posicionGlobalFase2 = startRank + i;
      t.posicionEnGrupoFase2 = i + 1;
      t.posLabel = t.posicionGlobalFase2 + ' (' + t.posicion + 'º - G' + t.grupoNumero + ')';
      if (t.esValleB) {
        hasValleB = true;
        defaultFase2LiteralGroup = idx + 1;
      }
      // Guardar proyección en el índice de equipos
      if (teamsIndex[t.equipoKey]) {
        teamsIndex[t.equipoKey].fase2GrupoTitulo = b.titulo;
        teamsIndex[t.equipoKey].fase2GrupoCodigo = b.codigo;
        teamsIndex[t.equipoKey].fase2PosicionGlobal = t.posicionGlobalFase2;
      }
    });
    rankCounterLiteral += sorted.length;
    return {
      numero: idx + 1,
      codigo: b.codigo,
      titulo: b.titulo,
      regla: b.regla,
      esGrupoValleB: hasValleB,
      equipos: sorted
    };
  });

  // MODO 2: Corte exacto de 10 equipos por grupo (Puestos 1-10, 11-20, 21-30, 31-40, 41-50, 51-N)
  // Idéntico a la tabla de Fase 2 de la web original de Somos Valle adaptado dinámicamente al total de equipos
  const totalTeams = globalOrdered.length;
  const slicesDef = [
    { start: 0, end: 10, titulo: 'Grupo Fase Final (Puestos 1º al 10º)', regla: '10 mejores clasificados por puesto de grupo (1º de cada grupo y mejores 2º).' },
    { start: 10, end: 20, titulo: 'Grupo 1 Fase Igualatoria (Puestos 11º al 20º)', regla: 'Puestos globales 11º al 20º según clasificación de Fase 1.' },
    { start: 20, end: 30, titulo: 'Grupo 2 Fase Igualatoria (Puestos 21º al 30º)', regla: 'Puestos globales 21º al 30º según clasificación de Fase 1.' },
    { start: 30, end: 40, titulo: 'Grupo 3 Fase Igualatoria (Puestos 31º al 40º)', regla: 'Puestos globales 31º al 40º según clasificación de Fase 1.' },
    { start: 40, end: 50, titulo: 'Grupo 4 Fase Igualatoria (Puestos 41º al 50º)', regla: 'Puestos globales 41º al 50º según clasificación de Fase 1.' },
    { start: 50, end: totalTeams, titulo: 'Grupo 5 Fase Igualatoria (Puestos 51º al ' + totalTeams + 'º)', regla: 'Puestos globales 51º al ' + totalTeams + 'º según clasificación de Fase 1.' }
  ].filter(function(s) { return s.start < totalTeams; });

  let defaultFase2BloquesGroup = 1;
  const gruposBloques = slicesDef.map(function(s, idx) {
    const sliceTeams = globalOrdered.slice(s.start, s.end).map(function(t) { return Object.assign({}, t); });
    sliceTeams.sort(comparePhase1Teams_);
    let hasValleB = false;
    sliceTeams.forEach(function(t, i) {
      t.posicionGlobalFase2 = s.start + i + 1;
      t.posicionEnGrupoFase2 = i + 1;
      t.posLabel = t.posicionGlobalFase2 + ' (' + t.posicion + 'º - G' + t.grupoNumero + ')';
      if (t.esValleB) {
        hasValleB = true;
        defaultFase2BloquesGroup = idx + 1;
      }
    });
    const endNum = s.start + sliceTeams.length;
    return {
      numero: idx + 1,
      codigo: 'GRUPO ' + (s.start + 1) + ' - ' + endNum,
      titulo: s.titulo,
      regla: s.regla,
      esGrupoValleB: hasValleB,
      equipos: sliceTeams
    };
  });

  return {
    fechaInicio: '21 de febrero de 2027',
    fechaFin: '9 de mayo de 2027',
    formato: 'Fase a una vuelta con los datos arrastrados de la clasificación actual de Fase 1',
    defaultGroupCircular: defaultFase2LiteralGroup,
    defaultGroupBloques: defaultFase2BloquesGroup,
    gruposCircular: gruposCircular,
    gruposBloques: gruposBloques
  };
}

/**
 * Comparador para desempatar equipos en la misma posición o dentro de un grupo virtual de Fase 2:
 * 1. Puntos DESC
 * 2. Diferencia de goles (Diff) DESC
 * 3. Goles a favor (GF) DESC
 * 4. Menor goles en contra (GC) ASC
 */
function comparePhase1Teams_(a, b) {
  if (b.puntos !== a.puntos) return b.puntos - a.puntos;
  if (b.diff !== a.diff) return b.diff - a.diff;
  if (b.gf !== a.gf) return b.gf - a.gf;
  if (a.gc !== b.gc) return a.gc - b.gc;
  return String(a.equipo).localeCompare(String(b.equipo), 'es');
}

/**
 * Detecta la siguiente jornada a disputar en un grupo (o la última si ya finalizaron todas).
 */
function detectCurrentJornada_(jornadas) {
  if (!jornadas || jornadas.length === 0) return 1;
  const todayIso = Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyy-MM-dd');

  let lastPlayedIdx = -1;
  for (let i = 0; i < jornadas.length; i++) {
    const j = jornadas[i];
    const realMatches = j.partidos.filter(function(p) { return !p.descansa; });
    const anyPlayed = realMatches.some(function(p) { return p.jugado; });
    if (anyPlayed) {
      lastPlayedIdx = i;
    }
  }

  // Si aún no se ha jugado ningún partido en todo el grupo, la siguiente jornada es la 1
  if (lastPlayedIdx === -1) {
    for (let i = 0; i < jornadas.length; i++) {
      const fIso = String(jornadas[i].fechaIso || '').slice(0, 10);
      if (fIso && fIso >= todayIso) {
        return jornadas[i].numero;
      }
    }
    return jornadas[0].numero;
  }

  // Si la última jornada con partidos jugados ya tiene todos sus partidos jugados (o su fecha ya pasó),
  // mostramos la siguiente jornada
  const lastJ = jornadas[lastPlayedIdx];
  const realMatchesLast = lastJ.partidos.filter(function(p) { return !p.descansa; });
  const allPlayedLast = realMatchesLast.length > 0 && realMatchesLast.every(function(p) { return p.jugado; });
  const lastDateIso = String(lastJ.fechaIso || '').slice(0, 10);

  if (allPlayedLast || (lastDateIso && lastDateIso < todayIso)) {
    const nextIdx = Math.min(lastPlayedIdx + 1, jornadas.length - 1);
    return jornadas[nextIdx].numero;
  }

  return lastJ.numero;
}

function ensureTeamInIndex_(teamsIndex, key, idEquipo, nombre, escudo, groupNumber, groupName) {
  if (!key) return;
  if (!teamsIndex[key]) {
    teamsIndex[key] = {
      key: key,
      idEquipo: idEquipo || 0,
      nombre: nombre,
      escudo: escudo,
      grupoNumero: groupNumber,
      grupoNombre: groupName,
      esValleB: isHighlightTeam_(nombre),
      esFamiliaValle: isValleFamilyTeam_(nombre),
      stats: {
        posicion: '-',
        puntos: 0,
        pj: 0,
        pg: 0,
        pe: 0,
        pp: 0,
        gf: 0,
        gc: 0,
        diff: 0,
        grupoNumero: groupNumber,
        grupoNombre: groupName
      },
      partidos: []
    };
  }
}

/**
 * Utilidades de formato y limpieza
 */
function cleanTeamName_(name) {
  return String(name || '').replace(/\s+/g, ' ').trim();
}

function normalizeTeamKey_(name) {
  return removeAccents_(cleanTeamName_(name).toUpperCase()).replace(/["']/g, '');
}

function isHighlightTeam_(name) {
  const norm = normalizeTeamKey_(name);
  return norm.indexOf('VALLE SANCHINARRO B') !== -1;
}

function isValleFamilyTeam_(name) {
  const norm = normalizeTeamKey_(name);
  return norm.indexOf('EL VALLE') !== -1;
}

function removeAccents_(str) {
  return String(str || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function resolveShieldUrl_(url) {
  if (!url || String(url).trim() === '') {
    return CONFIG.ECM_BASE_URL + '/Content/images/NoEscudo.png';
  }
  const clean = String(url).trim();
  if (/^https?:\/\//i.test(clean)) return clean;
  return CONFIG.ECM_BASE_URL + (clean.charAt(0) === '/' ? '' : '/') + clean;
}

function formatDateShort_(isoStr) {
  if (!isoStr) return '';
  const m = String(isoStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return String(isoStr);
  return m[3] + '/' + m[2] + '/' + m[1].slice(2);
}

function formatDateTimeParts_(isoStr) {
  if (!isoStr) {
    return { dateStr: 'Fecha pend.', timeStr: '', fullStr: 'Fecha pendiente' };
  }
  const m = String(isoStr).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) {
    const dOnly = formatDateShort_(isoStr);
    return { dateStr: dOnly, timeStr: '', fullStr: dOnly };
  }
  const dateStr = m[3] + '/' + m[2] + '/' + m[1].slice(2);
  const timeStr = (m[4] === '00' && m[5] === '00') ? 'Hora pend.' : (m[4] + ':' + m[5]);
  return {
    dateStr: dateStr,
    timeStr: timeStr,
    fullStr: dateStr + ' ' + timeStr
  };
}

function parseEcmJsonResponse_(httpResponse) {
  if (!httpResponse) return null;
  try {
    if (httpResponse.getResponseCode() !== 200) return null;
    const text = httpResponse.getContentText();
    if (!text || text.indexOf('<!DOCTYPE') !== -1 || text.indexOf('<html') !== -1) return null;
    let parsed = JSON.parse(text);
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    return parsed;
  } catch (e) {
    return null;
  }
}

function safeJsonParse_(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/**
 * Gestión de Caché Fragmentada en CacheService (evita el límite de 100 KB por clave en Apps Script)
 */
function saveToChunkedCache_(prefix, dataObj, ttlSeconds) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(dataObj);
    const totalChunks = Math.ceil(json.length / CONFIG.CACHE_CHUNK_SIZE);
    const payload = {};
    for (let i = 0; i < totalChunks; i++) {
      payload[prefix + 'CHUNK_' + i] = json.slice(i * CONFIG.CACHE_CHUNK_SIZE, (i + 1) * CONFIG.CACHE_CHUNK_SIZE);
    }
    payload[prefix + 'META'] = JSON.stringify({ chunks: totalChunks, savedAt: new Date().toISOString() });
    cache.putAll(payload, ttlSeconds);
  } catch (e) {
    // Si falla la caché, continúa sin interrumpir la respuesta
  }
}

function getFromChunkedCache_(prefix) {
  try {
    const cache = CacheService.getScriptCache();
    const metaRaw = cache.get(prefix + 'META');
    if (!metaRaw) return null;
    const meta = JSON.parse(metaRaw);
    if (!meta || !meta.chunks) return null;

    const keys = [];
    for (let i = 0; i < meta.chunks; i++) {
      keys.push(prefix + 'CHUNK_' + i);
    }
    const chunksObj = cache.getAll(keys);
    let fullJson = '';
    for (let i = 0; i < meta.chunks; i++) {
      const part = chunksObj[prefix + 'CHUNK_' + i];
      if (part == null) return null;
      fullJson += part;
    }
    return JSON.parse(fullJson);
  } catch (e) {
    return null;
  }
}

