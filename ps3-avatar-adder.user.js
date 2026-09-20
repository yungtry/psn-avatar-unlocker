// ==UserScript==
// @name         PS Store Avatar Adder
// @namespace    https://github.com/yungtry/psn-avatar-unlocker
// @version      6.4.0
// @description  Adds PS3/PS4 avatars to the PlayStation Store cart. Paste the avatar ID and click the button.
// @author       yungtry
// @match        https://store.playstation.com/*
// @match        https://checkout.playstation.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_addStyle
// @grant        GM.addStyle
// @grant        GM_getValue
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        unsafeWindow
// @connect      web.np.playstation.com
// @run-at       document-start
// @icon         https://store.playstation.com/favicon.ico
// ==/UserScript==

(function () {
    'use strict';

    console.log("[PSA] Script loaded on:", window.location.href);

    // =========================================================================
    // NAMESPACES
    // =========================================================================
    const Config = {};
    const Utils = {};
    const State = {};
    const Interceptor = {};
    const ApiService = {};
    const UiComponents = {};
    const EventHandlers = {};
    const App = {};


    // =========================================================================
    // CONFIG
    // =========================================================================
    Object.assign(Config, {
        GQL_URL: 'https://web.np.playstation.com/api/graphql/v1/op',
        CLIENT_NAME: '@sie-ppr-web-checkout/app',
        CLIENT_VERSION: '2.176.0',
        OPERATION_NAME: 'addToCart',
        HASH_KEY: 'psa_addToCart_hash',
        DEFAULT_HASH: ''
    });

    // =========================================================================
    // STORAGE (cross-manager: sync GM APIs, async GM4 APIs, or in-memory fallback)
    // =========================================================================
    // Tampermonkey/Violentmonkey expose the legacy synchronous GM_* functions and
    // expose them on GM.* as well. Greasemonkey 4 (Firefox) only exposes the async
    // GM.getValue/GM.setValue. Safari's Userscripts app exposes neither, so the
    // script falls back to plain in-memory storage.
    //
    // Design notes:
    // - get*() is synchronous by contract: it reads from a write-through memory
    //   cache that is hydrated from async GM.getValue during bootstrap (App.init).
    // - set*() writes to memory first (immediately visible) and then mirrors to
    //   GM.setValue (async, fire-and-forget) when that API exists.
    // - Tab-scoped fallback: when a cart request is sent via the page fetch()
    //   (no GM_xmlhttpRequest-style backend available, e.g. Safari), the request
    //   is executed in the page's own session, so the client identity is read
    //   from the page's captured headers via the memory cache.
    const Storage = {
        cache: { 'psa_client_name': Config.CLIENT_NAME, 'psa_client_version': Config.CLIENT_VERSION, [Config.HASH_KEY]: Config.DEFAULT_HASH },
        hasAsync() { return typeof GM !== 'undefined' && GM && typeof GM.setValue === 'function'; },
        syncGet(key, fallback) {
            if (typeof GM_getValue === 'function') {
                try { return GM_getValue(key, fallback); } catch (_) { }
            }
            return Object.prototype.hasOwnProperty.call(this.cache, key) ? this.cache[key] : fallback;
        },
        set(key, val) {
            this.cache[key] = val;
            if (typeof GM_setValue === 'function') {
                try { GM_setValue(key, val); } catch (_) { }
            } else if (this.hasAsync()) {
                try { GM.setValue(key, val); } catch (_) { }
            }
        },
        // Called once during bootstrap: hydrate the memory cache from async GM.getValue
        bootstrap() {
            const keys = ['psa_client_name', 'psa_client_version', Config.HASH_KEY];
            if (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') {
                for (const key of keys) {
                    try {
                        Promise.resolve(GM.getValue(key)).then((val) => {
                            if (val !== undefined && val !== null) this.cache[key] = val;
                        }).catch(() => { });
                    } catch (_) { }
                }
            }
        }
    };

    // =========================================================================
    // STATE
    // =========================================================================
    Object.assign(State, {
        getClientName() { return Storage.syncGet('psa_client_name', Config.CLIENT_NAME); },
        setClientName(val) { Storage.set('psa_client_name', val); },
        getClientVersion() { return Storage.syncGet('psa_client_version', Config.CLIENT_VERSION); },
        setClientVersion(val) { Storage.set('psa_client_version', val); },
        getHash() { return Storage.syncGet(Config.HASH_KEY, Config.DEFAULT_HASH); },
        setHash(val) { Storage.set(Config.HASH_KEY, val); }
    });


    // =========================================================================
    // UTILS
    // =========================================================================
    Object.assign(Utils, {
        detectLocale() {
            try {
                const m = window.location.pathname.match(/^\/([a-z]{2})-([a-z]{2})\//i);
                if (m) return { country: m[2].toUpperCase(), language: `${m[1]}-${m[2]}` };
            } catch (_) { }
            return { country: 'PL', language: 'pl-pl' };
        },

        uuid() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
                const r = Math.random() * 16 | 0;
                return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
            });
        },

        logMessage(level, text) {
            const log = document.getElementById('psa-log');
            if (!log) return;
            const e = document.createElement('div');
            e.className = `psa-log-entry psa-log-${level}`;
            e.innerHTML = `<span class="psa-dot"></span>`;
            const d = document.createElement('span');
            d.textContent = text;
            e.appendChild(d);
            log.appendChild(e);
            log.scrollTop = log.scrollHeight;
        },

        clearLog() {
            const log = document.getElementById('psa-log');
            if (log) log.innerHTML = '';
        },

        updateUIHash(hash) {
            const dot = document.getElementById('psa-hash-dot');
            const text = document.getElementById('psa-hash-text');
            const manualInput = document.getElementById('psa-manual-hash');

            if (dot) dot.className = hash ? '' : 'psa-hash-missing';
            if (text) text.textContent = hash ? `Hash: ${hash.substring(0, 24)}...` : 'missing (add product to cart)';
            if (manualInput) manualInput.value = hash;
        }
    });


    // =========================================================================
    // INTERCEPTOR (FETCH & XHR)
    // =========================================================================
    Object.assign(Interceptor, {
        init() {
            const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

            // Cross-browser patching helper. Firefox sandboxes userscripts: without
            // exportFunction/cloneInto the patched property would live in a wrapped
            // scope and the page could see/throw on it. Chrome/Safari userscript
            // managers often don't expose exportFunction, so we degrade gracefully.
            const canExport = typeof exportFunction === 'function' && typeof cloneInto === 'function';
            const exportFn = (fn, win) => canExport ? exportFunction(fn, win || pageWindow) : fn;
            const tryPatch = (obj, key, makeDescriptor) => {
                try {
                    const desc = makeDescriptor();
                    if (desc) Object.defineProperty(obj, key, desc);
                } catch (_) { }
            };

            // ─── Hook fetch ───
            try {
                if (pageWindow.fetch) {
                    const originalFetch = pageWindow.fetch;
                    const patchedFetch = exportFn(function (...args) {
                        try {
                            const [resource, init] = args;
                            const url = typeof resource === 'string' ? resource : resource?.url;
                            if (url) {
                                Interceptor.interceptUrl(url);
                                if (init?.headers) Interceptor.interceptHeaders(init.headers);
                                if (init?.body) Interceptor.interceptBody(init.body);
                            }
                        } catch (_) { }
                        return originalFetch.apply(this, args);
                    }, pageWindow);
                    // Plain value descriptor (not an accessor): its only function
                    // value is exportFn-wrapped, so defineProperty succeeds even
                    // inside Firefox's Xray sandbox.
                    tryPatch(pageWindow, 'fetch', () => ({
                        value: patchedFetch,
                        writable: true, configurable: true
                    }));
                }
            } catch (_) { }

            // ─── Hook XHR ───
            try {
                if (pageWindow.XMLHttpRequest) {
                    const Proto = pageWindow.XMLHttpRequest.prototype;
                    const originalOpen = Proto.open;
                    const originalSend = Proto.send;
                    const originalSetHeader = Proto.setRequestHeader;

                    tryPatch(Proto, 'open', () => ({
                        value: exportFn(function (method, url, ...rest) {
                            try {
                                this._psaUrl = url;
                                if (url) Interceptor.interceptUrl(url);
                            } catch (_) { }
                            return originalOpen.call(this, method, url, ...rest);
                        }, pageWindow),
                        writable: true, configurable: true
                    }));

                    tryPatch(Proto, 'setRequestHeader', () => ({
                        value: exportFn(function (name, value, ...rest) {
                            try {
                                const lowerName = name.toLowerCase();
                                if (lowerName === 'apollographql-client-name') {
                                    State.setClientName(value);
                                } else if (lowerName === 'apollographql-client-version') {
                                    State.setClientVersion(value);
                                }
                            } catch (_) { }
                            return originalSetHeader.call(this, name, value, ...rest);
                        }, pageWindow),
                        writable: true, configurable: true
                    }));

                    tryPatch(Proto, 'send', () => ({
                        value: exportFn(function (body) {
                            try {
                                if (this._psaUrl && body) Interceptor.interceptBody(body);
                            } catch (_) { }
                            return originalSend.call(this, body);
                        }, pageWindow),
                        writable: true, configurable: true
                    }));
                }
            } catch (_) { }
        },

        interceptHeaders(headers) {
            if (!headers) return;
            try {
                let clientName = null;
                let clientVersion = null;

                if (typeof headers.get === 'function') {
                    clientName = headers.get('apollographql-client-name');
                    clientVersion = headers.get('apollographql-client-version');
                } else if (typeof headers === 'object') {
                    for (const key of Object.keys(headers)) {
                        const lowerKey = key.toLowerCase();
                        if (lowerKey === 'apollographql-client-name') {
                            clientName = headers[key];
                        } else if (lowerKey === 'apollographql-client-version') {
                            clientVersion = headers[key];
                        }
                    }
                }

                if (clientName && typeof clientName === 'string') {
                    State.setClientName(clientName.trim());
                }
                if (clientVersion && typeof clientVersion === 'string') {
                    State.setClientVersion(clientVersion.trim());
                }
            } catch (_) { }
        },

        interceptUrl(url) {
            try {
                if (!url.includes('graphql') && !url.includes('np.playstation.com')) return;
                const decoded = decodeURIComponent(url);
                const opMatch = decoded.match(/operationName[=:]([A-Za-z_]+)/);
                const hashMatch = decoded.match(/sha256Hash['":\s]*["']?([a-f0-9]{64})/i);
                if (opMatch && hashMatch) {
                    Interceptor.sendInterceptionNotice(opMatch[1], hashMatch[1]);
                }
            } catch (_) { }
        },

        interceptBody(raw) {
            try {
                const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const hash = body?.extensions?.persistedQuery?.sha256Hash;
                const op = body?.operationName;
                if (hash && op) {
                    Interceptor.sendInterceptionNotice(op, hash);
                }
            } catch (_) { }
        },

        sendInterceptionNotice(op, hash) {
            const isTop = window.self === window.top;
            const normalizedHash = (typeof hash === 'string' ? hash : '').toLowerCase();

            if (op === Config.OPERATION_NAME) {
                // Persist valid hashes. With shared GM storage every frame writes
                // the same value; on Safari each frame's copy is session-local and
                // the top frame re-persists via the PSA_OP_INTERCEPTED message below.
                if (/^[a-f0-9]{64}$/.test(normalizedHash)) {
                    State.setHash(normalizedHash);
                }
                // Tell the top frame's panel which client produced the addToCart
                // request. This matters on managers without GM_xmlhttpRequest
                // (e.g. Safari Userscripts): the request is sent via the page's
                // own fetch(), so the page's client identity is the authoritative one.
                if (!isTop) {
                    Interceptor.propagateClientIdentity();
                }
            }

            // Pass to top window if intercepted inside an iframe.
            // The wildcard target origin is required here: this code runs inside
            // cross-origin checkout iframes, so no specific origin can be named.
            if (!isTop) {
                window.top.postMessage({ type: 'PSA_OP_INTERCEPTED', op: op, hash: hash }, '*');
            } else {
                EventHandlers.handleInterceptedOp(op, hash);
            }
        },

        propagateClientIdentity() {
            try {
                const name = typeof State.getClientName() === 'string' ? State.getClientName().trim() : '';
                const ver = typeof State.getClientVersion() === 'string' ? State.getClientVersion().trim() : '';
                if (name && ver && window.top && window.top.window) {
                    window.top.postMessage({
                        type: 'PSA_CLIENT_IDENTITY',
                        clientName: name,
                        clientVersion: ver
                    }, '*');
                }
            } catch (_) { }
        }
    });


    // =========================================================================
    // API SERVICE
    // =========================================================================
    Object.assign(ApiService, {
        // Request backend selection, in order of preference:
        // 1. GM_xmlhttpRequest — Tampermonkey / Violentmonkey; bypasses CORS and
        //    allows sending the Origin/Referer headers the PSN API expects.
        // 2. GM.xmlHttpRequest — Greasemonkey 4 (Firefox); same semantics via the async GM4 API.
        // 3. Page fetch() — Safari's Userscripts app has no cross-origin GM request
        //    API; the request runs with the page's own credentials/session instead.
        backend() {
            if (typeof GM_xmlhttpRequest === 'function') return 'gm';
            if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') return 'gm4';
            if (typeof fetch === 'function') return 'page';
            return null;
        },

        buildRequestOpts(sku, hash, country, language) {
            const locale = `${language.split('-')[0]}-${country}`;
            const clientName = State.getClientName();
            const clientVersion = State.getClientVersion();
            return {
                method: 'POST',
                url: Config.GQL_URL,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    'apollographql-client-name': clientName,
                    'apollographql-client-version': clientVersion,
                    'x-psn-app-ver': `${clientName}/v${clientVersion}`,
                    'x-psn-correlation-id': Utils.uuid(),
                    'x-psn-request-id': Utils.uuid(),
                    'x-psn-storefront-type': 'checkout:store',
                    'x-psn-store-locale-override': locale,
                    'x-psn-store-country': country,
                    'x-psn-store-language': language.split('-')[0],
                    'Origin': 'https://checkout.playstation.com',
                    'Referer': 'https://checkout.playstation.com/',
                },
                data: JSON.stringify({
                    operationName: 'addToCart',
                    variables: { skus: [{ skuId: sku, rewardId: 'OUTRIGHT' }] },
                    extensions: { persistedQuery: { version: 1, sha256Hash: hash } }
                })
            };
        },

        addToCartGQL(sku, hash, country, language) {
            const backend = ApiService.backend();
            const opts = ApiService.buildRequestOpts(sku, hash, country, language);
            if (backend === 'gm') return ApiService.viaGM(opts);
            if (backend === 'gm4') return ApiService.viaGM4(opts);
            if (backend === 'page') return ApiService.viaPageFetch(opts);
            return Promise.resolve({ errors: [{ message: 'No usable request backend in this userscript manager.' }] });
        },

        viaGM(opts) {
            return new Promise((resolve) => {
                GM_xmlhttpRequest(Object.assign({}, opts, {
                    onload: (resp) => ApiService.resolveResponse(resolve, resp),
                    onerror: () => resolve({ errors: [{ message: 'Network error' }] }),
                    ontimeout: () => resolve({ errors: [{ message: 'Timeout' }] })
                }));
            });
        },

        viaGM4(opts) {
            return new Promise((resolve) => {
                try {
                    GM.xmlHttpRequest(Object.assign({}, opts, {
                        onload: (resp) => ApiService.resolveResponse(resolve, resp),
                        onerror: () => resolve({ errors: [{ message: 'Network error' }] }),
                        ontimeout: () => resolve({ errors: [{ message: 'Timeout' }] })
                    }));
                } catch (e) {
                    resolve({ errors: [{ message: `GM.xmlHttpRequest failed: ${e && e.message ? e.message : e}` }] });
                }
            });
        },

        viaPageFetch(opts) {
            return new Promise((resolve) => {
                // fetch() forbids setting Origin/Referer manually; the browser
                // attaches the page's own values instead.
                const headers = Object.assign({}, opts.headers);
                delete headers['Origin'];
                delete headers['Referer'];
                fetch(opts.url, {
                    method: 'POST',
                    headers: headers,
                    body: opts.data,
                    credentials: 'include'
                })
                    .then((resp) => resp.text().then((text) => ({ status: resp.status, statusText: resp.statusText, text: text })))
                    .then(({ status, statusText, text }) => {
                        try { resolve(JSON.parse(text)); }
                        catch (e) { resolve({ errors: [{ message: `HTTP ${status}: ${statusText}` }] }); }
                    })
                    .catch(() => resolve({ errors: [{ message: 'Network error' }] }));
            });
        },

        resolveResponse(resolve, resp) {
            try { resolve(JSON.parse(resp.responseText)); }
            catch (e) { resolve({ errors: [{ message: `HTTP ${resp.status}: ${resp.statusText}` }] }); }
        }
    });


    // =========================================================================
    // UI COMPONENTS
    // =========================================================================
    Object.assign(UiComponents, {
        injectStyles() {
            // Cross-manager style injection. Tampermonkey/Violentmonkey expose
            // GM_addStyle; Greasemonkey 4 exposes GM.addStyle; Safari's Userscripts
            // app exposes neither, so fall back to a plain <style> element.
            const psaCss = `
                #psa-panel {
                    position: fixed; bottom: 24px; left: 24px; z-index: 999999;
                    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    width: 380px;
                    transition: transform 0.35s cubic-bezier(0.4,0,0.2,1), opacity 0.35s cubic-bezier(0.4,0,0.2,1);
                }
                #psa-panel.psa-hidden { transform: translateY(20px); opacity: 0; pointer-events: none; }
                #psa-card {
                    background: #0b101d;
                    border: 1px solid rgba(0, 114, 206, 0.4);
                    border-radius: 12px; padding: 24px;
                    box-shadow: 0 12px 40px rgba(0,0,0,0.65), 0 0 20px rgba(0, 114, 206, 0.15);
                    color: #f3f4f6;
                }
                #psa-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
                #psa-title { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 700; color: #ffffff; text-transform: uppercase; letter-spacing: 0.05em; }
                #psa-close-btn {
                    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 6px; color: #9ca3af; cursor: pointer; width: 28px; height: 28px;
                    display: flex; align-items: center; justify-content: center; transition: all 0.2s; padding: 0;
                }
                #psa-close-btn:hover { background: #ef4444; color: #ffffff; border-color: #ef4444; }
                #psa-input-group { display: flex; flex-direction: column; gap: 8px; margin-bottom: 14px; }
                #psa-input-label { font-size: 11px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.08em; }
                #psa-avatar-input {
                    background: #161c2c; border: 1px solid #1f293d;
                    border-radius: 6px; padding: 12px 14px; color: #ffffff; font-size: 13px;
                    font-family: 'SF Mono','Fira Code',monospace; outline: none;
                    transition: border-color 0.25s, box-shadow 0.25s; width: 100%; box-sizing: border-box;
                }
                #psa-avatar-input::placeholder { color: #4b5563; }
                #psa-avatar-input:focus { border-color: #0072ce; box-shadow: 0 0 0 3px rgba(0, 114, 206, 0.25); }
                #psa-country-group { display: flex; gap: 8px; margin-bottom: 16px; }
                #psa-country-select, #psa-lang-input {
                    background: #161c2c; border: 1px solid #1f293d;
                    border-radius: 6px; padding: 10px 12px; color: #ffffff; font-size: 12px;
                    outline: none; flex: 1; box-sizing: border-box;
                }
                #psa-country-select option { background: #0b101d; color: #ffffff; }
                #psa-add-btn {
                    width: 100%; padding: 12px 20px; border: none; border-radius: 24px;
                    font-size: 14px; font-weight: 700; cursor: pointer;
                    background: #0072ce;
                    color: white; box-shadow: 0 4px 12px rgba(0, 114, 206, 0.35);
                    transition: all 0.2s; position: relative; overflow: hidden;
                    text-transform: uppercase; letter-spacing: 0.05em;
                }
                #psa-add-btn:hover:not(:disabled) { background: #0082eb; transform: translateY(-1px); box-shadow: 0 6px 16px rgba(0, 114, 206, 0.5); }
                #psa-add-btn:disabled { opacity: 0.4; cursor: not-allowed; }
                #psa-add-btn.psa-loading { color: transparent; }
                #psa-add-btn.psa-loading::after {
                    content: ''; position: absolute; top: 50%; left: 50%;
                    width: 20px; height: 20px; margin: -10px 0 0 -10px;
                    border: 2px solid rgba(255,255,255,0.3); border-top-color: white;
                    border-radius: 50%; animation: psa-spin 0.6s linear infinite;
                }
                @keyframes psa-spin { to { transform: rotate(360deg); } }
                #psa-log {
                    margin-top: 14px; max-height: 180px; overflow-y: auto;
                    font-size: 11px; font-family: 'SF Mono','Fira Code',monospace; line-height: 1.5;
                    scrollbar-width: thin; background: #070a12; padding: 10px; border-radius: 6px;
                    border: 1px solid #131926;
                }
                .psa-log-entry { padding: 3px 0; display: flex; align-items: flex-start; gap: 6px; }
                .psa-log-entry .psa-dot { width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
                .psa-log-info .psa-dot { background: #0072ce; } .psa-log-ok .psa-dot { background: #10b981; }
                .psa-log-warn .psa-dot { background: #f59e0b; } .psa-log-err .psa-dot { background: #ef4444; }
                .psa-log-info { color: #9ca3af; } .psa-log-ok { color: #34d399; }
                .psa-log-warn { color: #fbbf24; } .psa-log-err { color: #f87171; }
                #psa-hash-status {
                    display: flex; align-items: center; gap: 6px; font-size: 11px; color: #9ca3af;
                    margin-bottom: 14px; padding: 8px 12px;
                    background: #161c2c; border-radius: 6px; border: 1px solid #1f293d;
                }
                #psa-hash-dot {
                    width: 8px; height: 8px; border-radius: 50%; background: #10b981;
                    box-shadow: 0 0 6px rgba(16,185,129,0.5);
                }
                #psa-hash-dot.psa-hash-missing {
                    background: #ef4444;
                    box-shadow: 0 0 6px rgba(239,68,68,0.5);
                }
                #psa-toggle-btn {
                    position: fixed; bottom: 24px; left: 24px; z-index: 999998;
                    width: 52px; height: 52px; border-radius: 50%;
                    border: 2px solid #0072ce;
                    background: #0b101d;
                    color: white; cursor: pointer; display: flex; align-items: center; justify-content: center;
                    box-shadow: 0 6px 20px rgba(0, 114, 206, 0.4); transition: all 0.3s;
                }
                #psa-toggle-btn:hover { transform: scale(1.08) rotate(15deg); box-shadow: 0 8px 25px rgba(0, 114, 206, 0.65); }
                #psa-toggle-btn.psa-hidden { transform: scale(0); opacity: 0; pointer-events: none; }
            `;
            if (typeof GM_addStyle === 'function') {
                try { GM_addStyle(psaCss); return; } catch (_) { }
            }
            if (typeof GM !== 'undefined' && GM && typeof GM.addStyle === 'function') {
                try { GM.addStyle(psaCss); return; } catch (_) { }
            }
            if (!document.getElementById('psa-style')) {
                const styleEl = document.createElement('style');
                styleEl.id = 'psa-style';
                styleEl.textContent = psaCss;
                document.head.appendChild(styleEl);
            }
        },

        createUI() {
            // Defensive guard: the panel must only ever mount in the top frame.
            if (window.self !== window.top) return;
            UiComponents.injectStyles();
            const locale = Utils.detectLocale();

            // Escape dynamic values interpolated into the panel markup below
            // (the language comes from window.location.pathname, the hash from storage)
            const esc = (v) => String(v)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

            const toggleBtn = document.createElement('button');
            toggleBtn.id = 'psa-toggle-btn';
            toggleBtn.innerHTML = `
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                    <!-- Triangle -->
                    <path d="M12 3L17 11H7L12 3Z" stroke="#00b2ff" stroke-width="2.5" stroke-linejoin="round" />
                    <!-- Circle -->
                    <circle cx="18" cy="17" r="2.5" stroke="#f00056" stroke-width="2.5" />
                    <!-- Cross -->
                    <path d="M4 15L8 19M8 15L4 19" stroke="#5b7fff" stroke-width="2.5" stroke-linecap="round" />
                    <!-- Square -->
                    <rect x="10.5" y="15.5" width="3" height="3" stroke="#d966ff" stroke-width="2.5" stroke-linejoin="round" />
                </svg>`;
            toggleBtn.title = 'PS Avatar Adder';
            document.body.appendChild(toggleBtn);

            const currentHashVal = State.getHash();

            const panel = document.createElement('div');
            panel.id = 'psa-panel';
            panel.classList.add('psa-hidden');
            panel.innerHTML = `
                <div id="psa-card">
                    <div id="psa-header">
                        <div id="psa-title">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="margin-right:2px;">
                                <!-- Triangle -->
                                <path d="M12 3L17 11H7L12 3Z" stroke="#00b2ff" stroke-width="2.5" stroke-linejoin="round" />
                                <!-- Circle -->
                                <circle cx="18" cy="17" r="2.5" stroke="#f00056" stroke-width="2.5" />
                                <!-- Cross -->
                                <path d="M4 15L8 19M8 15L4 19" stroke="#5b7fff" stroke-width="2.5" stroke-linecap="round" />
                                <!-- Square -->
                                <rect x="10.5" y="15.5" width="3" height="3" stroke="#d966ff" stroke-width="2.5" stroke-linejoin="round" />
                            </svg>
                            PS Avatar Adder <span style="font-size:10px;color:#71717a;font-weight:400">v6.4.0</span>
                        </div>
                        <button id="psa-close-btn" title="Close">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>

                    <div id="psa-hash-status">
                        <div id="psa-hash-dot" class="${currentHashVal ? '' : 'psa-hash-missing'}"></div>
                        <span id="psa-hash-text">Hash: ${currentHashVal ? esc(currentHashVal.substring(0, 24)) + '...' : 'missing (add any game to the cart)'}</span>
                    </div>

                    <div id="psa-input-group">
                        <label id="psa-input-label" for="psa-avatar-input">Avatar ID (Content ID)</label>
                        <input id="psa-avatar-input" type="text"
                            placeholder="e.g. EP0082-CUSA02487_00-FFXIVPIXAVATAR00"
                            spellcheck="false" autocomplete="off" />
                    </div>

                    <div id="psa-country-group">
                        <select id="psa-country-select">
                            <option value="PL" ${locale.country === 'PL' ? 'selected' : ''}>🇵🇱 PL</option>
                            <option value="US" ${locale.country === 'US' ? 'selected' : ''}>🇺🇸 US</option>
                            <option value="GB" ${locale.country === 'GB' ? 'selected' : ''}>🇬🇧 GB</option>
                            <option value="DE" ${locale.country === 'DE' ? 'selected' : ''}>🇩🇪 DE</option>
                            <option value="FR" ${locale.country === 'FR' ? 'selected' : ''}>🇫🇷 FR</option>
                            <option value="ES" ${locale.country === 'ES' ? 'selected' : ''}>🇪🇸 ES</option>
                            <option value="IT" ${locale.country === 'IT' ? 'selected' : ''}>🇮🇹 IT</option>
                            <option value="NL" ${locale.country === 'NL' ? 'selected' : ''}>🇳🇱 NL</option>
                            <option value="JP" ${locale.country === 'JP' ? 'selected' : ''}>🇯🇵 JP</option>
                            <option value="AU" ${locale.country === 'AU' ? 'selected' : ''}>🇦🇺 AU</option>
                        </select>
                        <input id="psa-lang-input" type="text" value="${esc(locale.language)}" placeholder="pl-pl" />
                    </div>

                    <button id="psa-add-btn">🛒 Add to Cart</button>

                    <div style="margin-top:12px;">
                        <details style="font-size:11px; color:#71717a;" ${currentHashVal ? '' : 'open'}>
                            <summary style="cursor:pointer; user-select:none;">⚙️ Advanced / Developer Options</summary>
                            <input id="psa-manual-hash" type="text" value="${esc(currentHashVal)}" placeholder="Paste 64-character hash..."
                                style="margin-top:8px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
                                border-radius:8px; padding:8px 10px; color:#f4f4f5; font-size:11px;
                                font-family:monospace; width:100%; box-sizing:border-box; outline:none;" />
                            <div style="margin-top:6px; display:flex; gap:8px;">
                                <button id="psa-save-hash" style="background:rgba(99,102,241,0.2);
                                    border:1px solid rgba(99,102,241,0.3); border-radius:6px; color:#818cf8;
                                    cursor:pointer; padding:4px 12px; font-size:11px; flex:1; font-weight:600;
                                    transition:all 0.2s;">Save hash</button>
                                <button id="psa-delete-hash" style="background:rgba(239,68,68,0.2);
                                    border:1px solid rgba(239,68,68,0.3); border-radius:6px; color:#fca5a5;
                                    cursor:pointer; padding:4px 12px; font-size:11px; flex:1; font-weight:600;
                                    transition:all 0.2s;">Delete hash</button>
                            </div>

                            <!-- Raw SKU Sender (Dev Panel) -->
                            <div style="margin-top:12px; border-top:1px solid rgba(255,255,255,0.06); padding-top:10px;">
                                <div style="font-size:10px; color:#9ca3af; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.05em;">Send Raw SKU (No suffix)</div>
                                <input id="psa-raw-sku-input" type="text" placeholder="e.g. EP0101-NPEB00685_00-AVMETALGEA000002-E001"
                                    style="background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.1);
                                    border-radius:8px; padding:8px 10px; color:#f4f4f5; font-size:11px;
                                    font-family:monospace; width:100%; box-sizing:border-box; outline:none;" />
                                <button id="psa-add-raw-btn" style="margin-top:6px; width:100%; background:rgba(0,114,206,0.2);
                                    border:1px solid rgba(0,114,206,0.4); border-radius:6px; color:#00b2ff;
                                    cursor:pointer; padding:6px 12px; font-size:11px; font-weight:700;
                                    transition:all 0.2s; text-transform:uppercase; letter-spacing:0.05em;">🚀 Add Raw SKU</button>
                            </div>
                        </details>
                    </div>

                    <div id="psa-log"></div>
                </div>
            `;
            panel.style.display = 'block';
            document.body.appendChild(panel);

            // UI Events
            toggleBtn.addEventListener('click', () => {
                panel.classList.remove('psa-hidden');
                toggleBtn.classList.add('psa-hidden');
            });
            document.getElementById('psa-close-btn').addEventListener('click', () => {
                panel.classList.add('psa-hidden');
                toggleBtn.classList.remove('psa-hidden');
            });
            document.getElementById('psa-add-btn').addEventListener('click', EventHandlers.handleAdd);
            document.getElementById('psa-avatar-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') EventHandlers.handleAdd();
            });
            document.getElementById('psa-save-hash').addEventListener('click', () => {
                const val = document.getElementById('psa-manual-hash').value.trim();
                if (/^[a-f0-9]{64}$/.test(val)) {
                    State.setHash(val);
                    Utils.updateUIHash(val);
                    Utils.logMessage('ok', 'Hash saved manually.');
                } else {
                    Utils.logMessage('err', 'Invalid hex hash.');
                }
            });
            document.getElementById('psa-delete-hash').addEventListener('click', () => {
                State.setHash('');
                Utils.updateUIHash('');
                Utils.logMessage('warn', 'Hash removed from memory.');
            });
            document.getElementById('psa-add-raw-btn').addEventListener('click', EventHandlers.handleAddRaw);
            document.getElementById('psa-raw-sku-input').addEventListener('keydown', (e) => {
                if (e.key === 'Enter') EventHandlers.handleAddRaw();
            });

            // Listen for postMessage from iframe
            window.addEventListener('message', (event) => {
                const d = event && event.data;
                if (!d || typeof d !== 'object') return;
                if (d.type === 'PSA_OP_INTERCEPTED') {
                    EventHandlers.handleInterceptedOp(d.op, d.hash);
                } else if (d.type === 'PSA_CLIENT_IDENTITY') {
                    if (typeof d.clientName === 'string' && d.clientName) State.setClientName(d.clientName.trim());
                    if (typeof d.clientVersion === 'string' && d.clientVersion) State.setClientVersion(d.clientVersion.trim());
                }
            });

            // Periodically check State (in case localStorage updated from iframe)
            setInterval(() => {
                const h = State.getHash();
                const statusText = document.getElementById('psa-hash-text');
                if (h && statusText && !statusText.textContent.includes(h.substring(0, 10))) {
                    Utils.updateUIHash(h);
                }
            }, 1000);

            if (currentHashVal) {
                Utils.logMessage('ok', 'Active hash loaded.');
            } else {
                Utils.logMessage('info', 'No hash. Script is listening in the background.');
                Utils.logMessage('info', 'Add any product to cart to capture it.');
            }
        }
    });

    // =========================================================================
    // EVENT HANDLERS
    // =========================================================================
    Object.assign(EventHandlers, {
        async handleAdd() {
            const btn = document.getElementById('psa-add-btn');
            const avatarId = document.getElementById('psa-avatar-input').value.trim();
            const country = document.getElementById('psa-country-select').value;
            const language = document.getElementById('psa-lang-input').value.trim();
            const activeHash = State.getHash();

            if (!avatarId) {
                Utils.logMessage('err', 'Enter avatar ID!');
                return;
            }

            if (!activeHash) {
                Utils.logMessage('err', 'No active hash.');
                Utils.logMessage('warn', 'Add any product to cart first to capture the hash.');
                return;
            }

            btn.disabled = true;
            btn.classList.add('psa-loading');
            Utils.clearLog();

            Utils.logMessage('info', `ID: ${avatarId}`);
            Utils.logMessage('info', `Region: ${country} / ${language}`);

            const suffixes = ['-E001', '-E002', '-E003', ''];

            for (const sfx of suffixes) {
                const sku = avatarId + sfx;
                Utils.logMessage('info', `Attempt: ${sku}...`);

                const data = await ApiService.addToCartGQL(sku, activeHash, country, language);

                if (data?.data?.addToCart) {
                    Utils.logMessage('ok', `✓ Added successfully: ${sku}`);
                    Utils.logMessage('ok', '🎉 Success! Item is in your cart.');
                    btn.disabled = false;
                    btn.classList.remove('psa-loading');
                    return;
                }

                if (data?.errors) {
                    const err = data.errors[0];
                    const msg = err?.message || 'Error';
                    const code = err?.extensions?.code || '';

                    if (code === 'PERSISTED_QUERY_NOT_FOUND') {
                        Utils.logMessage('err', 'Outdated hash detected.');
                        Utils.logMessage('warn', 'Cleared invalid hash. Add a product to cart to fetch a new one.');
                        State.setHash('');
                        Utils.updateUIHash('');
                        btn.disabled = false;
                        btn.classList.remove('psa-loading');
                        return;
                    }

                    Utils.logMessage('warn', `${sku}: ${msg}`);

                    // If it is not a SKU not found error, we found the right ID. Stop searching.
                    if (!msg.includes('SKU not found')) {
                        if (msg.includes('storefront') || msg.includes('store-front') || msg.includes('Store Front')) {
                            Utils.logMessage('ok', '⚠️ Received storefront error. Legacy PS3/PS4 avatars are often still successfully added to cart despite this! Check your cart on the official site.');
                        }
                        btn.disabled = false;
                        btn.classList.remove('psa-loading');
                        return;
                    }
                }
            }

            Utils.logMessage('err', 'All attempts failed. Check ID and region.');
            btn.disabled = false;
            btn.classList.remove('psa-loading');
        },

        async handleAddRaw() {
            const btn = document.getElementById('psa-add-raw-btn');
            const rawSku = document.getElementById('psa-raw-sku-input').value.trim();
            const country = document.getElementById('psa-country-select').value;
            const language = document.getElementById('psa-lang-input').value.trim();
            const activeHash = State.getHash();

            if (!rawSku) {
                Utils.logMessage('err', 'Enter Raw SKU!');
                return;
            }

            if (!activeHash) {
                Utils.logMessage('err', 'No active hash.');
                return;
            }

            btn.disabled = true;
            Utils.clearLog();

            Utils.logMessage('info', `[Raw] SKU: ${rawSku}`);
            Utils.logMessage('info', `Region: ${country} / ${language}`);
            Utils.logMessage('info', `Attempting raw addition...`);

            const data = await ApiService.addToCartGQL(rawSku, activeHash, country, language);

            if (data?.data?.addToCart) {
                Utils.logMessage('ok', `✓ Added successfully: ${rawSku}`);
                Utils.logMessage('ok', '🎉 Success! Item is in your cart.');
            } else if (data?.errors) {
                const err = data.errors[0];
                const msg = err?.message || 'Error';
                Utils.logMessage('err', `Failed: ${msg}`);
                if (msg.includes('storefront') || msg.includes('store-front') || msg.includes('Store Front')) {
                    Utils.logMessage('ok', '⚠️ Storefront error: Legacy PS3/PS4 avatars are often still successfully added to cart despite this! Check your cart on the official site.');
                }
            } else {
                Utils.logMessage('err', 'Unknown response from server.');
            }

            btn.disabled = false;
        },

        handleInterceptedOp(op, hash) {
            // Log all intercepted ops to show users that the interceptor is working
            Utils.logMessage('info', `[Intercepted] ${op}: ${String(hash || '').substring(0, 12)}...`);

            if (op === Config.OPERATION_NAME) {
                Utils.logMessage('ok', '🎉 Found addToCart hash!');
                // Persist here as well: with shared GM storage this is the
                // authoritative write; on Safari the top frame's copy is the only
                // one the panel can read back.
                const normalizedHash = (typeof hash === 'string' ? hash : '').toLowerCase();
                if (/^[a-f0-9]{64}$/.test(normalizedHash)) {
                    State.setHash(normalizedHash);
                }
                Utils.updateUIHash(hash);
            }
        }
    });

    // =========================================================================
    // APP INITIALIZATION
    // =========================================================================
    Object.assign(App, {
        init() {
            // Hydrate storage first (async GM.getValue on Greasemonkey 4), then
            // hook fetches so interception sees the real page traffic.
            Storage.bootstrap();
            Interceptor.init();

            // Only mount UI in top window
            if (window.self !== window.top) {
                return;
            }

            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                UiComponents.createUI();
            } else {
                window.addEventListener('DOMContentLoaded', UiComponents.createUI);
            }

            // Surfaced in the panel log so users can see which capabilities their
            // manager provides (matters on Safari and Greasemonkey).
            const backend = ApiService.backend();
            const backendLabel = backend === 'gm' ? 'GM_xmlhttpRequest'
                : backend === 'gm4' ? 'GM.xmlHttpRequest'
                : backend === 'page' ? 'page fetch (session-bound)'
                : 'none';
            const storageLabel = typeof GM_setValue === 'function' ? 'persistent (GM_setValue)'
                : Storage.hasAsync() ? 'persistent (GM.setValue)'
                : 'session-only (no GM storage)';
            const firstLog = () => {
                Utils.logMessage('info', `Request backend: ${backendLabel}`);
                Utils.logMessage('info', `Storage: ${storageLabel}`);
            };
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                setTimeout(firstLog, 0);
            } else {
                window.addEventListener('DOMContentLoaded', firstLog, { once: true });
            }
        }
    });

    App.init();

})();
