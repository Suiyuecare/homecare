const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const shapes = {
  home: [['path', { d: 'm3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z' }]],
  calendar: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ['path', { d: 'M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2' }]],
  cases: [['path', { d: 'M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z' }], ['path', { d: 'M8 13h8M8 17h5' }]],
  clipboard: [['rect', { x: 5, y: 5, width: 14, height: 16, rx: 2 }], ['rect', { x: 9, y: 3, width: 6, height: 4, rx: 1 }], ['path', { d: 'M9 12h6M9 16h6' }]],
  shifts: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ['path', { d: 'M8 3v4M16 3v4M3 11h18m-11 4 2 2 4-4' }]],
  check: [['path', { d: 'm5 12 4 4L19 6' }]],
  records: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'm8 12 3 3 5-6' }]],
  services: [['rect', { x: 3, y: 7, width: 18, height: 14, rx: 2 }], ['path', { d: 'M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v3h4v-3' }]],
  users: [['circle', { cx: 9, cy: 8, r: 3 }], ['path', { d: 'M3 21v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M21 21v-2a6 6 0 0 0-4-5' }]],
  interview: [['path', { d: 'M21 11a8 8 0 0 1-8 8H5l-3 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z' }], ['path', { d: 'M7 9h9M7 13h6' }]],
  certificate: [['path', { d: 'm12 3 3 2 4 1 1 4-1 4-3 2h-8l-3-2-1-4 1-4 4-1Z' }], ['path', { d: 'm9 10 2 2 4-4M8 16l-1 6 5-3 5 3-1-6' }]],
  book: [['path', { d: 'M12 6c-3-2-6-3-10-2v15c4-1 7 0 10 2 3-2 6-3 10-2V4c-4-1-7 0-10 2Zm0 0v15' }]],
  layers: [['path', { d: 'm12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5' }]],
  leave: [['rect', { x: 3, y: 5, width: 18, height: 16, rx: 2 }], ['path', { d: 'M8 3v4M16 3v4M3 11h18m-12 4 6 0' }]],
  visit: [['path', { d: 'm3 10 9-7 9 7v10H3Z' }], ['path', { d: 'm8 14 3 3 5-6' }]],
  search: [['circle', { cx: 10.5, cy: 10.5, r: 6.5 }], ['path', { d: 'm16 16 5 5' }]],
  announcement: [['path', { d: 'm3 10 15-6v16l-15-6Zm0 0v4M6 15l2 6h3l-2-5M21 8v8' }]],
  reports: [['path', { d: 'M4 3v18h17M9 17v-5M14 17V8M19 17V5' }]],
  settings: [['path', { d: 'M9.4 4.5 10 2h4l.6 2.5 2.1 1.2 2.5-.7 2 3.5-1.9 1.8v2.4l1.9 1.8-2 3.5-2.5-.7-2.1 1.2L14 22h-4l-.6-2.5-2.1-1.2-2.5.7-2-3.5 1.9-1.8v-2.4L2.8 9.5l2-3.5 2.5.7Z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  activity: [['path', { d: 'M3 12h4l3-8 4 16 3-8h4' }]],
  history: [['path', { d: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2' }]],
  help: [['circle', { cx: 12, cy: 12, r: 9 }], ['path', { d: 'M9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1.5 1-2 1.5-2 3M12 17h.01' }]],
  archive: [['rect', { x: 3, y: 3, width: 18, height: 4, rx: 1 }], ['path', { d: 'M5 7v14h14V7M9 11h6' }]],
  file: [['path', { d: 'M14 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9Zm0 0v6h6M8 13h8M8 17h5' }]],
  building: [['rect', { x: 5, y: 3, width: 14, height: 18, rx: 1 }], ['path', { d: 'M9 7h1M14 7h1M9 11h1M14 11h1M10 21v-6h4v6' }]],
  'arrow-right': [['path', { d: 'M4 12h16m-6-6 6 6-6 6' }]],
  more: [['circle', { cx: 5, cy: 12, r: 1 }], ['circle', { cx: 12, cy: 12, r: 1 }], ['circle', { cx: 19, cy: 12, r: 1 }]],
};

// Decorative icons share one local stroke vocabulary; visible text owns the name.
export function icon(name, { size = 20, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  const attributes = {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false', class: `app-icon${className ? ` ${className}` : ''}`,
  };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, String(value));
  for (const [tag, attrs] of Object.hasOwn(shapes, name) ? shapes[name] : shapes.file) {
    const node = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    svg.append(node);
  }
  return svg;
}
