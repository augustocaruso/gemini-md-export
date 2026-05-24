# Snippet de captura do tema lr26

Cole no DevTools (F12 → Console) da aba já aberta
`https://gemini.google.com/app/d0dd0b820082eb45` (ou qualquer `/app/<id>`).

Ele copia automaticamente o JSON pra clipboard. Cola aqui no chat.

```js
(() => {
  const read = (name, el = document.documentElement) => {
    try { return getComputedStyle(el).getPropertyValue(name).trim(); }
    catch { return ''; }
  };
  const pick = (el, props) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of props) out[p] = cs.getPropertyValue(p).trim();
    const r = el.getBoundingClientRect();
    out.__rect = { w: Math.round(r.width), h: Math.round(r.height) };
    out.__tag = el.tagName.toLowerCase();
    out.__cls = (el.className && typeof el.className === 'string' ? el.className : '').slice(0,160);
    out.__aria = el.getAttribute('aria-label') || '';
    return out;
  };
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0;
  };
  const visAll = (sel) => Array.from(document.querySelectorAll(sel)).filter(visible);
  const first = (sel) => visAll(sel)[0] || null;

  const surfaceProps = ['background-color','color','border','border-color','border-radius','box-shadow','padding','font-family','font-size','font-weight','line-height','letter-spacing','backdrop-filter'];
  const buttonProps = ['background-color','color','border','border-color','border-radius','width','height','padding','min-width','min-height','box-shadow','transition','font-family','font-size','font-weight'];
  const inputProps  = ['background-color','color','border','border-color','border-radius','padding','font-size','box-shadow'];

  const tokens = {};
  for (const name of [
    '--gem-sys-color--surface','--gem-sys-color--surface-container','--gem-sys-color--surface-container-low',
    '--gem-sys-color--surface-container-high','--gem-sys-color--surface-container-highest','--gem-sys-color--on-surface',
    '--gem-sys-color--on-surface-variant','--gem-sys-color--outline','--gem-sys-color--outline-variant',
    '--gem-sys-color--primary','--gem-sys-color--on-primary','--gem-sys-color--primary-container',
    '--gem-sys-color--on-primary-container','--gem-sys-color--secondary','--gem-sys-color--secondary-container',
    '--gem-sys-color--on-secondary-container','--gem-sys-color--tertiary-container','--gem-sys-color--error',
    '--gem-sys-color--inverse-surface','--gem-sys-color--inverse-on-surface',
    '--gem-sys-elevation--level1','--gem-sys-elevation--level2','--gem-sys-elevation--level3',
    '--gem-sys-shape--corner-small','--gem-sys-shape--corner-medium','--gem-sys-shape--corner-large',
    '--gem-sys-shape--corner-extra-large','--gem-sys-typescale--body-large-font','--gem-sys-typescale--label-large-font',
    '--mat-sys-surface','--mat-sys-on-surface','--mat-sys-primary','--mat-sys-secondary-container','--mat-sys-outline',
  ]) tokens[name] = read(name);

  const bodyClass = document.body.className.slice(0, 240);
  const htmlClass = document.documentElement.className.slice(0, 240);

  // Top-bar real
  const topBars = Array.from(document.querySelectorAll('top-bar-actions'));
  const topBar = topBars.find(visible) || topBars[0] || null;
  const rightSection = topBar?.querySelector('.right-section') || null;
  const buttonsContainers = rightSection ? Array.from(rightSection.querySelectorAll('.buttons-container')).filter(visible) : [];

  // Kebab nativo
  const kebab = (topBar && (
    topBar.querySelector('button[aria-haspopup="menu"]') ||
    topBar.querySelector('button.mat-mdc-icon-button') ||
    topBar.querySelector('mat-icon-button')
  )) || first('top-bar-actions button[mat-icon-button]') || first('button.mat-mdc-icon-button');

  const kebabIcon = (() => {
    if (!kebab) return null;
    const ic = kebab.querySelector('mat-icon, gem-icon, .material-symbols-outlined, .gds-icon, svg, i');
    if (!ic) return null;
    const cs = getComputedStyle(ic);
    return {
      tag: ic.tagName.toLowerCase(),
      cls: (ic.className && typeof ic.className === 'string' ? ic.className : '').slice(0,160),
      text: (ic.textContent || '').trim().slice(0,40),
      fontFamily: cs.getPropertyValue('font-family').trim(),
      fontSize: cs.getPropertyValue('font-size').trim(),
      color: cs.getPropertyValue('color').trim(),
      size: { w: Math.round(ic.getBoundingClientRect().width), h: Math.round(ic.getBoundingClientRect().height) },
    };
  })();

  // Active sidebar row, input area, dialog, menu, chip, toast
  const sidebar  = first('side-nav-action-button.is-selected, .conversations-list .selected, mat-list-item.mdc-list-item--selected, [data-test-id="conversation"].is-selected, gem-nav-list-item.is-selected');
  const inputArea = first('input-area-v2 .input-container, input-area-v2 .text-input-field, input-area-v2');
  const dialog   = first('mat-dialog-container, .cdk-overlay-pane mat-dialog-container, .cdk-overlay-pane[role="dialog"]');
  const menu     = first('.mat-mdc-menu-panel, .cdk-overlay-pane .menu-content, gem-popover, [role="menu"]');
  const menuItem = menu?.querySelector('[role="menuitem"], .mat-mdc-menu-item, .menu-item') || null;
  const chip     = first('mat-chip, .mdc-evolution-chip, [class*="chip"]:not([class*="chips"])');
  const toast    = first('.mat-mdc-snack-bar-container, .gmat-snack-bar, simple-snack-bar');

  const sample = {
    capturedAt: new Date().toISOString(),
    href: location.href,
    bodyClass,
    htmlClass,
    tokens,
    geometry: {
      topBarCount: topBars.length,
      topBarVisibleCount: topBars.filter(visible).length,
      topBarRect: topBar && topBar.getBoundingClientRect(),
      rightSectionRect: rightSection && rightSection.getBoundingClientRect(),
      buttonsContainerCount: rightSection ? rightSection.querySelectorAll('.buttons-container').length : 0,
      buttonsContainerVisibleCount: buttonsContainers.length,
    },
    kebab: pick(kebab, buttonProps),
    kebabIcon,
    sidebarItem: pick(sidebar, surfaceProps),
    inputArea: pick(inputArea, inputProps),
    dialog: pick(dialog, surfaceProps),
    menu: pick(menu, surfaceProps),
    menuItem: pick(menuItem, surfaceProps),
    chip: pick(chip, surfaceProps),
    toast: pick(toast, surfaceProps),
  };

  console.log('LR26 SAMPLE', sample);
  try { copy(JSON.stringify(sample, null, 2)); console.log('Copiado pra clipboard.'); } catch {}
  return sample;
})();
```
