// Збирає графіки по областях України з alerts.org.ua і записує один файл data/ua.json.
// Для Київської області додатково звіряє дані зі svitlo.live (запасне джерело й прапорець аварійних).
// Запуск: node scripts/fetch-ua.mjs data/ua.json
// Збій однієї області не ламає решту: для неї лишаються попередні дані з позначкою «stale».
// Якщо жодна область не оновилась, файл НЕ перезаписується, а скрипт завершується з помилкою.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ALERTS = (process.env.ALERTS_BASE || 'https://alerts.org.ua').replace(/\/$/, '');
const SVITLO = process.env.SVITLO_API || 'https://dtek-api.svitlo-proxy.workers.dev/';
const OUT = process.argv[2] || 'data/ua.json';
const PAUSE = Number(process.env.PAUSE_MS ?? 800);
const UA = 'svitlo-map/0.4 (open-source outage map; a few requests per run)';

// slug = адреса на alerts.org.ua; fetch:false — дані не публікуються взагалі
const REGIONS = [
  ['cherkaska-oblast', 'Черкаська область'], ['chernigivska-oblast', 'Чернігівська область'], ['chernivetcka-oblast', 'Чернівецька область'],
  ['dnipropetrovska-oblast', 'Дніпропетровська область'], ['ivano-frankivska-oblast', 'Івано-Франківська область'], ['harkivska-oblast', 'Харківська область'],
  ['hersonska-oblast', 'Херсонська область'], ['hmelnitcka-oblast', 'Хмельницька область'], ['kyivska-oblast', 'Київська область'], ['kyiv', 'м. Київ'],
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
      if (!res.ok) { if (res.status === 429 || res.status >= 500) await sleep(4000); throw new Error(`HTTP ${res.status}`); }
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
  const op = html.match(/за інформацією\s*<b>([^<]*)<\/b>/); const operator = op ? op[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").trim() : '';
  const body = html.slice(html.indexOf('id="shedule"'));
  const parts = body.split(/data-group-id="r\d+g([\d-]+)"/);
  const groups = {}, STATUS = { 0: 'on', 2: 'off' }, RANK = { on: 1, unk: 2, off: 3 }, unknown = new Map(), skipped = []; let gapTotal = 0;
  const min = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i].replace('-', '.'), chunk = parts[i + 1].split('<div class="stat">')[0];
    const sl = new Array(48).fill(null);
    // Кожен інтервал шукаємо за його ВІДКРИВАЛЬНИМ тегом; підпис беремо від кінця тегу до наступного інтервалу (або до «</div>»).
    // Так сусідні інтервали не «з'їдають» один одного, навіть якщо розмітка між ними нестандартна.
    const tags = [...chunk.matchAll(/<div\b([^>]*\bdata-start="[^"]*"[^>]*)>/g)];
    for (let ti = 0; ti < tags.length; ti++) {
      const tg = tags[ti], from = tg.index + tg[0].length, to = ti + 1 < tags.length ? tags[ti + 1].index : chunk.length;
      const m = [tg[0], tg[1], chunk.slice(from, Math.min(to, from + 300)).split('</div>')[0]];
      const at = m[1], s0 = at.match(/data-start="(\d{1,2}:\d{2})"/), e0 = at.match(/data-end="(\d{1,2}:\d{2})"/);
      if (!s0 || !e0) continue;
      let st = min(s0[1]), e = min(e0[1]);
      if (e === 0 && st > 0) e = 1440;                       // «22:00 - 00:00» означає кінець доби
      if (e === st || st >= 1440) continue;                  // нульової довжини, напр. «24:00 - 24:00»: на сторінці Черкаської області такі трапляються
      if (e < st || e > 1440) throw new Error(`група ${id}: дивний інтервал ${s0[1]}-${e0[1]}`);
      const cm = at.match(/\bstts(\d)\b/), label = m[2].replace(/<[^>]+>/g, ' ').replace(/\d{1,2}:\d{2}/g, ' ').replace(/[-–—]/g, ' ').replace(/\s+/g, ' ').trim();
      let code = cm ? STATUS[cm[1]] : undefined;
      if (!code) {                                           // невідомий клас: дивимось на підпис (ON/OFF) всередині інтервалу
        if (/можлив|ймовір/i.test(label)) { unknown.set(cm ? cm[1] : '?', label.slice(0, 30)); code = 'unk'; }   // «можливе відключення» не вважаємо ні світлом, ні відключенням
        else if (/\boff\b|відключ|вимкн/i.test(label)) code = 'off';
        else if (/\bon\b|є світло|світло буде|увімкн/i.test(label)) code = 'on';
        else { unknown.set(cm ? cm[1] : '?', label.slice(0, 30)); code = 'unk'; }
      }
      for (let k = Math.floor(st / 30); k < Math.ceil(e / 30); k++) sl[k] = RANK[code] > (RANK[sl[k]] ?? 0) ? code : sl[k] ?? code;   // відключення має пріоритет над «немає даних» і «є світло»
    }
    const gaps = sl.filter(x => x === null).length;
    if (gaps === 48) { skipped.push(id); continue; }
    if (gaps) { gapTotal += gaps; console.error(`  група ${id}: ${gaps} слотів без даних позначено як «немає даних»`); }
    groups[id] = sl.map(x => x ?? 'unk');
  }
  if (unknown.size) console.error('  невідомі статуси: ' + [...unknown].map(([c, l]) => `stts${c} («${l}»)`).join(', ') + ' позначено як «немає даних»');
  if (!Object.keys(groups).length) throw new NoSchedule(`груп із інтервалами не знайдено (сторінка ${html.length} байт, груп у розмітці: ${(parts.length - 1) / 2})`);
  const warn = [gapTotal ? `слотів без даних: ${gapTotal}` : '', unknown.size ? `невідомі статуси: ${[...unknown].map(([c, l]) => `код ${c}${l ? ' «' + l + '»' : ''}`).join(', ')}` : ''].filter(Boolean).join('; ');
  return { date: dm[1], updatedAt, operator, groups, warn };
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

// ---- історія: скільки годин без світла за ОПУБЛІКОВАНИМИ графіками (не фактичні відключення)
const HIST_PATH = OUT.replace(/[^/\\]*$/, 'history.json');
const BACKFILL = Number(process.env.BACKFILL_DAYS || 0);
function statsFromGroups(groups, u) {
  const q = {};
  for (const [id, arr] of Object.entries(groups)) {
    const known = arr.filter(x => x !== 'unk').length;
    if (known < 24) continue;
    q[id] = Math.round(arr.filter(x => x === 'off').length / 2 * (48 / known) * 10) / 10;
  }
  const v = Object.values(q);
  if (!v.length) return null;
  return { avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length * 10) / 10, min: Math.min(...v), max: Math.max(...v), n: v.length, q, u: u || null };
}
const hist = (() => { try { const h = JSON.parse(readFileSync(HIST_PATH, 'utf8')); return h && h.days ? h : { version: 1, days: {} }; } catch { return { version: 1, days: {} }; } })();
const histBatch = [];

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
    if (t.warn) reg.warn = t.warn;
    if (slug === 'kyivska-oblast' && sv) {
      reg.emergency = sv.emergency;
      if (sv.date === t.date) {
        const diff = ids.filter(id => sv.groups[id] && sv.groups[id].join() !== t.groups[id].join());
        reg.check = { with: 'svitlo.live', match: diff.length === 0, diff };
      }
    }
    regions[slug] = reg; okCount++; hardFails = 0;
    histBatch.push(...days.map(d => ({ slug, date: d.date, groups: d.groups, u: d.updatedAt })));
    console.log(`OK, груп ${ids.length}, днів ${days.length}${reg.check ? (reg.check.match ? ', звірка збіг' : ', розбіжності ' + reg.check.diff.join(',')) : ''}`);
  } catch (e) {
    const old = prev?.regions?.[slug];
    if (!(e instanceof NoSchedule) && ++hardFails >= 4) { abort = true; console.error('Чотири збої поспіль: схоже, джерело недоступне, зупиняю обхід.'); }
    else if (e instanceof NoSchedule) hardFails = 0;
    const why = String(e.message || e).slice(0, 160);
    if (e instanceof NoSchedule) { regions[slug] = { name, status: 'nodata', note: 'Графік не опублікований', error: why, queues: [] }; console.log('немає графіка:', e.message); }
    else if (old && old.queues?.length) { regions[slug] = { ...old, status: 'stale', note: 'Не вдалося оновити, показано попередні дані', error: why }; console.log('ПОМИЛКА, лишаю попередні дані:', e.message); }
    else { regions[slug] = { name, status: 'nodata', note: 'Дані тимчасово недоступні', error: why, queues: [] }; console.log('ПОМИЛКА:', e.message); }
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

// одноразове заповнення історії за минулі дні (BACKFILL_DAYS=6): корисно при першому запуску
if (BACKFILL > 0 && !abort) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
  console.log(`Заповнюю історію за ${BACKFILL} днів…`);
  for (const [slug, , doFetch] of REGIONS) {
    if (doFetch === false) continue;
    for (let k = 1; k <= BACKFILL; k++) {
      const dt = addDays(today, -k);
      if (hist.days[dt]?.[slug]) continue;
      try {
        const r = parseAlerts(await get(`${ALERTS}/${slug}/${dt}.html`, false, 1));
        if (r.date === dt) histBatch.push({ slug, date: dt, groups: r.groups, u: r.updatedAt });
      } catch { /* для цього дня даних немає */ }
      await sleep(PAUSE);
    }
  }
}
for (const { slug, date, groups, u } of histBatch) {
  const st = statsFromGroups(groups, u);
  if (st) (hist.days[date] ||= {})[slug] = st;
}
const cutoff = addDays(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date()), -120);
for (const d of Object.keys(hist.days)) if (d < cutoff) delete hist.days[d];
writeFileSync(HIST_PATH, JSON.stringify(hist));
writeFileSync(OUT, JSON.stringify({
  fetchedAt: new Date().toISOString(),
  parser: 'v5-labels',                                   // версія розбору: за цим полем у ua.json видно, який скрипт створив дані
  source: { name: 'alerts.org.ua', url: 'https://alerts.org.ua/' },
  regions
}));
console.log(`Готово: областей з даними ${okCount} з ${REGIONS.filter(r => r[2] !== false).length}`);
