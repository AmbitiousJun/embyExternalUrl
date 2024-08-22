import config from "./constant.js";

function proxyUri(uri) {
  return `/proxy${uri}`;
}

function appendUrlArg(u, k, v) {
  if (u.includes(k)) {
    return u;
  }
  return u + (u.includes("?") ? "&" : "?") + `${k}=${v}`;
}

function addDefaultApiKey(r, u) {
  let url = u;
  const itemInfo = getItemInfo(r);
  if (!url.includes("api_key") && !url.includes("X-Emby-Token")) {
    url = appendUrlArg(url, "api_key", itemInfo.api_key);
  }
  return url;
}

function generateUrl(r, host, uri) {
  let url = host + uri;
  let isFirst = true;
  for (const key in r.args) {
    url += isFirst ? "?" : "&";
    url += `${key}=${r.args[key]}`;
    isFirst = false;
  }
  return url;
}

function getEmbyOriginRequestUrl(r) {
  const embyHost = config.embyHost;
  return addDefaultApiKey(r, generateUrl(r, embyHost, r.uri));
}

function getCurrentRequestUrl(r) {
  const host = r.headersIn["Host"];
  return addDefaultApiKey(r, generateUrl(r, "http://" + host, r.uri));
}

// 生成一个 指定 位的随机 id
function randomId(n) {
  if (typeof n !== 'number' || n < 0) {
    return '';
  }
  const dict = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z'];
  let res = '';
  for (let i = 1; i <= n; i++) {
    res += dict[Math.floor(Math.random() * dict.length)];
  }
  return res;
}

// 判断一个变量是否为空, 或无意义状态
function isEmpty(v) {
  if (v === null || v === undefined) {
    return true;
  }
  if (typeof v === 'object') {
    const json = JSON.stringify(v);
    if (json === '[]' || json === '{}') {
      return true;
    }
  }
  if (typeof v === 'string' && v.trim() === '') {
    return true;
  }
  return false;
}

function getItemInfo(r) {
  const embyHost = config.embyHost;
  const embyApiKey = config.embyApiKey;
  const regex = /[A-Za-z0-9]+/g;
  const itemId = r.uri.replace("emby", "").replace(/-/g, "").match(regex)[1];
  const mediaSourceId = r.args.MediaSourceId
    ? r.args.MediaSourceId
    : r.args.mediaSourceId;
  const Etag = r.args.Tag;
  let api_key = r.args["X-Emby-Token"]
    ? r.args["X-Emby-Token"]
    : r.args.api_key;
  api_key = api_key ? api_key : embyApiKey;
  let itemInfoUri = "";
  if (mediaSourceId) {
    itemInfoUri = `${embyHost}/Items/${itemId}/PlaybackInfo?MediaSourceId=${mediaSourceId}&api_key=${api_key}`;
  } else {
    itemInfoUri = `${embyHost}/Items/${itemId}/PlaybackInfo?api_key=${api_key}`;
  }
  const videoPreviewFormat = r.args['video_preview_format'];
  return { itemId, mediaSourceId, Etag, api_key, itemInfoUri, videoPreviewFormat };
}

export default {
  appendUrlArg,
  addDefaultApiKey,
  proxyUri,
  getItemInfo,
  generateUrl,
  getCurrentRequestUrl,
  getEmbyOriginRequestUrl,
  randomId,
  isEmpty
};
