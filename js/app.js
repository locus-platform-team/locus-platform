// ===== Настройки =====
const PLOTS_URL = './data/plots_data.json';
// Формат кадастрового номера: 50:27:0020229:164
const CADASTRAL_FORMAT = /^\d{2}:\d{2}:\d{6,7}:\d+$/;
// Если слой компактнее этого размера (в метрах), камера захватывает его целиком.
// Большие слои (например, всё водохранилище) в кадр не включаем, иначе карта слишком отдалится.
const MAX_AUTOFIT_M = 3000;

// Стили слоёв. В plots_data.json у слоя указывается "style": "zone" | "water" | "object"
const STYLES = {
    zone:     { path: { color: '#4d86e8', weight: 1, fillColor: '#6fa0f0', fillOpacity: 0.35, interactive: false }, legend: '#6fa0f0' },
    water:    { path: { color: '#1d3fd1', weight: 1, fillColor: '#2347ec', fillOpacity: 0.9,  interactive: false }, legend: '#2347ec' },
    object:   { path: { color: '#6a1b9a', weight: 3, fillOpacity: 0, interactive: false },                          legend: '#6a1b9a' },
    neighbor: { path: { color: '#6b6b00', weight: 1, fillColor: '#e4f21a', fillOpacity: 0.75, interactive: false }, legend: '#e4f21a' },
    target:   { path: { color: '#8b0000', weight: 2, fillColor: '#e60000', fillOpacity: 0.85 },                     legend: '#e60000' }
};

// ===== Карта =====
const map = L.map('map').setView([55.7558, 37.6173], 9);
map.attributionControl.setPrefix('');

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors | Locus Platform'
}).addTo(map);

const mapLayers = L.layerGroup().addTo(map); // сюда рисуем слои текущего участка

// ===== Данные =====
let db = {}; // тексты и описание слоёв по кадастровым номерам (plots_data.json)

// ===== Элементы страницы =====
const els = {
    input: document.getElementById('cadastralInput'),
    button: document.getElementById('searchButton'),
    panel: document.getElementById('resultsPanel'),
    modal: document.getElementById('demoModal'),
    closeModal: document.getElementById('closeModalButton'),
    quickLinks: document.getElementById('quickLinks'),
    demoList: document.getElementById('demoList')
};

// ===== Сообщения для пользователя =====
function showStatus(text, isError = false) {
    let el = document.getElementById('statusMessage');
    if (!el) {
        el = document.createElement('div');
        el.id = 'statusMessage';
        el.style.cssText = 'margin:10px 20px 0;padding:10px;border-radius:4px;font-size:13px;line-height:1.4;';
        document.querySelector('.search-container').after(el);
    }
    el.textContent = text;
    el.style.display = text ? 'block' : 'none';
    el.style.background = isError ? '#fdecea' : '#eaf4ff';
    el.style.color = isError ? '#8a1c1c' : '#1a3d6d';
}

// ===== Загрузка файлов =====
async function loadJson(url) {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`${url}: сервер ответил ${res.status} ${res.statusText}`);
    }
    try {
        return await res.json();
    } catch (e) {
        throw new Error(`${url}: файл найден, но это не корректный JSON (${e.message})`);
    }
}

// Файлы карты кешируем: повторный поиск того же участка не качает их заново
const fileCache = new Map();
function loadCached(url) {
    if (!fileCache.has(url)) {
        fileCache.set(url, loadJson(url).catch(err => { fileCache.delete(url); throw err; }));
    }
    return fileCache.get(url);
}

async function loadData() {
    els.button.disabled = true;
    showStatus('Загрузка данных…');
    try {
        db = await loadJson(PLOTS_URL);
    } catch (err) {
        console.error(err);
        showStatus(`Не удалось загрузить данные участков. ${err.message}. ` +
                   'Если страница открыта двойным кликом, запустите её через Live Server.', true);
        return; // без данных работать нечему, кнопка остаётся заблокированной
    }
    renderQuickLinks();
    els.button.disabled = false;
    showStatus('');
}

// ===== Кликабельные номера (строятся из plots_data.json) =====
function makeQuickButton(cad, withName) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'quick-link';
    b.textContent = withName ? `${cad} (${db[cad].name})` : cad;
    b.addEventListener('click', () => {
        els.input.value = cad;
        searchPlot();
    });
    return b;
}

function renderQuickLinks() {
    els.quickLinks.innerHTML = '';
    els.demoList.innerHTML = '';
    Object.keys(db).forEach(cad => {
        els.quickLinks.appendChild(makeQuickButton(cad, false));
        els.demoList.appendChild(makeQuickButton(cad, true));
    });
}

// ===== Проверка, что координаты в градусах (EPSG:4326) =====
function isLikelyWGS84(bounds) {
    const c = bounds.getCenter();
    return c.lat > 40 && c.lat < 80 && c.lng > 15 && c.lng < 80;
}

// ===== Модальное окно =====
function openModal() { els.modal.style.display = 'flex'; els.panel.style.display = 'none'; }
function closeModal() { els.modal.style.display = 'none'; }

// ===== Боковая панель =====
function fillPanel(data) {
    document.getElementById('plotName').textContent = data.name;
    document.getElementById('plotLocation').textContent = data.location;

    const badge = document.getElementById('riskBadge');
    badge.textContent = data.risk_level;
    badge.className = 'badge ' + (data.risk_level === 'Критический' ? 'critical' : 'high');

    const ul = document.getElementById('plotRegulations');
    ul.innerHTML = '';
    data.regulations.forEach(reg => {
        const li = document.createElement('li');
        li.textContent = reg;
        ul.appendChild(li);
    });

    document.getElementById('plotForbidden').textContent = data.forbidden;
    document.getElementById('plotSolution').textContent = data.solution;

    // Пометка «демо», пока тексты не подтверждены юристами
    let note = document.getElementById('demoNote');
    if (!note) {
        note = document.createElement('div');
        note.id = 'demoNote';
        note.style.cssText = 'margin-bottom:12px;padding:8px 10px;background:#fff4e0;border:1px solid #f0d9a8;border-radius:4px;font-size:12px;color:#7a5200;line-height:1.4;';
        els.panel.prepend(note);
    }
    note.textContent = 'Демонстрационные данные: тексты не проверены юристами, границы зон показаны схематично. Не является юридической консультацией.';
    note.style.display = data.verified_by_lawyers ? 'none' : 'block';

    els.panel.style.display = 'block';
}

// ===== Легенда (строится под каждый участок) =====
let legend = null;
function setLegend(items) {
    if (legend) legend.remove();
    legend = L.control({ position: 'bottomleft' });
    legend.onAdd = function () {
        const box = L.DomUtil.create('div');
        box.style.cssText = 'background:white;padding:8px 10px;border-radius:6px;box-shadow:0 1px 5px rgba(0,0,0,.3);font-size:12px;line-height:1.7;';
        items.forEach(({ color, label }) => {
            const row = document.createElement('div');
            const sw = document.createElement('span');
            sw.style.cssText = `display:inline-block;width:14px;height:14px;margin-right:6px;vertical-align:middle;border:1px solid #888;background:${color};`;
            row.appendChild(sw);
            row.appendChild(document.createTextNode(label));
            box.appendChild(row);
        });
        return box;
    };
    legend.addTo(map);
}

// ===== Отрисовка участка и его слоёв =====
let drawToken = 0; // защита от «гонки», если пользователь быстро кликает по разным участкам

async function drawOnMap(cad, data) {
    const token = ++drawToken;
    mapLayers.clearLayers();
    if (legend) { legend.remove(); legend = null; }

    const geo = data.geo;
    if (!geo || !geo.parcels) {
        showStatus('Для этого участка пока нет карты. Показан только текстовый отчёт.', true);
        return;
    }

    const layerDefs = geo.layers ?? [];
    const [parcelsRes, ...layerRes] = await Promise.allSettled([
        loadCached(geo.parcels),
        ...layerDefs.map(l => loadCached(l.file))
    ]);
    if (token !== drawToken) return; // за это время выбрали другой участок

    if (parcelsRes.status === 'rejected') {
        console.error(parcelsRes.reason);
        showStatus(`Не удалось загрузить границы участка. ${parcelsRes.reason.message}`, true);
        return;
    }
    const parcels = parcelsRes.value;

    const geoName = geo.geo_name ?? cad;
    const target = parcels.features.find(f => String(f.properties?.Name) === geoName);
    if (!target) {
        showStatus(`В файле границ нет участка с Name = «${geoName}». Показан только текст.`, true);
        return;
    }

    const targetLayer = L.geoJSON(target, { style: STYLES.target.path })
        .bindTooltip(`Участок ${cad}`, { sticky: true });
    const targetBounds = targetLayer.getBounds();
    if (!targetBounds.isValid() || !isLikelyWGS84(targetBounds)) {
        console.warn('Подозрительные координаты участка:', targetBounds);
        showStatus('Координаты участка выглядят неправильно. Вероятно, файл не в градусах (EPSG:4326). ' +
                   'Попросите ГИС пере-экспортировать GeoJSON в EPSG:4326.', true);
        return;
    }

    const legendItems = [{ color: STYLES.target.legend, label: 'Наш участок' }];
    const view = targetBounds.pad(3);
    const problems = [];

    // Слои рисуются в том порядке, в котором перечислены в plots_data.json (первый снизу)
    layerDefs.forEach((def, i) => {
        const res = layerRes[i];
        if (res.status === 'rejected') {
            console.error(res.reason);
            problems.push(res.reason.message);
            return;
        }
        const style = STYLES[def.style] ?? STYLES.zone;
        const layer = L.geoJSON(res.value, { style: style.path });
        mapLayers.addLayer(layer);
        legendItems.push({ color: style.legend, label: def.label });

        const b = layer.getBounds();
        if (b.isValid() && b.getNorthEast().distanceTo(b.getSouthWest()) < MAX_AUTOFIT_M) view.extend(b);
    });

    // Соседние участки (все остальные в файле) и наш участок поверх всего
    const neighbors = parcels.features.filter(f => f !== target);
    if (neighbors.length) {
        mapLayers.addLayer(L.geoJSON({ type: 'FeatureCollection', features: neighbors }, { style: STYLES.neighbor.path }));
        legendItems.splice(1, 0, { color: STYLES.neighbor.legend, label: 'Существующие участки' });
    }
    mapLayers.addLayer(targetLayer);

    setLegend(legendItems);
    map.fitBounds(view, { maxZoom: 16 });
    showStatus(problems.length ? `Часть слоёв не загрузилась: ${problems.join(' | ')}` : '', problems.length > 0);
}

// ===== Поиск =====
function searchPlot() {
    const input = els.input.value.replace(/\s+/g, ''); // убираем все пробелы

    if (!input) {
        showStatus('Введите кадастровый номер.', true);
        return;
    }
    if (!CADASTRAL_FORMAT.test(input)) {
        showStatus('Неверный формат. Пример: 50:27:0020229:164', true);
        return;
    }
    if (!Object.hasOwn(db, input)) {
        showStatus('');
        openModal();
        return;
    }

    showStatus('');
    closeModal();
    const data = db[input];
    fillPanel(data);
    drawOnMap(input, data);
}

// ===== События =====
els.button.addEventListener('click', searchPlot);

els.input.addEventListener('keydown', e => {
    if (e.key === 'Enter') searchPlot();
});

els.closeModal.addEventListener('click', closeModal);

els.modal.addEventListener('click', e => {
    if (e.target === els.modal) closeModal(); // клик по тёмному фону
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
});

// ===== Старт =====
loadData();