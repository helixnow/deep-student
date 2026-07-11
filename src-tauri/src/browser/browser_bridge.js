/*!
 * Deep Student browser content bridge (AX-lite v1).
 * Injected via WebviewWindowBuilder::initialization_script.
 * Global: window.__dsBrowserBridge
 * Envelope: { ok: true|false, v: 1, epoch, data|error }
 * Host must retrieve results via with_webview platform callbacks — never poll eval globals.
 */
(function () {
  'use strict';

  var GLOBAL = '__dsBrowserBridge';
  var SEAL = Symbol.for('ds.browserBridge.v1');
  var VERSION = '1';

  if (window[SEAL] && window[SEAL].version === VERSION) {
    return;
  }

  var refs = new Map();
  var refCounter = 0;
  var epoch = 1;
  var highlightTimer = null;
  var highlightEl = null;

  var INTERACTIVE_SELECTOR = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role="button"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="link"]',
    '[role="combobox"]',
    '[role="slider"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    'summary',
  ].join(',');

  var STRUCTURAL_SELECTOR =
    'h1,h2,h3,h4,h5,h6,main,nav,header,footer,[role="main"],[role="navigation"],[role="banner"],[role="contentinfo"],img[alt],li';

  function ok(data) {
    return { ok: true, v: 1, epoch: epoch, data: data };
  }

  function err(code, message, details) {
    var out = {
      ok: false,
      v: 1,
      epoch: epoch,
      error: { code: code, message: String(message || code) },
    };
    if (details && typeof details === 'object') {
      out.error.details = details;
    }
    return out;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    var he = /** @type {HTMLElement} */ (el);
    var style = window.getComputedStyle(he);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      Number(style.opacity) <= 0.01
    ) {
      return false;
    }
    var rect = he.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    if (
      rect.bottom < 0 ||
      rect.right < 0 ||
      rect.top > window.innerHeight ||
      rect.left > window.innerWidth
    ) {
      return false;
    }
    return true;
  }

  function accessibleName(el) {
    var he = /** @type {HTMLElement} */ (el);
    var aria = he.getAttribute('aria-label');
    if (aria) return aria.slice(0, 120);
    var labelledBy = he.getAttribute('aria-labelledby');
    if (labelledBy) {
      var target = document.getElementById(labelledBy);
      if (target) return (target.textContent || '').trim().slice(0, 120);
    }
    if (he instanceof HTMLInputElement || he instanceof HTMLTextAreaElement) {
      return (he.placeholder || he.name || '').slice(0, 120);
    }
    if (he instanceof HTMLImageElement) {
      return (he.alt || '').slice(0, 120);
    }
    var title = he.getAttribute('title');
    var text = (he.textContent || '').replace(/\s+/g, ' ').trim();
    return (text || title || '').slice(0, 120);
  }

  function roleOf(el) {
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = /** @type {HTMLInputElement} */ (el).type || 'text';
      if (type === 'password') return 'textbox';
      if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'submit') {
        return type === 'submit' ? 'button' : type;
      }
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'img') return 'image';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (el.getAttribute('contenteditable') === 'true') return 'textbox';
    return tag;
  }

  function isPasswordField(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if ((el.type || '').toLowerCase() === 'password') return true;
    var autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (autocomplete === 'current-password' || autocomplete === 'new-password') return true;
    return false;
  }

  function boxOf(el) {
    var rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  function allocRef(el) {
    var ref = 'e' + ++refCounter;
    refs.set(ref, new WeakRef(el));
    return ref;
  }

  function resolveRef(ref) {
    if (typeof ref !== 'string' || !/^e\d+$/.test(ref)) return null;
    var wr = refs.get(ref);
    if (!wr) return null;
    var el = wr.deref();
    if (!el || !el.isConnected) return null;
    return el;
  }

  function nodePayload(el, ref, includeBoxes) {
    var he = /** @type {HTMLElement & { disabled?: boolean; checked?: boolean; value?: string }} */ (
      el
    );
    var entry = {
      ref: ref,
      role: roleOf(el),
      name: accessibleName(el),
    };
    if (includeBoxes !== false) {
      entry.box = boxOf(el);
    }
    if (he.disabled) entry.disabled = true;
    if (typeof he.checked === 'boolean') entry.checked = he.checked;
    if (isPasswordField(el)) {
      entry.value = '[password]';
      entry.password = true;
    } else if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      entry.value = String(el.value).slice(0, 120);
    }
    var level = el.tagName.match(/^H([1-6])$/i);
    if (level) entry.level = Number(level[1]);
    return entry;
  }

  function collectCandidates(interactiveOnly) {
    var seen = new Set();
    var list = [];
    function add(el) {
      if (!el || seen.has(el)) return;
      seen.add(el);
      list.push(el);
    }
    Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).forEach(add);
    if (!interactiveOnly) {
      Array.from(document.querySelectorAll(STRUCTURAL_SELECTOR)).forEach(add);
    }
    return list;
  }

  function ready() {
    return ok({
      status: 'ready',
      version: VERSION,
      engine: 'ax-lite',
      url: location.href,
      title: document.title || '',
      epoch: epoch,
      domGeneration: refCounter,
      consoleBuffered: 0,
      features: {
        ax: true,
        highlight: true,
        virtualCursor: false,
        sameOriginFrames: false,
      },
    });
  }

  function snapshot(opts) {
    opts = opts || {};
    var interactiveOnly = opts.interactiveOnly !== false;
    var maxNodes = typeof opts.maxNodes === 'number' ? opts.maxNodes : 400;
    var includeBoxes = opts.includeBoxes !== false;
    var includeHidden = opts.includeHidden === true;

    refs.clear();
    refCounter = 0;
    epoch += 1;

    var nodes = [];
    var truncated = false;
    var candidates = collectCandidates(interactiveOnly);
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!includeHidden && !isVisible(el)) continue;
      if (nodes.length >= maxNodes) {
        truncated = true;
        break;
      }
      var ref = allocRef(el);
      nodes.push(nodePayload(el, ref, includeBoxes));
    }

    var treeLines = nodes.map(function (n) {
      var bits = ['[' + n.ref + ']', n.role || 'generic'];
      if (n.name) bits.push('"' + String(n.name).replace(/"/g, '\\"') + '"');
      if (n.password) bits.push('(password)');
      else if (n.value != null && n.value !== '') bits.push('value=' + JSON.stringify(n.value));
      if (n.disabled) bits.push('disabled');
      return bits.join(' ');
    });

    return ok({
      url: location.href,
      title: document.title || '',
      viewport: {
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      },
      engine: 'ax-lite',
      interactiveOnly: interactiveOnly,
      truncated: truncated,
      count: nodes.length,
      nodes: nodes,
      tree: treeLines.join('\n'),
    });
  }

  function ensureHighlightRoot() {
    if (highlightEl && highlightEl.isConnected) return highlightEl;
    highlightEl = document.createElement('div');
    highlightEl.setAttribute('data-ds-browser-highlight', '1');
    highlightEl.style.cssText =
      'position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #2563eb;' +
      'border-radius:4px;background:rgba(37,99,235,0.12);box-sizing:border-box;display:none;';
    (document.documentElement || document.body).appendChild(highlightEl);
    return highlightEl;
  }

  function showHighlight(box, durationMs, label) {
    var root = ensureHighlightRoot();
    root.style.left = box.x + 'px';
    root.style.top = box.y + 'px';
    root.style.width = Math.max(box.w, 2) + 'px';
    root.style.height = Math.max(box.h, 2) + 'px';
    root.style.display = 'block';
    root.title = label || '';
    if (highlightTimer) clearTimeout(highlightTimer);
    var ms = typeof durationMs === 'number' ? durationMs : 800;
    highlightTimer = setTimeout(function () {
      root.style.display = 'none';
    }, ms);
  }

  function pointerClick(el, doubleClick) {
    var rect = el.getBoundingClientRect();
    var x = rect.x + rect.width / 2;
    var y = rect.y + rect.height / 2;
    var opts = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      view: window,
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    // HTMLElement.click() already dispatches the click event and performs the
    // element's default activation. Dispatching a synthetic click before it
    // caused buttons/links to fire twice.
    if (typeof /** @type {HTMLElement} */ (el).click === 'function') {
      try {
        /** @type {HTMLElement} */ (el).click();
      } catch (_) {
        /* ignore */
      }
    } else {
      el.dispatchEvent(new MouseEvent('click', opts));
    }
    if (doubleClick) {
      el.dispatchEvent(new MouseEvent('dblclick', opts));
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function click(target) {
    target = target || {};
    if (typeof target.ref === 'string') {
      var el = resolveRef(target.ref);
      if (!el) return err('STALE_REF', 'ref not found or detached: ' + target.ref);
      /** @type {HTMLElement} */ (el).scrollIntoView({
        block: 'center',
        inline: 'nearest',
      });
      var point = pointerClick(el, !!target.doubleClick);
      showHighlight(boxOf(el), 600, target.ref);
      return ok({
        mode: 'ref',
        ref: target.ref,
        role: roleOf(el),
        name: accessibleName(el),
        point: point,
        highlighted: true,
      });
    }
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      var hit = document.elementFromPoint(target.x, target.y);
      if (!hit) return err('NOT_FOUND', 'no element at point');
      var point2 = pointerClick(hit, !!target.doubleClick);
      showHighlight(boxOf(hit), 600, 'xy');
      return ok({
        mode: 'xy',
        role: roleOf(hit),
        name: accessibleName(hit),
        point: point2,
        highlighted: true,
      });
    }
    return err('INVALID_ARGS', 'click requires {ref} or {x,y}');
  }

  function setNativeValue(el, value) {
    var proto =
      el instanceof HTMLInputElement
        ? HTMLInputElement.prototype
        : HTMLTextAreaElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function typeText(ref, text, opts) {
    opts = opts || {};
    if (typeof ref !== 'string') return err('INVALID_ARGS', 'type requires ref string');
    if (typeof text !== 'string') return err('INVALID_ARGS', 'type requires text string');
    var el = resolveRef(ref);
    if (!el) return err('STALE_REF', 'ref not found or detached: ' + ref);

    if (isPasswordField(el)) {
      return err('BLOCKED', 'password fields cannot be typed by agent bridge', {
        reason: 'password_field',
        ref: ref,
      });
    }

    var he = /** @type {HTMLElement} */ (el);
    he.scrollIntoView({ block: 'center', inline: 'nearest' });
    he.focus();

    var clear = opts.clear !== false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      var next = clear ? text : String(el.value || '') + text;
      setNativeValue(el, next);
      var preview = String(el.value || '').slice(0, 80);
      if (opts.submit) {
        he.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })
        );
        he.dispatchEvent(
          new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true })
        );
      }
      showHighlight(boxOf(el), 500, ref);
      return ok({ ref: ref, valuePreview: preview });
    }

    if (he.isContentEditable || he.getAttribute('contenteditable') === 'true') {
      if (clear) he.textContent = '';
      he.textContent = (he.textContent || '') + text;
      he.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
      showHighlight(boxOf(el), 500, ref);
      return ok({ ref: ref, valuePreview: String(he.textContent || '').slice(0, 80) });
    }

    return err('NOT_INTERACTIVE', 'target is not editable');
  }

  function findScrollTarget(ref) {
    if (ref) {
      var el = resolveRef(ref);
      if (!el) return null;
      return /** @type {HTMLElement} */ (el);
    }
    return /** @type {HTMLElement} */ (
      document.scrollingElement || document.documentElement || document.body
    );
  }

  function scroll(opts) {
    opts = opts || {};
    var target = findScrollTarget(opts.ref);
    if (!target) return err('STALE_REF', 'scroll ref not found');

    if (opts.to === 'top') {
      target.scrollTo({ top: 0, left: target.scrollLeft, behavior: 'auto' });
    } else if (opts.to === 'bottom') {
      target.scrollTo({
        top: target.scrollHeight,
        left: target.scrollLeft,
        behavior: 'auto',
      });
    } else if (opts.to && typeof opts.to === 'object') {
      target.scrollTo({
        top: typeof opts.to.y === 'number' ? opts.to.y : target.scrollTop,
        left: typeof opts.to.x === 'number' ? opts.to.x : target.scrollLeft,
        behavior: 'auto',
      });
    } else {
      var dx = typeof opts.dx === 'number' ? opts.dx : 0;
      var dy = typeof opts.dy === 'number' ? opts.dy : 0;
      target.scrollBy({ left: dx, top: dy, behavior: 'auto' });
    }

    var top = target.scrollTop || 0;
    var height = target.clientHeight || 0;
    var scrollHeight = target.scrollHeight || 0;
    return ok({
      tag: target.tagName ? target.tagName.toLowerCase() : 'unknown',
      scrollTop: top,
      scrollLeft: target.scrollLeft || 0,
      clientHeight: height,
      scrollHeight: scrollHeight,
      atBottom: top + height >= scrollHeight - 2,
    });
  }

  function highlight(target, opts) {
    opts = opts || {};
    var durationMs = typeof opts.durationMs === 'number' ? opts.durationMs : 1000;
    if (target && typeof target.ref === 'string') {
      var el = resolveRef(target.ref);
      if (!el) return err('STALE_REF', 'ref not found: ' + target.ref);
      showHighlight(boxOf(el), durationMs, opts.label || target.ref);
      return ok({ shown: true });
    }
    if (target && Array.isArray(target.refs)) {
      var first = null;
      for (var i = 0; i < target.refs.length; i++) {
        var e = resolveRef(target.refs[i]);
        if (e) {
          first = e;
          break;
        }
      }
      if (!first) return err('NOT_FOUND', 'no valid refs to highlight');
      showHighlight(boxOf(first), durationMs, opts.label || 'refs');
      return ok({ shown: true });
    }
    if (target && typeof target.x === 'number' && typeof target.y === 'number') {
      showHighlight(
        { x: target.x - 12, y: target.y - 12, w: 24, h: 24 },
        durationMs,
        opts.label || 'xy'
      );
      return ok({ shown: true });
    }
    return err('INVALID_ARGS', 'highlight requires {ref}, {refs}, or {x,y}');
  }

  var api = {
    version: VERSION,
    ready: ready,
    snapshot: snapshot,
    click: click,
    type: typeText,
    scroll: scroll,
    highlight: highlight,
    /** @internal test helpers */
    _isPasswordField: isPasswordField,
  };

  try {
    Object.defineProperty(window, GLOBAL, {
      value: api,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  } catch (_) {
    window[GLOBAL] = api;
  }
  window[SEAL] = api;
})();
