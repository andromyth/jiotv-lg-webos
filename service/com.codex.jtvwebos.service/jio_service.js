/* webOS TV local service: all Jio API calls and stream proxying stay on the TV. */
var Service = require("webos-service");
var https = require("https");
var http = require("http");
var dns = require("dns");
var crypto = require("crypto");
var zlib = require("zlib");
var URL = require("url").URL;
var hlsUtils = require("./hls_utils");
var sanitizeWebOsHlsManifest = hlsUtils.sanitizeWebOsHlsManifest;
var rewriteDashManifest = hlsUtils.rewriteDashManifest;
var service = new Service(require("./package.json").name);

var JIO_HOST = "jiotvapi.media.jio.com";
var USER_AGENT = "okhttp/4.12.0";
var APP_NAME = "RJIL_JioTV";
var OS = "android";
var DEVICE_TYPE = "phone";
var LANGUAGES = {
  "1": "Hindi", "2": "Marathi", "3": "Punjabi", "4": "Urdu", "5": "Bengali",
  "6": "English", "7": "Malayalam", "8": "Tamil", "9": "Gujarati", "10": "Odia",
  "11": "Telugu", "12": "Bhojpuri", "13": "Kannada", "14": "Assamese",
  "15": "Nepali", "16": "French"
};

var authData = null;
var refreshPromise = null;
var proxyServer = null;
var proxyPort = 0;
var proxyToken = "";
var proxySubscriptions = {};
var streamCache = {};
var streamRefreshes = {};
var streamModes = {};

function lookupIpv4(hostname, options, callback) {
  if (typeof options === "function") callback = options;
  dns.lookup(hostname, { family: 4 }, callback);
}

function uuid() {
  var b = crypto.randomBytes(16);
  b[6] = (b[6] & 15) | 64;
  b[8] = (b[8] & 63) | 128;
  var h = b.toString("hex");
  return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
}

function isJioHost(hostname) {
  var host = String(hostname || "").toLowerCase();
  return host === "jio.com" || host.slice(-8) === ".jio.com" || host.slice(-10) === ".jiocdn.com";
}

function decodeBody(response, body) {
  var encoding = String(response.headers["content-encoding"] || "").toLowerCase();
  if (encoding === "gzip") return zlib.gunzipSync(body).toString("utf8");
  if (encoding === "deflate") return zlib.inflateSync(body).toString("utf8");
  return body.toString("utf8");
}

function requestText(rawUrl, method, headers, body) {
  return new Promise(function(resolve, reject) {
    var target;
    try { target = new URL(rawUrl); } catch (e) { reject(new Error("Invalid Jio URL")); return; }
    if ((target.protocol !== "https:" && target.protocol !== "http:") || !isJioHost(target.hostname)) {
      reject(new Error("Refusing non-Jio network request"));
      return;
    }
    var requestHeaders = Object.assign({ "Accept-Encoding": "identity" }, headers || {});
    var payload = body == null ? null : Buffer.from(String(body), "utf8");
    if (payload) requestHeaders["Content-Length"] = String(payload.length);
    var transport = target.protocol === "https:" ? https : http;
    var req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: method || "GET",
      headers: requestHeaders,
      lookup: lookupIpv4,
      timeout: 15000
    }, function(res) {
      var chunks = [];
      res.on("data", function(chunk) { chunks.push(chunk); });
      res.on("end", function() {
        var bytes = Buffer.concat(chunks);
        try { resolve({ status: res.statusCode || 0, text: decodeBody(res, bytes), headers: res.headers }); }
        catch (e) { reject(e); }
      });
    });
    req.on("timeout", function() { req.destroy(new Error("Jio request timed out")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestJson(url, method, headers, body) {
  return requestText(url, method, headers, body).then(function(response) {
    var json = {};
    if (response.text) {
      try { json = JSON.parse(response.text); }
      catch (_) { throw new Error("Jio returned an unreadable response (HTTP " + response.status + ")"); }
    }
    return { status: response.status, json: json, text: response.text, headers: response.headers };
  });
}

function getJioErrorDetail(response) {
  var json = response && response.json || {};
  var candidates = [json.message, json.error_description, json.description];
  if (typeof json.error === "string") candidates.push(json.error);
  else if (json.error && typeof json.error.message === "string") candidates.push(json.error.message);
  if (json.code != null) candidates.push(String(json.code));
  var detail = "";
  for (var i = 0; i < candidates.length; i++) {
    if (typeof candidates[i] === "string" && candidates[i].trim()) { detail = candidates[i].trim(); break; }
  }
  if (!detail && response && response.text && !/^\s*</.test(response.text)) detail = response.text.trim();
  detail = String(detail || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ");
  detail = detail.replace(/\b(?:Bearer\s+)?[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted token]");
  detail = detail.replace(/\+?91\s?\d{10}\b/g, "[redacted number]");
  if (detail.length > 220) detail = detail.slice(0, 217) + "...";
  return detail;
}

function getJioRequestId(response) {
  var headers = response && response.headers || {};
  var names = ["x-request-id", "x-correlation-id", "x-amzn-requestid", "x-trace-id"];
  for (var i = 0; i < names.length; i++) {
    var value = headers[names[i]];
    if (typeof value === "string" && /^[A-Za-z0-9._:-]{1,100}$/.test(value)) return value;
  }
  return "";
}

function requestTextFollow(rawUrl, headers, hops) {
  var count = hops == null ? 3 : hops;
  return requestText(rawUrl, "GET", headers).then(function(response) {
    var location = response.headers && response.headers.location;
    if (response.status < 300 || response.status >= 400 || !location || count <= 0) {
      response.url = rawUrl;
      return response;
    }
    var next;
    try { next = new URL(location, rawUrl); }
    catch (_) { throw new Error("Jio returned an invalid stream redirect."); }
    if (!isJioHost(next.hostname)) throw new Error("Jio redirected the stream to an unsupported host.");
    return requestTextFollow(next.toString(), headers, count - 1);
  });
}

function normalizeMobile(value) {
  var digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 12 && digits.slice(0, 2) === "91") digits = digits.slice(2);
  if (!/^\d{10}$/.test(digits)) throw new Error("Enter a valid 10-digit Indian mobile number.");
  return digits;
}

function authHeaders() {
  return {
    "User-Agent": USER_AGENT,
    os: OS,
    devicetype: DEVICE_TYPE,
    appname: APP_NAME,
    "Content-Type": "application/json"
  };
}

function sendOtp(mobile) {
  var number = Buffer.from("+91" + normalizeMobile(mobile), "utf8").toString("base64");
  return requestText("https://" + JIO_HOST + "/userservice/apis/v1/loginotp/send", "POST", authHeaders(), JSON.stringify({ number: number }))
    .then(function(response) {
      if (response.status < 200 || response.status >= 300) throw new Error("Jio could not send the OTP (HTTP " + response.status + ").");
      return { ok: true };
    });
}

function verifyOtp(mobile, otp) {
  var number = Buffer.from("+91" + normalizeMobile(mobile), "utf8").toString("base64");
  var deviceId = uuid();
  var body = {
    number: number,
    otp: String(otp || "").trim(),
    deviceInfo: {
      consumptionDeviceName: "unknown sdk_google_atv_x86",
      info: { type: "android", platform: { name: "generic_x86" }, androidId: deviceId }
    }
  };
  if (!body.otp) return Promise.reject(new Error("Enter the OTP from Jio."));
  return requestJson("https://" + JIO_HOST + "/userservice/apis/v1/loginotp/verify", "POST", authHeaders(), JSON.stringify(body))
    .then(function(response) {
      if (response.status < 200 || response.status >= 300) throw new Error("Jio OTP verification failed (HTTP " + response.status + ").");
      var json = response.json;
      var user = json.sessionAttributes && json.sessionAttributes.user || {};
      if (!json.ssoToken || !json.authToken) throw new Error(json.message || "Jio did not return a usable sign-in session.");
      return {
        mobile: normalizeMobile(mobile),
        ssoToken: json.ssoToken || "",
        authToken: json.authToken || "",
        refreshToken: json.refreshToken || "",
        crmid: user.subscriberId || "",
        uniqueId: user.unique || "",
        deviceId: json.deviceId || deviceId,
        userId: user.uid || ""
      };
    });
}

function getChannels() {
  var categoryMap = {};
  var channels = {};
  var headers = { "User-Agent": USER_AGENT, "Accept-Encoding": "identity" };
  return requestJson("https://jiotvapi.cdn.jio.com/apis/v1.3/dictionary/dictionary?langId=6", "GET", headers)
    .then(function(response) {
      if (response.status >= 200 && response.status < 300) categoryMap = response.json.channelCategoryMapping || {};
    }).catch(function() {})
    .then(function() {
      var urls = [
        "https://jiotvapi.cdn.jio.com/apis/v1.4/getMobileChannelList/get/?langId=6&devicetype=phone&os=android&usertype=JIO&version=422",
        "https://jiotvapi.cdn.jio.com/apis/v3.1/getMobileChannelList/get/?langId=6&os=android&devicetype=phone&usertype=JIO&version=422"
      ];
      return urls.reduce(function(chain, url) {
        return chain.then(function() {
          return requestJson(url, "GET", headers).then(function(response) {
            if (response.status < 200 || response.status >= 300) return;
            var result = response.json.result || [];
            result.forEach(function(channel) {
              var id = String(channel.channel_id || "");
              if (!/^\d{1,7}$/.test(id) || channels[id]) return;
              var logo = channel.logoUrl || "";
              channels[id] = {
                id: id,
                name: channel.channel_name || "Unknown",
                logoUrl: logo ? "https://jiotvimages.cdn.jio.com/dare_images/images/" + logo : "",
                group: categoryMap[String(channel.channelCategoryId)] || "Other",
                language: LANGUAGES[String(channel.channelLanguageId)] || "Other",
                isDrm: channel.isDrm === true || String(channel.isDrm) === "true" || channel.streamType === "mpd",
                channelNumber: Number(id)
              };
            });
          }).catch(function() {});
        });
      }, Promise.resolve());
    }).then(function() {
      var result = Object.keys(channels).map(function(id) { return channels[id]; });
      result.sort(function(a, b) { return a.channelNumber - b.channelNumber; });
      if (!result.length) throw new Error("Jio returned no channels. Check the TV's internet connection and try again.");
      return result;
    });
}

function tokenExpiry(token) {
  var text = String(token || "");
  var hdneaExpiry = /(?:^|[~&])exp=(\d+)/.exec(text);
  if (hdneaExpiry) return Number(hdneaExpiry[1]) || 0;
  try {
    var part = text.split(".")[1];
    if (!part) return 0;
    var payload = JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return Number(payload.exp) || 0;
  } catch (_) { return 0; }
}

function performRefreshAuth() {
  if (!authData || !authData.refreshToken) {
    var missingRefresh = new Error("Your Jio sign-in needs to be renewed.");
    missingRefresh.status = 401;
    return Promise.reject(missingRefresh);
  }
  var headers = {
    ssotoken: authData.ssoToken,
    accesstoken: authData.authToken,
    appName: APP_NAME,
    os: OS,
    devicetype: DEVICE_TYPE,
    deviceId: authData.deviceId,
    uniqueId: authData.uniqueId,
    versionCode: "422",
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json"
  };
  var body = JSON.stringify({ appName: APP_NAME, deviceId: authData.deviceId, refreshToken: authData.refreshToken, uniqueId: authData.uniqueId });
  return requestJson("https://auth.media.jio.com/tokenservice/apis/v1/refreshtoken?langId=6", "POST", headers, body)
    .then(function(response) {
      if (response.status < 200 || response.status >= 300) {
        var refreshError = new Error("Jio rejected the saved sign-in (HTTP " + response.status + ").");
        refreshError.status = response.status;
        throw refreshError;
      }
      var json = response.json;
      if (!json.authToken && !json.ssoToken) throw new Error("Jio did not return renewed sign-in tokens.");
      authData = Object.assign({}, authData, {
        authToken: json.authToken || authData.authToken,
        ssoToken: json.ssoToken || authData.ssoToken,
        refreshToken: json.refreshToken || authData.refreshToken
      });
      notifyAuth();
      return authData;
    });
}

function recoverSession() {
  if (!authData || !authData.ssoToken || !authData.mobile) return Promise.reject(new Error("Your Jio sign-in expired. Sign in again in Settings."));
  var ssoToken = authData.ssoToken;
  var refreshUrl = "https://tv.media.jio.com/apis/v2.0/loginotp/refresh?langId=6";
  return requestJson(refreshUrl, "GET", {
    devicetype: DEVICE_TYPE,
    versionCode: "422",
    os: OS,
    "User-Agent": USER_AGENT,
    ssoToken: authData.ssoToken,
    uniqueid: authData.uniqueId,
    deviceid: authData.deviceId
  }).then(function(response) {
    if (response.status >= 200 && response.status < 300 && response.json.ssoToken) ssoToken = response.json.ssoToken;
    var body = { number: Buffer.from("+91" + normalizeMobile(authData.mobile), "utf8").toString("base64") };
    var headers = {
      ssotoken: ssoToken,
      appname: APP_NAME,
      deviceid: authData.deviceId,
      devicetype: DEVICE_TYPE,
      os: OS,
      subscriberid: authData.crmid,
      persistentRefreshToken: "true",
      versionCode: "422",
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json"
    };
    return requestJson("https://" + JIO_HOST + "/userservice/apis/v1/loginotp/exchangetoken", "POST", headers, JSON.stringify(body)).then(function(exchange) {
      if (exchange.status < 200 || exchange.status >= 300 || !exchange.json.authToken) throw new Error("Jio could not restore the saved sign-in. Sign in again in Settings.");
      authData = Object.assign({}, authData, {
        ssoToken: ssoToken,
        authToken: exchange.json.authToken,
        refreshToken: exchange.json.refreshToken || authData.refreshToken,
        userId: exchange.json.userId || authData.userId,
        crmid: exchange.json.subscriberId || authData.crmid
      });
      notifyAuth();
      return authData;
    });
  });
}

function refreshAuth() {
  if (refreshPromise) return refreshPromise;
  refreshPromise = performRefreshAuth().catch(function(error) {
    if (error && error.status >= 400 && error.status < 500) return recoverSession();
    throw error;
  }).finally(function() { refreshPromise = null; });
  return refreshPromise;
}

function ensureFreshAuth() {
  var exp = tokenExpiry(authData && authData.authToken);
  if (exp && exp - Math.floor(Date.now() / 1000) < 7200 && authData.refreshToken) return refreshAuth();
  return Promise.resolve(authData);
}

function hdneaFromUrl(url) {
  var marker = "__hdnea__=";
  var start = String(url || "").indexOf(marker);
  if (start < 0) return "";
  start += marker.length;
  var end = String(url).indexOf("&", start);
  return String(url).slice(start, end < 0 ? String(url).length : end);
}

function urlWithHdnea(url, token) {
  if (!token) return url;
  var marker = "__hdnea__=";
  var start = String(url).indexOf(marker);
  if (start >= 0) {
    start += marker.length;
    var end = String(url).indexOf("&", start);
    return String(url).slice(0, start) + token + (end < 0 ? "" : String(url).slice(end));
  }
  try {
    var target = new URL(url);
    target.searchParams.set("__hdnea__", token);
    return target.toString();
  } catch (_) { return url; }
}

function streamHeaders(channelId, token) {
  var headers = {
    "User-Agent": "plaYtv/7.1.8 (Linux;Android 8.1.0) ExoPlayerLib/2.11.7",
    ssoToken: authData.ssoToken,
    userId: authData.userId,
    uniqueId: authData.uniqueId,
    crmid: authData.crmid,
    deviceid: authData.deviceId,
    devicetype: DEVICE_TYPE,
    os: "B2G",
    osversion: "2.5",
    versioncode: "353"
  };
  if (token) headers.Cookie = "__hdnea__=" + token;
  return headers;
}

function licenseHeaders(channelId, token) {
  var headers = {
    "User-Agent": "PlayTV/1.0",
    appName: APP_NAME,
    "x-platform": OS,
    os: OS,
    devicetype: DEVICE_TYPE,
    osVersion: "13",
    srno: uuid(),
    channelid: String(channelId),
    usergroup: "tvYR7NSNn7rymo3F",
    versionCode: "422",
    Accept: "*/*",
    ssoToken: authData.ssoToken,
    Accesstoken: authData.authToken,
    userId: authData.userId,
    uniqueId: authData.uniqueId,
    crmid: authData.crmid,
    deviceid: authData.deviceId
  };
  if (token) headers.Cookie = "__hdnea__=" + token;
  return headers;
}

function getStreamData(channelId, retry) {
  if (!authData || !authData.authToken) return Promise.reject(new Error("Sign in with Jio in Settings before playing a channel."));
  return ensureFreshAuth().then(function() {
    var body = "stream_type=Live&channel_id=" + encodeURIComponent(String(channelId));
    var headers = {
      Appkey: "NzNiMDhlYzQyNjJm",
      Devicetype: DEVICE_TYPE,
      Os: OS,
      Deviceid: authData.deviceId,
      Osversion: "13",
      Dm: "Google Pixel 5",
      Uniqueid: authData.deviceId,
      Usergroup: "tvYR7NSNn7rymo3F",
      Languageid: "6",
      Userid: authData.userId,
      Sid: "892898ba-f9de-4572-b6c2-e717b0ad",
      Crmid: authData.crmid,
      Isott: "false",
      Channel_id: String(channelId),
      Langid: "6",
      ssoToken: authData.ssoToken,
      Accesstoken: authData.authToken,
      Subscriberid: authData.crmid,
      analyticsId: authData.deviceId,
      Lbcookie: "1",
      Versioncode: "422",
      "User-Agent": USER_AGENT,
      "Content-Type": "application/x-www-form-urlencoded"
    };
    return requestJson("https://" + JIO_HOST + "/playback/apis/v1.1/geturl", "POST", headers, body)
      .then(function(response) {
        if ((response.status === 401 || response.status === 419) && retry !== false) {
          return refreshAuth().then(function() { return getStreamData(channelId, false); });
        }
        if (response.status === 403) {
          var detail = getJioErrorDetail(response);
          var requestId = getJioRequestId(response);
          throw new Error("Jio refused the channel request (HTTP 403) before returning media." +
            (detail ? " Jio's response: " + detail + "." : "") +
            (requestId ? " Jio request ID: " + requestId + "." : ""));
        }
        if (response.status < 200 || response.status >= 300) throw new Error("Jio could not open this channel (HTTP " + response.status + ").");
        var hlsUrl = String(response.json.result || "").trim();
        var mpd = response.json.mpd || {};
        var mpdUrl = String(mpd.result || "").trim();
        var licenseUrl = String(mpd.key || "").trim();
        var hlsIsUsable = !!hlsUrl && !/paywall/i.test(hlsUrl);
        if (!hlsIsUsable && !mpdUrl) throw new Error("Jio did not return a playable stream for this channel.");
        var hdnea = hlsIsUsable ? hdneaFromUrl(hlsUrl) : "";
        var mpdHdnea = mpdUrl ? hdneaFromUrl(mpdUrl) : "";
        var expiry = tokenExpiry(hdnea) || tokenExpiry(mpdHdnea);
        return {
          streamUrl: hlsIsUsable ? hlsUrl : "",
          hdnea: hdnea,
          mpdUrl: mpdUrl,
          mpdHdnea: mpdHdnea,
          licenseUrl: licenseUrl,
          expiresAt: expiry ? expiry * 1000 : Date.now() + 75000
        };
      });
  });
}

function ensureStream(channelId) {
  var key = String(channelId);
  var cached = streamCache[key];
  if (cached && Date.now() < cached.expiresAt - 12000) return Promise.resolve(cached);
  return getStreamData(key, true).then(function(data) {
    streamCache[key] = data;
    return data;
  });
}

function refreshStreamData(channelId) {
  var key = String(channelId);
  if (streamRefreshes[key]) return streamRefreshes[key];
  streamRefreshes[key] = getStreamData(key, true).then(function(data) {
    streamCache[key] = data;
    delete streamRefreshes[key];
    return data;
  }, function(error) {
    delete streamRefreshes[key];
    throw error;
  });
  return streamRefreshes[key];
}

function extractVariants(manifest, baseUrl) {
  var lines = String(manifest || "").split(/\r?\n/);
  var variants = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (line.indexOf("#EXT-X-STREAM-INF:") !== 0) continue;
    var uriLine = "";
    for (var j = i + 1; j < lines.length; j++) {
      var candidate = lines[j].trim();
      if (candidate && candidate.charAt(0) !== "#") { uriLine = candidate; i = j; break; }
    }
    if (!uriLine) continue;
    var resolution = /RESOLUTION=\d+x(\d+)/i.exec(line);
    var average = /AVERAGE-BANDWIDTH=(\d+)/i.exec(line);
    var bandwidth = /(?:^|[:,])BANDWIDTH=(\d+)/i.exec(line);
    var height = resolution ? Number(resolution[1]) : 0;
    var rate = Number(average ? average[1] : (bandwidth ? bandwidth[1] : 0));
    try { variants.push({ height: height, bandwidth: rate, url: new URL(uriLine, baseUrl).toString(), sourceLine: line, sourceIndex: i }); }
    catch (_) {}
  }
  variants.sort(function(a, b) { return b.height - a.height || b.bandwidth - a.bandwidth; });
  return variants;
}

function localFetchUrl(channelId, upstream) {
  return "http://127.0.0.1:" + proxyPort + "/v/" + proxyToken + "/fetch?ch=" + encodeURIComponent(String(channelId)) + "&u=" + encodeURIComponent(upstream);
}

function rewriteManifest(manifest, baseUrl, channelId) {
  var lines = String(manifest || "").split(/\r?\n/);
  return lines.map(function(line) {
    if (!line) return line;
    if (line.charAt(0) === "#") {
      return line.replace(/URI="([^"]+)"/g, function(match, uri) {
        try { return "URI=\"" + localFetchUrl(channelId, new URL(uri, baseUrl).toString()) + "\""; }
        catch (_) { return match; }
      });
    }
    try { return localFetchUrl(channelId, new URL(line.trim(), baseUrl).toString()); }
    catch (_) { return line; }
  }).join("\n");
}

function selectMasterVariant(manifest, baseUrl, channelId, level) {
  var lines = String(manifest || "").split(/\r?\n/);
  var variants = extractVariants(manifest, baseUrl);
  if (!variants.length) return rewriteManifest(manifest, baseUrl, channelId);
  var selected = variants[Math.max(0, Math.min(Number(level) || 0, variants.length - 1))];
  var selectedUrl = selected.url;
  var output = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.trim().indexOf("#EXT-X-STREAM-INF:") === 0) {
      var uriIndex = i + 1;
      while (uriIndex < lines.length && (!lines[uriIndex].trim() || lines[uriIndex].trim().charAt(0) === "#")) uriIndex++;
      if (uriIndex < lines.length) {
        var rawUri = lines[uriIndex].trim();
        var resolved = "";
        try { resolved = new URL(rawUri, baseUrl).toString(); } catch (_) {}
        if (resolved === selectedUrl) {
          output.push(rewriteManifest(line, baseUrl, channelId));
          output.push(localFetchUrl(channelId, resolved));
        }
        i = uriIndex;
      } else output.push(line);
    } else {
      output.push(rewriteManifest(line, baseUrl, channelId));
    }
  }
  return output.join("\n");
}

function getQualityLevels(channelId) {
  return ensureStream(channelId).then(function(data) {
    if (!data.streamUrl) return [];
    return requestText(urlWithHdnea(data.streamUrl, data.hdnea), "GET", streamHeaders(channelId, data.hdnea));
  }).then(function(response) {
    if (response.status < 200 || response.status >= 300) return [];
    return extractVariants(response.text, streamCache[String(channelId)].streamUrl).map(function(item) {
      return { height: item.height, bandwidth: item.bandwidth };
    });
  });
}

function resolvePlayback(channelId, options) {
  var key = String(channelId);
  if (!/^\d{1,7}$/.test(key)) return Promise.reject(new Error("Invalid channel id"));
  return ensureStream(key).then(function(initialData) {
    function resolveWithData(data) {
      function hlsPlayback(dashFailure) {
        if (!data.streamUrl) return Promise.reject(new Error("Jio did not provide an HLS stream for this channel." + (dashFailure ? " " + dashFailure : "")));
        var hlsUrl = urlWithHdnea(data.streamUrl, data.hdnea);
        return requestTextFollow(hlsUrl, streamHeaders(key, data.hdnea), 3).then(function(response) {
          var body = String(response.text || "").trim();
          if (response.status >= 200 && response.status < 300 && body.indexOf("#EXTM3U") === 0) {
            streamModes[key] = "hls";
            return {
              mode: "hls",
              levels: extractVariants(response.text, response.url || data.streamUrl).map(function(item) {
                return { height: item.height, bandwidth: item.bandwidth };
              }),
              auth: authData
            };
          }
          throw new Error("Jio's same-channel HLS manifest returned HTTP " + response.status + " and was not a usable HLS playlist." + (dashFailure ? " " + dashFailure : ""));
        }, function(error) {
          throw new Error("Jio's same-channel HLS manifest request failed: " + (error.message || "network error") + "." + (dashFailure ? " " + dashFailure : ""));
        });
      }
      function dashPlayback() {
        if (!data.mpdUrl) return Promise.resolve({ fallback: true, failure: "Jio did not return a DASH manifest." });
        var mpdToken = data.mpdHdnea || data.hdnea;
        var mpdUrl = urlWithHdnea(data.mpdUrl, mpdToken);
        var mpdHost;
        try { mpdHost = new URL(mpdUrl).hostname; }
        catch (_) { return Promise.resolve({ fallback: true, failure: "Jio returned an invalid DASH URL." }); }
        if (!isJioHost(mpdHost)) return Promise.resolve({ fallback: true, failure: "Jio returned an unsupported DASH host." });
        return requestTextFollow(mpdUrl, streamHeaders(key, mpdToken), 3).then(function(response) {
          var body = String(response.text || "").trim();
          if (response.status >= 200 && response.status < 300 && /<MPD\b/i.test(body)) {
            streamModes[key] = "dash";
            return { mode: "dash", hasDrm: !!data.licenseUrl, auth: authData };
          }
          return { fallback: true, failure: "The DASH manifest returned HTTP " + response.status + " or was not a valid MPD." };
        }, function(error) {
          return { fallback: true, failure: "The DASH manifest request failed: " + (error.message || "network error") + "." };
        });
      }
      if (options && options.forceHls) return hlsPlayback(null);
      return dashPlayback().then(function(result) {
        return result.fallback ? hlsPlayback(result.failure) : result;
      });
    }

    function isExpiredOrMissingManifest(error) {
      return /\bHTTP (?:403|404|410)\b/i.test(error && error.message || "");
    }

    return resolveWithData(initialData).catch(function(firstError) {
      if (!isExpiredOrMissingManifest(firstError)) throw firstError;
      return refreshStreamData(key).then(function(freshData) {
        return resolveWithData(freshData).catch(function(retryError) {
          throw new Error("Jio's refreshed stream URL also failed. " + (retryError.message || "The new URL did not return a usable manifest."));
        });
      }, function(refreshError) {
        throw new Error("The stream manifest returned HTTP 403/404/410, and Jio could not provide a fresh URL: " + (refreshError.message || "request failed"));
      });
    });
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");
}

function sendText(res, status, text, contentType) {
  setCors(res);
  res.statusCode = status;
  res.setHeader("Content-Type", contentType || "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}

function isKeyUrl(rawUrl) {
  return /\.pkey(?:\?|$)/i.test(rawUrl) || /aes128\.key/i.test(rawUrl) || /(^|\/)tv\.media\.jio\.com\//i.test(rawUrl);
}

function proxyUpstream(req, res, channelId, rawUrl, hops) {
  var target;
  try { target = new URL(rawUrl); } catch (_) { sendText(res, 400, "Invalid upstream URL"); return; }
  if ((target.protocol !== "https:" && target.protocol !== "http:") || !isJioHost(target.hostname)) {
    sendText(res, 403, "Upstream host is not allowed");
    return;
  }
  ensureStream(channelId).then(function(data) {
    var streamToken = streamModes[String(channelId)] === "dash" ? (data.mpdHdnea || data.hdnea) : data.hdnea;
    var signedUrl = urlWithHdnea(target.toString(), streamToken);
    var signedTarget = new URL(signedUrl);
    var headers = isKeyUrl(signedTarget.pathname) ? licenseHeaders(channelId, streamToken) : streamHeaders(channelId, streamToken);
    headers["Accept-Encoding"] = "identity";
    if (req.headers.range) headers.Range = req.headers.range;
    var transport = signedTarget.protocol === "https:" ? https : http;
    var upstream = transport.request({
      protocol: signedTarget.protocol,
      hostname: signedTarget.hostname,
      port: signedTarget.port || (signedTarget.protocol === "https:" ? 443 : 80),
      path: signedTarget.pathname + signedTarget.search,
      method: req.method === "HEAD" ? "HEAD" : "GET",
      headers: headers,
      lookup: lookupIpv4,
      timeout: 20000
    }, function(upstreamRes) {
      var location = upstreamRes.headers.location;
      if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && location && (hops || 0) < 3) {
        upstreamRes.resume();
        var redirected;
        try { redirected = new URL(location, signedTarget).toString(); }
        catch (_) { sendText(res, 502, "Invalid Jio redirect"); return; }
        proxyUpstream(req, res, channelId, redirected, (hops || 0) + 1);
        return;
      }
      var type = String(upstreamRes.headers["content-type"] || "");
      var looksManifest = /mpegurl/i.test(type) || /\.m3u8?(?:$|\?)/i.test(signedTarget.pathname);
      var looksDash = /dash\+xml/i.test(type) || /\.mpd(?:$|\?)/i.test(signedTarget.pathname);
      setCors(res);
      res.statusCode = upstreamRes.statusCode || 502;
      ["content-type", "content-length", "content-range", "accept-ranges", "cache-control", "last-modified"].forEach(function(name) {
        if (upstreamRes.headers[name]) res.setHeader(name, upstreamRes.headers[name]);
      });
      if ((looksManifest || looksDash) && res.statusCode >= 200 && res.statusCode < 300) {
        var chunks = [];
        upstreamRes.on("data", function(chunk) { chunks.push(chunk); });
        upstreamRes.on("end", function() {
          var text;
          try { text = decodeBody(upstreamRes, Buffer.concat(chunks)); }
          catch (_) { sendText(res, 502, "Could not read Jio playlist"); return; }
          res.removeHeader("content-length");
          res.setHeader("Cache-Control", "no-store");
          if (looksDash) {
            res.setHeader("Content-Type", "application/dash+xml; charset=utf-8");
            res.end(rewriteDashManifest(text, signedTarget.toString()));
          } else {
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
            res.end(sanitizeWebOsHlsManifest(rewriteManifest(text, signedTarget.toString(), channelId)));
          }
        });
      } else {
        upstreamRes.on("error", function() { if (!res.headersSent) sendText(res, 502, "Jio stream request failed"); else res.destroy(); });
        upstreamRes.pipe(res);
      }
    });
    upstream.on("timeout", function() { upstream.destroy(new Error("Jio stream request timed out")); });
    upstream.on("error", function() { if (!res.headersSent) sendText(res, 502, "Jio stream request failed"); else res.destroy(); });
    upstream.end();
  }).catch(function(error) {
    if (!res.headersSent) sendText(res, 502, error.message || "Could not resolve Jio stream");
    else res.destroy();
  });
}

function serveLive(req, res, channelId, level) {
  if (!/^\d{1,7}$/.test(String(channelId))) { sendText(res, 400, "Invalid channel id"); return; }
  ensureStream(channelId).then(function(data) {
    if (!data.streamUrl) throw new Error("Jio did not return an HLS stream for this channel.");
    var masterUrl = urlWithHdnea(data.streamUrl, data.hdnea);
    return requestText(masterUrl, "GET", streamHeaders(channelId, data.hdnea)).then(function(response) {
      if (response.status < 200 || response.status >= 300) throw new Error("Jio playlist failed (HTTP " + response.status + ").");
      return selectMasterVariant(response.text, masterUrl, channelId, level);
    });
  }).then(function(manifest) {
    sendText(res, 200, sanitizeWebOsHlsManifest(manifest), "application/vnd.apple.mpegurl; charset=utf-8");
  }).catch(function(error) {
    sendText(res, 502, error.message || "Could not load Jio playlist");
  });
}

function serveDash(req, res, channelId) {
  if (!/^\d{1,7}$/.test(String(channelId))) { sendText(res, 400, "Invalid channel id"); return; }
  ensureStream(channelId).then(function(data) {
    if (!data.mpdUrl) throw new Error("Jio did not return an alternate DASH stream for this channel.");
    var token = data.mpdHdnea || data.hdnea;
    var manifestUrl = urlWithHdnea(data.mpdUrl, data.mpdHdnea);
    if (!isJioHost(new URL(manifestUrl).hostname)) throw new Error("Jio returned an unsupported DASH host.");
    return requestTextFollow(manifestUrl, streamHeaders(channelId, token), 3).then(function(response) {
      if (response.status < 200 || response.status >= 300) throw new Error("Jio DASH playlist failed (HTTP " + response.status + ").");
      if (!/<MPD\b/i.test(String(response.text || ""))) throw new Error("Jio did not return a DASH manifest.");
      streamModes[String(channelId)] = "dash";
      return { text: response.text, url: response.url || manifestUrl };
    });
  }).then(function(result) {
    sendText(res, 200, rewriteDashManifest(result.text, result.url), "application/dash+xml; charset=utf-8");
  }).catch(function(error) {
    sendText(res, 502, error.message || "Could not load Jio DASH playlist");
  });
}

function forwardLicense(res, rawUrl, headers, challenge, hops) {
  var target;
  try { target = new URL(rawUrl); }
  catch (_) { sendText(res, 502, "Jio returned an invalid license URL"); return; }
  if ((target.protocol !== "https:" && target.protocol !== "http:") || !isJioHost(target.hostname)) {
    sendText(res, 403, "License host is not allowed");
    return;
  }
  var transport = target.protocol === "https:" ? https : http;
  var licenseHeaders = Object.assign({}, headers, {
    "Accept-Encoding": "identity",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(challenge.length)
  });
  var upstream = transport.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    path: target.pathname + target.search,
    method: "POST",
    headers: licenseHeaders,
    lookup: lookupIpv4,
    timeout: 20000
  }, function(upstreamRes) {
    var location = upstreamRes.headers.location;
    if (upstreamRes.statusCode >= 300 && upstreamRes.statusCode < 400 && location && hops > 0) {
      upstreamRes.resume();
      var redirected;
      try { redirected = new URL(location, target).toString(); }
      catch (_) { sendText(res, 502, "Invalid Jio license redirect"); return; }
      forwardLicense(res, redirected, headers, challenge, hops - 1);
      return;
    }
    setCors(res);
    res.statusCode = upstreamRes.statusCode || 502;
    if (upstreamRes.headers["content-type"]) res.setHeader("Content-Type", upstreamRes.headers["content-type"]);
    if (upstreamRes.headers["cache-control"]) res.setHeader("Cache-Control", upstreamRes.headers["cache-control"]);
    else res.setHeader("Cache-Control", "no-store");
    upstreamRes.on("error", function() { if (!res.headersSent) sendText(res, 502, "Jio license request failed"); else res.destroy(); });
    upstreamRes.pipe(res);
  });
  upstream.on("timeout", function() { upstream.destroy(new Error("Jio license request timed out")); });
  upstream.on("error", function() { if (!res.headersSent) sendText(res, 502, "Jio license request failed"); else res.destroy(); });
  upstream.end(challenge);
}

function serveLicense(req, res, channelId) {
  if (!/^\d{1,7}$/.test(String(channelId))) { sendText(res, 400, "Invalid channel id"); return; }
  var chunks = [];
  var size = 0;
  req.on("data", function(chunk) {
    size += chunk.length;
    if (size > 5242880) { sendText(res, 413, "DRM challenge is too large"); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on("end", function() {
    var challenge = Buffer.concat(chunks);
    ensureStream(channelId).then(function(data) {
      if (!data.licenseUrl) throw new Error("Jio did not return a Widevine license URL for this channel.");
      streamModes[String(channelId)] = "dash";
      var token = data.mpdHdnea || data.hdnea;
      forwardLicense(res, data.licenseUrl, licenseHeaders(channelId, token), challenge, 3);
    }).catch(function(error) {
      if (!res.headersSent) sendText(res, 502, error.message || "Could not request Jio's DRM license");
    });
  });
  req.on("error", function() { if (!res.headersSent) sendText(res, 400, "DRM challenge upload failed"); });
}

function handleProxyRequest(req, res) {
  var url;
  try { url = new URL(req.url, "http://127.0.0.1"); }
  catch (_) { sendText(res, 400, "Invalid local URL"); return; }
  if (req.method === "OPTIONS") { setCors(res); res.statusCode = 204; res.end(); return; }
  var prefix = "/v/" + proxyToken + "/";
  if (!proxyToken || url.pathname.indexOf(prefix) !== 0) { sendText(res, 404, "Not found"); return; }
  if (url.pathname === prefix + "health") { sendText(res, 200, "ok"); return; }
  var dash = /^\/v\/[^/]+\/dash\/(\d{1,7})\.mpd$/.exec(url.pathname);
  if (dash && (req.method === "GET" || req.method === "HEAD")) {
    serveDash(req, res, dash[1]);
    return;
  }
  var license = /^\/v\/[^/]+\/license$/.exec(url.pathname);
  if (license && req.method === "POST") {
    serveLicense(req, res, url.searchParams.get("ch") || "");
    return;
  }
  var live = /^\/v\/[^/]+\/live\/(\d{1,7})\.m3u8$/.exec(url.pathname);
  if (live && (req.method === "GET" || req.method === "HEAD")) {
    serveLive(req, res, live[1], url.searchParams.get("level") || 0);
    return;
  }
  if (url.pathname === prefix + "fetch" && (req.method === "GET" || req.method === "HEAD")) {
    var channelId = url.searchParams.get("ch") || "";
    var upstream = url.searchParams.get("u") || "";
    if (!/^\d{1,7}$/.test(channelId) || !upstream) { sendText(res, 400, "Invalid stream request"); return; }
    proxyUpstream(req, res, channelId, upstream, 0);
    return;
  }
  sendText(res, 404, "Not found");
}

function ensureProxy() {
  if (proxyServer && proxyServer.listening) return Promise.resolve();
  return new Promise(function(resolve, reject) {
    proxyToken = crypto.randomBytes(18).toString("hex");
    proxyServer = http.createServer(handleProxyRequest);
    proxyServer.on("error", function(error) { proxyServer = null; reject(error); });
    proxyServer.listen(0, "127.0.0.1", function() {
      proxyPort = proxyServer.address().port;
      resolve();
    });
  });
}

function closeProxy() {
  streamCache = {};
  streamRefreshes = {};
  streamModes = {};
  proxyToken = "";
  proxyPort = 0;
  if (proxyServer) {
    var server = proxyServer;
    proxyServer = null;
    server.close();
  }
}

function notifyAuth() {
  Object.keys(proxySubscriptions).forEach(function(key) {
    try { proxySubscriptions[key].respond({ returnValue: true, event: "authUpdated", auth: authData }); }
    catch (_) { delete proxySubscriptions[key]; }
  });
}

function register(method, handler) {
  service.register(method, function(message) {
    Promise.resolve().then(function() { return handler(message.payload || {}); }).then(function(result) {
      message.respond(Object.assign({ returnValue: true }, result || {}));
    }).catch(function(error) {
      message.respond({ returnValue: false, errorText: error && error.message ? error.message : "Jio request failed" });
    });
  });
}

register("auth/sendOtp", function(payload) { return sendOtp(payload.mobile); });
register("auth/verifyOtp", function(payload) {
  return verifyOtp(payload.mobile, payload.otp).then(function(auth) {
    authData = auth;
    streamCache = {};
    streamRefreshes = {};
    streamModes = {};
    notifyAuth();
    return { auth: auth };
  });
});
register("library/getChannels", function() { return getChannels().then(function(channels) { return { channels: channels }; }); });
register("auth/refresh", function(payload) {
  authData = payload.auth || authData;
  return refreshAuth().then(function(auth) { return { auth: auth }; });
});
register("proxy/qualities", function(payload) {
  authData = payload.auth || authData;
  return getQualityLevels(payload.channelId).then(function(levels) { return { levels: levels, auth: authData }; });
});
register("proxy/resolve", function(payload) {
  authData = payload.auth || authData;
  return resolvePlayback(payload.channelId, { forceHls: !!payload.forceHls });
});

service.register("proxy/start", function(message) {
  authData = message.payload && message.payload.auth || authData;
  if (!authData || !authData.authToken) {
    message.respond({ returnValue: false, errorText: "Sign in with Jio in Settings before watching." });
    return;
  }
  ensureProxy().then(function() {
    if (message.isSubscription) proxySubscriptions[message.uniqueToken] = message;
    message.respond({
      returnValue: true,
      baseUrl: "http://127.0.0.1:" + proxyPort + "/v/" + proxyToken,
      auth: authData
    });
  }).catch(function(error) {
    message.respond({ returnValue: false, errorText: "Could not start the TV's local stream service: " + (error.message || "unknown error") });
  });
}, function(message) {
  delete proxySubscriptions[message.uniqueToken];
  if (!Object.keys(proxySubscriptions).length) closeProxy();
});

register("proxy/stop", function() {
  proxySubscriptions = {};
  closeProxy();
  return { stopped: true };
});

register("diagnostic/ping", function() { return { version: require("./package.json").version, nodeService: true }; });
