// Popup: every change is written to chrome.storage.local right away; bridge.js applies it to the
// open Linear tabs. PALETTES, DEFAULTS, LEVELS, levelColors and tintOf come from options.js.

let state = { ...DEFAULTS };

const $ = (id) => document.getElementById(id);

function save(patch) {
  state = { ...state, ...patch };
  chrome.storage.local.set(patch);
  render();
}

function buildPalettes() {
  const container = $('palettes');
  const choices = [...Object.entries(PALETTES), ['custom', { label: 'Personnalisée' }]];
  for (const [key, palette] of choices) {
    const row = document.createElement('label');
    row.className = 'palette';
    row.innerHTML = `<input type="radio" name="palette" value="${key}" /><span class="name">${palette.label}</span>`;
    const swatches = document.createElement('span');
    swatches.className = key === 'custom' ? 'custom-colors' : 'swatches';
    for (let level = 0; level < LEVELS; level++) {
      if (key === 'custom') {
        const picker = document.createElement('input');
        picker.type = 'color';
        picker.title = `Niveau ${level + 1}`;
        picker.dataset.level = String(level);
        picker.addEventListener('input', () => {
          const customColors = [...state.customColors];
          customColors[level] = picker.value;
          save({ customColors, palette: 'custom' });
        });
        swatches.append(picker);
      } else {
        const swatch = document.createElement('i');
        swatch.style.background = palette.colors[level];
        swatches.append(swatch);
      }
    }
    row.append(swatches);
    row.querySelector('input').addEventListener('change', () => {
      // Picking a preset also loads it into the custom pickers, as a starting point.
      save(key === 'custom' ? { palette: key } : { palette: key, customColors: [...PALETTES[key].colors] });
    });
    container.append(row);
  }
}

function render() {
  for (const name of ['enabled', 'collapse', 'colors']) $(name).checked = state[name];
  $('options').classList.toggle('disabled', !state.enabled);
  $('colors-options').classList.toggle('disabled', !state.colors);
  $('collapse-options').classList.toggle('disabled', !state.collapse);
  $('levelStep').value = state.levelStep;
  $('levelStep-value').textContent = `+${state.levelStep} %`;

  for (const radio of document.querySelectorAll('input[name="palette"]')) radio.checked = radio.value === state.palette;
  for (const picker of document.querySelectorAll('.custom-colors input')) {
    picker.value = state.customColors[Number(picker.dataset.level)];
  }

  $('tintStrength').value = state.tintStrength;
  $('tintStrength-value').textContent = `${state.tintStrength} %`;

  renderPreview();
}

function renderPreview() {
  const preview = $('preview');
  preview.replaceChildren();
  const labels = ['Ticket parent', 'Sous-ticket', 'Niveau 2', 'Niveau 3', 'Niveau 4', 'Niveau 5'];
  labels.forEach((text, level) => {
    const line = document.createElement('div');
    const indent = 8 + 14 * level;
    line.style.paddingLeft = `${indent + 6}px`;
    if (level > 0 && state.colors) {
      line.style.background = `linear-gradient(to right, transparent ${indent}px, ${tintOf(state, level)} ${indent}px)`;
    }
    const span = document.createElement('span');
    span.textContent = text;
    line.append(span);
    preview.append(line);
  });
}

// Sends an action to the Linear tab in front, through bridge.js. No answer means the page runs
// without our scripts (opened before the extension was installed or reloaded): ask for a reload.
function sendToActiveTab(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { action }, () => {
      if (chrome.runtime.lastError) $('reload-tab').hidden = false;
    });
  });
}
$('collapse-all').addEventListener('click', () => sendToActiveTab('collapse-all'));
$('expand-all').addEventListener('click', () => sendToActiveTab('expand-all'));

for (const name of ['enabled', 'collapse', 'colors']) {
  $(name).addEventListener('change', () => save({ [name]: $(name).checked }));
}
for (const name of ['tintStrength', 'levelStep']) {
  $(name).addEventListener('input', () => save({ [name]: Number($(name).value) }));
}

buildPalettes();
chrome.storage.local.get(DEFAULTS, (stored) => {
  state = stored;
  render();
});

// What the popup shows depends on the open tab:
// - not linear.app (the tab's address decides): only where the extension works;
// - a Linear tab opened before the extension was installed or reloaded: the page still runs without
//   our scripts, they do not answer the ping, so the settings plus a button to reload the tab;
// - a Linear view that does not show the sub-issue tree ("Show sub-issues" off, or "Nested
//   sub-issues" on Hide): only that, with a button to turn both on;
// - a Linear page without an issue list: only that;
// - otherwise the settings.
const PANELS = ['main', 'off-linear', 'no-option', 'no-list'];
function showPanel(name) {
  for (const panel of PANELS) $(panel).hidden = panel !== name;
}

function checkTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!/^https:\/\/linear\.app\//.test(tab?.url || '')) return showPanel('off-linear');
    chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (answer) => {
      // No answer, or an answer without `nested`: the page runs scripts older than this popup
      // (an unpacked extension's popup is read from disk at each opening, the page scripts only
      // when the extension is reloaded). Show the settings and ask for a reload of the tab.
      const stale = Boolean(chrome.runtime.lastError) || !answer?.ok || !answer.nested;
      $('reload-tab').hidden = !stale;
      if (stale || answer.nested === 'on') return showPanel('main');
      showPanel(answer.nested === 'off' ? 'no-option' : 'no-list');
    });
  });
}
checkTab();

// Turns the option on in the open view, then waits for the list to show the tree.
$('enable-option').addEventListener('click', () => {
  sendToActiveTab('enable-sub-issues');
  let tries = 0;
  const timer = setInterval(() => {
    checkTab();
    if (++tries >= 8 || !$('main').hidden) clearInterval(timer);
  }, 500);
});
$('reload-tab-button').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) chrome.tabs.reload(tab.id);
    window.close();
  });
});
