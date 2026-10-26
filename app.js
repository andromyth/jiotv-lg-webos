(() => {
  'use strict';

  const SERVICE_URI = 'luna://com.codex.jtvwebos.service/';
  const AUTH_KEY = 'jtv-webos.jio-auth.v1';
  const CHANNELS_KEY = 'jtv-webos.channels.v1';
  const FAVORITES_KEY = 'jtv-webos.favorites.v1';
  const LANGUAGE_KEY = 'jtv-webos.language.v1';
  const QUALITY_UPGRADE_STABLE_MS = 45000;
  const QUALITY_UPGRADE_COOLDOWN_MS = 60000;
  const PLAYER_CONTROLS_HIDE_MS = 4500;
  const state = {
    channels: readStored(CHANNELS_KEY, []), group: 'all', language: readStored(LANGUAGE_KEY, 'bengali'), selected: -1,
    tuneBuffer: '', tuneTimer: null,
    active: null, auth: readStored(AUTH_KEY, null), proxyBaseUrl: '', proxyRequest: null,
    proxyPromise: null, loading: false, qualityLevels: null, qualityIndex: 0,
    playbackToken: 0, playbackMode: '', hlsRetryTried: false, stallSince: 0, stallTimer: null, ignoreStallsUntil: 0,
    lastPlaybackTime: 0, lastProgressAt: 0, qualityStableSince: 0, lastQualityChangeAt: 0,
    qualityRecoveryTimer: null, controlsHideTimer: null, lowestQualityWarningShown: false, otpSent: false, userInteracted: false,
    dashPlayer: null, dashTracks: [],
    programGuideVisible: false, epgProgrammes: [], epgCache: Object.create(null), epgRequestToken: 0, epgLoading: false, guideProgressTimer: null
  };
  const $ = (id) => document.getElementById(id);
  const elements = {
    connection: $('connection'), list: $('channel-list'), groups: $('groups'), languages: $('languages'),
    languageFilterRow: $('language-filter-row'), empty: $('empty'), search: $('search'),
    dialog: $('settings-dialog'), mobile: $('jio-mobile'), otp: $('jio-otp'), otpRow: $('otp-row'),
    signedIn: $('signed-in'), loginFields: $('login-fields'), settingsMessage: $('settings-message'),
    playerView: $('player-view'), player: $('player'), playerPrompt: $('player-prompt'), playerError: $('player-error'), controls: $('player-controls'),
    channelCount: $('channel-count'), nowTitle: $('now-title'), qualityStatus: $('quality-status'), toast: $('toast'),
    tuneDisplay: $('tune-display'), tuneDigits: $('tune-digits'),
    programGuide: $('program-guide'), guideChannel: $('guide-channel'), guideCurrentTitle: $('guide-current-title'),
    guideCurrentTime: $('guide-current-time'), guideCurrentDescription: $('guide-current-description'),
    guideProgress: $('guide-progress-fill'), guideProgressBar: $('guide-progress'), guideProgramList: $('guide-program-list'), guideStatus: $('guide-status')
  };

  function readStored(key, fallback) {
    try { const value = JSON.parse(localStorage.getItem(key)); return value == null ? fallback : value; }
    catch (_) { return fallback; }
  }
  function clearElement(element) { while (element.firstChild) element.removeChild(element.firstChild); }
  function serviceCall(method, parameters) {
    return new Promise((resolve, reject) => {
      if (!window.webOS || !webOS.service || !webOS.service.request) {
        reject(new Error('TV services are unavailable. Reinstall the JTV app from its TV package.'));
        return;
      }
      webOS.service.request(SERVICE_URI, {
        method,
        parameters: parameters || {},
        onSuccess(result) {
          if (result && result.returnValue === false) reject(new Error(result.errorText || 'The TV service could not complete this request.'));
          else resolve(result || {});
        },
        onFailure(error) { reject(new Error(error && error.errorText || 'Could not contact the JTV service on this TV.')); }
      });
    });
  }
  function saveAuth(auth) {
    state.auth = auth || null;
    if (state.auth) localStorage.setItem(AUTH_KEY, JSON.stringify(state.auth));
    else localStorage.removeItem(AUTH_KEY);
    updateAccountUI();
  }
  function normalizeChannels(channels) {
    return (channels || []).map((channel) => ({
      id: String(channel.id), title: channel.name || 'Unknown channel', logo: channel.logoUrl || '',
      group: channel.group || 'Other', language: channel.language || 'Other', isDrm: !!channel.isDrm
    }));
  }
  function languageKey(language) {
    const value = String(language || 'Other').trim().toLocaleLowerCase();
    if (['hi', 'hin', 'hindi'].includes(value)) return 'hindi';
    if (['bn', 'ben', 'bangla', 'bengali', 'বাংলা'].includes(value)) return 'bengali';
    if (['en', 'eng', 'english'].includes(value)) return 'english';
    return value || 'other';
  }
  function languageLabel(key, original) {
    if (key === 'hindi') return 'Hindi';
    if (key === 'bengali') return 'Bengali';
    if (key === 'english') return 'English';
    const value = String(original || key || 'Other').trim();
    return value.charAt(0).toLocaleUpperCase() + value.slice(1);
  }
  function filteredChannels() {
    const query = elements.search.value.trim().toLocaleLowerCase();
    const favorites = new Set(readStored(FAVORITES_KEY, []));
    return state.channels.filter((channel) => {
      const matchesGroup = state.group === 'all' || (state.group === 'favorites' ? favorites.has(channel.id) : channel.group === state.group);
      const matchesQuery = !query || `${channel.title} ${channel.group} ${channel.language}`.toLocaleLowerCase().includes(query);
      const matchesLanguage = state.language === 'all' || languageKey(channel.language) === state.language;
      return matchesGroup && matchesQuery && matchesLanguage;
    });
  }
  function setConnection(label, connected) {
    elements.connection.textContent = label;
    elements.connection.classList.toggle('connected', connected);
  }
  function render() {
    const channels = filteredChannels();
    const favorites = new Set(readStored(FAVORITES_KEY, []));
    const titleByLanguage = { bengali: 'Bengali channels', hindi: 'Hindi channels', english: 'English channels' };
    $('library-title').textContent = titleByLanguage[state.language] || 'Live channels';
    renderLanguageFilters();
    clearElement(elements.groups);
    const groups = [...new Set(state.channels.map((channel) => channel.group).filter(Boolean))];
    for (const group of groups) {
      const button = document.createElement('button');
      button.className = `group-chip${state.group === group ? ' active' : ''}`;
      button.textContent = group;
      button.dataset.group = group;
      button.addEventListener('click', () => {
        // Selecting the active category again clears only that category filter.
        // Keep the current language choice (Bengali by default) untouched.
        state.group = state.group === group ? 'all' : group; state.selected = -1; syncRail(); render();
        const selected = Array.from(elements.groups.querySelectorAll('.group-chip')).find((item) => item.dataset.group === group);
        if (selected) selected.focus();
      });
      elements.groups.append(button);
    }
    const hasFilters = !!elements.search.value.trim() || state.group !== 'all' || state.language !== 'all';
    elements.channelCount.textContent = state.channels.length
      ? (hasFilters ? `${channels.length.toLocaleString()} results` : `${state.channels.length.toLocaleString()} channels`)
      : '';
    clearElement(elements.list);
    channels.forEach((channel, index) => {
      const card = document.createElement('button');
      card.type = 'button';
      const isActive = !!state.active && state.active.id === channel.id;
      card.className = `channel-card${isActive ? ' selected' : ''}`;
      if (isActive) card.setAttribute('aria-current', 'true');
      card.dataset.index = String(index);
      card.dataset.channelId = channel.id;
      const logo = document.createElement('span');
      logo.className = 'logo';
      if (channel.logo) {
        const img = document.createElement('img');
        img.src = channel.logo;
        img.alt = '';
        img.onerror = () => { logo.textContent = channel.title.slice(0, 1).toUpperCase(); };
        logo.append(img);
      } else logo.textContent = channel.title.slice(0, 1).toUpperCase();
      const copy = document.createElement('span');
      copy.className = 'channel-copy';
      const title = document.createElement('strong'); title.textContent = channel.title;
      const group = document.createElement('small'); group.textContent = channel.group;
      copy.append(title, group);
      const channelId = document.createElement('span');
      channelId.className = 'channel-id';
      const channelIdLabel = document.createElement('small');
      channelIdLabel.textContent = 'ID';
      const channelIdNumber = document.createElement('strong');
      channelIdNumber.textContent = channel.id;
      channelId.append(channelIdLabel, channelIdNumber);
      channelId.setAttribute('aria-label', `Channel ID ${channel.id}`);
      card.append(logo, copy, channelId);
      if (favorites.has(channel.id)) { const star = document.createElement('span'); star.className = 'favorite'; star.textContent = '★'; card.append(star); }
      card.addEventListener('focus', () => { state.selected = index; });
      card.addEventListener('click', () => play(channel));
      card.addEventListener('contextmenu', (event) => { event.preventDefault(); toggleFavorite(channel); });
      elements.list.append(card);
    });
    const noChannels = channels.length === 0;
    elements.empty.classList.toggle('visible', noChannels);
    elements.list.hidden = noChannels;
    elements.groups.hidden = !state.channels.length;
    elements.languageFilterRow.hidden = !state.channels.length;
    if (!state.channels.length) {
      $('empty').querySelector('h2').textContent = state.loading ? 'Loading Jio channels' : 'Channels are unavailable';
      $('empty').querySelector('p').textContent = state.loading
        ? 'Connecting directly to Jio. This TV does not need a laptop or companion server.'
        : 'Check that this TV is online, then choose Settings to try again.';
      $('settings-cta').hidden = false;
      $('settings-cta').textContent = state.loading ? 'Settings' : 'Sign in or retry';
    } else {
      const showingEmptyFavorites = state.group === 'favorites' && state.language === 'all' && !elements.search.value.trim();
      $('empty').querySelector('h2').textContent = showingEmptyFavorites ? 'No saved channels yet' : 'No channels found';
      $('empty').querySelector('p').textContent = showingEmptyFavorites ? 'Save a channel from its card to find it here.' : 'Try a different search, language, or category.';
      $('settings-cta').hidden = true;
    }
    syncRail();
  }
  function renderLanguageFilters() {
    clearElement(elements.languages);
    const counts = new Map();
    for (const channel of state.channels) {
      const key = languageKey(channel.language);
      const current = counts.get(key) || { count: 0, label: languageLabel(key, channel.language) };
      current.count++; counts.set(key, current);
    }
    const preferred = ['bengali', 'hindi', 'english'];
    const rest = [...counts.keys()].filter((key) => !preferred.includes(key)).sort((a, b) => counts.get(a).label.localeCompare(counts.get(b).label));
    const filters = [{ key: 'all', label: 'All', count: state.channels.length }];
    for (const key of [...preferred.filter((key) => counts.has(key)), ...rest]) filters.push({ key, label: counts.get(key).label, count: counts.get(key).count });
    for (const filter of filters) {
      const button = document.createElement('button');
      button.type = 'button'; button.className = `language-chip${state.language === filter.key ? ' active' : ''}`;
      button.dataset.language = filter.key; button.textContent = `${filter.label} (${filter.count.toLocaleString()})`;
      button.setAttribute('aria-pressed', state.language === filter.key ? 'true' : 'false');
      button.addEventListener('click', () => {
        state.language = filter.key; localStorage.setItem(LANGUAGE_KEY, filter.key); state.selected = -1; render();
        const selected = Array.from(elements.languages.querySelectorAll('button')).find((item) => item.dataset.language === filter.key);
        if (selected) selected.focus();
      });
      elements.languages.append(button);
    }
  }
  function syncRail() { document.querySelectorAll('.rail-item').forEach((item) => item.classList.toggle('selected', item.dataset.group === state.group)); }

  async function loadChannels() {
    state.loading = true; render(); setConnection(state.auth ? 'Connecting to Jio…' : 'Loading Jio channels…', false);
    try {
      const result = await serviceCall('library/getChannels', {});
      state.channels = normalizeChannels(result.channels);
      localStorage.setItem(CHANNELS_KEY, JSON.stringify(state.channels));
      state.group = 'all';
      if (state.language !== 'all' && !state.channels.some((channel) => languageKey(channel.language) === state.language)) {
        state.language = state.channels.some((channel) => languageKey(channel.language) === 'bengali') ? 'bengali' : 'all';
        localStorage.setItem(LANGUAGE_KEY, state.language);
      }
      setConnection(state.auth ? 'Jio account ready' : 'Sign in to watch', !!state.auth);
      return state.channels.length;
    } catch (error) {
      setConnection('Jio connection failed', false);
      if (!state.channels.length) showToast(error.message || 'Could not load channels from Jio.');
      else showToast('Could not refresh channels. Showing the saved list.');
      return state.channels.length;
    } finally { state.loading = false; render(); }
  }
  function updateAccountUI() {
    const signedIn = !!(state.auth && state.auth.authToken);
    elements.signedIn.hidden = !signedIn;
    elements.loginFields.hidden = signedIn;
    if (signedIn) $('account-label').textContent = `Signed in to Jio${state.auth.mobile ? ` •••• ${state.auth.mobile.slice(-4)}` : ''}`;
    if (state.channels.length) setConnection(signedIn ? 'Jio account ready' : 'Sign in to watch', signedIn);
  }
  function openSettings() {
    clearTuneBuffer();
    elements.settingsMessage.textContent = '';
    elements.mobile.value = state.auth && state.auth.mobile ? state.auth.mobile : '';
    elements.otp.value = '';
    elements.otpRow.hidden = !state.otpSent;
    updateAccountUI();
    elements.dialog.showModal();
    if (state.auth) $('sign-out').focus(); else elements.mobile.focus();
  }
  function showToast(message) {
    elements.toast.textContent = message; elements.toast.classList.add('show');
    clearTimeout(showToast.timer); showToast.timer = setTimeout(() => elements.toast.classList.remove('show'), 3000);
  }
  function clearTuneBuffer() {
    clearTimeout(state.tuneTimer);
    state.tuneTimer = null;
    state.tuneBuffer = '';
    elements.tuneDisplay.hidden = true;
    elements.tuneDisplay.setAttribute('aria-hidden', 'true');
  }
  function appendTuneDigit(digit) {
    if (state.tuneBuffer.length >= 8) return;
    state.tuneBuffer += digit;
    clearTimeout(state.tuneTimer);
    state.tuneTimer = setTimeout(clearTuneBuffer, 5000);
    elements.tuneDigits.textContent = state.tuneBuffer;
    elements.tuneDisplay.hidden = false;
    elements.tuneDisplay.setAttribute('aria-hidden', 'false');
  }
  function tuneToEnteredChannel() {
    if (!state.tuneBuffer) return false;
    const id = state.tuneBuffer;
    clearTuneBuffer();
    const channel = state.channels.find((item) => item.id === id);
    if (!channel) {
      showToast(`No channel with ID ${id}`);
      return true;
    }
    play(channel);
    return true;
  }
  function clearPlayerControlsTimer() {
    if (state.controlsHideTimer) clearTimeout(state.controlsHideTimer);
    state.controlsHideTimer = null;
  }
  function revealPlayerControls(autoHide) {
    clearPlayerControlsTimer();
    document.body.classList.remove('player-controls-hidden');
    elements.controls.setAttribute('aria-hidden', 'false');
    if (!autoHide || !state.active || elements.player.paused || elements.player.ended) return;
    state.controlsHideTimer = setTimeout(() => {
      state.controlsHideTimer = null;
      if (!state.active || elements.player.paused || elements.player.ended || !elements.playerError.hidden) return;
      document.body.classList.add('player-controls-hidden');
      elements.controls.setAttribute('aria-hidden', 'true');
    }, PLAYER_CONTROLS_HIDE_MS);
  }
  function saveRefreshedAuth(auth) { if (auth && auth.authToken) saveAuth(auth); }
  function startProxy() {
    if (!state.auth || !state.auth.authToken) return Promise.reject(new Error('Sign in with Jio in Settings before watching.'));
    if (state.proxyBaseUrl) return Promise.resolve(state.proxyBaseUrl);
    if (state.proxyPromise) return state.proxyPromise;
    state.proxyPromise = new Promise((resolve, reject) => {
      let settled = false;
      state.proxyRequest = webOS.service.request(SERVICE_URI, {
        method: 'proxy/start', parameters: { auth: state.auth }, subscribe: true,
        onSuccess(result) {
          if (result && result.auth) saveRefreshedAuth(result.auth);
          if (result && result.baseUrl) {
            state.proxyBaseUrl = result.baseUrl;
            if (!settled) { settled = true; resolve(result.baseUrl); }
          }
          if (result && result.returnValue === false && !settled) { settled = true; reject(new Error(result.errorText || 'Could not start the TV stream service.')); }
        },
        onFailure(error) {
          if (!settled) { settled = true; reject(new Error(error && error.errorText || 'Could not start the TV stream service.')); }
        }
      });
    }).finally(() => { state.proxyPromise = null; });
    return state.proxyPromise;
  }
  function stopProxy() {
    if (state.proxyRequest && state.proxyRequest.cancel) state.proxyRequest.cancel();
    state.proxyRequest = null; state.proxyBaseUrl = ''; state.proxyPromise = null;
  }

  async function sendOtp() {
    $('send-otp').disabled = true; elements.settingsMessage.textContent = 'Requesting an OTP from Jio…';
    try {
      const result = await serviceCall('auth/sendOtp', { mobile: elements.mobile.value });
      state.otpSent = true; elements.otpRow.hidden = false; elements.otp.focus();
      elements.settingsMessage.textContent = result.message || 'OTP sent. Enter the code Jio sent to your phone.';
    } catch (error) { elements.settingsMessage.textContent = error.message || 'Jio could not send the OTP.'; }
    finally { $('send-otp').disabled = false; }
  }
  async function verifyOtp() {
    $('verify-otp').disabled = true; elements.settingsMessage.textContent = 'Verifying with Jio…';
    try {
      const result = await serviceCall('auth/verifyOtp', { mobile: elements.mobile.value, otp: elements.otp.value });
      saveAuth(result.auth); state.otpSent = false;
      elements.dialog.close();
      setConnection('Jio account ready', true); showToast('Signed in to Jio on this TV.');
      elements.search.focus();
    } catch (error) { elements.settingsMessage.textContent = error.message || 'Could not verify the OTP.'; }
    finally { $('verify-otp').disabled = false; }
  }

  function playbackURL(channel, level) {
    return `${state.proxyBaseUrl}/live/${encodeURIComponent(channel.id)}.m3u8?level=${encodeURIComponent(String(level))}`;
  }
  function parseQualityLevels(manifest) {
    const levels = new Map();
    const lines = manifest.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim().startsWith('#EXT-X-STREAM-INF')) continue;
      const resolution = /RESOLUTION=\d+x(\d+)/i.exec(line);
      const averageBandwidth = /AVERAGE-BANDWIDTH=(\d+)/i.exec(line);
      const bandwidth = /(?:^|[:,])BANDWIDTH=(\d+)/i.exec(line);
      const height = resolution ? Number(resolution[1]) : 0;
      const rate = Number((averageBandwidth && averageBandwidth[1]) || (bandwidth && bandwidth[1]) || 0);
      const key = height ? `h${height}` : `b${rate}`;
      const previous = levels.get(key);
      if (!previous || rate > previous.bandwidth) levels.set(key, { height, bandwidth: rate });
    }
    return [...levels.values()].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  }
  async function discoverQualityLevels(channel, playbackToken) {
    try {
      const result = await serviceCall('proxy/qualities', { channelId: channel.id, auth: state.auth });
      if (result.auth) saveRefreshedAuth(result.auth);
      if (playbackToken !== state.playbackToken || !state.active || state.active.id !== channel.id) return;
      state.qualityLevels = result.levels || [];
      elements.qualityStatus.textContent = qualityLabel(0);
    } catch (_) {
      if (playbackToken === state.playbackToken) { state.qualityLevels = []; elements.qualityStatus.textContent = 'Best available'; }
    }
  }
  function qualityLabel(index) {
    const level = state.qualityLevels && state.qualityLevels[index];
    return level && level.height ? `${level.height}p` : (index ? 'Lower quality' : 'Best available');
  }
  async function destroyDashPlayer() {
    const player = state.dashPlayer;
    state.dashPlayer = null; state.dashTracks = [];
    if (player) { try { await player.destroy(); } catch (_) {} }
  }
  async function retryDashAsSameChannelHls(channel, playbackToken, dashMessage) {
    if (playbackToken !== state.playbackToken || !state.active || state.active.id !== channel.id) return true;
    if (state.hlsRetryTried || state.playbackMode !== 'dash') return state.hlsRetryTried || state.playbackMode === 'switching';
    state.hlsRetryTried = true; state.playbackMode = 'switching';
    showToast(`DASH could not play. Trying the HLS stream for ${channel.title}.`);
    try {
      const playback = await serviceCall('proxy/resolve', { channelId: channel.id, auth: state.auth, forceHls: true });
      if (playback.auth) saveRefreshedAuth(playback.auth);
      if (playbackToken !== state.playbackToken || !state.active || state.active.id !== channel.id) return true;
      if (playback.mode !== 'hls') throw new Error('Jio did not provide a usable HLS playlist for this channel.');
      await destroyDashPlayer();
      if (playbackToken !== state.playbackToken || !state.active || state.active.id !== channel.id) return true;
      state.playbackMode = 'hls'; state.qualityLevels = playback.levels || []; state.qualityIndex = 0;
      state.lastPlaybackTime = 0; state.lowestQualityWarningShown = false;
      elements.playerError.hidden = true; elements.qualityStatus.textContent = qualityLabel(0);
      setQualitySource(0, true, false);
      showToast(`Playing ${channel.title} using its HLS stream.`);
    } catch (error) {
      if (playbackToken !== state.playbackToken || !state.active || state.active.id !== channel.id) return true;
      state.playbackMode = 'failed';
      showPlayerError(`${dashMessage} The same channel's HLS stream also failed: ${error.message || 'Jio did not provide a usable HLS playlist.'}`);
    }
    return true;
  }
  function patchWebOsDrmDecodingInfo() {
    const capabilities = navigator.mediaCapabilities;
    if (!capabilities || typeof capabilities.decodingInfo !== 'function' || window.__jtvWebOsDrmMcapPatched) return;
    const original = capabilities.decodingInfo;
    capabilities.decodingInfo = function(configuration) {
      return original.call(capabilities, configuration).then((info) => {
        const keySystem = configuration && configuration.keySystemConfiguration;
        if (!keySystem || info.keySystemAccess || !info.supported || !navigator.requestMediaKeySystemAccess) return info;
        const emeConfiguration = {
          initDataTypes: [keySystem.initDataType || 'cenc'],
          distinctiveIdentifier: keySystem.distinctiveIdentifier || 'optional',
          persistentState: keySystem.persistentState || 'optional',
          sessionTypes: keySystem.sessionTypes && keySystem.sessionTypes.length ? keySystem.sessionTypes : ['temporary']
        };
        const capabilityFor = (media, drm) => {
          const capability = { contentType: media.contentType };
          if (drm.robustness) capability.robustness = drm.robustness;
          if (drm.encryptionScheme) capability.encryptionScheme = drm.encryptionScheme;
          return capability;
        };
        if (configuration.audio && keySystem.audio) emeConfiguration.audioCapabilities = [capabilityFor(configuration.audio, keySystem.audio)];
        if (configuration.video && keySystem.video) emeConfiguration.videoCapabilities = [capabilityFor(configuration.video, keySystem.video)];
        return navigator.requestMediaKeySystemAccess(keySystem.keySystem, [emeConfiguration]).then((access) =>
          Object.assign({}, info, { keySystemAccess: access })
        ).catch(() => Object.assign({}, info, { supported: false, keySystemAccess: null }));
      });
    };
    window.__jtvWebOsDrmMcapPatched = true;
  }
  async function startDashPlayback(channel, playbackToken, hasDrm) {
    if (!window.shaka || !window.shaka.Player || !window.shaka.Player.isBrowserSupported()) {
      throw new Error('This TV cannot play Jio’s DASH stream with its current media support.');
    }
    patchWebOsDrmDecodingInfo();
    const player = new window.shaka.Player();
    state.dashPlayer = player;
    await player.attach(elements.player);
    if (playbackToken !== state.playbackToken) { await destroyDashPlayer(); return; }
    const channelId = encodeURIComponent(channel.id);
    const proxyBase = state.proxyBaseUrl;
    player.configure({ abr: { enabled: false } });
    if (hasDrm) {
      player.configure({ drm: { servers: { 'com.widevine.alpha': `${proxyBase}/license?ch=${channelId}` } } });
    }
    player.getNetworkingEngine().registerRequestFilter((type, request) => {
      if (type === window.shaka.net.NetworkingEngine.RequestType.LICENSE) return;
      request.uris = request.uris.map((uri) => {
        if (uri.indexOf(`${proxyBase}/`) === 0 || !/^https?:\/\//i.test(uri)) return uri;
        return `${proxyBase}/fetch?ch=${channelId}&u=${encodeURIComponent(uri)}`;
      });
    });
    player.addEventListener('error', (event) => {
      if (playbackToken !== state.playbackToken || state.playbackMode !== 'dash') return;
      const detail = event.detail || {};
      const category = Number(detail.category);
      const code = detail.code ? ` (error ${detail.code})` : '';
      const diagnosis = ({
        1: 'a network or CDN request failed',
        3: 'the TV could not decode the media format',
        4: 'the stream manifest could not be read',
        6: 'the Widevine license could not be acquired or used'
      })[category] || (hasDrm ? 'the Widevine stream could not be played' : 'the DASH stream could not be played');
      void retryDashAsSameChannelHls(channel, playbackToken, `Jio playback failed: ${diagnosis}${code}.`)
        .then((handled) => { if (!handled && playbackToken === state.playbackToken) showPlayerError(`Jio playback failed: ${diagnosis}${code}.`); });
    });
    await player.load(`${proxyBase}/dash/${channelId}.mpd`);
    if (playbackToken !== state.playbackToken) { await destroyDashPlayer(); return; }
    const bestByLevel = new Map();
    for (const track of player.getVariantTracks()) {
      const key = track.height ? `h${track.height}` : `b${track.bandwidth || 0}`;
      const previous = bestByLevel.get(key);
      if (!previous || (track.bandwidth || 0) > (previous.bandwidth || 0)) bestByLevel.set(key, track);
    }
    state.dashTracks = [...bestByLevel.values()].sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    state.qualityLevels = state.dashTracks.map((track) => ({ height: track.height || 0, bandwidth: track.bandwidth || 0 }));
    elements.qualityStatus.textContent = qualityLabel(0);
    elements.playerPrompt.hidden = true;
    if (state.dashTracks.length) player.selectVariantTrack(state.dashTracks[0], true);
    await elements.player.play().catch((error) => {
      if (error && error.name === 'NotAllowedError') showPlayerError('Press OK to start playback.');
    });
  }
  async function play(channel) {
    if (!channel) return;
    if (state.programGuideVisible) closeProgramGuide();
    if (!state.auth || !state.auth.authToken) {
      showToast('Sign in with your Jio number in Settings to watch channels.'); openSettings(); return;
    }
    state.playbackToken++;
    const playbackToken = state.playbackToken;
    await destroyDashPlayer();
    state.playbackMode = ''; state.hlsRetryTried = false;
    clearStallMonitor(); clearQualityRecovery(); state.qualityLevels = null; state.qualityIndex = 0;
    state.lastPlaybackTime = 0; state.lowestQualityWarningShown = false;
    elements.playerError.hidden = true; elements.player.pause(); elements.player.removeAttribute('src'); elements.player.load();
    elements.playerPrompt.hidden = false; elements.controls.hidden = false; revealPlayerControls(false);
    elements.playerView.setAttribute('aria-hidden', 'false'); elements.nowTitle.textContent = channel.title;
    elements.qualityStatus.textContent = 'Connecting to Jio…'; state.active = channel; render();
    document.body.classList.add('playing'); $('play-toggle').focus();
    try {
      await startProxy();
      if (playbackToken !== state.playbackToken || !state.active) return;
      const playback = await serviceCall('proxy/resolve', { channelId: channel.id, auth: state.auth });
      if (playback.auth) saveRefreshedAuth(playback.auth);
      if (playbackToken !== state.playbackToken || !state.active) return;
      elements.playerPrompt.hidden = true;
      if (playback.mode === 'dash') {
        state.playbackMode = 'dash';
        try {
          await startDashPlayback(channel, playbackToken, !!playback.hasDrm);
        } catch (error) {
          if (await retryDashAsSameChannelHls(channel, playbackToken, error.message || 'The TV could not start the DASH stream.')) return;
          throw error;
        }
      } else {
        state.playbackMode = 'hls';
        state.qualityLevels = playback.levels || [];
        elements.qualityStatus.textContent = qualityLabel(0);
        setQualitySource(0, true, false);
      }
    } catch (error) {
      if (playbackToken === state.playbackToken && !state.hlsRetryTried) showPlayerError(error.message || 'Could not start the TV stream service.');
    }
  }
  function setQualitySource(level, startPlayback, fallback) {
    if (!state.active || !state.proxyBaseUrl) return;
    const player = elements.player;
    const resume = startPlayback || (!player.paused && !player.ended);
    const movingUp = level < state.qualityIndex;
    clearStallMonitor(); state.qualityIndex = level; state.lastPlaybackTime = 0;
    state.lastProgressAt = Date.now(); state.qualityStableSince = 0; state.lastQualityChangeAt = Date.now();
    state.ignoreStallsUntil = Date.now() + 2500;
    elements.qualityStatus.textContent = qualityLabel(level);
    if (state.dashPlayer) {
      const track = state.dashTracks[level];
      if (track) state.dashPlayer.selectVariantTrack(track, true);
      if (fallback) showToast(`Network is slow. Switching to ${qualityLabel(level)}.`);
      else if (movingUp) showToast(`Connection is stable. Trying ${qualityLabel(level)}.`);
      if (resume && player.paused) player.play().catch(() => {});
      return;
    }
    player.pause(); player.src = playbackURL(state.active, level); player.load();
    if (fallback) showToast(`Network is slow. Switching to ${qualityLabel(level)}.`);
    else if (movingUp) showToast(`Connection is stable. Trying ${qualityLabel(level)}.`);
    if (resume) player.play().catch((error) => { if (error && error.name === 'NotAllowedError') showPlayerError('Press OK to start playback.'); });
  }
  function startQualityRecovery() {
    if (state.qualityRecoveryTimer) return;
    state.qualityRecoveryTimer = setInterval(() => {
      const player = elements.player;
      if (!state.active || player.paused || player.ended || !state.qualityLevels || state.qualityIndex <= 0) {
        state.qualityStableSince = 0;
        return;
      }
      const now = Date.now();
      if (state.stallSince || !state.lastProgressAt || now - state.lastProgressAt > 7000) {
        state.qualityStableSince = 0;
        return;
      }
      if (!state.qualityStableSince) { state.qualityStableSince = now; return; }
      if (now - state.qualityStableSince < QUALITY_UPGRADE_STABLE_MS || now - state.lastQualityChangeAt < QUALITY_UPGRADE_COOLDOWN_MS) return;
      setQualitySource(state.qualityIndex - 1, true, false);
    }, 5000);
  }
  function clearQualityRecovery() {
    if (state.qualityRecoveryTimer) clearInterval(state.qualityRecoveryTimer);
    state.qualityRecoveryTimer = null; state.qualityStableSince = 0;
  }
  function clearStallMonitor() { if (state.stallTimer) clearTimeout(state.stallTimer); state.stallTimer = null; state.stallSince = 0; }
  function scheduleStallFallback() {
    if (!state.active || elements.player.paused) return;
    if (!state.stallSince) state.stallSince = Date.now();
    if (state.stallTimer) return;
    state.stallTimer = setTimeout(() => {
      state.stallTimer = null;
      if (!state.active || elements.player.paused || !state.stallSince) return;
      const stalledFor = Date.now() - state.stallSince;
      if (stalledFor < 8000) { state.stallTimer = setTimeout(handleSustainedStall, 8000 - stalledFor); return; }
      handleSustainedStall();
    }, 8000);
  }
  function handleSustainedStall() {
    state.stallTimer = null;
    if (!state.active || elements.player.paused) return;
    if (state.qualityLevels && state.qualityIndex + 1 < state.qualityLevels.length) { setQualitySource(state.qualityIndex + 1, false, true); return; }
    clearStallMonitor();
    if (!state.lowestQualityWarningShown) {
      showToast(state.qualityLevels && state.qualityLevels.length > 1 ? 'Still buffering at the lowest available quality.' : 'Still buffering. No lower stream quality is available.');
      state.lowestQualityWarningShown = true;
    }
  }
  function handlePlaybackError() {
    if (!state.active) return;
    if (state.dashPlayer) return;
    if (state.qualityLevels === null) {
      const playbackToken = state.playbackToken;
      setTimeout(() => { if (playbackToken === state.playbackToken && state.active && state.qualityLevels !== null) handlePlaybackError(); }, 1500);
      return;
    }
    if (Date.now() >= state.ignoreStallsUntil && state.qualityLevels && state.qualityIndex + 1 < state.qualityLevels.length) {
      setQualitySource(state.qualityIndex + 1, !elements.player.paused, true); return;
    }
    const mediaError = elements.player.error;
    const code = mediaError && mediaError.code;
    const diagnosis = ({
      1: 'playback was interrupted',
      2: 'the TV could not fetch the stream from the network or CDN',
      3: 'the TV could not decode the stream format',
      4: 'the TV rejected the stream format or source'
    })[code] || 'the TV reported a playback error';
    showPlayerError(`Jio stream failed: ${diagnosis}${code ? ` (media error ${code})` : ''}.`);
  }
  function showPlayerError(message) { revealPlayerControls(false); elements.playerError.textContent = message; elements.playerError.hidden = false; }
  function isYellowButton(event) {
    const code = event && (event.keyCode || event.which);
    const key = String(event && event.key || "").toLowerCase();
    return code === 405 || key === "yellow" || key === "colorf3";
  }
  function toEpochMilliseconds(value) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "number" || /^-?\\d+(?:\\.\\d+)?$/.test(String(value).trim())) {
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      return Math.abs(number) < 1000000000000 ? number * 1000 : number;
    }
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  function normalizeEpgProgrammes(items) {
    const firstValue = (item, keys) => {
      for (const key of keys) if (item[key] !== undefined && item[key] !== null && item[key] !== "") return item[key];
      return null;
    };
    return (Array.isArray(items) ? items : []).map((item) => {
      item = item || {};
      const startMs = toEpochMilliseconds(firstValue(item, ['startEpoch', 'start_epoch', 'startTime', 'start_time', 'start', 'starttime']));
      const endMs = toEpochMilliseconds(firstValue(item, ['endEpoch', 'end_epoch', 'endTime', 'end_time', 'end', 'stoptime']));
      const rawTitle = firstValue(item, ['title', 'showname', 'programName', 'program_name', 'name']);
      return {
        startMs,
        endMs,
        title: rawTitle == null ? '' : String(rawTitle).trim(),
        description: String(firstValue(item, ['description', 'desc', 'episodeDesc', 'episode_desc']) || '').trim(),
        category: String(firstValue(item, ['category', 'showCategory', 'genre']) || '').trim()
      };
    }).filter((item) => item.title && Number.isFinite(item.startMs) && Number.isFinite(item.endMs) && item.endMs > item.startMs)
      .sort((a, b) => a.startMs - b.startMs);
  }
  function formatGuideTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  function setGuideStatus(message) {
    elements.guideStatus.textContent = message || '';
    elements.guideStatus.hidden = !message;
  }
  function renderProgramGuide() {
    if (!state.programGuideVisible) return;
    const now = Date.now();
    const programmes = state.epgProgrammes || [];
    const current = programmes.find((item) => item.startMs <= now && item.endMs > now) || null;
    if (current) {
      elements.guideCurrentTitle.textContent = current.title;
      elements.guideCurrentTime.textContent = formatGuideTime(current.startMs) + ' – ' + formatGuideTime(current.endMs) + '  ·  LIVE';
      elements.guideCurrentDescription.textContent = current.description || current.category || 'Programme currently airing on this channel.';
      const duration = current.endMs - current.startMs;
      const progress = duration > 0 ? Math.max(0, Math.min(100, ((now - current.startMs) / duration) * 100)) : 0;
      elements.guideProgress.style.width = progress.toFixed(1) + '%';
      elements.guideProgressBar.setAttribute('aria-valuenow', String(Math.round(progress)));
    } else {
      elements.guideCurrentTitle.textContent = 'Current programme unavailable';
      elements.guideCurrentTime.textContent = '';
      elements.guideCurrentDescription.textContent = 'The schedule may not include a listing for the current time.';
      elements.guideProgress.style.width = '0%';
      elements.guideProgressBar.setAttribute('aria-valuenow', '0');
    }
    clearElement(elements.guideProgramList);
    const upcoming = programmes.filter((item) => item.startMs > now && item !== current).slice(0, 3);
    if (!upcoming.length) {
      const empty = document.createElement('div');
      empty.className = 'guide-program-empty';
      empty.textContent = state.epgLoading ? 'Loading upcoming programmes…' : 'No upcoming programme listings are available.';
      elements.guideProgramList.append(empty);
      return;
    }
    upcoming.forEach((programme) => {
      const card = document.createElement('div');
      card.className = 'guide-program-card';
      const time = document.createElement('span');
      time.className = 'guide-program-time';
      time.textContent = formatGuideTime(programme.startMs) + ' – ' + formatGuideTime(programme.endMs);
      const title = document.createElement('strong');
      title.className = 'guide-program-title';
      title.textContent = programme.title;
      const description = document.createElement('span');
      description.className = 'guide-program-description';
      description.textContent = programme.description || programme.category || '';
      card.append(time, title, description);
      elements.guideProgramList.append(card);
    });
  }
  function closeProgramGuide() {
    if (!state.programGuideVisible) return;
    state.programGuideVisible = false;
    state.epgRequestToken++;
    state.epgLoading = false;
    if (state.guideProgressTimer) clearInterval(state.guideProgressTimer);
    state.guideProgressTimer = null;
    elements.programGuide.hidden = true;
    elements.programGuide.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('program-guide-open');
    if (state.active && !elements.player.paused && !elements.player.ended) {
      clearPlayerControlsTimer();
      document.body.classList.add('player-controls-hidden');
      elements.controls.setAttribute('aria-hidden', 'true');
    } else {
      revealPlayerControls(false);
    }
  }
  function openProgramGuide() {
    if (!state.active) return;
    state.programGuideVisible = true;
    state.epgLoading = false;
    const channel = state.active;
    const channelId = String(channel.id);
    const requestToken = ++state.epgRequestToken;
    clearPlayerControlsTimer();
    document.body.classList.add('program-guide-open', 'player-controls-hidden');
    elements.controls.setAttribute('aria-hidden', 'true');
    elements.programGuide.hidden = false;
    elements.programGuide.setAttribute('aria-hidden', 'false');
    elements.guideChannel.textContent = channel.title;
    const cached = state.epgCache[channelId];
    if (cached && cached.programmes) {
      state.epgProgrammes = cached.programmes;
      setGuideStatus(Date.now() - cached.fetchedAt < 180000 ? '' : 'Refreshing programme information…');
    } else {
      state.epgProgrammes = [];
      setGuideStatus('Loading programme information…');
    }
    renderProgramGuide();
    if (state.guideProgressTimer) clearInterval(state.guideProgressTimer);
    state.guideProgressTimer = setInterval(renderProgramGuide, 30000);
    if (cached && Date.now() - cached.fetchedAt < 180000) return;
    state.epgLoading = true;
    renderProgramGuide();
    serviceCall('epg/get', { channelId: channelId, offset: 0 }).then((result) => {
      if (requestToken !== state.epgRequestToken || !state.programGuideVisible || !state.active || String(state.active.id) !== channelId) return;
      const programmes = normalizeEpgProgrammes(result.programmes || result.epg || result.result);
      state.epgLoading = false;
      if (programmes.length) {
        state.epgProgrammes = programmes;
        state.epgCache[channelId] = { programmes: programmes, fetchedAt: Date.now() };
        setGuideStatus('');
      } else {
        state.epgProgrammes = [];
        setGuideStatus('No programme schedule was returned for this channel.');
      }
      renderProgramGuide();
    }).catch(() => {
      if (requestToken !== state.epgRequestToken || !state.programGuideVisible || !state.active || String(state.active.id) !== channelId) return;
      state.epgLoading = false;
      setGuideStatus(state.epgProgrammes.length ? 'Could not refresh the guide; showing the last available schedule.' : 'Programme information is temporarily unavailable. Press Yellow to retry.');
      renderProgramGuide();
    });
  }
  function toggleProgramGuide() {
    if (!state.active) return;
    if (state.programGuideVisible) closeProgramGuide();
    else openProgramGuide();
  }

  function stopPlayback() {
    closeProgramGuide();
    clearPlayerControlsTimer(); document.body.classList.remove('player-controls-hidden');
    state.playbackToken++; state.playbackMode = ''; state.hlsRetryTried = false; clearStallMonitor(); clearQualityRecovery(); state.qualityLevels = null; state.qualityIndex = 0;
    const previousChannelId = state.active && state.active.id;
    destroyDashPlayer();
    elements.player.pause(); elements.player.removeAttribute('src'); elements.player.load();
    state.active = null; document.body.classList.remove('playing');
    elements.playerView.setAttribute('aria-hidden', 'true'); elements.playerPrompt.hidden = false;
    elements.controls.hidden = true; elements.controls.setAttribute('aria-hidden', 'true'); elements.nowTitle.textContent = 'Choose a channel'; stopProxy(); render();
    if (previousChannelId) {
      const previousCard = Array.from(elements.list.querySelectorAll('.channel-card')).find((card) => card.dataset.channelId === previousChannelId);
      if (previousCard) previousCard.focus();
    }
  }
  function toggleFavorite(channel) {
    const favorites = new Set(readStored(FAVORITES_KEY, []));
    if (favorites.has(channel.id)) favorites.delete(channel.id); else favorites.add(channel.id);
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites])); render();
    const card = Array.from(elements.list.querySelectorAll('.channel-card')).find((item) => item.dataset.channelId === channel.id);
    if (card) card.focus();
    showToast(favorites.has(channel.id) ? 'Added to Saved' : 'Removed from Saved');
  }

  function focusableElements(scope) {
    return Array.from(scope.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]')).filter((element) => {
      if (element.closest('[hidden]') || element.disabled) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }
  function focusAndReveal(element) {
    if (!element) return false;
    element.focus();
    element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    return true;
  }
  function gridColumnCount() {
    const columns = window.getComputedStyle(elements.list).gridTemplateColumns
      .trim().split(/\\s+/).filter(Boolean).length;
    return Math.max(1, columns || 1);
  }
  function nearestHorizontalElement(elementsToCheck, sourceElement) {
    if (!elementsToCheck.length) return null;
    const sourceRect = sourceElement.getBoundingClientRect();
    const sourceX = sourceRect.left + sourceRect.width / 2;
    return elementsToCheck.reduce((best, element) => {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.left + rect.width / 2 - sourceX);
      return !best || distance < best.distance ? { element, distance } : best;
    }, null).element;
  }
  function moveFocus(direction) {
    const current = document.activeElement;
    const vertical = direction === 'ArrowUp' || direction === 'ArrowDown';

    // Keep vertical navigation inside the channel grid. Generic screen-wide
    // focus geometry can choose a genre chip while scrolling the channel list,
    // especially when the list itself has been scrolled.
    if (vertical && current && current.classList && current.classList.contains('channel-card')) {
      const cards = Array.from(elements.list.querySelectorAll('.channel-card'));
      const index = cards.indexOf(current);
      if (index !== -1) {
        const columns = gridColumnCount();
        if (direction === 'ArrowUp') {
          if (index >= columns) return focusAndReveal(cards[index - columns]);
          // Only the first channel row may navigate upward to the genre row.
          const genres = Array.from(elements.groups.querySelectorAll('.group-chip'));
          return focusAndReveal(nearestHorizontalElement(genres, current)) || true;
        }
        // At the bottom of the grid, keep focus in the grid rather than
        // jumping to unrelated controls. Repeated Down presses remain harmless.
        const below = cards[index + columns];
        return below ? focusAndReveal(below) : true;
      }
    }

    // Down from a genre chip enters the first row of channels, choosing the
    // tile closest to the chip's horizontal position.
    if (direction === 'ArrowDown' && current && current.classList && current.classList.contains('group-chip')) {
      const cards = Array.from(elements.list.querySelectorAll('.channel-card'));
      const firstRow = cards.slice(0, gridColumnCount());
      if (firstRow.length) return focusAndReveal(nearestHorizontalElement(firstRow, current));
    }

    const scope = elements.dialog.open ? elements.dialog : (document.body.classList.contains('playing') ? elements.playerView : document);
    const candidates = focusableElements(scope);
    if (!candidates.includes(current)) {
      const first = direction === 'ArrowUp' || direction === 'ArrowLeft' ? candidates[candidates.length - 1] : candidates[0];
      if (first) { focusAndReveal(first); return true; }
      return false;
    }
    const currentRect = current.getBoundingClientRect();
    const currentX = currentRect.left + currentRect.width / 2;
    const currentY = currentRect.top + currentRect.height / 2;
    const sign = direction === 'ArrowUp' || direction === 'ArrowLeft' ? -1 : 1;
    const options = candidates.filter((element) => element !== current).map((element) => {
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2; const y = rect.top + rect.height / 2;
      const main = vertical ? (y - currentY) * sign : (x - currentX) * sign;
      const cross = vertical ? Math.abs(x - currentX) : Math.abs(y - currentY);
      const tolerance = vertical ? 0 : Math.max(24, Math.min(80, Math.min(currentRect.height, rect.height) * 0.55));
      return { element, main, cross, tolerance };
    }).filter((candidate) => candidate.main > 1 && (vertical || candidate.cross <= candidate.tolerance));
    options.sort((a, b) => a.main - b.main || a.cross - b.cross);
    const next = options[0] && options[0].element;
    if (!next) return false;
    return focusAndReveal(next);
  }
  function focusInitialHomeItem() {
    const preferred = Array.from(elements.languages.querySelectorAll('button')).find((button) => button.dataset.language === state.language);
    const firstChannel = elements.list.querySelector('.channel-card');
    const target = preferred || firstChannel || (state.channels.length ? $('settings-open') : $('settings-cta'));
    if (target) target.focus();
  }
  function activateSearch() {
    if (!elements.search.readOnly) return;
    elements.search.blur();
    elements.search.readOnly = false;
    elements.search.setAttribute('aria-readonly', 'false');
    elements.search.focus();
  }

  $('settings-open').addEventListener('click', openSettings);
  $('settings-form').addEventListener('submit', (event) => event.preventDefault());
  $('settings-close').addEventListener('click', () => elements.dialog.close());
  $('settings-done').addEventListener('click', () => elements.dialog.close());
  $('settings-cta').addEventListener('click', () => { if (state.channels.length) openSettings(); else loadChannels(); });
  document.querySelectorAll('.rail-item').forEach((button) => button.addEventListener('click', () => { state.group = button.dataset.group; syncRail(); render(); button.focus(); }));
  elements.search.addEventListener('input', render);
  elements.search.addEventListener('click', activateSearch);
  elements.search.addEventListener('blur', () => {
    elements.search.readOnly = true;
    elements.search.setAttribute('aria-readonly', 'true');
  });
  $('send-otp').addEventListener('click', sendOtp);
  $('verify-otp').addEventListener('click', verifyOtp);
  $('sign-out').addEventListener('click', () => {
    stopProxy(); saveAuth(null); state.otpSent = false; elements.otpRow.hidden = true;
    elements.settingsMessage.textContent = 'Signed out on this TV.'; setConnection('Sign in to watch', false);
    if (state.active) stopPlayback();
  });
  $('back-library').addEventListener('click', stopPlayback);
  $('play-toggle').addEventListener('click', () => elements.player.paused ? elements.player.play().catch(() => {}) : elements.player.pause());
  elements.player.addEventListener('playing', () => {
    elements.playerError.hidden = true; $('play-toggle').textContent = 'Ⅱ'; $('play-toggle').setAttribute('aria-label', 'Pause playback');
    state.lastPlaybackTime = elements.player.currentTime || 0; state.lastProgressAt = Date.now();
    state.qualityStableSince = state.qualityIndex > 0 ? Date.now() : 0;
    startQualityRecovery(); clearStallMonitor(); revealPlayerControls(true);
  });
  elements.player.addEventListener('pause', () => { state.qualityStableSince = 0; $('play-toggle').textContent = '▶'; $('play-toggle').setAttribute('aria-label', 'Resume playback'); revealPlayerControls(false); });
  elements.player.addEventListener('ended', () => { clearPlayerControlsTimer(); revealPlayerControls(false); });
  elements.player.addEventListener('timeupdate', () => {
    const currentTime = elements.player.currentTime || 0;
    if (currentTime > state.lastPlaybackTime + 0.1) {
      state.lastPlaybackTime = currentTime; state.lastProgressAt = Date.now(); clearStallMonitor();
    }
  });
  function notePlaybackStall() { state.qualityStableSince = 0; revealPlayerControls(false); scheduleStallFallback(); }
  elements.player.addEventListener('waiting', notePlaybackStall);
  elements.player.addEventListener('stalled', notePlaybackStall);
  elements.player.addEventListener('error', handlePlaybackError);
  document.addEventListener('keydown', (event) => {
    const editable = event.target && event.target.matches('input, textarea, [contenteditable="true"]');
    const direction = ({ 37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown' })[event.keyCode] || event.key;
    if (event.target === elements.search && elements.search.readOnly && (event.key === 'Enter' || event.keyCode === 13)) {
      event.preventDefault(); activateSearch(); return;
    }
    if (elements.dialog.open) {
      if (event.key === 'Escape' || event.keyCode === 461) { event.preventDefault(); elements.dialog.close(); }
      else if (/^Arrow(Up|Down)$/.test(direction) && moveFocus(direction)) event.preventDefault();
      return;
    }
    if (state.active && isYellowButton(event)) {
      event.preventDefault();
      toggleProgramGuide();
      return;
    }
    if (state.programGuideVisible && /^Arrow(Up|Down|Left|Right)$/.test(direction)) {
      event.preventDefault();
      return;
    }
    if (!editable) {
      const keyCode = event.keyCode || event.which;
      const digit = /^[0-9]$/.test(event.key || '') ? event.key
        : (keyCode >= 48 && keyCode <= 57) ? String(keyCode - 48)
          : (keyCode >= 96 && keyCode <= 105) ? String(keyCode - 96) : '';
      if (digit) { event.preventDefault(); appendTuneDigit(digit); return; }
      if ((event.key === 'Enter' || event.keyCode === 13) && tuneToEnteredChannel()) { event.preventDefault(); return; }
    }
    const searchBoundary = editable && event.target === elements.search &&
      (!elements.search.value || (direction === 'ArrowRight' && elements.search.selectionEnd === elements.search.value.length) ||
      (direction === 'ArrowLeft' && elements.search.selectionStart === 0));
    if (/^Arrow(Up|Down)$/.test(direction) || (!editable && /^Arrow(Left|Right)$/.test(direction)) || searchBoundary) {
      if (moveFocus(direction)) event.preventDefault();
      return;
    }
    const backPressed = event.keyCode === 461 || event.key === 'Escape' || (event.key === 'Backspace' && !editable);
    if (backPressed) {
      if (state.programGuideVisible) { closeProgramGuide(); event.preventDefault(); return; }
      if (state.tuneBuffer) { clearTuneBuffer(); event.preventDefault(); return; }
      if (state.active) { event.preventDefault(); stopPlayback(); } else event.preventDefault();
      return;
    }
    if ((event.key === 'Enter' || event.key === ' ' || event.keyCode === 13) && document.activeElement === elements.player && state.active) {
      event.preventDefault(); elements.player.paused ? elements.player.play().catch(() => {}) : elements.player.pause();
    }
    if ((event.keyCode === 427 || event.key === 'ChannelUp') && state.active) { event.preventDefault(); cycleChannel(1); }
    if ((event.keyCode === 428 || event.key === 'ChannelDown') && state.active) { event.preventDefault(); cycleChannel(-1); }
  });
  function cycleChannel(delta) {
    const channels = filteredChannels();
    const index = channels.findIndex((channel) => state.active && channel.id === state.active.id);
    if (channels.length) play(channels[(index + delta + channels.length) % channels.length]);
  }

  document.addEventListener('keydown', () => { state.userInteracted = true; if (state.active && !state.programGuideVisible) revealPlayerControls(true); }, true);
  document.addEventListener('pointerdown', () => { state.userInteracted = true; if (state.active) revealPlayerControls(true); }, true);
  document.addEventListener('mousedown', () => { state.userInteracted = true; }, true);
  render(); updateAccountUI();
  if (!state.userInteracted) focusInitialHomeItem();
  loadChannels().then(() => {
    if (!elements.dialog.open && !state.active && !state.userInteracted) focusInitialHomeItem();
  });
  window.addEventListener('beforeunload', () => { closeProgramGuide(); clearPlayerControlsTimer(); clearQualityRecovery(); destroyDashPlayer(); stopProxy(); });
  window.JTVWebOS = { getChannels: () => [...state.channels], reloadChannels: loadChannels, tuneToChannelId: (id) => {
    const channel = state.channels.find((item) => item.id === String(id));
    if (!channel) return false;
    play(channel);
    return true;
  } };
})();
