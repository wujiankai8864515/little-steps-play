/* Read-only CSS viewport observations. Godot owns layout and coordinate mapping. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TravelHostViewport = api.createViewport({window: root, document: root.document});
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_DIMENSION = 10000000;
  const MAX_RATIO = 100;
  const SIDES = ['top', 'right', 'bottom', 'left'];

  function number(value, min, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
  }

  function positive(value, max = MAX_DIMENSION) {
    const result = number(value, 0, max);
    return result !== null && result > 0 ? result : null;
  }

  function emptyMetrics() {
    return {schema: 1, units: 'css_px', css_width: null, css_height: null,
      device_pixel_ratio: null, insets: null, canvas_rect: null,
      backbuffer_width: null, backbuffer_height: null};
  }

  function createViewport(options) {
    const window = options.window;
    const document = options.document;
    const canvasId = options.canvasId || 'canvas';
    let probe = null;
    let closed = false;

    function removeProbe() {
      if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
      probe = null;
    }

    function readInsets(width, height) {
      if (!document.body || !document.body.isConnected || typeof window.getComputedStyle !== 'function') return null;
      if (!probe || !probe.isConnected || probe.ownerDocument !== document) {
        removeProbe();
        probe = document.createElement('div');
        probe.setAttribute('aria-hidden', 'true');
        probe.setAttribute('inert', '');
        // A negative margin is a valid CSS sentinel. Unsupported env() or an
        // absent variable must not masquerade as measured zero safe insets.
        probe.style.cssText = 'all:initial!important;position:fixed!important;display:block!important;' +
          'left:-100000px!important;top:-100000px!important;width:0!important;height:0!important;' +
          'visibility:hidden!important;pointer-events:none!important;overflow:hidden!important;' +
          'margin:-1px!important;';
        for (const side of SIDES) {
          probe.style.setProperty('margin-' + side, 'env(safe-area-inset-' + side + ', -1px)', 'important');
        }
        document.body.appendChild(probe);
      }
      const style = window.getComputedStyle(probe);
      const insets = {};
      for (const side of SIDES) {
        const raw = style.getPropertyValue('margin-' + side).trim();
        // getComputedStyle yields resolved CSS pixels. Do not accept parseFloat
        // prefixes, percentages, unresolved expressions, NaN, or infinities.
        if (!/^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(raw)) return null;
        const value = number(Number(raw.slice(0, -2)), 0, side === 'left' || side === 'right' ? width : height);
        if (value === null) return null;
        insets[side] = value;
      }
      if (insets.left + insets.right >= width || insets.top + insets.bottom >= height) return null;
      return insets;
    }

    function getMetrics() {
      const metrics = emptyMetrics();
      if (closed || !window || !document) return JSON.stringify(metrics);
      // These are layout-viewport dimensions, not visualViewport dimensions or
      // backing-store pixels. Sample every call; no resize/orientation cache.
      metrics.css_width = positive(window.innerWidth);
      metrics.css_height = positive(window.innerHeight);
      metrics.device_pixel_ratio = positive(window.devicePixelRatio, MAX_RATIO);
      try {
        const canvas = document.getElementById(canvasId);
        if (!canvas || canvas.nodeName !== 'CANVAS' || !canvas.isConnected || canvas.ownerDocument !== document) {
          removeProbe();
          return JSON.stringify(metrics);
        }
        const rect = canvas.getBoundingClientRect();
        const left = number(rect.left, -MAX_DIMENSION, MAX_DIMENSION);
        const top = number(rect.top, -MAX_DIMENSION, MAX_DIMENSION);
        const width = positive(rect.width);
        const height = positive(rect.height);
        if (left === null || top === null || width === null || height === null) return JSON.stringify(metrics);
        metrics.canvas_rect = {left, top, width, height};
        const backbufferWidth = positive(canvas.width);
        const backbufferHeight = positive(canvas.height);
        metrics.backbuffer_width = Number.isInteger(backbufferWidth) ? backbufferWidth : null;
        metrics.backbuffer_height = Number.isInteger(backbufferHeight) ? backbufferHeight : null;
        if (metrics.css_width !== null && metrics.css_height !== null) {
          metrics.insets = readInsets(metrics.css_width, metrics.css_height);
        }
      } catch (_) {
        // Detached documents, blocked style reads, or unavailable DOM APIs are
        // observations of missing data, never a reason to invent safe insets.
        metrics.insets = null;
      }
      return JSON.stringify(metrics);
    }

    function close() {
      closed = true;
      removeProbe();
    }

    return Object.freeze({getMetrics, close});
  }

  return {createViewport, MAX_DIMENSION, MAX_RATIO};
}));
