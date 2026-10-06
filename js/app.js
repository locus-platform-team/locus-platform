// ===== Настройки =====
const PATHS = {
    plots: './data/plots_data.json',
    parcels: './data/uchastock.geojson',
    buffers: './data/Bufer.geojson'
};
// Формат кадастрового номера: 50:27:0020229:164
const CADASTRAL_FORMAT = /^\d{2}:\d{2}:\d{6,7}:\d+$/;

// ===== Карта =====
const map = L.map('map').setView([55.7558, 37.6173], 9);
map.attributionControl.setPrefix('');

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap contributors | Locus Platform'
}).addTo(map);

const mapLayers = L.layerGroup().addTo(map); // сюда рисуем участок и зоны

// ===== Данные (заполняются после загрузки) =====
let db = {};          // тексты по кадастровым номерам (plots_data.json)
let parcels = null;   // границы участков (uchastock.geojson)
let buffers = null;   // зоны ограничений (Buffer.geojson)

// ===== Элементы страницы =====
const els = {
    input: document.getElementById('cadastralInput'),
    button: document.getElementById('searchButton'),
    panel: document.getElementById('resultsPanel'),
    modal: document.getElementById('demoModal'),
    closeModal: document.getElementById('closeModalButton')
};

// ===== Сообщения для пользователя (вместо «тихих» сбоев) =====
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

async function loadData() {
    els.button.disabled = true;
    showStatus('Загрузка данных…');

    // Каждый файл грузится независимо: если один не загрузился, остальные всё равно работают
    const [plotsRes, parcelsRes, buffersRes] = await Promise.allSettled([
        loadJson(PATHS.plots),
        loadJson(PATHS.parcels),
        loadJson(PATHS.buffers)
    ]);

    const problems = [];

    if (plotsRes.status === 'fulfilled') {
        db = plotsRes.value;
    } else {
        console.error(plotsRes.reason);
        showStatus('Не удалось загрузить тексты участков (plots_data.json). Откройте консоль (F12), там причина. ' +
                   'Если страница открыта двойным кликом, запустите её через Live Server.', true);
        return; // без текстов работать нечему, кнопка остаётся заблокированной
    }

    if (parcelsRes.status === 'fulfilled') {
        parcels = parcelsRes.value;
    } else {
        console.error(parcelsRes.reason);
        problems.push('границы участков (uchastock.geojson)');
    }

    if (buffersRes.status === 'fulfilled') {
        buffers = buffersRes.value;
    } else {
        console.error(buffersRes.reason);
        problems.push('зоны ограничений (Buffer.geojson)');
    }

    els.button.disabled = false;
    if (problems.length) {
        showStatus(`Не загрузились: ${problems.join(', ')}. Тексты работают, карта без этих слоёв. Подробности в консоли (F12).`, true);
    } else {
        showStatus('');
    }
}

// ===== Проверка, что координаты в градусах (EPSG:4326) =====
function isLikelyWGS84(bounds) {
    const c = bounds.getCenter();
    return c.lat > 40 && c.lat < 80 && c.lng > 15 && c.lng < 80;
}

// ===== Модальное окно =====
function openModal() { els.modal.style.display = 'flex'; els.panel.style.display = 'none'; }
function closeModal() { els.modal.style.display = 'none'; }

// ===== Заполнение боковой панели =====
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
    els.panel.style.display = 'block';
}

// ===== Отрисовка участка и зон на карте =====
function drawOnMap(cad, data) {
    mapLayers.clearLayers();

    if (!parcels) {
        showStatus('Границы участков не загрузились, показан только текстовый отчёт.', true);
        return;
    }

    // Имя участка в GeoJSON берём из plots_data.json (поле geo_name),
    // а если его нет, ищем по самому кадастровому номеру
    const geoName = data.geo_name ?? cad;
    const feature = parcels.features.find(f => String(f.properties?.Name) === geoName);

    if (!feature) {
        showStatus(`Для этого участка пока нет границ в файле (искали Name = «${geoName}»). Показан только текст.`, true);
        return;
    }

    const parcelLayer = L.geoJSON(feature, {
        style: { color: '#0b5ed7', weight: 3, fillOpacity: 0.1 }
    });
    const parcelBounds = parcelLayer.getBounds();

    if (!parcelBounds.isValid() || !isLikelyWGS84(parcelBounds)) {
        console.warn('Подозрительные координаты участка:', parcelBounds);
        showStatus('Координаты участка выглядят неправильно. Вероятно, файл не в градусах (EPSG:4326). ' +
                   'Попросите ГИС пере-экспортировать GeoJSON в EPSG:4326.', true);
        return;
    }

    const group = L.featureGroup([parcelLayer]);

    // Показываем только те зоны, которые пересекаются с областью участка,
    // а не весь файл Buffer.geojson целиком
    if (buffers) {
        const nearBuffers = L.geoJSON(buffers, {
            filter: f => L.geoJSON(f).getBounds().intersects(parcelBounds),
            style: { color: 'red', weight: 1, fillOpacity: 0.4 }
        });
        if (nearBuffers.getLayers().length) {
            group.addLayer(nearBuffers);
        } else {
            showStatus('Зона ограничений для этого участка в Buffer.geojson не найдена.', true);
        }
    }

    mapLayers.addLayer(group);
    map.fitBounds(group.getBounds(), { padding: [50, 50] });
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