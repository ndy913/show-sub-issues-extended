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
          // Starts from the palette on screen: touching a color of a preset makes it a custom one.
          const customColors = [...levelColors(state)];
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
    // Picking a preset keeps the custom colors aside: coming back to « Personnalisée » finds them.
    row.querySelector('input').addEventListener('change', () => save({ palette: key }));
    container.append(row);
  }
}

function render() {
  for (const name of ['enabled', 'collapse', 'colors']) $(name).checked = state[name];
  // Greyed-out blocks are also inert, so the keyboard cannot reach them either.
  for (const [id, on] of [['options', state.enabled], ['colors-options', state.colors], ['collapse-options', state.collapse]]) {
    $(id).classList.toggle('disabled', !on);
    $(id).inert = !on;
  }
  $('levelStep').value = state.levelStep;
  $('levelStep-value').textContent = `+${state.levelStep} %`;

  for (const radio of document.querySelectorAll('input[name="palette"]')) radio.checked = radio.value === state.palette;
  // The pickers show the palette in use, preset or custom.
  for (const picker of document.querySelectorAll('.custom-colors input')) {
    picker.value = levelColors(state)[Number(picker.dataset.level)];
  }

  $('tintStrength').value = state.tintStrength;
  $('tintStrength-value').textContent = `${state.tintStrength} %`;

  renderPreview();
}

function renderPreview() {
  const preview = $('preview');
  preview.replaceChildren();
  // Same as in Linear: every level is tinted, the top one across the whole row, the others from
  // their tree line.
  const labels = ['Niveau 1 : ticket', 'Niveau 2 : sous-ticket', 'Niveau 3', 'Niveau 4', 'Niveau 5'];
  labels.forEach((text, depth) => {
    const line = document.createElement('div');
    const indent = 8 + 14 * depth;
    line.style.paddingLeft = `${indent + 6}px`;
    if (state.colors) {
      const start = depth === 0 ? 0 : indent;
      line.style.background = `linear-gradient(to right, transparent ${start}px, ${tintOf(state, depth + 1)} ${start}px)`;
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

// Turns the option on in the open view, then waits for the list to show the tree. Still no tree
// after 4 s: say so (a board has no tree, and the extension only finds Linear's English labels).
$('enable-option').addEventListener('click', () => {
  $('enable-failed').hidden = true;
  sendToActiveTab('enable-sub-issues');
  let tries = 0;
  const timer = setInterval(() => {
    checkTab();
    if (!$('main').hidden) return clearInterval(timer);
    if (++tries >= 8) {
      clearInterval(timer);
      $('enable-failed').hidden = false;
    }
  }, 500);
});
$('reload-tab-button').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab) chrome.tabs.reload(tab.id);
    window.close();
  });
});
