/* ОБРАБОТЧИК ФОТО ТОВАРОВ SCANDI (27–28.10.2026).
   Два раздела: «Одно фото» и «Пакет до 20»; товар указывают артикулом или штрихкодом.
   Каждое фото даёт вариант на белом фоне (карточка) и, если есть размер, вариант с разметкой (31.10.2026, Амир:
   студийный убран; «эмоциональные» снимки на столе с декором снимаются и идут на сайт без обработчика).
   Тарелки и салатницы снимают сверху: только белый фон. Кружки, вазы и остальное — сбоку: белый фон и размер.
   Ластик правит вырез, и варианты этого снимка собираются заново.
   1. Товар → по списку (skus.json) находим артикул, название и раздел; нет в списке — «Без раздела».
   2. Фото → вырезаем товар из фона прямо в браузере (@imgly/background-removal, модель ISNet),
      ставим по центру на белый квадрат 1400 px с мягкой тенью → JPEG.
   3. Имя файла — артикул: первое фото артикула «30295656.jpg» (главное, для карточки), дальше
      «30295656 (2).jpg», «(3)»… — так их ждёт сборщик фото сайта (photos-in → photos-build.py).
   4. Пакет по штрихкодам: снимок этикетки со штрихкодом открывает товар, следующие снимки до
      следующего штрихкода — его фото. Снимок штрихкода не обрабатывается и не сохраняется.
   5. Всё хранится в браузере (IndexedDB) до очистки; скачать — раздел или всё, папками по разделам. */
/* Библиотеки и модель лежат у нас (vendor/, bg/), а не на CDN: 28.10.2026 загрузка модели со staticimgly.com
   обрывалась с «Failed to fetch». Свой адрес надёжнее, и всё кешируется браузером. */
import { removeBackground, preload } from './vendor/bg-removal.mjs';
import { readBarcodes } from './vendor/zxing-reader.mjs';

const SIZE = 1400;          // сторона готового квадрата
const FILL = 0.82;          // доля квадрата, которую занимает товар
const INPUT_MAX = 1600;     // большие снимки телефона уменьшаем до вырезания — быстрее и хватает
const BATCH_MAX = 20;
const NO_FOLDER = 'Без раздела';
const BG_CONFIG = {
  model: 'isnet_fp16',      // 88 МБ, один раз; качество почти как у полной модели
  publicPath: new URL('bg/', window.location.href).href,
  output: { format: 'image/png' },
};

const $ = (id) => document.getElementById(id);
const el = {
  sku: $('sku'), skuPick: $('sku-pick'), info: $('sku-info'), file: $('file'), pick: $('pick-label'),
  oneBarcode: $('one-barcode'), bcFile: $('bc-file'), bc: $('bc'), bcInfo: $('bc-info'),
  one: $('one'), batch: $('batch'), batchHow: $('batch-how'), batchFiles: $('batch-files'), plan: $('plan'), planActions: $('plan-actions'), planGo: $('plan-go'), planCancel: $('plan-cancel'),
  work: $('work'), before: $('before'), afterCard: $('after-card'), afterSize: $('after-size'), sizeFig: $('size-fig'), eraseBtn: $('erase-btn'), status: $('status'), bar: $('bar'), oneSize: $('one-size'),
  folders: $('folders'), total: $('total'), dlAll: $('dl-all'), clear: $('clear'), src: $('skus-src'),
};
const state = { mode: 'one', id: 'sku', busy: false, plan: null, lastShot: null };

/* ---------- Товары: артикулы и штрихкоды ----------
   skus.json (v2): строки [артикул, штрихкод, название, раздел, ключ]. Ключ — имя файла: артикул, если он в списке
   один; у 71 артикула из выгрузки Billz по Чимгану (27.10) товары разные («SH-632» — и цветы, и отдушка) —
   тогда штрихкод, а если повторяется и он — «артикул_штрихкод». Иначе фото разных товаров слиплись бы. */
let ITEMS = [];
const BY_SKU = new Map();
const BY_BC = new Map();
const keyOf = (s) => String(s || '').replace(/[^0-9A-Za-zА-Яа-яЁё]/g, '').toUpperCase();
const bcKey = (s) => keyOf(s).replace(/^0+/, '');      // EAN-13 и UPC-A — одно и то же с ведущим нулём
// Имя файла: «/» и прочее недопустимое в имени — дефисом, как в photos-in.
const fileSafe = (s) => String(s || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ');
const push = (map, k, item) => { if (!k) return; if (!map.has(k)) map.set(k, []); map.get(k).push(item); };
const uniq = (list) => { const seen = new Set(); return (list || []).filter((x) => !seen.has(keyOf(x.k)) && seen.add(keyOf(x.k))); };
const bySku = (sku) => uniq(BY_SKU.get(keyOf(sku)));
const byBarcode = (code) => uniq(BY_BC.get(bcKey(code)));

async function loadSkus() {
  try {
    const res = await fetch('skus.json', { cache: 'no-cache' });
    const data = await res.json();
    // ph — фото на сайте: 2 — хорошее (своё), 1 — мелкое из Billz, 0 — товара на сайте нет.
    ITEMS = (data.items || []).map(([s, b, n, c, k, ph]) => ({ s, b, n, c, k: k || s, ph: ph || 0 }));
    for (const it of ITEMS) { push(BY_SKU, keyOf(it.s), it); push(BY_BC, bcKey(it.b), it); }
    el.src.textContent = `${ITEMS.length} товаров (${BY_BC.size} штрихкодов), ${data.source}${data.updated ? ` от ${data.updated}` : ''}`;
  } catch {
    el.src.textContent = 'не загрузился — все фото пойдут в «Без раздела»';
  }
}

/* РАЗМЕР. Разбираем «21x30 см», «9х9х32.5см», «52*33», «Ø26 см», «30 см»; единицы см, мм, м, по умолчанию см.
   В названиях Billz он есть примерно у трети товаров; не нашёлся — вписывают руками, с этикетки. */
const NUM = '\\d+(?:[.,]\\d+)?';
const X = '\\s*[xхХX×*]\\s*';
const UNIT = '(см|cm|мм|mm|м|m)(?![а-яa-z])';
const RE_SIZE3 = new RegExp(`(${NUM})${X}(${NUM})${X}(${NUM})\\s*(?:${UNIT})?`, 'i');
const RE_SIZE2 = new RegExp(`(${NUM})${X}(${NUM})\\s*(?:${UNIT})?(?!\\s*шт)`, 'i');
const RE_SIZE1 = new RegExp(`(${NUM})\\s*${UNIT}`, 'i');
const unitRu = (u) => ({ cm: 'см', mm: 'мм', m: 'м' }[String(u || '').toLowerCase()] || String(u || 'см').toLowerCase());
/* ОБЪЁМ ВМЕСТО СМ (Амир, 31.10.2026): кружка, графин и подобное — это миллилитры. «0,5 л» и «31 сл» в названиях
   приводим к мл. Подстаканник, свеча в стакане и ваза-кувшин — не посуда для питья: у них остаются сантиметры. */
const VESSEL = /кружк|графин|стакан|бокал|чашк|чайник|кувшин|термос|бутылк|фужер|рюмк|пиал|кофейник|кофеварк|кофепресс|заварник|молочник|сливочник/i;
const NOT_VESSEL = /свеч|подстакан|подстав|держател|ваз[аы]|сито|щ[её]т|[её]ршик|игруш|брелок|сортер|пирамид|стаканчик|контейнер|мельниц|органайзер|гипс/i;
const isVessel = (name) => VESSEL.test(name || '') && !NOT_VESSEL.test(name || '');
const RE_VOLUME = new RegExp(`(${NUM})\\s*(мл|ml|сл|cl|л|l)(?![а-яa-z])`, 'i');
const ML_IN = { 'мл': 1, ml: 1, 'сл': 10, cl: 10, 'л': 1000, l: 1000 };
function parseVolume(text) {
  const m = RE_VOLUME.exec(String(text || ''));
  return m ? Math.round(Number(m[1].replace(',', '.')) * ML_IN[m[2].toLowerCase()]) : null;
}
// vessel: у кружки просто «350» в поле — миллилитры; маленькое число («2», «0,5») — литры: «2 мл» на графине, 31.10.2026.
function parseSize(text, vessel = false) {
  const t = String(text || '');
  const num = (v) => Number(v.replace(',', '.'));
  const ml = parseVolume(t);
  if (ml) return { ml };
  if (vessel && new RegExp(`^\\s*${NUM}\\s*$`).test(t)) {
    const n = num(t.trim());
    return { ml: Math.round(n < 20 ? n * 1000 : n) };
  }
  let m = RE_SIZE3.exec(t);
  if (m) return { vals: [num(m[1]), num(m[2]), num(m[3])], unit: unitRu(m[4]) };
  m = RE_SIZE2.exec(t);
  if (m) return { vals: [num(m[1]), num(m[2])], unit: unitRu(m[3]) };
  m = RE_SIZE1.exec(t);
  return m ? { vals: [num(m[1])], unit: unitRu(m[2]) } : null;
}
const sizeNum = (v) => String(v).replace('.', ',');
const sizeLabel = (v, unit) => `${sizeNum(v)} ${unit}`;
// Тарелки и салатницы — только белый фон, размер из названия не подставляем. Вписанный вручную размер сработает.
const TOP_VIEW = /тарел|блюд|поднос|салатн|менажн/i;
function sizeFromName(name) {
  // Кружка и графин — раньше тарелок: «Чашка с блюдцем» иначе попала бы к тарелкам.
  if (isVessel(name)) { const ml = parseVolume(name); return ml ? `${ml} мл` : ''; }
  if (TOP_VIEW.test(name)) return '';
  const z = parseSize(name);
  if (z?.ml && !/\d\s*(мл|ml)(?![а-яa-z])/i.test(name)) return '';   // «Мусорное ведро 10 л» — не в миллилитрах
  if (z?.ml) return `${z.ml} мл`;
  return z ? `${z.vals.map(sizeNum).join('×')} ${z.unit}` : '';
}

const sizeHint = (name) => (isVessel(name) ? 'Объём, например 350 мл' : 'Например, 21x30 см или 26 см');

/* ВЫБОР ТОВАРА: поле артикула + (если товаров с таким артикулом или штрихкодом несколько) список «какой из них»
   + строка-подсказка. result(): { key, item } — key пойдёт в имя файла; null — товар ещё не указан или не выбран. */
function makePicker({ input, select, info, size, placeholder = 'Введите артикул.', onChange = () => {} }) {
  const st = { items: [], chosen: null, barcode: '' };
  const api = {
    result() {
      const sizeText = size?.value.trim() || '';
      if (st.chosen) return { key: st.chosen.k, item: st.chosen, size: sizeText };
      if (st.items.length > 1) return null;
      const text = input.value.trim();
      return text ? { key: text, item: null, size: sizeText } : null;
    },
    setBarcode(code) {
      st.barcode = code;
      if (size) delete size.dataset.manual;
      const items = byBarcode(code);
      input.value = items.length ? items[0].s : '';
      fill(items);
      showInfo(); onChange();
    },
    refresh: () => showInfo(),
  };
  function showInfo() {
    info.className = info.className.replace(/\s*is-(ok|warn)/g, '');
    // Размер — из названия товара, пока человек не вписал свой.
    if (size && !size.dataset.manual) size.value = st.chosen ? sizeFromName(st.chosen.n) : '';
    if (size) size.placeholder = sizeHint(st.chosen?.n);
    const r = api.result();
    const text = input.value.trim();
    if (st.items.length > 1 && !st.chosen) { info.classList.add('is-warn'); info.textContent = `${st.barcode ? 'Штрихкод' : 'Артикул'} у ${st.items.length} разных товаров — выберите, какой снимаете.`; return; }
    if (r?.item) {
      info.classList.add(r.item.ph === 2 ? 'is-warn' : 'is-ok');
      // Хорошее фото уже на сайте — снимать не обязательно (28.10.2026: не делать лишнюю работу).
      info.textContent = `${r.item.ph === 2 ? '📷 На сайте уже есть хорошее фото — можно не снимать. ' : '✓ '}${r.item.n} · раздел «${r.item.c}» · файл ${fileSafe(r.key)}.jpg`;
      return;
    }
    if (text) { info.classList.add('is-warn'); info.textContent = st.barcode ? `Штрихкод ${st.barcode} — в списке не нашёлся. Фото попадёт в «${NO_FOLDER}» под именем ${fileSafe(text)}.jpg.` : `Артикула нет в списке — фото попадёт в «${NO_FOLDER}». Проверьте, нет ли опечатки.`; return; }
    info.textContent = st.barcode ? `Штрихкод ${st.barcode} — в списке не нашёлся. Впишите артикул.` : placeholder;
  }
  function fill(items) {
    st.items = items;
    st.chosen = items.length === 1 ? items[0] : null;
    select.hidden = items.length < 2;
    select.replaceChildren(new Option('— какой товар? —', ''), ...items.map((it, i) => new Option(`${it.n} · ${it.b || it.s}`, String(i))));
  }
  input.addEventListener('input', () => { st.barcode = ''; if (size) delete size.dataset.manual; fill(bySku(input.value.trim())); showInfo(); onChange(); });
  size?.addEventListener('input', () => { if (size.value.trim()) size.dataset.manual = '1'; else delete size.dataset.manual; onChange(); });
  select.addEventListener('change', () => { st.chosen = st.items[Number(select.value)] || null; showInfo(); onChange(); });
  if (input.value.trim()) fill(bySku(input.value.trim()));
  showInfo();
  return api;
}

// Поле + список + подсказка для раскладки пакета.
function pickerBox(value, ph) {
  const input = document.createElement('input');
  input.className = 'field__input';
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = ph;
  input.value = value || '';
  const select = document.createElement('select');
  select.className = 'field__input field__select';
  select.hidden = true;
  const info = document.createElement('p');
  info.className = 'group__info';
  const size = document.createElement('input');
  size.className = 'field__input field__size';
  size.type = 'text';
  size.autocomplete = 'off';
  size.placeholder = sizeHint();
  const wrap = document.createElement('div');
  wrap.className = 'pickbox';
  wrap.append(input, select, info, size);
  return { wrap, input, select, info, size };
}

/* Открыть снимок. HEIC (iPhone) открывает только Safari — в остальных браузерах понятная ошибка вместо
   «The source image could not be decoded». */
async function openImage(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    if (/heic|heif/i.test(`${file.type} ${file.name}`)) throw new Error('формат HEIC этот браузер не открывает — снимайте в JPG (iPhone: Настройки → Камера → Форматы → «Наиболее совместимый») или откройте страницу в Safari');
    throw new Error('не удалось открыть фото — это точно снимок (JPG или PNG)?');
  }
}

/* Время съёмки из EXIF (DateTimeOriginal) — для порядка в пакете. Дата файла сбивается, если фото
   правили или пересохраняли. Нет EXIF (PNG, скриншот) — null, тогда берём дату файла. */
async function shotTime(file) {
  try {
    const v = new DataView(await file.slice(0, 128 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 < v.byteLength) {
      const mark = v.getUint16(o);
      const len = v.getUint16(o + 2);
      if (mark === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) {  // APP1 «Exif»
        const t = o + 10;
        const le = v.getUint16(t) === 0x4949;
        const u16 = (x) => v.getUint16(t + x, le);
        const u32 = (x) => v.getUint32(t + x, le);
        const findTag = (ifd, tag) => { const n = u16(ifd); for (let i = 0; i < n; i += 1) { const e = ifd + 2 + i * 12; if (u16(e) === tag) return e; } return -1; };
        const ifd0 = u32(4);
        const exifPtr = findTag(ifd0, 0x8769);
        if (exifPtr < 0) return null;
        const e = findTag(u32(exifPtr + 8), 0x9003);
        if (e < 0) return null;
        const off = u32(e + 8);
        const str = String.fromCharCode(...new Uint8Array(v.buffer, t + off, 19));
        const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(str);
        return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
      }
      if ((mark & 0xFF00) !== 0xFF00) return null;
      o += 2 + len;
    }
  } catch { /* битый EXIF — не страшно */ }
  return null;
}

/* ---------- Чтение штрихкода ---------- */
// Возвращает { text, share } — share: доля ширины кадра, которую занимает штрихкод. Снимок этикетки — это
// крупный штрихкод (≥ 20 % ширины); мелкий штрихкод на упаковке в кадре товара группу не делит.
async function readBarcode(file) {
  try {
    const bmp = await openImage(file);
    const c = await toCanvas(bmp, 1400);
    const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const found = await readBarcodes(img, { formats: ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E', 'Code128', 'Code39', 'ITF'], tryHarder: true, maxNumberOfSymbols: 1 });
    const r = found.find((x) => x.isValid && x.text);
    if (!r) return null;
    const xs = [r.position.topLeft.x, r.position.topRight.x, r.position.bottomLeft.x, r.position.bottomRight.x];
    return { text: r.text.trim(), share: (Math.max(...xs) - Math.min(...xs)) / c.width };
  } catch (e) {
    console.error('barcode', e);
    return null;
  }
}

/* ---------- Хранилище (IndexedDB) ---------- */
let dbp = null;
function db() {
  // Версия 2: «shots» — исходник и вырез снимка, по ним ластик заново собирает варианты.
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('scandi-photo', 2);
    r.onupgradeneeded = () => {
      if (!r.result.objectStoreNames.contains('photos')) r.result.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      if (!r.result.objectStoreNames.contains('shots')) r.result.createObjectStore('shots', { keyPath: 'id', autoIncrement: true });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function tx(mode, fn, store = 'photos') {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    // Кончилось место на телефоне — запись прерывается; без onabort ожидание не закончилось бы никогда.
    t.onabort = () => reject(t.error || new Error('не хватило места на телефоне — скачайте архив и очистите готовые фото'));
  });
}
const allPhotos = () => tx('readonly', (s) => s.getAll());
const putPhoto = (p) => tx('readwrite', (s) => s.put(p));
const delPhoto = (id) => tx('readwrite', (s) => s.delete(id));
const clearPhotos = async () => { await tx('readwrite', (s) => s.clear()); await tx('readwrite', (s) => s.clear(), 'shots'); };
const getShot = (id) => tx('readonly', (s) => s.get(id), 'shots');
const putShot = (x) => tx('readwrite', (s) => s.put(x), 'shots');
const delShot = (id) => tx('readwrite', (s) => s.delete(id), 'shots');

/* ---------- Обработка одного снимка ---------- */
function setProgress(text, part, bad = false) {
  el.status.textContent = text;
  el.status.classList.toggle('is-bad', bad);
  el.bar.style.width = `${Math.round(Math.max(0, Math.min(1, part)) * 100)}%`;
}

async function toCanvas(bitmap, maxSide) {
  const k = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bitmap.width * k);
  c.height = Math.round(bitmap.height * k);
  c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
  return c;
}
const canvasBlob = (c, type, q) => new Promise((resolve) => c.toBlob(resolve, type, q));

// Границы непрозрачной части: товар без пустых полей вокруг.
function alphaBox(c) {
  const { width: w, height: h } = c;
  const d = c.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (d[(y * w + x) * 4 + 3] > 24) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* НАСТОЯЩАЯ ТЕНЬ НА ФОНЕ (29.10.2026: тарелка на бумаге — модель оставила её тень полупрозрачной, а уплотнение
   краёв сделало тень частью предмета). Убираем то, в чём модель не уверена (альфа ниже 250), если оно примыкает к фону
   и выглядит как тень: тот же оттенок, что фон рядом с предметом, только темнее. Идём от фона внутрь, пока это
   «тень». Там, где модель уверена (альфа 250+), не трогаем ничего — серые и светлые предметы целы. */
function removeCastShadow(cut, orig) {
  const { width: w, height: h } = cut;
  if (orig.width !== w || orig.height !== h) return;
  const g = cut.getContext('2d');
  const img = g.getImageData(0, 0, w, h);
  const a = img.data;
  const o = orig.getContext('2d').getImageData(0, 0, w, h).data;
  // Рамка предмета и фон вокруг неё (с запасом 8 %): медиана цвета там, где модель видит фон.
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (a[(y * w + x) * 4 + 3] > 128) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return;
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.08);
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
  const rs = [], gs = [], bs = [];
  for (let y = y0; y <= y1; y += 3) for (let x = x0; x <= x1; x += 3) {
    const i = (y * w + x) * 4;
    if (a[i + 3] <= 10) { rs.push(o[i]); gs.push(o[i + 1]); bs.push(o[i + 2]); }
  }
  if (rs.length < 200) return;
  const med = (arr) => arr.sort((p, q) => p - q)[arr.length >> 1];
  const br = med(rs), bg = med(gs), bb = med(bs);
  const lum = (r, gg, b) => 0.299 * r + 0.587 * gg + 0.114 * b;
  const Lb = lum(br, bg, bb);
  const sb = br + bg + bb || 1;
  const shadowLike = (i) => {
    const r = o[i], gg = o[i + 1], b = o[i + 2];
    const L = lum(r, gg, b);
    if (L > Lb - 8 || L < Lb * 0.5) return false;          // тень — темнее фона, но не чёрная
    const sum = r + gg + b || 1;
    // Оттенок (доли каналов) почти как у фона: тень — тот же фон, только темнее.
    return Math.abs(r / sum - br / sb) + Math.abs(gg / sum - bg / sb) + Math.abs(b / sum - bb / sb) < 0.04;
  };
  // Обход от фона внутрь по «теневым» неуверенным пикселям.
  const seen = new Uint8Array(w * h);
  const queue = [];
  for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
    const k = y * w + x;
    if (a[k * 4 + 3] <= 10) { seen[k] = 1; queue.push(k); }
  }
  let removed = 0;
  for (let q = 0; q < queue.length; q += 1) {
    const k = queue[q];
    const x = k % w, y = (k - x) / w;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
      const n = ny * w + nx;
      if (seen[n]) continue;
      seen[n] = 1;
      const i = n * 4;
      if (a[i + 3] < 250 && shadowLike(i)) { a[i + 3] = 0; removed += 1; queue.push(n); }
    }
  }
  if (removed) g.putImageData(img, 0, 0);
}

/* КРАЯ (28.10.2026: «у товаров сильно задевает края»). Модель ставит краю предмета полупрозрачность, а светлые
   края на светлом фоне (борт белой тарелки, ручка кружки) она почти стирает. Поэтому:
   1) всё, что модель считает предметом хотя бы на ~15 %, делаем плотнее (кривая: 15 % → 0, 55 % и выше → 100 %);
   2) смягчаем край на 1 px, чтобы не было «лесенки».
   Маску НЕ расширяем: проверено — расширение на 2 px тащит в край серую кайму фона. */
const EDGE_LO = 38;        // ~15 % — ниже считаем фоном
const EDGE_HI = 140;       // ~55 % — выше предмет целиком
function refineEdges(c) {
  const { width: w, height: h } = c;
  const g = c.getContext('2d');
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;
  const a = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i += 1) {
    const v = d[i * 4 + 3];
    a[i] = v <= EDGE_LO ? 0 : v >= EDGE_HI ? 255 : ((v - EDGE_LO) * 255) / (EDGE_HI - EDGE_LO);
  }
  // Смягчение края: среднее 3×3 только там, где соседи разные.
  const soft = new Uint8ClampedArray(a);
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const v = a[i];
      if (v === a[i - 1] && v === a[i + 1] && v === a[i - w] && v === a[i + w]) continue;
      let sum = 0;
      for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) sum += a[i + dy * w + dx];
      soft[i] = sum / 9;
    }
  }
  for (let i = 0; i < n; i += 1) d[i * 4 + 3] = soft[i];
  g.putImageData(img, 0, 0);
}

// Товар по центру белого квадрата — «студийный» вид: мягкая тень вокруг и тень-пятно под предметом,
// иначе светлый предмет теряется на белом (28.10.2026: «добавить небольшую тень»).
/* Рисует предмет с мягкой тенью и пятном под ним (28.10.2026: «добавить небольшую тень»). */
function drawObject(g, cut, box, x, y, w, h, { blur = 30, offset = 10, alpha = 0.22, pool = 0.20 } = {}) {
  g.save();
  const cx = x + w / 2, cy = y + h;
  const rx = w * 0.42, ry = Math.max(14, w * 0.045);
  const grad = g.createRadialGradient(cx, cy, 0, cx, cy, rx);
  grad.addColorStop(0, `rgba(0, 0, 0, ${pool})`);
  grad.addColorStop(0.6, `rgba(0, 0, 0, ${pool * 0.35})`);
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  g.translate(cx, cy);
  g.scale(1, ry / rx);
  g.translate(-cx, -cy);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(cx, cy, rx, 0, Math.PI * 2);
  g.fill();
  g.restore();
  g.save();
  g.shadowColor = `rgba(0, 0, 0, ${alpha})`;
  g.shadowBlur = blur;
  g.shadowOffsetY = offset;
  g.imageSmoothingQuality = 'high';
  g.drawImage(cut, box.x, box.y, box.w, box.h, x, y, w, h);
  g.restore();
}
function square() {
  const c = document.createElement('canvas');
  c.width = SIZE; c.height = SIZE;
  const g = c.getContext('2d');
  g.fillStyle = '#FFFFFF';
  g.fillRect(0, 0, SIZE, SIZE);
  return [c, g];
}
const fit = (box, fill) => { const k = Math.min((SIZE * fill) / box.w, (SIZE * fill) / box.h); return [box.w * k, box.h * k]; };

// 1. Белый фон: по центру чистого белого квадрата — для карточки каталога.
function composeCard(cut, box) {
  const [c, g] = square();
  const [w, h] = fit(box, FILL);
  drawObject(g, cut, box, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
  return c;
}

// 2. С размерами: линии сверху и справа от предмета с подписями.
function composeSize(cut, box, size) {
  const [c, g] = square();
  // Объём линией не покажешь: предмет и подпись под ним.
  if (size.ml) {
    const [w, h] = fit(box, 0.66);
    const y = (SIZE - h) / 2 - SIZE * 0.04;
    drawObject(g, cut, box, (SIZE - w) / 2, y, w, h, { blur: 22, offset: 8, alpha: 0.16, pool: 0.14 });
    g.fillStyle = '#222222';
    g.font = '600 46px -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'alphabetic';
    g.fillText(`${size.ml} мл`, SIZE / 2, y + h + SIZE * 0.085);
    return c;
  }
  const [w, h] = fit(box, 0.6);
  const x = (SIZE - w) / 2 - SIZE * 0.035;
  const y = (SIZE - h) / 2 + SIZE * 0.04;
  drawObject(g, cut, box, x, y, w, h, { blur: 22, offset: 8, alpha: 0.16, pool: 0.14 });
  const sorted = [...size.vals].sort((a, b) => b - a);
  const wide = w >= h;
  // Большее значение — к длинной стороне силуэта: порядок чисел в названиях бывает любым.
  const top = size.vals.length === 1 ? (wide ? sorted[0] : null) : (wide ? sorted[0] : sorted[1]);
  const right = size.vals.length === 1 ? (wide ? null : sorted[0]) : (wide ? sorted[1] : sorted[0]);
  const round = Math.abs(w - h) / Math.max(w, h) < 0.06 && size.vals.length === 1;
  const GAP = SIZE * 0.05, TICK = SIZE * 0.012;
  g.strokeStyle = '#3A3A3A';
  g.fillStyle = '#222222';
  g.lineWidth = 3;
  g.font = '600 46px -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';
  if (top !== null) {
    const ly = y - GAP;
    g.beginPath();
    g.moveTo(x, ly); g.lineTo(x + w, ly);
    g.moveTo(x, ly - TICK); g.lineTo(x, ly + TICK);
    g.moveTo(x + w, ly - TICK); g.lineTo(x + w, ly + TICK);
    g.stroke();
    g.fillText(`${round ? 'Ø ' : ''}${sizeLabel(top, size.unit)}`, x + w / 2, ly - TICK - 16);
  }
  if (right !== null) {
    const lx = x + w + GAP;
    g.beginPath();
    g.moveTo(lx, y); g.lineTo(lx, y + h);
    g.moveTo(lx - TICK, y); g.lineTo(lx + TICK, y);
    g.moveTo(lx - TICK, y + h); g.lineTo(lx + TICK, y + h);
    g.stroke();
    g.save();
    g.translate(lx + TICK + 46, y + h / 2);
    g.rotate(Math.PI / 2);
    g.fillText(sizeLabel(right, size.unit), 0, 0);
    g.restore();
  }
  // Третье измерение на линиях не показать — подпись внизу.
  if (size.vals.length === 3) {
    g.font = '500 38px -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    g.fillStyle = '#555555';
    g.fillText(`Размер: ${size.vals.map(sizeNum).join(' × ')} ${size.unit}`, SIZE / 2, SIZE - SIZE * 0.035);
  }
  return c;
}

let modelReady = false;
// Вырезает фон. Возвращает вырез (холст) и исходник (для кисти «Вернуть» в ластике). prefix — «7 из 20: » в пакете.
async function cutout(file, prefix = '') {
  const bitmap = await openImage(file);
  const orig = await toCanvas(bitmap, INPUT_MAX);
  const input = await canvasBlob(orig, 'image/jpeg', 0.95);
  const opts = {
    ...BG_CONFIG,
    progress: (key, cur, total) => {
      if (!modelReady && total) setProgress(`${prefix}загружаем модель… ${Math.round((cur / total) * 100)}%`, cur / total);
    },
  };
  // Сеть оборвалась на загрузке модели — ещё две попытки с паузой, прежде чем сдаться.
  let png;
  for (let attempt = 1; ; attempt += 1) {
    try { png = await removeBackground(input, opts); break; } catch (e) {
      if (attempt >= 3 || !/fetch|network|load/i.test(String(e?.message || e))) throw e;
      setProgress(`${prefix}связь прервалась — пробуем ещё раз (${attempt + 1} из 3)…`, 0.1);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  modelReady = true;
  const cut = await toCanvas(await createImageBitmap(png), 4000);
  removeCastShadow(cut, orig);
  refineEdges(cut);
  if (!alphaBox(cut)) throw new Error('товар на фото не найден — переснимите на однотонном фоне');
  return { cut, src: input };
}

// Сохраняет готовое фото; первое фото товара — главное. Возвращает имя файла.
async function thumbOfJpg(jpg) {
  const c = await toCanvas(await createImageBitmap(jpg), 240);
  return canvasBlob(c, 'image/jpeg', 0.85);
}

const kindOf = (p) => p.kind || 'card';   // старые записи — карточные
const jpgOf = (c) => canvasBlob(c, 'image/jpeg', 0.92);
const canvasFromBlob = async (b) => toCanvas(await createImageBitmap(b), 4000);

// Варианты снимка. Вариант с размерами — только если размер указан.
async function buildVariants(cut, sizeText, wantSize, item) {
  const box = alphaBox(cut);
  if (!box) throw new Error('на фото ничего не осталось');
  const size = wantSize ? parseSize(sizeText, isVessel(item?.n)) : null;
  return {
    card: await jpgOf(composeCard(cut, box)),
    size: size ? await jpgOf(composeSize(cut, box, size)) : null,
  };
}

// Снимок и его варианты — в базу. Первое фото товара — главное; разметка размеров — только у него.
async function saveShot(res, { cut, src }) {
  const { key, item, size } = res;
  const all = await allPhotos();
  const first = !all.some((p) => kindOf(p) === 'card' && keyOf(p.sku) === keyOf(key));
  const blobs = await buildVariants(cut, size, first, item);
  const shotId = await putShot({ key, item: item || null, size: size || '', src, cut: await canvasBlob(cut, 'image/png') });
  const base = { sku: key, art: item?.s || '', folder: item ? item.c : NO_FOLDER, title: item ? item.n : '', shotId };
  const order = Date.now();
  await putPhoto({ ...base, order, main: first, kind: 'card', blob: blobs.card, thumb: await thumbOfJpg(blobs.card) });
  if (blobs.size) await putPhoto({ ...base, order: order + 1, main: false, kind: 'size', blob: blobs.size, thumb: await thumbOfJpg(blobs.size) });
  return { shotId, blobs, first };
}

function showResults(shotId, blobs) {
  state.lastShot = shotId;
  showPic(el.afterCard, blobs.card);
  el.sizeFig.classList.toggle('is-none', !blobs.size);
  if (blobs.size) showPic(el.afterSize, blobs.size); else el.afterSize.removeAttribute('src');
  el.eraseBtn.hidden = false;
}
function clearResults() {
  [el.afterCard, el.afterSize].forEach((i) => i.removeAttribute('src'));
  el.sizeFig.classList.remove('is-none');
  el.eraseBtn.hidden = true;
}

let wakeLock = null;
const keepAwake = async (on) => {
  try {
    if (on && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch { /* не поддерживается — не страшно */ }
};
window.addEventListener('beforeunload', (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ''; } });

function lock(on) {
  state.busy = on;
  keepAwake(on);
  el.clear.disabled = on || el.clear.dataset.empty === '1';
  document.querySelectorAll('.shot__tools button').forEach((b) => { b.disabled = on; });
  el.eraseBtn.disabled = on;
  el.file.disabled = on || !onePicker?.result();
  el.pick.setAttribute('aria-disabled', String(el.file.disabled));
  el.batchFiles.disabled = on;
  el.planGo.disabled = on;
  document.querySelectorAll('.seg__btn').forEach((b) => { b.disabled = on; });
}

/* ---------- Раздел «Одно фото» ---------- */
let onePicker = null;
function oneReady() {
  el.file.disabled = state.busy || !onePicker?.result();
  el.pick.setAttribute('aria-disabled', String(el.file.disabled));
}

// Штрихкод (снятый или набранный) → товар.
function applyBarcode(code) {
  el.bcInfo.className = 'hint';
  el.bcInfo.textContent = code ? `Штрихкод ${code}` : '';
  if (code) onePicker.setBarcode(code);
}

async function processOne(file) {
  const res = onePicker.result();
  if (!res) return;
  lock(true);
  el.work.hidden = false;
  el.work.classList.remove('is-plan');
  clearResults();
  showPic(el.before, file);
  try {
    setProgress(modelReady ? 'Вырезаем товар из фона…' : 'Загружаем модель (один раз, ~90 МБ)…', 0.1);
    const done = await saveShot(res, await cutout(file));
    showResults(done.shotId, done.blobs);
    el.work.scrollIntoView({ block: 'nearest', behavior: 'smooth' });   // на ноутбуке результат бывает ниже экрана
    const noSize = done.first && !done.blobs.size && !TOP_VIEW.test(res.item?.n || '') ? ' Размера нет — варианта с разметкой не будет; можно вписать в «Ластике».' : '';
    setProgress(`Готово: ${fileSafe(res.key)} — ${done.blobs.size ? 'белый фон и размер' : 'белый фон'}.${noSize} Если осталась тень — «Ластик».`, 1);
    await render();
  } catch (e) {
    console.error(e);
    fail(e);
  } finally {
    el.file.value = '';
    lock(false);
    oneReady();
  }
}

function fail(e) {
  const net = /fetch|network/i.test(String(e?.message || e));
  // Текст ошибки — тоже: по нему видно, что именно не так (28.10.2026 на телефоне — только общая фраза).
  const detail = String(e?.message || e).slice(0, 160);
  const inApp = /Telegram|; wv\)|FBAN|Instagram/i.test(navigator.userAgent);
  setProgress(net
    ? `Не удалось скачать модель.${inApp ? ' Похоже, страница открыта во встроенном браузере — откройте её в Chrome или Safari (меню ⋮ → «Открыть в браузере»).' : ' Проверьте интернет и попробуйте ещё раз.'} [${detail}]`
    : `Не получилось: ${detail}. Попробуйте ещё раз или другое фото.`, 0, true);
}

/* ---------- Раздел «Пакет до 20» ---------- */
function batchHow() {
  el.batchHow.textContent = state.id === 'barcode'
    ? 'Снимайте по порядку: сначала этикетку со штрихкодом, потом 1–3 фото товара (первое — спереди), потом штрихкод следующего товара. Выберите все снимки разом — обработчик сам разложит их по товарам.'
    : 'Выберите до 20 снимков. Впишите артикул у первого фото каждого товара — следующие фото без артикула относятся к тому же товару.';
}

const thumbOf = (file) => { const u = URL.createObjectURL(file); planUrls.push(u); return u; };
const planUrls = [];

async function buildPlan(files) {
  planUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  // По времени съёмки: в галерее порядок выбора бывает любым, а снимали подряд.
  const dated = await Promise.all([...files].map(async (f) => ({ f, t: (await shotTime(f)) ?? f.lastModified })));
  const list = dated.sort((a, b) => a.t - b.t).slice(0, BATCH_MAX).map((x) => x.f);
  el.work.hidden = false;
  el.work.classList.add('is-plan');  // на раскладке картинок «Было/Стало» ещё нет
  clearResults();
  el.before.removeAttribute('src');
  // Больше 20 — берём первые 20 по времени съёмки; пишем об этом в итоговой строке, чтобы не затёрлось.
  const over = files.length > BATCH_MAX ? ` Выбрано ${files.length} — взяли первые ${BATCH_MAX} по времени съёмки.` : '';
  if (state.id === 'barcode') {
    const groups = [];
    for (let i = 0; i < list.length; i += 1) {
      setProgress(`Ищем штрихкоды: ${i + 1} из ${list.length}…`, (i + 1) / list.length);
      const bc = await readBarcode(list[i]);
      const cur = groups[groups.length - 1];
      // Тот же штрихкод, что у текущего товара, — это его упаковка в кадре, а не новая этикетка.
      if (bc && bc.share >= 0.2 && !(cur && cur.barcode && bcKey(cur.barcode) === bcKey(bc.text))) {
        groups.push({ barcode: bc.text, bcFile: list[i], photos: [] });
      } else {
        if (!groups.length) groups.push({ barcode: '', bcFile: null, photos: [] });
        groups[groups.length - 1].photos.push(list[i]);
      }
    }
    state.plan = { kind: 'groups', groups: groups.filter((g) => g.photos.length) };
    const lost = groups.filter((g) => !g.photos.length).length;
    setProgress(`Нашли товаров: ${state.plan.groups.length}${lost ? ` (штрихкод без фото товара: ${lost} — пропущен)` : ''}. Проверьте и нажмите «Обработать».${over}`, 0);
  } else {
    state.plan = { kind: 'rows', rows: list.map((f) => ({ file: f })) };
    setProgress(`Впишите артикулы и нажмите «Обработать».${over}`, 0);
  }
  renderPlan();
}

function renderPlan() {
  const p = state.plan;
  el.plan.replaceChildren();
  el.planActions.hidden = !p;
  if (!p) return;
  if (p.kind === 'groups') {
    p.groups.forEach((g, gi) => {
      const box = document.createElement('div');
      box.className = 'group';
      const head = document.createElement('div');
      head.className = 'group__head';
      const title = document.createElement('p');
      title.className = 'group__title';
      title.textContent = `Товар ${gi + 1}${g.barcode ? ` · штрихкод ${g.barcode}` : ' · штрихкода перед этими фото нет'}`;
      const pb = pickerBox('', 'Артикул');
      head.append(title, pb.wrap);
      g.picker = makePicker({ input: pb.input, select: pb.select, info: pb.info, size: pb.size, onChange: check });
      if (g.barcode) g.picker.setBarcode(g.barcode);
      const pics = document.createElement('div');
      pics.className = 'group__pics';
      if (g.bcFile) {
        const f = document.createElement('figure');
        f.className = 'is-bc';
        f.innerHTML = '<img alt="Штрихкод" /><figcaption>штрихкод</figcaption>';
        f.querySelector('img').src = thumbOf(g.bcFile);
        pics.append(f);
      }
      g.photos.forEach((file, i) => {
        const f = document.createElement('figure');
        f.innerHTML = `<img alt="" />${i === 0 ? '<figcaption>спереди</figcaption>' : ''}`;
        f.querySelector('img').src = thumbOf(file);
        pics.append(f);
      });
      box.append(head, pics);
      el.plan.append(box);
    });
  } else {
    p.rows.forEach((r, ri) => {
      const row = document.createElement('div');
      row.className = 'photo-row';
      const img = document.createElement('img');
      img.alt = '';
      img.src = thumbOf(r.file);
      const pb = pickerBox('', ri === 0 ? 'Артикул' : 'Артикул (пусто — тот же, что выше)');
      r.input = pb.input;
      r.info = pb.info;
      r.sizeInput = pb.size;
      r.picker = makePicker({ input: pb.input, select: pb.select, info: pb.info, size: pb.size, placeholder: 'Впишите артикул.', onChange: check });
      row.append(img, pb.wrap);
      el.plan.append(row);
    });
  }
  check();
}

// Товар строки в режиме «по артикулу»: свой или ближайший сверху. undefined — у строки вписан
// артикул, но товар не выбран (артикул у нескольких товаров).
function rowResult(i) {
  const rows = state.plan.rows;
  for (let j = i; j >= 0; j -= 1) {
    if (rows[j].input.value.trim()) return rows[j].picker.result() || undefined;
  }
  return null;
}

function check() {
  const p = state.plan;
  if (!p) return;
  let ready;
  if (p.kind === 'groups') {
    ready = p.groups.length > 0 && p.groups.every((g) => g.picker?.result());
  } else {
    p.rows.forEach((r, i) => {
      r.sizeInput.hidden = !r.input.value.trim();   // без артикула это то же фото товара, что выше
      if (r.input.value.trim()) { r.picker.refresh(); return; }
      const inh = i > 0 ? rowResult(i) : null;
      r.info.className = `group__info${inh ? '' : ' is-warn'}`;
      r.info.textContent = inh ? `Тот же товар: ${fileSafe(inh.key)}${inh.item ? ` · ${inh.item.n}` : ''}` : 'Впишите артикул.';
    });
    ready = p.rows.length > 0 && p.rows.every((r, i) => rowResult(i));
  }
  const n = p.kind === 'groups' ? p.groups.reduce((s, g) => s + g.photos.length, 0) : p.rows.length;
  el.planGo.textContent = `Обработать ${n} фото`;
  el.planGo.disabled = state.busy || !ready;
}

async function runPlan() {
  const p = state.plan;
  const jobs = p.kind === 'groups'
    ? p.groups.flatMap((g) => g.photos.map((file) => ({ file, res: g.picker.result() })))
    : p.rows.map((r, i) => ({ file: r.file, res: rowResult(i) }));
  lock(true);
  el.work.hidden = false;
  el.work.classList.remove('is-plan');
  let ok = 0;
  const failed = [];
  for (let i = 0; i < jobs.length; i += 1) {
    const { file, res } = jobs[i];
    const prefix = `${i + 1} из ${jobs.length}: `;
    el.before.src = thumbOf(file);
    clearResults();
    setProgress(`${prefix}${modelReady ? 'вырезаем товар из фона…' : 'загружаем модель (один раз, ~90 МБ)…'}`, i / jobs.length);
    try {
      const done = await saveShot(res, await cutout(file, prefix));
      showResults(done.shotId, done.blobs);
      ok += 1;
      await render();
    } catch (e) {
      console.error(e);
      failed.push(`${i + 1} (${fileSafe(res.key)})`);
    }
  }
  lock(false);
  setProgress(`Готово: ${ok} из ${jobs.length}.${failed.length ? ` Не получились: ${failed.join(', ')} — их можно повторить в «Одно фото».` : ''}`, 1, failed.length > 0);
  state.plan = null;
  el.batchFiles.value = '';
  renderPlan();
}

/* ---------- Готовые фото: список и имена файлов ---------- */
// Главное — первым; остальные по времени. Имена: артикул.jpg, артикул (2).jpg…
const KIND = {
  card: { folder: 'Белый фон', badge: 'Белый фон', suffix: '' },
  size: { folder: 'С размерами', badge: 'Размер', suffix: 'размер' },
  detail: { folder: 'Страница товара', badge: 'Вид', suffix: 'вид' },   // записи до 30.10.2026
};
function named(photos) {
  const bySku = new Map();
  for (const p of photos) {
    const k = `${kindOf(p)}|${keyOf(p.sku)}`;
    if (!bySku.has(k)) bySku.set(k, []);
    bySku.get(k).push(p);
  }
  const out = [];
  for (const list of bySku.values()) {
    list.sort((a, b) => (b.main - a.main) || (a.order - b.order));
    const kind = kindOf(list[0]);
    const base = fileSafe(list[0].sku);
    list.forEach((p, i) => {
      const n = i ? ` ${i + 1}` : '';
      const file = kind === 'card' ? `${base}${i ? ` (${i + 1})` : ''}.jpg` : kind === 'detail' ? `${base} (вид ${i + 1}).jpg` : `${base} (${KIND[kind].suffix}${n}).jpg`;
      out.push({ ...p, file, isMain: kind === 'card' && i === 0 });
    });
  }
  return out;
}

// «Было/Стало»: прежняя ссылка на картинку освобождается при каждой новой.
const showPic = (img, blob) => { if (img.dataset.url) URL.revokeObjectURL(img.dataset.url); const u = URL.createObjectURL(blob); img.dataset.url = u; img.src = u; };

const urls = [];
async function render() {
  urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const photos = named(await allPhotos());
  el.total.textContent = photos.length ? `${photos.length} фото · хранятся только на этом устройстве — скачайте архив` : '';
  el.dlAll.disabled = photos.length === 0;
  el.clear.dataset.empty = photos.length ? '' : '1';
  el.clear.disabled = state.busy || photos.length === 0;
  if (!photos.length) { el.folders.innerHTML = '<p class="empty">Пока пусто — обработанные фото появятся здесь.</p>'; return; }

  const folders = new Map();
  for (const p of photos) {
    if (!folders.has(p.folder)) folders.set(p.folder, new Map());
    const skus = folders.get(p.folder);
    if (!skus.has(keyOf(p.sku))) skus.set(keyOf(p.sku), []);
    skus.get(keyOf(p.sku)).push(p);
  }
  const names = [...folders.keys()].sort((a, b) => (a === NO_FOLDER) - (b === NO_FOLDER) || a.localeCompare(b, 'ru'));
  el.folders.replaceChildren(...names.map((name) => {
    const skus = folders.get(name);
    const count = [...skus.values()].reduce((s, l) => s + l.length, 0);
    const box = document.createElement('div');
    box.className = 'folder';
    box.innerHTML = '<div class="folder__head"><p class="folder__name"></p><button class="btn btn--sm" type="button">Скачать раздел</button></div><div class="folder__body"></div>';
    box.querySelector('.folder__name').textContent = name;
    const small = document.createElement('small');
    small.textContent = ` · ${count} фото`;
    box.querySelector('.folder__name').append(small);
    box.querySelector('button').onclick = () => download(photos.filter((p) => p.folder === name), `Scandi фото — ${name}.zip`, false);
    const body = box.querySelector('.folder__body');
    for (const list of skus.values()) {
      const row = document.createElement('div');
      row.className = 'sku';
      const t = document.createElement('p');
      t.className = 'sku__title';
      const b = document.createElement('b');
      b.textContent = list[0].sku;
      t.append(b, list[0].title ? ` · ${list[0].title}` : '');
      const strip = document.createElement('div');
      strip.className = 'sku__row';
      list.sort((a, b) => a.order - b.order);
      for (const p of list) {
        const u = URL.createObjectURL(p.thumb || p.blob);
        urls.push(u);
        const shot = document.createElement('div');
        shot.className = 'shot';
        shot.innerHTML = `<img alt="" /><span class="shot__badge ${p.isMain ? '' : 'is-plain'}">${p.isMain ? 'Карточка' : KIND[kindOf(p)].badge}</span><p class="shot__name"></p><div class="shot__tools">${p.shotId ? '<button type="button" data-erase>Ластик</button>' : ''}${p.isMain || kindOf(p) !== 'card' ? '' : '<button type="button" data-main>Главное</button>'}<button type="button" data-del>Удалить</button></div>`;
        shot.querySelector('img').src = u;
        shot.querySelector('.shot__name').textContent = p.file;
        shot.querySelector('[data-del]').onclick = async () => { if (confirm(`Удалить ${p.file}?`)) { await removeShot(p, list); } };
        const m = shot.querySelector('[data-main]');
        if (m) m.onclick = () => makeMain(p, list);
        const er = shot.querySelector('[data-erase]');
        if (er) er.onclick = () => openEditor(p.shotId);
        strip.append(shot);
      }
      row.append(t, strip);
      body.append(row);
    }
    return box;
  }));
}

// Главное фото у артикула одно: переносим отметку.
async function makeMain(p, list) {
  for (const x of list.filter((y) => kindOf(y) === 'card')) await putPhoto(stripView({ ...x, main: x.id === p.id }));
  await render();
}
async function removeShot(p, list) {
  await delPhoto(p.id);
  // Удалили главное — главным становится следующее по времени.
  if (p.isMain) {
    const next = list.filter((x) => x.id !== p.id && kindOf(x) === 'card').sort((a, b) => a.order - b.order)[0];
    if (next) await putPhoto(stripView({ ...next, main: true }));
  }
  // Ни одного варианта снимка не осталось — исходник и вырез больше не нужны.
  if (p.shotId && !(await allPhotos()).some((x) => x.shotId === p.shotId)) await delShot(p.shotId);
  await render();
}
const stripView = ({ file, isMain, ...rest }) => rest;

/* ---------- Скачивание ---------- */
async function download(list, zipName, withFolders) {
  if (!list.length) return;
  const zip = new window.JSZip();
  // Варианты — по своим папкам: на сайт их загружают отдельно. Общий архив — ещё и по разделам.
  for (const p of list) zip.file(`${withFolders ? `${fileSafe(p.folder)}/` : ''}${KIND[kindOf(p)].folder}/${p.file}`, p.blob);
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = zipName;
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

/* ---------- Переключатели ---------- */
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('[data-mode]').forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
  el.one.hidden = mode !== 'one';
  el.batch.hidden = mode !== 'batch';
  el.work.hidden = true;
}
function setId(id) {
  state.id = id;
  document.querySelectorAll('[data-id]').forEach((b) => { const on = b.dataset.id === id; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
  el.oneBarcode.hidden = id !== 'barcode';
  batchHow();
  if (state.plan) { state.plan = null; el.batchFiles.value = ''; renderPlan(); el.work.hidden = true; }
}

/* ---------- Ластик (30.10.2026) ----------
   Тень светлого предмета на светлом фоне автоматически не отделить — стираем пальцем. «Вернуть» рисует исходным
   фото: так же чинится край, который срезала модель. Двумя пальцами — двигать и увеличивать. После «Готово» все
   варианты снимка собираются заново, имена файлов прежние. */
const ed = { canvas: null, ctx: null, src: null, shotId: null, shot: null, tool: 'erase', undo: [], pts: new Map(), zoom: 1, tx: 0, ty: 0, last: null, stroke: false, pinch: null, pan: null, space: false };
const edEl = { box: $('editor'), stage: $('ed-stage'), cursor: $('ed-cursor'), brush: $('ed-brush'), undo: $('ed-undo'), size: $('ed-size'), done: $('ed-done'), cancel: $('ed-cancel'), msg: $('ed-msg'), zin: $('ed-zin'), zout: $('ed-zout') };
const applyView = () => { if (ed.canvas) ed.canvas.style.transform = `translate(${ed.tx}px, ${ed.ty}px) scale(${ed.zoom})`; };
// Фото целиком в рабочей области, с любым экраном: без этого на ноутбуке холст 1200×1600 не влезал по высоте.
function edFit() {
  if (!ed.canvas) return;
  const r = edEl.stage.getBoundingClientRect();
  const k = Math.min((r.width - 16) / ed.canvas.width, (r.height - 16) / ed.canvas.height);
  ed.canvas.style.width = `${Math.max(1, Math.floor(ed.canvas.width * k))}px`;
  ed.canvas.style.height = `${Math.max(1, Math.floor(ed.canvas.height * k))}px`;
}
new ResizeObserver(edFit).observe(edEl.stage);
// При открытии — сразу к предмету: на снимке он часто занимает лишь часть кадра, а работать надо с его краем.
function edFocusObject() {
  const box = alphaBox(ed.canvas);
  if (!box) return;
  const r = edEl.stage.getBoundingClientRect();
  const k = parseFloat(ed.canvas.style.width) / ed.canvas.width;     // пиксель холста → экран при масштабе 1
  ed.zoom = Math.max(1, Math.min(8, Math.min(r.width / (box.w * k), r.height / (box.h * k)) * 0.9));
  ed.tx = (ed.canvas.width / 2 - (box.x + box.w / 2)) * k * ed.zoom;
  ed.ty = (ed.canvas.height / 2 - (box.y + box.h / 2)) * k * ed.zoom;
  applyView();
}
// Увеличение вокруг точки на экране: она остаётся под курсором (пальцами или колесом).
function edZoomAt(nextZoom, cx, cy) {
  const z = Math.max(1, Math.min(8, nextZoom));
  const r = ed.canvas.getBoundingClientRect();
  const c = { x: r.left + r.width / 2 - ed.tx, y: r.top + r.height / 2 - ed.ty };
  const q = { x: (cx - c.x - ed.tx) / ed.zoom, y: (cy - c.y - ed.ty) / ed.zoom };
  ed.tx = cx - c.x - z * q.x;
  ed.ty = cy - c.y - z * q.y;
  ed.zoom = z;
  if (z === 1) { ed.tx = 0; ed.ty = 0; }
  applyView();
}
// Кружок кисти для мыши: виден настоящий размер штриха.
function edCursor(e) {
  const on = e.pointerType === 'mouse' && e.type !== 'pointerleave' && !ed.pan;
  edEl.cursor.hidden = !on;
  if (!on) return;
  const r = edEl.stage.getBoundingClientRect();
  const d = Number(edEl.brush.value);
  edEl.cursor.style.width = `${d}px`;
  edEl.cursor.style.height = `${d}px`;
  edEl.cursor.style.transform = `translate(${e.clientX - r.left - d / 2}px, ${e.clientY - r.top - d / 2}px)`;
}
const setTool = (t) => {
  ed.tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => { const on = b.dataset.tool === t; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
};
async function openEditor(shotId) {
  const shot = await getShot(shotId);
  if (!shot) { setProgress('Для этого фото нет исходника — обработайте его заново.', 0, true); return; }
  ed.shotId = shotId; ed.shot = shot;
  ed.canvas = await canvasFromBlob(shot.cut);
  ed.ctx = ed.canvas.getContext('2d', { willReadFrequently: true });
  ed.src = await canvasFromBlob(shot.src);
  ed.undo = []; ed.pts.clear(); ed.zoom = 1; ed.tx = 0; ed.ty = 0; ed.stroke = false; ed.pinch = null;
  ed.canvas.className = 'editor__canvas';
  edEl.stage.replaceChildren(ed.canvas, edEl.cursor);
  edEl.size.value = shot.size || '';
  edEl.size.placeholder = sizeHint(shot.item?.n);
  edEl.msg.textContent = '';
  edEl.undo.disabled = true;
  setTool('erase');
  applyView();
  edEl.box.hidden = false;
  edFit();
  edFocusObject();
  document.body.style.overflow = 'hidden';
  ed.canvas.addEventListener('pointerdown', edDown);
  ed.canvas.addEventListener('pointermove', edMove);
  ed.canvas.addEventListener('pointerup', edUp);
  ed.canvas.addEventListener('pointercancel', edUp);
  ed.canvas.addEventListener('pointerleave', edCursor);
  ed.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  ed.canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    edZoomAt(ed.zoom * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY);
  }, { passive: false });
}
function closeEditor() {
  edEl.box.hidden = true;
  edEl.cursor.hidden = true;
  document.body.style.overflow = '';
  ed.canvas = null; ed.ctx = null; ed.src = null; ed.undo = [];
  edEl.stage.replaceChildren(edEl.cursor);
}
function edPoint(e) {
  const r = ed.canvas.getBoundingClientRect();
  const k = ed.canvas.width / r.width;
  return { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k, k };
}
function edStroke(a, b, k) {
  const g = ed.ctx;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = Number(edEl.brush.value) * k;
  if (ed.tool === 'erase') {
    g.globalCompositeOperation = 'destination-out';
    g.strokeStyle = '#000';
  } else {
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = g.createPattern(ed.src, 'no-repeat');
  }
  g.beginPath();
  g.moveTo(a.x, a.y);
  g.lineTo(b.x + 0.01, b.y);
  g.stroke();
  g.restore();
}
function edDown(e) {
  e.preventDefault();
  ed.canvas.setPointerCapture(e.pointerId);
  // Мышь: правая или средняя кнопка, либо с зажатым пробелом — двигать, а не стирать.
  if (e.pointerType === 'mouse' && (e.button !== 0 || ed.space)) {
    ed.pan = { x: e.clientX, y: e.clientY };
    edEl.cursor.hidden = true;
    return;
  }
  ed.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ed.pts.size === 1) {
    ed.undo.push(ed.ctx.getImageData(0, 0, ed.canvas.width, ed.canvas.height));
    if (ed.undo.length > 6) ed.undo.shift();
    edEl.undo.disabled = false;
    ed.stroke = true;
    ed.last = edPoint(e);
    edStroke(ed.last, ed.last, ed.last.k);
  } else if (ed.pts.size === 2) {
    // Второй палец — это не рисование: откатываем только что начатый штрих.
    if (ed.stroke) {
      ed.ctx.putImageData(ed.undo.pop(), 0, 0);
      edEl.undo.disabled = ed.undo.length === 0;
      ed.stroke = false;
    }
    ed.pinch = null;
  }
}
function edMove(e) {
  if (ed.pan) {
    ed.tx += e.clientX - ed.pan.x;
    ed.ty += e.clientY - ed.pan.y;
    ed.pan = { x: e.clientX, y: e.clientY };
    applyView();
    return;
  }
  edCursor(e);
  if (!ed.pts.has(e.pointerId)) return;
  e.preventDefault();
  ed.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ed.pts.size >= 2) {
    const [a, b] = [...ed.pts.values()];
    const now = { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (ed.pinch) {
      ed.tx += now.x - ed.pinch.x;
      ed.ty += now.y - ed.pinch.y;
      edZoomAt(ed.zoom * (now.d / ed.pinch.d), now.x, now.y);
    }
    ed.pinch = now;
    return;
  }
  if (!ed.stroke) return;
  const p = edPoint(e);
  edStroke(ed.last, p, p.k);
  ed.last = p;
}
function edUp(e) {
  ed.pan = null;
  ed.pts.delete(e.pointerId);
  if (ed.pts.size < 2) ed.pinch = null;
  if (ed.pts.size === 0) ed.stroke = false;
}
async function editorDone() {
  const box = alphaBox(ed.canvas);
  if (!box) { edEl.msg.textContent = 'Всё стёрто — верните предмет кистью «Вернуть» или нажмите «Отменить».'; return; }
  edEl.done.disabled = true;
  edEl.msg.textContent = 'Собираем варианты…';
  try {
    const { shotId, shot } = ed;
    const sizeText = edEl.size.value.trim();
    const photos = (await allPhotos()).filter((p) => p.shotId === shotId);
    const card = photos.find((p) => kindOf(p) === 'card');
    // Разметка — у того снимка, где она уже есть или где её просят сейчас (только у главного фото товара).
    const wantSize = photos.some((p) => kindOf(p) === 'size') || (Boolean(card?.main) && Boolean(sizeText));
    const blobs = await buildVariants(ed.canvas, sizeText, wantSize, shot.item);
    await putShot({ ...shot, size: sizeText, cut: await canvasBlob(ed.canvas, 'image/png') });
    for (const kind of ['card', 'size']) {
      const rec = photos.find((p) => kindOf(p) === kind);
      if (rec && blobs[kind]) await putPhoto({ ...rec, blob: blobs[kind], thumb: await thumbOfJpg(blobs[kind]) });
      else if (rec && !blobs[kind]) await delPhoto(rec.id);
      else if (!rec && blobs[kind] && card) {
        const { id, ...base } = card;
        await putPhoto({ ...base, kind, main: false, order: card.order + 2, blob: blobs[kind], thumb: await thumbOfJpg(blobs[kind]) });
      }
    }
    closeEditor();
    if (state.lastShot === shotId) showResults(shotId, blobs);
    await render();
  } catch (e) {
    console.error(e);
    edEl.msg.textContent = `Не получилось: ${e.message || e}`;
  } finally {
    edEl.done.disabled = false;
  }
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
edEl.undo.addEventListener('click', () => {
  const snap = ed.undo.pop();
  if (snap) ed.ctx.putImageData(snap, 0, 0);
  edEl.undo.disabled = ed.undo.length === 0;
});
const edMiddle = () => { const r = edEl.stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
edEl.zin.addEventListener('click', () => edZoomAt(ed.zoom * 1.5, ...edMiddle()));
edEl.zout.addEventListener('click', () => edZoomAt(ed.zoom / 1.5, ...edMiddle()));
// Клавиши на ноутбуке: Ctrl+Z — шаг назад, [ и ] — размер кисти, пробел — двигать, Esc — отмена.
window.addEventListener('keydown', (e) => {
  if (edEl.box.hidden) return;
  if (e.target === edEl.size) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); edEl.undo.click(); }
  else if (e.code === 'BracketLeft') edEl.brush.value = Number(edEl.brush.value) - 4;
  else if (e.code === 'BracketRight') edEl.brush.value = Number(edEl.brush.value) + 4;
  else if (e.code === 'Space') { e.preventDefault(); ed.space = true; }
  else if (e.code === 'Escape') closeEditor();
});
window.addEventListener('keyup', (e) => { if (e.code === 'Space') ed.space = false; });
edEl.done.addEventListener('click', editorDone);
edEl.cancel.addEventListener('click', closeEditor);
el.eraseBtn.addEventListener('click', () => { if (state.lastShot) openEditor(state.lastShot); });

/* ---------- Запуск ---------- */
document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
document.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => setId(b.dataset.id)));
// Вкладки — и стрелками с клавиатуры.
document.querySelectorAll('.seg').forEach((seg) => seg.addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const btns = [...seg.querySelectorAll('.seg__btn')];
  const next = btns[(btns.indexOf(document.activeElement) + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
  next.focus(); next.click();
}));
el.file.addEventListener('change', () => { const f = el.file.files?.[0]; if (f) processOne(f); });
el.bc.addEventListener('input', () => applyBarcode(el.bc.value.trim()));
el.bcFile.addEventListener('change', async () => {
  const f = el.bcFile.files?.[0];
  el.bcFile.value = '';
  if (!f) return;
  el.bcInfo.className = 'hint';
  el.bcInfo.textContent = 'Читаем штрихкод…';
  const bc = await readBarcode(f);
  if (!bc) { el.bcInfo.className = 'hint is-warn'; el.bcInfo.textContent = 'Штрихкод не прочитался — снимите ближе и ровнее или наберите цифры.'; return; }
  el.bc.value = bc.text;
  applyBarcode(bc.text);
});
el.batchFiles.addEventListener('change', () => { if (el.batchFiles.files?.length) buildPlan(el.batchFiles.files); });
el.planGo.addEventListener('click', runPlan);
el.planCancel.addEventListener('click', () => { state.plan = null; el.batchFiles.value = ''; renderPlan(); el.work.hidden = true; });
el.dlAll.addEventListener('click', async () => download(named(await allPhotos()), 'Scandi фото — все разделы.zip', true));
el.clear.addEventListener('click', async () => { if (confirm('Удалить все обработанные фото с этого устройства?')) { await clearPhotos(); await render(); } });

batchHow();
await loadSkus();
onePicker = makePicker({ input: el.sku, select: el.skuPick, info: el.info, size: el.oneSize, placeholder: 'Введите артикул — по нему фото получит имя и попадёт в свой раздел.', onChange: oneReady });
oneReady();
// Студийные фото, собранные до 31.10.2026: больше не нужны и в архив попасть не должны.
for (const p of await allPhotos()) if (p.kind === 'studio') await delPhoto(p.id);
await render();
// Модель (~90 МБ) — не при открытии страницы, а с первым действием: ввели артикул, нажали вкладку или кнопку фото.
// Пока вводят артикул, она успевает скачаться, а просто открыть страницу на мобильном интернете — бесплатно.
let preloading = false;
const warmUp = () => { if (preloading || modelReady) return; preloading = true; preload(BG_CONFIG).then(() => { modelReady = true; }).catch(() => { preloading = false; }); };
['pointerdown', 'keydown', 'focusin'].forEach((ev) => document.querySelector('.card').addEventListener(ev, warmUp, { once: true, passive: true }));

// Хранилище браузера — постоянное, чтобы телефон не стёр необработанные фото (Safari чистит через ~7 дней без захода).
navigator.storage?.persist?.().catch(() => {});
