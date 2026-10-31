import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const docsDir = path.join(rootDir, 'docs');
const scratchDir = path.join(rootDir, '.scratch');
const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyoLUgxCghF1oZk8WNQW06PiQXMyt3CXLqf6uqXkdrKb1UIOsvqHcikQvAKT_LX7drY/exec?format=json&refresh=1';

async function fetchFromGas() {
  console.log(`[CI/Fallback] Obteniendo datos frescos desde Google Apps Script API...`);
  const resp = await fetch(GAS_API_URL, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`GAS API HTTP error: ${resp.status}`);
  const json = await resp.json();
  if (!json || !json.groups || !Array.isArray(json.groups)) {
    throw new Error('Formato devuelto por GAS API no válido');
  }
  return json;
}

async function fetchAllFromEcm() {
  const BASE = 'https://juegosdeportivos.ecmadrid.org';
  const urlCache = new Map();

  // Si existen las capturas locales en scratch y no estamos en GitHub Actions, las cargamos directamente
  if (!process.env.GITHUB_ACTIONS && fs.existsSync(path.join(scratchDir, 'grupos_111_cat300.json'))) {
    const groupsText = fs.readFileSync(path.join(scratchDir, 'grupos_111_cat300.json'), 'utf8');
    urlCache.set(
      `${BASE}/api/GruposPorCategoria?action=ObtenerGruposCategoriaListado&IdCategoria=300&IdCompeticion=111`,
      { text: groupsText, headers: {} }
    );
    urlCache.set(
      `${BASE}/Clasificaciones/MostrarClasificacion?IdDeporte=2`,
      { text: '', headers: { 'Set-Cookie': 'ASP.NET_SessionId=local;' } }
    );
    const groups = JSON.parse(groupsText).data.filter((g) => g && g.Id > 0);
    for (const g of groups) {
      const cFile = path.join(scratchDir, `clasif_g${g.Id}.json`);
      const rFile = path.join(scratchDir, `res_${g.Id}.json`);
      if (fs.existsSync(cFile)) {
        urlCache.set(
          `${BASE}/Clasificaciones/ObtenerClasificacionJornadaGrupo?IdGrupo=${g.Id}&IdJornada=0&IdDeporte=2&IdEquipo=0`,
          { text: fs.readFileSync(cFile, 'utf8'), headers: {} }
        );
      }
      if (fs.existsSync(rFile)) {
        urlCache.set(
          `${BASE}/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=${g.Id}&IdJornada=0&IdEquipo=0`,
          { text: fs.readFileSync(rFile, 'utf8'), headers: {} }
        );
      }
    }
    // Cargar también todas las jornadas de Grupo 2 (160) descargadas
    const j2File = path.join(scratchDir, 'res_160_j2.json');
    const j5File = path.join(scratchDir, 'res_160_j5.json');
    const j7File = path.join(scratchDir, 'res_160_j7.json');
    if (fs.existsSync(j2File)) {
      urlCache.set(`${BASE}/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=160&IdJornada=2462&IdEquipo=0`, {
        text: fs.readFileSync(j2File, 'utf8'),
        headers: {}
      });
    }
    if (fs.existsSync(j5File)) {
      urlCache.set(`${BASE}/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=160&IdJornada=2465&IdEquipo=0`, {
        text: fs.readFileSync(j5File, 'utf8'),
        headers: {}
      });
    }
    if (fs.existsSync(j7File)) {
      urlCache.set(`${BASE}/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=160&IdJornada=2467&IdEquipo=0`, {
        text: fs.readFileSync(j7File, 'utf8'),
        headers: {}
      });
    }
    return urlCache;
  }

  async function getText(url, headers = {}) {
    const resp = await fetch(url, { headers });
    const text = await resp.text();
    const setCookie = resp.headers.getSetCookie ? resp.headers.getSetCookie() : (resp.headers.get('set-cookie') || '');
    urlCache.set(url, { text, headers: { 'Set-Cookie': setCookie } });
    return { text, setCookie };
  }

  const groupsUrl = `${BASE}/api/GruposPorCategoria?action=ObtenerGruposCategoriaListado&IdCategoria=300&IdCompeticion=111`;
  const { text: groupsText } = await getText(groupsUrl);
  const groupsJson = JSON.parse(groupsText);
  const groups = (groupsJson.data || []).filter((g) => g && g.Id > 0);

  const initUrl = `${BASE}/Clasificaciones/MostrarClasificacion?IdDeporte=2`;
  const { setCookie } = await getText(initUrl);
  const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie || '');
  const mCookie = cookieStr.match(/ASP\.NET_SessionId=[^;,\s]+/i);
  const sessionCookie = mCookie ? mCookie[0] : '';
  const reqHeaders = sessionCookie ? { Cookie: sessionCookie } : {};

  const r1Promises = [];
  for (const g of groups) {
    const cUrl = `${BASE}/Clasificaciones/ObtenerClasificacionJornadaGrupo?IdGrupo=${g.Id}&IdJornada=0&IdDeporte=2&IdEquipo=0`;
    const j0Url = `${BASE}/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=${g.Id}&IdJornada=0&IdEquipo=0`;
    r1Promises.push(getText(cUrl, reqHeaders));
    r1Promises.push(getText(j0Url, reqHeaders));
  }
  await Promise.all(r1Promises);

  const r2Promises = [];
  for (const g of groups) {
    const j0Url = `${BASE}/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=${g.Id}&IdJornada=0&IdEquipo=0`;
    const rawText = urlCache.get(j0Url)?.text || '';
    let parsed = JSON.parse(rawText);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    const firstJ = parsed?.jornada || parsed?.next || parsed?.previous;
    if (firstJ && firstJ.Id && firstJ.Numero) {
      const baseId = Number(firstJ.Id) - (Number(firstJ.Numero) - 1);
      for (const offset of [3, 6, 8]) {
        const targetId = baseId + offset;
        const jUrl = `${BASE}/Resultados/ObtenerResultadosJornadaGrupo?IdGrupo=${g.Id}&IdJornada=${targetId}&IdEquipo=0`;
        r2Promises.push(getText(jUrl, reqHeaders));
      }
    }
  }
  await Promise.all(r2Promises);

  return urlCache;
}

async function main() {
  let data = null;

  // En GitHub Actions, ECM bloquea los rangos de IPs de Azure con timeout.
  // Usamos directamente el backend de Google Apps Script que ejecuta en la red de Google sin bloqueo.
  if (process.env.GITHUB_ACTIONS) {
    try {
      data = await fetchFromGas();
    } catch (err) {
      console.warn('Fallo al obtener desde GAS API en CI:', err.message);
    }
  }

  if (!data) {
    try {
      const urlCache = await fetchAllFromEcm();

      const codigoSource = fs.readFileSync(path.join(rootDir, 'Código.js'), 'utf8');
      const sandbox = {
        console,
        Date,
        Math,
        Object,
        Array,
        String,
        Number,
        Boolean,
        RegExp,
        JSON,
        encodeURIComponent,
        parseInt,
        isNaN,
        Utilities: {
          formatDate: (date, tz, fmt) => {
            const d = new Date(date);
            const pad = (n) => String(n).padStart(2, '0');
            if (fmt === 'yyyy-MM-dd') {
              return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            }
            return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
          }
        },
        CacheService: {
          getScriptCache: () => ({
            get: () => null,
            putAll: () => {}
          })
        },
        UrlFetchApp: {
          fetch: (url) => {
            const hit = urlCache.get(url) || { text: '{}', headers: {} };
            return {
              getResponseCode: () => 200,
              getContentText: () => hit.text,
              getAllHeaders: () => hit.headers
            };
          },
          fetchAll: (reqs) =>
            reqs.map((r) => {
              const url = typeof r === 'string' ? r : r.url;
              const hit = urlCache.get(url) || { text: '{}', headers: {} };
              return {
                getResponseCode: () => 200,
                getContentText: () => hit.text,
                getAllHeaders: () => hit.headers
              };
            })
        }
      };

      vm.createContext(sandbox);
      vm.runInContext(codigoSource, sandbox);
      data = sandbox.getLeagueData(true);
    } catch (ecmErr) {
      console.warn('Fallo en scraping directo ECM:', ecmErr.message);
      // Intento de rescate con GAS si no se había probado antes
      try {
        data = await fetchFromGas();
      } catch (gasErr) {
        console.warn('Fallo también en rescate con GAS API:', gasErr.message);
      }
    }
  }

  fs.mkdirSync(docsDir, { recursive: true });

  if (data && data.groups && data.groups.length > 0) {
    fs.writeFileSync(path.join(docsDir, 'data.json'), JSON.stringify(data), 'utf8');
    console.log(`Generado docs/data.json (${data.groups.length} grupos, grupo inicial: Grupo ${data.defaultGroup}, jornada inicial G2: Jornada ${data.groups[data.defaultGroup - 1]?.jornadaActual || '?'})`);
  } else {
    console.warn('No se pudieron obtener datos frescos. Se conserva docs/data.json previo.');
  }

  const indexHtml = fs.readFileSync(path.join(rootDir, 'Index.html'), 'utf8');
  fs.writeFileSync(path.join(docsDir, 'index.html'), indexHtml, 'utf8');
  fs.writeFileSync(path.join(docsDir, '404.html'), indexHtml, 'utf8');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
