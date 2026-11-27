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

// Sends "collapse-all" or "expand-all" to the Linear tab in front, through bridge.js.
function sendToActiveTab(action) {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab) return;
    chrome.tabs.sendMessage(tab.id, { action }, () => {
      // No bridge.js in that tab: it is not a Linear page.
      $('collapse-message').hidden = !chrome.runtime.lastError;
    });
  });
}
$('collapse-all').addEventListener('click', () => sendToActiveTab('collapse-all'));
$('expand-all').addEventListener('click', () => sendToActiveTab('expand-all'));

for (const name of ['enabled', 'collapse', 'colors']) {
  $(name).addEventListener('change', () => save({ [name]: $(name).checked }));
}
// Turning the extension on also turns on Linear's "Show sub-issues" and "Nested sub-issues" on
// the current view: the extension has nothing to work on without them.
$('enabled').addEventListener('change', () => {
  if ($('enabled').checked) sendToActiveTab('enable-sub-issues');
});
for (const name of ['tintStrength', 'levelStep']) {
  $(name).addEventListener('input', () => save({ [name]: Number($(name).value) }));
}

buildPalettes();
chrome.storage.local.get(DEFAULTS, (stored) => {
  state = stored;
  render();
});

// Outside linear.app the popup only says where the extension works: bridge.js, injected on
// linear.app only, answers the ping; anywhere else the message fails.
chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  const show = (onLinear) => {
    $('main').hidden = !onLinear;
    $('off-linear').hidden = onLinear;
  };
  if (!tab) return show(false);
  chrome.tabs.sendMessage(tab.id, { action: 'ping' }, (answer) => show(!chrome.runtime.lastError && Boolean(answer?.ok)));
});
