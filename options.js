// Option model shared by the popup and bridge.js (both load this file first).

const LEVELS = 5;

// Neutral families only: no green, orange, blue or red, which already mean something in Linear.
// Each palette drifts across its family from level 1 to 5 so neighbouring levels stay apart.
const PALETTES = {
  lavande: { label: 'Lavande', colors: ['#9187d8', '#a47ed0', '#b676c2', '#c46fb0', '#c96e9c'] },
  ardoise: { label: 'Ardoise', colors: ['#8a93a6', '#8d89aa', '#9a88a8', '#a687a0', '#ad8996'] },
  sable: { label: 'Sable', colors: ['#c2ad8f', '#bfa194', '#b8959b', '#aa8ca4', '#9a88ac'] },
};

const DEFAULTS = {
  enabled: true,
  collapse: true,
  colors: true,
  palette: 'lavande', // a key of PALETTES, or 'custom'
  customColors: PALETTES.lavande.colors,
  tintStrength: 10, // background opacity of level 1, in %
  levelStep: 50, // how much stronger each level below gets, in % of level 1
};

function levelColors(options) {
  return options.palette === 'custom' ? options.customColors : PALETTES[options.palette]?.colors || PALETTES.lavande.colors;
}

// Background of level n (1-based, level 1 being the top-level issues): the level color at
// tintStrength %, plus levelStep % of that per level below. With the defaults: 10 %, 15 %, 20 %,
// 25 %, 30 %.
function tintOf(options, level) {
  const hex = levelColors(options)[level - 1];
  const alpha = Math.min(0.6, (options.tintStrength / 100) * (1 + (options.levelStep / 100) * (level - 1)));
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
}
