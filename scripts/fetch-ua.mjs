// Збирає графіки по областях України з alerts.org.ua і записує один файл data/ua.json.
// Для Київської області додатково звіряє дані зі svitlo.live (запасне джерело й прапорець аварійних).
// Запуск: node scripts/fetch-ua.mjs data/ua.json
// Збій однієї області не ламає решту: для неї лишаються попередні дані з позначкою «stale».
// Якщо жодна область не оновилась, файл НЕ перезаписується, а скрипт завершується з помилкою.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ALERTS = (process.env.ALERTS_BASE || 'https://alerts.org.ua').replace(/\/$/, '');
const SVITLO = process.env.SVITLO_API || 'https://dtek-api.svitlo-proxy.workers.dev/';
const OUT = process.argv[2] || 'data/ua.json';
const PAUSE = Number(process.env.PAUSE_MS ?? 500);
const UA = 'svitlo-map/0.4 (open-source outage map; a few requests per run)';

// slug = адреса на alerts.org.ua; fetch:false — дані не публікуються взагалі
const REGIONS = [
  ['cherkaska-oblast', 'Черкаська область'], ['chernigivska-oblast', 'Чернігівська область'], ['chernivetcka-oblast', 'Чернівецька область'],
  ['dnipropetrovska-oblast', 'Дніпропетровська область'], ['ivano-frankivska-oblast', 'Івано-Франківська область'], ['harkivska-oblast', 'Харківська область'],
  ['hersonska-oblast', 'Херсонська область'], ['hmelnitcka-oblast', 'Хмельницька область'], ['kyivska-oblast', 'Київська область'],
  ['kirovogradska-oblast', 'Кіровоградська область'], ['lvivska-oblast', 'Львівська область'], ['mykolaivska-oblast', 'Миколаївська область'],
  ['odeska-oblast', 'Одеська область'], ['poltavska-oblast', 'Полтавська область'], ['rivnenska-oblast', 'Рівненська область'],
  ['sumska-oblast', 'Сумська область'], ['ternopilska-oblast', 'Тернопільська область'], ['vinnytcka-oblast', 'Вінницька область'],
  ['volynska-oblast', 'Волинська область'], ['zakarpatska-oblast', 'Закарпатська область'], ['zaporizka-oblast', 'Запорізька область'],
  ['zhytomyrska-oblast', 'Житомирська область'],
  ['crimea', 'Автономна Республіка Крим', false, 'Дані недоступні'], ['donetcka-oblast', 'Донецька область', false, 'Дані недоступні'], ['luganska-oblast', 'Луганська область', false, 'Дані недоступні']
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, json = false, tries = 3) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (e) { last = e; console.error(`  ${url} спроба ${i}/${tries}: ${e.message}`); if (i < tries) await sleep(3000 * i); }
  }
  throw last;
}
const addDays = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function kyivToUtc(y, mo, d, h, mi) {
  const want = Date.UTC(y, mo - 1, d, h, mi); let t = want;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
    t += want - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  }
  return new Date(t);
}

class NoSchedule extends Error {}
// Сторінка області: <div id="shedule" data-time="ДАТА"> ... data-group-id="r12g1-1" ... data-start/data-end ... class="stts0|stts2"
function parseAlerts(html) {
  const dm = html.match(/id="shedule"[^>]*data-time="(\d{4}-\d{2}-\d{2})"/);
  if (!dm) throw new NoSchedule('немає блоку розкладу');
  const um = html.match(/Оновлено:\s*(\d{2})\.(\d{2})\.(\d{4})\s*о\s*(\d{1,2}):(\d{2})/);
  const updatedAt = um ? kyivToUtc(+um[3], +um[2], +um[1], +um[4], +um[5]).toISOString() : null;
  const op = html.match(/за інформацією\s*<b>([^<]*)<\/b>/); const operator = op ? op[1].trim() : '';
  const body = html.slice(html.indexOf('id="shedule"'));
  const parts = body.split(/data-group-id="r\d+g(\d+(?:-\d+)?)"/);
  const groups = {}, STATUS = { 0: 'on', 2: 'off' }, unknown = new Set();
  const min = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i].replace('-', '.'), chunk = parts[i + 1].split('<div class="stat">')[0];
    const sl = new Array(48).fill(null);
    for (const m of chunk.matchAll(/data-start="(\d{2}:\d{2})" data-end="(\d{2}:\d{2})"[^>]*class="[^"]*\bstts(\d)\b/g)) {
      const s = min(m[1]), e = min(m[2]);
      if (s % 30 || e % 30 || e <= s) throw new Error(`група ${id}: дивний інтервал ${m[1]}-${m[2]}`);
      const code = STATUS[m[3]] ?? (unknown.add(m[3]), 'unk');
      for (let k = s / 30; k < e / 30; k++) sl[k] = code;
    }
    if (sl.some(x => x === null)) throw new Error(`група ${id}: слоти не покриті повністю`);
    groups[id] = sl;
  }
  if (unknown.size) console.error('  невідомі коди статусу stts' + [...unknown].join(',stts') + ' позначено як «немає даних»');
  if (!Object.keys(groups).length) throw new NoSchedule('груп не знайдено');
  return { date: dm[1], updatedAt, operator, groups };
}
const enc = a => a.map(s => s === 'on' ? '1' : s === 'off' ? '0' : '?').join('');   // 48 символів на добу

async function svitlo() {
  let raw = await get(SVITLO, true);
  if (typeof raw.body === 'string') raw = JSON.parse(raw.body);
  const region = (raw.regions || []).find(r => r.cpu === 'kiivska-oblast');
  if (!region) throw new Error('регіон kiivska-oblast відсутній');
  const CODE = { 1: 'on', 2: 'off' };
  const slots = map => { const o = []; for (let h = 0; h < 24; h++) for (const m of ['00', '30']) o.push(CODE[Number(map?.[`${String(h).padStart(2, '0')}:${m}`] ?? 0)] ?? 'unk'); return o; };
  const date = raw.date_today;
  return { date, emergency: Boolean(region.emergency), groups: Object.fromEntries(Object.keys(region.schedule || {}).map(id => [id, slots(region.schedule[id]?.[date])])) };
}

// ---- основний потік
const prev = existsSync(OUT) ? (() => { try { return JSON.parse(readFileSync(OUT, 'utf8')); } catch { return null; } })() : null;
const regions = {}; let okCount = 0, hardFails = 0, abort = false;   // abort: сайт, схоже, повністю недоступний
let sv = null; try { sv = await svitlo(); } catch (e) { console.error('svitlo.live:', e.message); }

for (const [slug, name, doFetch = true, note] of REGIONS) {
  if (!doFetch) { regions[slug] = { name, status: 'nodata', note, queues: [] }; continue; }
  if (abort) {
    const old = prev?.regions?.[slug];
    regions[slug] = old?.queues?.length ? { ...old, status: 'stale', note: 'Не вдалося оновити, показано попередні дані' } : { name, status: 'nodata', note: 'Дані тимчасово недоступні', queues: [] };
    continue;
  }
  process.stdout.write(`${slug}: `);
  try {
    const t = parseAlerts(await get(`${ALERTS}/${slug}/`));
    const days = [t];
    await sleep(PAUSE);
    try {
      const tm = addDays(t.date, 1), r2 = parseAlerts(await get(`${ALERTS}/${slug}/${tm}.html`, false, 1));
      if (r2.date === tm) days.push(r2);
    } catch { /* графіка на завтра ще немає */ }
    const ids = Object.keys(t.groups).sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));
    const queues = ids.map(id => ({ id, d: Object.fromEntries(days.filter(d => d.groups[id]).map(d => [d.date, enc(d.groups[id])])) }));
    const reg = { name, status: 'ok', operator: t.operator, updatedAt: t.updatedAt, emergency: false, queues };
    if (slug === 'kyivska-oblast' && sv) {
      reg.emergency = sv.emergency;
      if (sv.date === t.date) {
        const diff = ids.filter(id => sv.groups[id] && sv.groups[id].join() !== t.groups[id].join());
        reg.check = { with: 'svitlo.live', match: diff.length === 0, diff };
      }
    }
    regions[slug] = reg; okCount++; hardFails = 0;
    console.log(`OK, груп ${ids.length}, днів ${days.length}${reg.check ? (reg.check.match ? ', звірка збіг' : ', розбіжності ' + reg.check.diff.join(',')) : ''}`);
  } catch (e) {
    const old = prev?.regions?.[slug];
    if (!(e instanceof NoSchedule) && ++hardFails >= 4) { abort = true; console.error('Чотири збої поспіль: схоже, джерело недоступне, зупиняю обхід.'); }
    else if (e instanceof NoSchedule) hardFails = 0;
    if (e instanceof NoSchedule) { regions[slug] = { name, status: 'nodata', note: 'Графік не опублікований', queues: [] }; console.log('немає графіка'); }
    else if (old && old.queues?.length) { regions[slug] = { ...old, status: 'stale', note: 'Не вдалося оновити, показано попередні дані' }; console.log('ПОМИЛКА, лишаю попередні дані:', e.message); }
    else { regions[slug] = { name, status: 'nodata', note: 'Дані тимчасово недоступні', queues: [] }; console.log('ПОМИЛКА:', e.message); }
  }
  await sleep(PAUSE);
}

// резервний шлях лише для Київської області, якщо alerts.org.ua недоступний
if (regions['kyivska-oblast'].status !== 'ok' && sv) {
  const ids = Object.keys(sv.groups).sort((a, b) => a.localeCompare(b, 'uk', { numeric: true }));
  if (ids.length >= 6 && Object.values(sv.groups)[0].some(s => s !== 'unk')) {
    regions['kyivska-oblast'] = { name: 'Київська область', status: 'ok', operator: 'svitlo.live (запасне джерело)', updatedAt: null, emergency: sv.emergency, queues: ids.map(id => ({ id, d: { [sv.date]: enc(sv.groups[id]) } })) };
    okCount++; console.log('Київська: використано запасне джерело svitlo.live');
  }
}

if (!okCount) throw new Error('Жодну область не вдалося оновити');
writeFileSync(OUT, JSON.stringify({
  fetchedAt: new Date().toISOString(),
  source: { name: 'alerts.org.ua', url: 'https://alerts.org.ua/' },
  regions
}));
console.log(`Готово: областей з даними ${okCount} з ${REGIONS.filter(r => r[2] !== false).length}`);
