/* Godot 4.5.2 public Engine.copyToFS transport. This file never mounts packs. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TravelResourceTransport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_PACK_BYTES = 128 * 1024 * 1024;
  const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
  const ID = /^[a-z][a-z0-9_]{0,63}$/;
  const SHA256 = /^[a-f0-9]{64}$/;

  function checkedPath(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_./-]+\.pck$/.test(value) ||
        value.startsWith('/') || value.split('/').some(p => p === '.' || p === '..' || !p)) {
      throw new Error('Pack path must be a safe relative .pck path.');
    }
    return value;
  }

  function validateManifest(manifest) {
    if (!manifest || manifest.schema !== 1 || !manifest.packs || typeof manifest.packs !== 'object' || Array.isArray(manifest.packs)) {
      throw new Error('Unsupported resource pack manifest.');
    }
    if (Object.keys(manifest.packs).length > 128) throw new Error('Too many resource packs.');
    const groups = new Map();
    for (const [id, raw] of Object.entries(manifest.packs)) {
      if (!raw || !ID.test(id) || groups.has(id)) throw new Error('Invalid or duplicate pack id.');
      const bytes = raw.bytes;
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_PACK_BYTES) throw new Error('Invalid pack byte budget.');
      if (!SHA256.test(raw.sha256)) throw new Error('Pack SHA-256 is required.');
      if (typeof raw.startup !== 'boolean') throw new Error('Pack startup flag is required.');
      groups.set(id, Object.freeze({id, path: checkedPath(raw.path), bytes, sha256: raw.sha256, startup: raw.startup}));
    }
    if (Array.from(groups.values()).filter(pack => pack.startup).length !== 1) throw new Error('Exactly one startup pack descriptor is required.');
    return groups;
  }

  function createTransport(options) {
    const groups = validateManifest(options.manifest);
    const fetcher = options.fetch || globalThis.fetch.bind(globalThis);
    const crypto = options.crypto || globalThis.crypto;
    const Abort = options.AbortController || globalThis.AbortController;
    const base = new URL(options.baseURL);
    const ready = options.engineReady || Promise.resolve();
    const inflight = new Map();
    const requests = new Map();
    const installed = new Map();
    let counter = 0;
    let closed = false;

    function emit(request, state, detail) {
      if (requests.get(request.id) !== request || closed) return;
      const event = Object.assign({request_id: request.id, epoch: request.epoch,
        pack_id: request.packId, state, loaded: 0, total: 0, pack_path: '', error: '', download_usec: null, hash_usec: null, copy_usec: null, mount_usec: null,
        verified_sha256: '', cache_hit: false, http_cache_hit: null}, detail || {});
      try { request.callback(JSON.stringify(event)); }
      catch (error) { if (options.onCallbackError) options.onCallbackError(error); }
      if ((state === 'ready' || state === 'failed') && requests.get(request.id) === request) requests.delete(request.id);
    }

    function broadcast(work, state, detail) {
      for (const request of work.subscribers.values()) emit(request, state, detail);
    }

    async function awaitEngine(signal) {
      if (signal.aborted) throw signal.reason || new Error('Pack request canceled.');
      let onAbort;
      try {
        await Promise.race([ready, new Promise((_, reject) => {
          onAbort = () => reject(signal.reason || new Error('Pack request canceled.'));
          signal.addEventListener('abort', onAbort, {once: true});
        })]);
      } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
    }

    async function download(work) {
      const descriptor = work.descriptor;
      const started = performance.now();
      const url = new URL(descriptor.path, base);
      if (url.origin !== base.origin) throw new Error('Cross-origin pack paths are not allowed.');
      // Version the browser cache; every hit is still verified below.
      url.searchParams.set('sha256', descriptor.sha256);
      const response = await fetcher(url.href, {signal: work.controller.signal,
        credentials: 'same-origin', cache: 'force-cache', redirect: 'error'});
      if (!response.ok) throw new Error('Pack request failed: HTTP ' + response.status + '.');
      if (!response.body || typeof response.body.getReader !== 'function') {
        throw new Error('Streaming response bodies are required for bounded pack downloads.');
      }
      // Allocate once. A malformed/oversized response cannot grow memory past its declared budget.
      const bytes = new Uint8Array(descriptor.bytes);
      const reader = response.body.getReader();
      let offset = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (work.controller.signal.aborted) throw work.controller.signal.reason || new Error('Pack request canceled.');
          if (chunk.done) break;
          if (offset + chunk.value.byteLength > descriptor.bytes) throw new Error('Pack exceeds declared byte budget.');
          bytes.set(chunk.value, offset);
          offset += chunk.value.byteLength;
          broadcast(work, 'progress', {loaded: offset, total: descriptor.bytes});
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally { reader.releaseLock(); }
      if (offset !== descriptor.bytes) throw new Error('Pack byte count does not match manifest.');
      const downloaded = performance.now();
      if (!crypto || !crypto.subtle) throw new Error('Secure-context SHA-256 verification is unavailable.');
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      const actual = Array.from(digest, n => n.toString(16).padStart(2, '0')).join('');
      if (actual !== descriptor.sha256) throw new Error('Pack SHA-256 does not match manifest.');
      const hashed = performance.now();
      await awaitEngine(work.controller.signal);
      if (closed || work.controller.signal.aborted || work.subscribers.size === 0) throw new Error('Pack request canceled.');
      if (!options.engine || typeof options.engine.copyToFS !== 'function') throw new Error('Godot copyToFS is unavailable.');
      const path = '/travel-packs/' + descriptor.id + '-' + descriptor.sha256.slice(0, 16) + '.pck';
      // Public API copies into Emscripten FS; GDScript mounts only after validating its owner epoch.
      const copyStarted = performance.now();
      options.engine.copyToFS(path, bytes.buffer);
      const copied = performance.now();
      const result = {pack_path: path, loaded: descriptor.bytes, total: descriptor.bytes,
        download_usec: Math.round((downloaded - started) * 1000),
        hash_usec: Math.round((hashed - downloaded) * 1000),
        copy_usec: Math.round((copied - copyStarted) * 1000), verified_sha256: actual};
      installed.set(descriptor.id, result);
      broadcast(work, 'ready', result);
    }

    function fetch_pack(requestJSON, callback) {
      if (closed) throw new Error('Resource transport has stopped.');
      if (typeof callback !== 'function') throw new Error('Pack callback must be callable.');
      const input = JSON.parse(requestJSON);
      if (!input || !ID.test(input.pack_id) || !Number.isSafeInteger(input.epoch) || input.epoch < 0) {
        throw new Error('Pack request needs pack_id and nonnegative integer epoch.');
      }
      const descriptor = groups.get(input.pack_id);
      if (!descriptor || descriptor.startup) throw new Error('Requested deferred pack is not in the host manifest.');
      const requestId = input.request_id === undefined ? 'pack-' + (++counter) : input.request_id;
      if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || requests.has(requestId)) {
        throw new Error('Invalid or already active request_id.');
      }
      const request = {id: requestId, packId: descriptor.id, epoch: input.epoch, callback};
      requests.set(request.id, request);
      // Never call back synchronously: GDScript must store the returned request id first.
      queueMicrotask(() => {
        if (requests.get(request.id) !== request || closed) return;
        if (installed.has(descriptor.id)) {
          emit(request, 'ready', Object.assign({}, installed.get(descriptor.id), {
            download_usec: 0, hash_usec: 0, copy_usec: 0, cache_hit: true}));
          return;
        }
        let work = inflight.get(descriptor.id);
        if (work) { work.subscribers.set(request.id, request); return; }
        work = {descriptor, controller: new Abort(), subscribers: new Map([[request.id, request]])};
        const timeout = setTimeout(() => work.controller.abort(new Error('Pack download timed out.')), options.requestTimeoutMs || 120000);
        inflight.set(descriptor.id, work);
        broadcast(work, 'progress', {loaded: 0, total: descriptor.bytes});
        download(work).catch(error => {
          broadcast(work, 'failed', {total: descriptor.bytes, error: error.message || String(error)});
        }).finally(() => { clearTimeout(timeout); if (inflight.get(descriptor.id) === work) inflight.delete(descriptor.id); });
      });
      return request.id;
    }

    function cancel(requestId) {
      const request = requests.get(requestId);
      if (!request) return false;
      requests.delete(requestId);
      const work = inflight.get(request.packId);
      if (work) {
        work.subscribers.delete(requestId);
        if (!work.subscribers.size) {
          // Remove immediately so a fresh retry cannot join a canceled download.
          inflight.delete(request.packId);
          work.controller.abort();
        }
      }
      return true;
    }

    function close() {
      closed = true;
      for (const work of inflight.values()) work.controller.abort();
      inflight.clear(); requests.clear(); installed.clear();
    }
    return Object.freeze({fetch_pack, cancel, close});
  }
  return Object.freeze({createTransport, validateManifest, MAX_PACK_BYTES});
}));
