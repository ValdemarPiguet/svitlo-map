// Cloudflare Worker «Світло·Україна»: (1) стежить за екстреними відключеннями, (2) питає вас у Telegram, чи вмикати попередження,
// (3) віддає чинні попередження сайту (GET /alerts), (4) приймає форму зворотного зв'язку (POST / або /feedback) і пересилає в Telegram.
//
// Змінні та прив'язки (Settings):
//   BOT_TOKEN       (Secret)  токен бота від @BotFather
//   CHAT_ID         (Text)    ваш числовий chat id (лише ви можете керувати ботом)
//   WEBHOOK_SECRET  (Secret)  довільний довгий рядок; Telegram передає його в заголовку веб-хука
//   ALLOWED_ORIGIN  (Text)    https://valdemarpiguet.github.io  (через кому, якщо кілька)
//   TG_CHANNELS     (Text)    публічні Telegram-канали через кому, без @ (необов'язково), напр.: ukrenergo,kyivobl_open_alerts
//   FEEDBACK_BOT_TOKEN (Secret, необов'язково) токен ОКРЕМОГО бота для форми зворотного зв'язку; без нього форма йде тим самим ботом
//   FEEDBACK_CHAT_ID   (Text, необов'язково) куди слати форму; за замовчуванням CHAT_ID (ваш id підходить для будь-якого вашого бота)
//   KV              (KV namespace binding) сховище попереджень і службових міток
// Необов'язково: SVITLO_API (адреса API svitlo.live), SVITLO_MAP (JSON {"cpu":"slug"}), ALERT_HOURS (за замовчуванням 12), NEWS_URL.
//   GH_TOKEN       (Secret, необов'язково) токен GitHub (fine-grained, Actions: Read and write для репозиторію) для запуску оновлення даних
//   GH_REPO        (Text, необов'язково) репозиторій, напр. valdemarpiguet/svitlo-map; GH_WORKFLOW (за замовчуванням update.yml), GH_REF (main)
//   DISPATCH_CRON   (Text, необов'язково) рядок крону, за яким запускати оновлення; за замовчуванням '17 3,11,18,21 * * *'
//   CONTROL_CRON    (Text, необов'язково) крон перевірки свіжості даних після запуску; за замовчуванням '57 3,11,18,21 * * *'
//   DATA_URL        (Text, необов'язково) адреса data/ua.json на сайті; за замовчуванням <перший з ALLOWED_ORIGIN>/data/ua.json (для github.io: /svitlo-map/data/ua.json)
// Cron Triggers: 7 */3 * * *  (моніторинг + перевірка свіжості)  |  17 3,11,18,21 * * *  (запуск оновлення в GitHub)  |  57 3,11,18,21 * * *  (контроль після запуску)
// Cron Trigger: 7 */3 * * *  (раз на 3 години; хвилина :07, а не :00, щоб не потрапляти в пік навантаження Cloudflare)

const REGIONS = [
  ['cherkaska-oblast', 'Черкаська', /черкащин|черкас/],
  ['chernigivska-oblast', 'Чернігівська', /чернігівщин|чернігівськ|чернігів(?![а-яіїєґ])/],
  ['chernivetcka-oblast', 'Чернівецька', /чернівецьк|буковин|чернівц/],
  ['dnipropetrovska-oblast', 'Дніпропетровська', /дніпропетровськ|дніпропетровщин|дніпр/],
  ['donetcka-oblast', 'Донецька', /донеччин|донецьк/],
  ['ivano-frankivska-oblast', 'Івано-Франківська', /івано-франківськ|прикарпат/],
  ['harkivska-oblast', 'Харківська', /харківщин|харківськ|харків/],
  ['hersonska-oblast', 'Херсонська', /херсонщин|херсонськ|херсон/],
  ['hmelnitcka-oblast', 'Хмельницька', /хмельниччин|хмельницьк/],
  ['kyivska-oblast', 'Київська', /київщин|київськ(?:а|ої|ій|у) обл|київська область|київської області|київській області/],
  ['kyiv', 'м. Київ', /(?:^|[^а-яіїєґ])київ(?![а-яіїєґ])|києв|столиц/],
  ['kirovogradska-oblast', 'Кіровоградська', /кіровоградщин|кіровоградськ|кропивницьк/],
  ['luganska-oblast', 'Луганська', /луганщин|луганськ/],
  ['lvivska-oblast', 'Львівська', /львівщин|львівськ|львів/],
  ['mykolaivska-oblast', 'Миколаївська', /миколаївщин|миколаївськ|миколаїв/],
  ['odeska-oblast', 'Одеська', /одещин|одеськ|одес/],
  ['poltavska-oblast', 'Полтавська', /полтавщин|полтавськ|полтав/],
  ['rivnenska-oblast', 'Рівненська', /рівненщин|рівненськ|рівне(?![а-яіїєґ])/],
  ['sumska-oblast', 'Сумська', /сумщин|сумськ|(?:^|[^а-яіїєґ])суми(?![а-яіїєґ])|сумах/],
  ['ternopilska-oblast', 'Тернопільська', /тернопільщин|тернопільськ|тернопіл/],
  ['vinnytcka-oblast', 'Вінницька', /вінниччин|вінницьк|вінниц/],
  ['volynska-oblast', 'Волинська', /волинськ|волині|(?:^|[^а-яіїєґ])волинь|луцьк/],
  ['zakarpatska-oblast', 'Закарпатська', /закарпатт|закарпатськ|ужгород/],
  ['zaporizka-oblast', 'Запорізька', /запоріжж|запорізьк/],
  ['zhytomyrska-oblast', 'Житомирська', /житомирщин|житомирськ|житомир/]
];
const SLUGS = REGIONS.map(r => r[0]);
const NAME = Object.fromEntries(REGIONS.map(r => [r[0], r[1]]));
const ALL_RE = /(?:в|у|по)\s+(?:усіх|всіх)\s+(?:регіон|област)|по\s+всій\s+(?:країн|україн)|всій\s+україні|усіх\s+регіонах/;
const EMERG_RE = /аварійн|екстрен|(?:^|[^а-яіїєґ])гав(?![а-яіїєґ])/;
const CANCEL_RE = /скасован|скасува|відновлен|відновил|повернул|повертаємо|припинен|відмін/;
const MONTHS = { січня: 0, лютого: 1, березня: 2, квітня: 3, травня: 4, червня: 5, липня: 6, серпня: 7, вересня: 8, жовтня: 9, листопада: 10, грудня: 11 };

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const json = (o, status, cors, extra = {}) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', ...cors, ...extra } });
const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const now = () => Date.now();

function htmlToText(h) {
  return String(h).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
function kyivOffsetMs(d) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', timeZoneName: 'longOffset' }).formatToParts(d).find(x => x.type === 'timeZoneName').value; // GMT+03:00
    const m = p.match(/GMT([+-])(\d\d):(\d\d)/); return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60000 : 3 * 3600000;
  } catch { return 3 * 3600000; }
}
const fmtKyiv = ms => new Date(ms).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

// ---------- розпізнавання області і типу повідомлення
function detectScope(lower) {
  if (ALL_RE.test(lower)) return { all: true, slugs: [] };
  return { all: false, slugs: REGIONS.filter(r => r[2].test(lower)).map(r => r[0]) };
}
function classify(text) {
  const lower = text.toLowerCase();
  if (!EMERG_RE.test(lower)) return null;
  const kind = CANCEL_RE.test(lower) ? 'cancel' : 'start';
  return { kind, scope: detectScope(lower) };
}
function snippet(text) {
  const t = text.replace(/\s+/g, ' ').trim(), lower = t.toLowerCase();
  const m = lower.match(/аварійн|екстрен|гав/); const i = m ? m.index : 0;
  const a = Math.max(0, i - 120), b = Math.min(t.length, i + 260);
  return (a ? '…' : '') + t.slice(a, b) + (b < t.length ? '…' : '');
}

// ---------- джерела
async function getText(url, ms = 9000) {
  const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; svitlo-map-monitor; +https://valdemarpiguet.github.io/svitlo-map/)', 'accept-language': 'uk,en;q=0.8' }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
function parseTgChannel(html, channel) {
  const out = [];
  for (const p of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = (p.match(/data-post="([^"]+)"/) || [])[1];
    const body = (p.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
    const when = (p.match(/<time[^>]*datetime="([^"]+)"/) || [])[1];
    if (!post || !body) continue;
    out.push({ key: 'tg:' + post, text: htmlToText(body), time: when ? Date.parse(when) : null, source: { name: 'Telegram @' + channel, url: 'https://t.me/' + post } });
  }
  return out;
}
function parseNews(html, base) {
  const HEAD = 'Новини по відключенням світла', i0 = html.indexOf(HEAD);
  if (i0 < 0) return [];
  let seg = htmlToText(html.slice(i0, i0 + 24000)).slice(HEAD.length);          // не перетворюємо всю сторінку (≈300 КБ): так економимо процесорний час Worker
  const j = seg.search(/УВАГА!|\nУкраїна\n/); if (j > 0) seg = seg.slice(0, j);
  const out = [], re = /(\d{1,2})\s+(січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня),?\s+(\d{1,2}):(\d{2})/g;
  let last = 0, m; const year = new Date().getFullYear();
  while ((m = re.exec(seg))) {
    const chunk = seg.slice(last, m.index).replace(/\s+/g, ' ').trim(); last = m.index + m[0].length;
    if (!chunk) continue;
    const guess = Date.UTC(year, MONTHS[m[2]], +m[1], +m[3], +m[4]);
    out.push({ key: 'news:' + hash(chunk), text: chunk, time: guess - kyivOffsetMs(new Date(guess)), source: { name: 'alerts.org.ua (новини)', url: base } });
  }
  return out;
}
async function collect(env) {
  const cands = [], health = {};
  const run = async (name, fn) => { try { const c = await fn(); cands.push(...c); health[name] = { ok: true }; } catch (e) { health[name] = { ok: false, err: String(e.message || e).slice(0, 80) }; } };
  const newsUrl = env.NEWS_URL || 'https://alerts.org.ua/';
  await run('alerts.org.ua', async () => parseNews(await getText(newsUrl), newsUrl));
  for (const ch of String(env.TG_CHANNELS || '').split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean))
    await run('@' + ch, async () => parseTgChannel(await getText('https://t.me/s/' + ch), ch));
  if (env.SVITLO_API) await run('svitlo.live', async () => {
    let raw = JSON.parse(await getText(env.SVITLO_API)); if (typeof raw.body === 'string') raw = JSON.parse(raw.body);
    const map = { 'kiivska-oblast': 'kyivska-oblast', ...(env.SVITLO_MAP ? JSON.parse(env.SVITLO_MAP) : {}) }, out = [];
    health._cpus = (raw.regions || []).map(r => r.cpu).join(',');
    for (const r of raw.regions || []) if (r.emergency && map[r.cpu])
      out.push({ key: 'sv:' + r.cpu + ':' + Math.floor(now() / (6 * 3600000)), text: 'svitlo.live: для області ' + NAME[map[r.cpu]] + ' зафіксовано ознаку екстрених відключень (emergency).', time: now(), forced: { all: false, slugs: [map[r.cpu]] }, kind: 'start', source: { name: 'svitlo.live', url: 'https://svitlo.live/' } });
    return out;
  });
  return { cands, health };
}

// ---------- сховище й Telegram
const kvGet = async (env, k, def) => { try { const v = await env.KV.get(k); return v ? JSON.parse(v) : def; } catch { return def; } };
const kvPut = (env, k, v, ttl) => env.KV.put(k, JSON.stringify(v), ttl ? { expirationTtl: ttl } : undefined);
async function tg(env, method, body) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.ok;
}
const say = (env, text, markup) => tg(env, 'sendMessage', { chat_id: env.CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });

async function getAlerts(env) {
  const a = await kvGet(env, 'alerts', { updatedAt: null, items: [] });
  const t = now(); a.items = (a.items || []).filter(i => Date.parse(i.expires) > t); return a;
}
async function putAlerts(env, items) { await kvPut(env, 'alerts', { updatedAt: new Date().toISOString(), items }); }
const scopeKey = s => s === 'all' ? 'all' : [...s].sort().join(',');
async function addAlert(env, scope, source, hours) {
  const a = await getAlerts(env), ms = (hours || +env.ALERT_HOURS || 12) * 3600000, k = scopeKey(scope);
  const exp = new Date(now() + ms).toISOString(), ex = a.items.find(i => scopeKey(i.scope) === k);
  if (ex) { ex.expires = exp; if (source) ex.source = source; }
  else a.items.push({ id: 'a' + now().toString(36), scope, title: 'Введені екстрені відключення', text: 'Заздалегідь опубліковані графіки відключень у цих областях тимчасово не діють. Слідкуйте за повідомленнями обленерго.', since: new Date().toISOString(), expires: exp, source: source || null });
  await putAlerts(env, a.items); return a.items;
}
async function removeAlerts(env, scope) {
  const a = await getAlerts(env);
  let removed = 0, hasAll = a.items.some(i => i.scope === 'all');
  if (scope === 'all') { removed = a.items.length; a.items = []; }
  else a.items = a.items.map(i => { if (i.scope === 'all') return i; const keep = i.scope.filter(s => !scope.includes(s)); removed += i.scope.length - keep.length; return { ...i, scope: keep }; }).filter(i => i.scope === 'all' || i.scope.length);
  await putAlerts(env, a.items); return { removed, blockedByAll: scope !== 'all' && removed === 0 && hasAll };
}
const whereText = sc => sc.all ? 'вся країна' : (sc.slugs.length ? sc.slugs.map(s => NAME[s]).join(', ') : 'області не визначено');

async function notify(env, c) {
  const id = hash(c.key + now()), sc = c.forced || c.scope;
  await kvPut(env, 'pending:' + id, { scope: sc, kind: c.kind, source: c.source }, 86400);
  const head = c.kind === 'start' ? '⚠️ <b>Можливо, введені екстрені відключення</b>' : '✅ <b>Можливо, екстрені відключення скасовано</b>';
  const text = `${head}\n\n<i>${esc(c.source.name)}</i>${c.time ? ' · ' + esc(fmtKyiv(c.time)) : ''}\n«${esc(snippet(c.text))}»\n\n<b>Області:</b> ${esc(whereText(sc))}${c.source.url ? '\n' + esc(c.source.url) : ''}`;
  const rows = [];
  if (c.kind === 'start') {
    if (sc.all) rows.push([{ text: '✅ Увімкнути для всієї країни', callback_data: `on:${id}:all` }]);
    else { if (sc.slugs.length) rows.push([{ text: '✅ Увімкнути: ' + sc.slugs.map(s => NAME[s]).join(', ').slice(0, 40), callback_data: `on:${id}:det` }]); rows.push([{ text: '🌍 Вся країна', callback_data: `on:${id}:all` }]); }
  } else rows.push([{ text: sc.all ? '✅ Вимкнути всі попередження' : '✅ Вимкнути' + (sc.slugs.length ? '' : ' (всі)'), callback_data: `off:${id}:${sc.all || !sc.slugs.length ? 'all' : 'det'}` }]);
  rows.push([{ text: '🙈 Ігнорувати', callback_data: `ig:${id}` }]);
  return say(env, text, { inline_keyboard: rows });
}

async function runChecks(env) {
  // автоматичне зняття прострочених попереджень (сповіщаємо власника)
  const raw = await kvGet(env, 'alerts', { items: [] }), live = await getAlerts(env);
  if ((raw.items || []).length !== live.items.length) { await putAlerts(env, live.items); await say(env, `ℹ️ Попередження вимкнулось автоматично через ${+env.ALERT_HOURS || 12} год. Щоб продовжити: /on all або /on <область>.`); }
  const { cands, health } = await collect(env);
  const hs = await kvGet(env, 'health', {}); let changed = false;
  for (const [n, h] of Object.entries(health)) {
    if (n === '_cpus') { if (hs._cpus !== h) { hs._cpus = h; changed = true } continue; }
    const p = hs[n] || { fails: 0 };
    if (h.ok) { if (p.fails) { hs[n] = { ok: true, fails: 0 }; changed = true; } else if (!hs[n]) { hs[n] = { ok: true, fails: 0 }; changed = true; } }
    else { const f = (p.fails || 0) + 1; hs[n] = { ok: false, fails: f, err: h.err, at: now() }; changed = true; if (f === 2) await say(env, `🔧 Джерело «${esc(n)}» недоступне вже 2 перевірки поспіль (${esc(h.err)}). Решта джерел працюють.`); }
  }
  if (changed) await kvPut(env, 'health', hs);
  const maxAge = 18 * 3600000, fresh = [];
  for (const c of cands) {
    if (c.time && now() - c.time > maxAge) continue;
    if (await env.KV.get('seen:' + c.key)) continue;
    let cc = c;
    if (!c.forced) { const k = classify(c.text); if (!k) continue; cc = { ...c, kind: k.kind, scope: k.scope }; }
    fresh.push(cc);
  }
  const overlap = (a, b) => a.all || b.all || !a.slugs.length || !b.slugs.length || a.slugs.some(x => b.slugs.includes(x));
  const active = (await getAlerts(env)).items;
  let sent = 0;
  for (const c of fresh) {
    const sc = c.forced || c.scope;
    await kvPut(env, 'seen:' + c.key, 1, 3 * 86400);
    if (c.kind === 'start' && c.time && fresh.some(o => o.kind === 'cancel' && o.time && o.time > c.time && overlap(sc, o.forced || o.scope))) continue;   // уже скасовано: подія завершилась між перевірками
    if (c.kind === 'cancel' && !active.some(i => i.scope === 'all' || sc.all || !sc.slugs.length || i.scope.some(x => sc.slugs.includes(x)))) continue;   // нічого скасовувати: попередження не було ввімкнено
    if (sent < 5) { await notify(env, c); sent++; }
  }
  return { cands: cands.length, sent };
}

// ---------- свіжість даних: чи оновився data/ua.json
const ACTIONS_URL = env => env.GH_REPO ? `https://github.com/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW || 'update.yml'}` : '';
async function dataAge(env) {
  const base = String(env.ALLOWED_ORIGIN || '').split(',')[0].trim();
  const url = env.DATA_URL || (base ? base + (/github\.io/.test(base) ? '/svitlo-map/data/ua.json' : '/data/ua.json') : '');
  if (!url) return { skip: true };
  try {
    const r = await fetch(url + (url.includes('?') ? '&' : '?') + 't=' + now(), { signal: AbortSignal.timeout(10000), headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) return { err: 'HTTP ' + r.status };
    const j = JSON.parse(await r.text()), t = Date.parse(j.fetchedAt);
    if (!Number.isFinite(t)) return { err: 'у файлі немає fetchedAt' };
    return { t, ageMin: Math.round((now() - t) / 60000) };
  } catch (e) { return { err: String(e.message || e).slice(0, 80) }; }
}
const fmtAge = m => m >= 120 ? `${Math.round(m / 60)} год` : `${m} хв`;
async function checkFreshness(env, maxAgeMin, force) {
  const a = await dataAge(env);
  if (a.skip) return { skipped: true };
  const stale = a.err || a.ageMin > maxAgeMin;
  if (!stale) { await env.KV.delete('stale:notified'); return { ok: true, ageMin: a.ageMin }; }
  if (!force && await env.KV.get('stale:notified')) return { stale: true, muted: true };     // не частіше, ніж раз на 6 годин
  await kvPut(env, 'stale:notified', 1, 6 * 3600);
  const head = a.err ? `⚠️ <b>Не вдалося перевірити дані сайту</b> (${esc(a.err)}).` : `⚠️ <b>Графіки не оновлювались ${esc(fmtAge(a.ageMin))}.</b> Останнє оновлення: ${esc(fmtKyiv(a.t))} за Києвом.`;
  const rows = env.GH_TOKEN ? [[{ text: '🔄 Оновити зараз', callback_data: 'upd' }]] : (ACTIONS_URL(env) ? [[{ text: 'Відкрити GitHub Actions', url: ACTIONS_URL(env) }]] : []);
  await say(env, head + '\nЯкщо оновлення не почалося само, запустіть його вручну.', rows.length ? { inline_keyboard: rows } : undefined);
  return { stale: true, notified: true };
}

// ---------- запуск оновлення даних у GitHub Actions (надійніше за власний розклад GitHub)
async function dispatchUpdate(env) {
  if (!env.GH_TOKEN || !env.GH_REPO) return { ok: false, desc: 'GH_TOKEN або GH_REPO не задано' };
  try {
    const r = await fetch(`https://api.github.com/repos/${env.GH_REPO}/actions/workflows/${env.GH_WORKFLOW || 'update.yml'}/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'svitlo-map-worker', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: env.GH_REF || 'main' }), signal: AbortSignal.timeout(10000)
    });
    if (r.status === 204) return { ok: true, desc: '' };
    let j = {}; try { j = await r.json(); } catch { /* немає тіла */ }
    return { ok: false, desc: `HTTP ${r.status}${j.message ? ': ' + j.message : ''}` };
  } catch (e) { return { ok: false, desc: String(e.message || e).slice(0, 120) }; }
}
async function scheduledDispatch(env) {
  const r = await dispatchUpdate(env);
  if (!r.ok) await say(env, `⚠️ Не вдалося запустити оновлення даних у GitHub: ${esc(r.desc)}\nПеревірте токен GH_TOKEN (термін дії, права Actions: Read and write).`);
  return r;
}

// ---------- веб-хук Telegram: кнопки та команди (лише власник)
async function onCallback(env, q) {
  if (String(q.from && q.from.id) !== String(env.CHAT_ID)) return;
  const [act, id, k] = String(q.data || '').split(':');
  await tg(env, 'answerCallbackQuery', { callback_query_id: q.id });
  if (q.message) await tg(env, 'editMessageReplyMarkup', { chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } });
  if (act === 'ig') return say(env, '🙈 Проігноровано.');
  if (act === 'upd') { const r = await dispatchUpdate(env); return say(env, r.ok ? '✅ Оновлення запущено. Воно триває 1–2 хвилини, потім сайт оновиться ще за 1–3 хвилини.' : `❌ Не вдалося запустити: ${esc(r.desc)}`); }
  const p = await kvGet(env, 'pending:' + id, null);
  if (!p) return say(env, 'Пропозиція застаріла. Скористайтесь командою /on або /off.');
  if (act === 'on') { const sc = k === 'all' ? 'all' : p.scope.slugs; if (sc !== 'all' && !sc.length) return say(env, 'Області не визначено. Скористайтесь /on <область> (список: /regions).'); await addAlert(env, sc, p.source); return say(env, `✅ Попередження увімкнено: ${esc(sc === 'all' ? 'вся країна' : sc.map(s => NAME[s]).join(', '))}. Сайт покаже його протягом кількох хвилин.`); }
  if (act === 'off') { const r = await removeAlerts(env, k === 'all' ? 'all' : p.scope.slugs); return say(env, r.blockedByAll ? 'ℹ️ Діє попередження для всієї країни, окремі області з нього не зняти. Вимкнути його: /off all' : `✅ Вимкнено (знято: ${r.removed}).`); }
}
async function onCommand(env, text) {
  const m = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s); if (!m) return;
  const cmd = m[1].toLowerCase(), args = m[2].split(/\s+/).filter(Boolean);
  const parse = () => { let hours = null; const s = []; let all = false, bad = [];
    for (const a of args) { if (a === 'all') all = true; else if (/^\d{1,2}h?$/.test(a)) hours = +a.replace('h', ''); else if (SLUGS.includes(a)) s.push(a); else bad.push(a); }
    return { hours, scope: all ? 'all' : s, bad }; };
  if (cmd === 'on') { const p = parse(); if (p.bad.length) return say(env, `Невідомо: ${esc(p.bad.join(', '))}. Список: /regions`);
    if (p.scope !== 'all' && !p.scope.length) return say(env, 'Вкажіть: /on all або /on kyivska-oblast odeska-oblast [6h]');
    await addAlert(env, p.scope, { name: 'Вручну', url: '' }, p.hours); return say(env, `✅ Увімкнено: ${esc(p.scope === 'all' ? 'вся країна' : p.scope.map(s => NAME[s]).join(', '))} на ${p.hours || +env.ALERT_HOURS || 12} год.`); }
  if (cmd === 'off') { const p = parse(); if (p.bad.length) return say(env, `Невідомо: ${esc(p.bad.join(', '))}. Список: /regions`);
    const r = await removeAlerts(env, p.scope === 'all' || !p.scope.length ? 'all' : p.scope); return say(env, r.blockedByAll ? 'ℹ️ Діє попередження для всієї країни, окремі області з нього не зняти. Вимкнути його: /off all' : `✅ Вимкнено (знято: ${r.removed}).`); }
  if (cmd === 'checkdata') {
    const a = await dataAge(env);
    if (a.skip) return say(env, 'Адресу даних не задано (ALLOWED_ORIGIN або DATA_URL).');
    if (a.err) return say(env, `❌ Не вдалося прочитати дані сайту: ${esc(a.err)}`);
    if (a.ageMin <= 10 * 60) return say(env, `✅ Дані свіжі: оновлено ${esc(fmtKyiv(a.t))} за Києвом (${esc(fmtAge(a.ageMin))} тому).`);
    return checkFreshness(env, 10 * 60, true);
  }
  if (cmd === 'update') {                                                  // ручний запуск оновлення даних з телефона
    const r = await dispatchUpdate(env);
    return say(env, r.ok ? '✅ Оновлення даних запущено. Воно триватиме 1–2 хвилини, потім сайт оновиться ще за 1–3 хвилини.' : `❌ Не вдалося запустити: ${esc(r.desc)}`);
  }
  if (cmd === 'fbtest') {                                                  // перевірка окремого бота для форми
    const r = await feedbackSend(env, '🧪 Тест: форма зворотного зв\'язку працює.');
    return say(env, r.ok ? `✅ Тестове повідомлення надіслано ${env.FEEDBACK_BOT_TOKEN ? 'окремим ботом' : 'основним ботом (FEEDBACK_BOT_TOKEN не задано)'}. Перевірте його чат.` : `❌ Не вдалося надіслати: ${esc(r.desc)}\nПеревірте змінну FEEDBACK_BOT_TOKEN (без пробілів), що в окремого бота натиснуто Start, і що після додавання змінної натиснуто Deploy.`);
  }
  if (cmd === 'regions') return say(env, SLUGS.map(s => `<code>${s}</code> — ${esc(NAME[s])}`).join('\n'));
  if (cmd === 'status') {
    const a = await getAlerts(env), hs = await kvGet(env, 'health', {});
    const lines = a.items.length ? a.items.map(i => `• ${i.scope === 'all' ? 'вся країна' : i.scope.map(s => NAME[s]).join(', ')} — до ${esc(fmtKyiv(Date.parse(i.expires)))}`) : ['• чинних попереджень немає'];
    const src = Object.entries(hs).filter(([n]) => n !== '_cpus').map(([n, h]) => `• ${esc(n)}: ${h.ok ? 'ок' : 'недоступне (' + esc(h.err) + ')'}`);
    const da = await dataAge(env), dline = da.skip ? '' : (da.err ? `\n\n<b>Дані сайту</b>: не вдалося прочитати (${esc(da.err)})` : `\n\n<b>Дані сайту</b>: оновлено ${esc(fmtKyiv(da.t))} (${esc(fmtAge(da.ageMin))} тому)`);
    return say(env, `<b>Чинні попередження</b>\n${lines.join('\n')}\n\n<b>Джерела</b>\n${src.join('\n') || '• ще не перевірялись'}${hs._cpus ? `\n\n<b>svitlo.live (cpu)</b>: ${esc(hs._cpus)}` : ''}${dline}`);
  }
  return say(env, '<b>Команди</b>\n/on all — увімкнути для всієї країни\n/on kyivska-oblast odeska-oblast [6h] — для областей (час у годинах, за замовчуванням 12)\n/off [all|область…] — вимкнути\n/status — стан\n/regions — список областей\n/fbtest — перевірити окремого бота для форми\n/update — запустити оновлення графіків прямо зараз\n/checkdata — перевірити, коли востаннє оновлювались дані сайту');
}
async function handleTg(request, env) {
  if (!env.WEBHOOK_SECRET || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) return new Response('forbidden', { status: 403 });
  let u; try { u = await request.json(); } catch { return new Response('bad', { status: 400 }); }
  if (u.callback_query) await onCallback(env, u.callback_query);
  else if (u.message && u.message.text && String(u.message.from && u.message.from.id) === String(env.CHAT_ID)) await onCommand(env, u.message.text);
  return new Response('ok');
}

// ---------- форма зворотного зв'язку
const TYPES = ['Пропозиція', 'Помилка', 'Інше'];
async function feedbackSend(env, text) {          // зворотний зв'язок іде окремим ботом, якщо задано FEEDBACK_BOT_TOKEN
  const token = env.FEEDBACK_BOT_TOKEN || env.BOT_TOKEN, chat = env.FEEDBACK_CHAT_ID || env.CHAT_ID;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true }), signal: AbortSignal.timeout(+env.TG_TIMEOUT_MS || 8000) });
    let j = {}; try { j = await r.json(); } catch { /* немає тіла */ }
    return { ok: r.ok, desc: j.description || ('HTTP ' + r.status) };
  } catch (e) { return { ok: false, desc: (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? 'Telegram не відповів вчасно (timeout)' : String(e.message || e).slice(0, 120) }; }
}
async function handleFeedback(request, env, cors) {
  const T0 = Date.now(), t = {};
  let d; try { const x = await request.text(); if (x.length > 8000) return json({ ok: false, error: 'too_large' }, 413, cors); d = JSON.parse(x); } catch { return json({ ok: false, error: 'bad_json' }, 400, cors); }
  if (d.hp) return json({ ok: true }, 200, cors);
  const message = String(d.message || '').trim().slice(0, 2000); if (message.length < 5) return json({ ok: false, error: 'short' }, 400, cors);
  const type = TYPES.includes(d.type) ? d.type : 'Інше', contact = String(d.contact || '').trim().slice(0, 120), ctx = String(d.ctx || '').slice(0, 800);
  const ip = request.headers.get('CF-Connecting-IP') || 'x', key = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`;
  const n = +(await env.KV.get(key) || 0); t.kv = Date.now() - T0;
  if (n >= 5) return json({ ok: false, error: 'rate' }, 429, cors);                                                   // ліміт: 5 повідомлень на годину з одного IP
  const r = await feedbackSend(env, `📩 <b>${esc(type)}</b>\n\n${esc(message)}\n\n<b>Контакт:</b> ${esc(contact || 'не вказано')}\n<pre>${esc(ctx)}</pre>`); t.tg = Date.now() - T0 - t.kv;
  console.log('feedback', JSON.stringify({ ok: r.ok, desc: r.ok ? '' : r.desc, kvMs: t.kv, tgMs: t.tg, colo: request.cf && request.cf.colo }));     // видно в Logs Worker
  if (!r.ok) return json({ ok: false, error: 'telegram', detail: r.desc, t }, 502, cors);
  await env.KV.put(key, String(n + 1), { expirationTtl: 3700 });                                                      // рахуємо лише успішні відправки
  return json({ ok: true, t }, 200, cors);
}

export default {
  async scheduled(event, env, ctx) {
    if (env.GH_TOKEN && event.cron === (env.DISPATCH_CRON || '17 3,11,18,21 * * *')) ctx.waitUntil(scheduledDispatch(env));
    else if (event.cron === (env.CONTROL_CRON || '57 3,11,18,21 * * *')) ctx.waitUntil(checkFreshness(env, 60));          // після запуску дані мають бути свіжими (< 60 хв)
    else ctx.waitUntil(runChecks(env).then(() => checkFreshness(env, 10 * 60)));                                         // загальна перевірка: дані не старші за 10 годин
  },
  async fetch(request, env) {
    const url = new URL(request.url), origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean), okOrigin = allowed.includes(origin);
    const cors = { 'Access-Control-Allow-Origin': okOrigin ? origin : (allowed[0] || ''), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (url.pathname === '/tg' && request.method === 'POST') return handleTg(request, env);
    if (url.pathname === '/alerts' && request.method === 'GET') {
      const a = await getAlerts(env);
      return json({ updatedAt: a.updatedAt, serverTime: new Date().toISOString(), items: a.items }, 200, cors, { 'Cache-Control': 'public, max-age=30' });
    }
    if (request.method === 'POST' && (url.pathname === '/' || url.pathname === '/feedback')) { if (!okOrigin) return json({ ok: false, error: 'origin' }, 403, cors); return handleFeedback(request, env, cors); }
    return json({ ok: false, error: 'not_found' }, 404, cors);
  }
};
export { classify, detectScope, parseTgChannel, parseNews, htmlToText, runChecks };
