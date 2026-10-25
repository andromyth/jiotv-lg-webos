/* Remove HLS tags LG lists as unsupported by its native player. */
var UNSUPPORTED_HLS_TAGS = [
  "#EXT-X-PROGRAM-DATE-TIME:",
  "#EXT-X-ALLOW-CACHE:",
  "#EXT-X-DATERANGE:",
  "#EXT-X-I-FRAMES-ONLY",
  "#EXT-X-I-FRAME-STREAM-INF:",
  "#EXT-X-SESSION-DATA:",
  "#EXT-X-INDEPENDENT-SEGMENTS",
  "#EXT-X-DISCONTINUITY-SEQUENCE:"
];

function sanitizeWebOsHlsManifest(manifest) {
  var source = String(manifest || "");
  if (source.trim().indexOf("#EXTM3U") !== 0) return source;
  return source.split(/\r?\n/).filter(function(line) {
    var trimmed = line.trim();
    return !UNSUPPORTED_HLS_TAGS.some(function(tag) { return trimmed.indexOf(tag) === 0; });
  }).join("\n");
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* Resolve relative DASH segment URLs against the Jio manifest, not the TV loopback proxy. */
function rewriteDashManifest(manifest, manifestUrl) {
  var source = String(manifest || "");
  var root = /<MPD\b[^>]*>/i.exec(source);
  if (!root) return source;

  var base;
  try {
    var url = new (require("url").URL)(manifestUrl);
    url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf("/") + 1);
    url.search = "";
    url.hash = "";
    base = url.toString();
  } catch (_) { return source; }

  var rootStart = root.index + root[0].length;
  var lower = source.toLowerCase();
  var firstPeriod = lower.indexOf("<period", rootStart);
  var rootContentEnd = firstPeriod >= 0 ? firstPeriod : lower.indexOf("</mpd", rootStart);
  if (rootContentEnd < 0) rootContentEnd = source.length;
  var rootContent = source.slice(rootStart, rootContentEnd);
  var baseMatch = /<BaseURL\b[^>]*>([\s\S]*?)<\/BaseURL>/i.exec(rootContent);

  if (baseMatch) {
    var existing = baseMatch[1].trim();
    if (/^https?:\/\//i.test(existing)) return source;
    var resolved;
    try { resolved = new (require("url").URL)(existing, base).toString(); }
    catch (_) { resolved = base; }
    var absoluteTag = baseMatch[0].replace(baseMatch[1], escapeXml(resolved));
    var absoluteAt = rootStart + baseMatch.index;
    return source.slice(0, absoluteAt) + absoluteTag + source.slice(absoluteAt + baseMatch[0].length);
  }

  return source.slice(0, rootStart) + "<BaseURL>" + escapeXml(base) + "</BaseURL>" + source.slice(rootStart);
}

module.exports = {
  sanitizeWebOsHlsManifest: sanitizeWebOsHlsManifest,
  rewriteDashManifest: rewriteDashManifest
};
