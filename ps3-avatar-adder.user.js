// ==UserScript==
// @name         PS Store Avatar Adder
// @namespace    https://github.com/yungtry/ps3avatars
// @version      6.3.0
// @description  Adds PS3/PS4 avatars to the PlayStation Store cart. Paste the avatar ID and click the button.
// @author       yungtry
// @match        https://store.playstation.com/*
// @match        https://checkout.playstation.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
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
        GQL_URL: 'https://web.np.playstation.com/api/graphql/v1//op',
        CLIENT_NAME: '@sie-ppr-web-checkout/app',
        CLIENT_VERSION: '2.176.0',
        OPERATION_NAME: 'addToCart',
        HASH_KEY: 'psa_addToCart_hash',
        DEFAULT_HASH: ''
    });

    // =========================================================================
    // STATE
    // =========================================================================
    Object.assign(State, {
        getClientName() { return GM_getValue('psa_client_name', Config.CLIENT_NAME); },
        setClientName(val) { GM_setValue('psa_client_name', val); },
        getClientVersion() { return GM_getValue('psa_client_version', Config.CLIENT_VERSION); },
        setClientVersion(val) { GM_setValue('psa_client_version', val); },
        getHash() { return GM_getValue(Config.HASH_KEY, Config.DEFAULT_HASH); },
        setHash(val) { GM_setValue(Config.HASH_KEY, val); }
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
            const d = document.createElement('span');
            d.textContent = text;
            e.innerHTML = `<span class="psa-dot"></span>`;
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
            if (text) text.textContent = hash ? `Hash: ${hash.substring(0, 20)}...` : 'missing (add product to cart)';
            if (manualInput) manualInput.value = hash;
        }
    });


    // =========================================================================
    // INTERCEPTOR (FETCH & XHR)
    // =========================================================================
    Object.assign(Interceptor, {
        init() {
            const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

            // ─── Hook fetch ───
            if (pageWindow.fetch) {
                const originalFetch = pageWindow.fetch;
                pageWindow.fetch = function (...args) {
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
                };
            }

            // ─── Hook XHR ───
            if (pageWindow.XMLHttpRequest) {
                const originalOpen = pageWindow.XMLHttpRequest.prototype.open;
                const originalSend = pageWindow.XMLHttpRequest.prototype.send;
                const originalSetHeader = pageWindow.XMLHttpRequest.prototype.setRequestHeader;

                pageWindow.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                    this._psaUrl = url;
                    if (url) Interceptor.interceptUrl(url);
                    return originalOpen.call(this, method, url, ...rest);
                };

                pageWindow.XMLHttpRequest.prototype.setRequestHeader = function (name, value, ...rest) {
                    try {
                        const lowerName = name.toLowerCase();
                        if (lowerName === 'apollographql-client-name') {
                            State.setClientName(value);
                        } else if (lowerName === 'apollographql-client-version') {
                            State.setClientVersion(value);
                        }
                    } catch (_) { }
                    return originalSetHeader.call(this, name, value, ...rest);
                };

                pageWindow.XMLHttpRequest.prototype.send = function (body) {
                    if (this._psaUrl && body) Interceptor.interceptBody(body);
                    return originalSend.call(this, body);
                };
            }
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
            if (op === Config.OPERATION_NAME) {
                if (/^[a-f0-9]{64}$/.test(hash)) {
                    State.setHash(hash);
                }
            }

            // Pass to top window if intercepted inside an iframe
            if (window.self !== window.top) {
                window.top.postMessage({ type: 'PSA_OP_INTERCEPTED', op: op, hash: hash }, '*');
            } else {
                EventHandlers.handleInterceptedOp(op, hash);
            }
        }
    });


    // =========================================================================
    // API SERVICE
    // =========================================================================
    Object.assign(ApiService, {
        addToCartGQL(sku, hash, country, language) {
            return new Promise((resolve) => {
                const locale = `${language.split('-')[0]}-${country}`;
                const clientName = State.getClientName();
                const clientVersion = State.getClientVersion();

                GM_xmlhttpRequest({
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
                    }),
                    anonymous: false,
                    onload: (resp) => {
                        try { resolve(JSON.parse(resp.responseText)); }
                        catch (e) { resolve({ errors: [{ message: `HTTP ${resp.status}: ${resp.statusText}` }] }); }
                    },
                    onerror: () => resolve({ errors: [{ message: 'Network error' }] }),
                    ontimeout: () => resolve({ errors: [{ message: 'Timeout' }] })
                });
            });
        }
    });


    // =========================================================================
    // UI COMPONENTS
    // =========================================================================
    Object.assign(UiComponents, {
        injectStyles() {
            GM_addStyle(`
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
            `);
        },

        createUI() {
            UiComponents.injectStyles();
            const locale = Utils.detectLocale();

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
                            PS Avatar Adder <span style="font-size:10px;color:#71717a;font-weight:400">v6.1</span>
                        </div>
                        <button id="psa-close-btn" title="Close">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>

                    <div id="psa-hash-status">
                        <div id="psa-hash-dot" class="${currentHashVal ? '' : 'psa-hash-missing'}"></div>
                        <span id="psa-hash-text">Hash: ${currentHashVal ? currentHashVal.substring(0, 20) + '...' : 'missing (add any game to the cart)'}</span>
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
                        <input id="psa-lang-input" type="text" value="${locale.language}" placeholder="pl-pl" />
                    </div>

                    <button id="psa-add-btn">🛒 Add to Cart</button>

                    <div style="margin-top:12px;">
                        <details style="font-size:11px; color:#71717a;" ${currentHashVal ? '' : 'open'}>
                            <summary style="cursor:pointer; user-select:none;">⚙️ Advanced / Developer Options</summary>
                            <input id="psa-manual-hash" type="text" value="${currentHashVal}" placeholder="Paste 64-character hash..."
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
                if (event.data && event.data.type === 'PSA_OP_INTERCEPTED') {
                    EventHandlers.handleInterceptedOp(event.data.op, event.data.hash);
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
            Utils.logMessage('info', `[Intercepted] ${op}: ${hash.substring(0, 12)}...`);

            if (op === Config.OPERATION_NAME) {
                Utils.logMessage('ok', '🎉 Found addToCart hash!');
                Utils.updateUIHash(hash);
            }
        }
    });

    // =========================================================================
    // APP INITIALIZATION
    // =========================================================================
    Object.assign(App, {
        init() {
            // Hook fetches first
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
        }
    });

    App.init();

})();
