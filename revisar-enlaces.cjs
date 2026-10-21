// Revisión mensual de los enlaces de la guía. La ejecuta el workflow .github/workflows/revisar-enlaces.yml.
// Abre un aviso (issue) con el resultado y cierra los de meses anteriores.
const fs = require('fs');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function probar(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,*/*' } });
    return { status: r.status, finalUrl: r.url };
  } catch (e) {
    return { error: (e.cause && e.cause.code) || e.name || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// Dominio "raíz" para comparar (www.x.com, us.x.com y x.com cuentan como el mismo sitio).
const raiz = u => {
  try {
    const h = new URL(u).hostname.toLowerCase();
    const partes = h.split('.');
    const largo = /\.(co|org|com|ac|gov)\.uk$/.test(h) ? 3 : 2;
    return partes.slice(-largo).join('.');
  } catch (e) {
    return '';
  }
};

// Errores de red que casi siempre son una protección anti-bots y no un sitio caído.
const ERRORES_DUDOSOS = ['UND_ERR_SOCKET', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT', 'AbortError', 'ETIMEDOUT', 'EPIPE'];
const ERRORES_CAIDO = ['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'];

module.exports = async ({ github, context }) => {
  const tiendas = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  const caidos = [], cambiados = [], dudosos = [], bien = [];

  for (const t of tiendas) {
    if (!t.sitioWeb) continue;
    const r = await probar(t.sitioWeb);
    const fila = { nombre: t.nombre, url: t.sitioWeb, r };
    if (r.error) {
      (ERRORES_CAIDO.includes(r.error) ? caidos : dudosos).push(fila);
    } else if ([404, 410, 500, 502, 504, 521, 522, 523, 525].includes(r.status)) {
      caidos.push(fila);
    } else if ([401, 403, 429, 503].includes(r.status)) {
      dudosos.push(fila);
    } else if (raiz(r.finalUrl) && raiz(r.finalUrl) !== raiz(t.sitioWeb)) {
      cambiados.push(fila);
    } else {
      bien.push(fila);
    }
    await new Promise(res => setTimeout(res, 400));
  }

  const estado = r => (r.error ? `error de conexión (${r.error})` : `respuesta ${r.status}`);
  const sinParametros = u => String(u).split('?')[0];
  const lista = (arr, extra) => arr.map(f => `- **${f.nombre}**: ${f.url} → ${extra ? extra(f) : estado(f.r)}`).join('\n');
  const hayProblemas = caidos.length > 0 || cambiados.length > 0;

  let cuerpo =
    `@${context.repo.owner} Revisión mensual de enlaces de **${process.env.GUIA}** (${process.env.SITIO}): ` +
    `${bien.length} bien, ${caidos.length} posiblemente caídos, ${cambiados.length} con cambio de dominio, ` +
    `${dudosos.length} que no se pudieron verificar automáticamente.\n\n`;
  if (!hayProblemas && !dudosos.length) cuerpo += 'Todas las webs responden con normalidad. No hay nada que hacer este mes. ✅\n\n';
  if (caidos.length) cuerpo += `### Posiblemente caídos o cerrados (revisar primero)\n${lista(caidos)}\n\n`;
  if (cambiados.length) cuerpo += `### Redirigen a otro dominio (puede que la tienda se haya mudado o cambiado de nombre)\n${lista(cambiados, f => 'redirige a ' + sinParametros(f.r.finalUrl))}\n\n`;
  if (dudosos.length) cuerpo += `### No se pudieron verificar (suelen ser protecciones anti-bots: abrirlas a mano para confirmar)\n${lista(dudosos)}\n\n`;
  cuerpo += '---\nPara corregir una ficha, avisale a Claude qué tienda cerró o cambió y se actualiza la guía.';

  // Cierra los avisos de meses anteriores para que quede uno solo abierto.
  const abiertos = await github.paginate(github.rest.issues.listForRepo, { ...context.repo, state: 'open', per_page: 100 });
  for (const i of abiertos) {
    if (!i.pull_request && i.title.startsWith('Revisión de enlaces')) {
      await github.rest.issues.update({ ...context.repo, issue_number: i.number, state: 'closed' });
    }
  }
  const fecha = new Date().toISOString().slice(0, 7);
  await github.rest.issues.create({ ...context.repo, title: `Revisión de enlaces – ${fecha}${hayProblemas ? ' ⚠️' : ' ✅'}`, body: cuerpo });
  console.log(cuerpo);
};
