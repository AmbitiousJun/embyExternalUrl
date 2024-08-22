//author: @bpking  https://github.com/bpking1/embyExternalUrl
//查看日志: "docker logs -f -n 10 emby-nginx 2>&1  | grep js:"
import config from "./constant.js";
import util from "./util.js";

async function redirect2Pan(r) {
  // fetch mount emby/jellyfin file path
  const itemInfo = util.getItemInfo(r);
  r.warn(`itemInfoUri: ${itemInfo.itemInfoUri}`);
  const useTranscodeResource = !util.isEmpty(itemInfo.videoPreviewFormat);

  const embyRes = await fetchEmbyFilePath(itemInfo.itemInfoUri, itemInfo.Etag);
  if (embyRes.code !== 200) {
    r.error(embyRes.msg);
    return r.return(embyRes.code, embyRes.msg);
  }

  const embyPath = embyRes.data;
  let alistPathRes = await embyPath2AlistPath(embyPath);
  if (alistPathRes.success) {
    const alistRes = await fetchAlistResource(alistPathRes.path, useTranscodeResource, itemInfo.videoPreviewFormat, false);

    if (alistRes.code === 200) {
      r.warn(`redirect to: ${alistRes.data}`);
      return r.return(302, alistRes.data);
    }

    if (alistRes.code === 403) {
      r.error(alistRes.msg);
      return r.return(403, alistRes.msg);
    }
  }

  alistPathRes = await alistPathRes.range();
  if (!alistPathRes.success) {
    r.error(alistPathRes.res.msg);
    return r.return(alistPathRes.res.code, alistPathRes.res.msg);
  }

  for (let i = 0; i < alistPathRes.paths.length; i++) {
    const path = alistPathRes.paths[i];
    r.warn(`try to fetch alist path from ${path}`);
    const alistRes = await fetchAlistResource(path, useTranscodeResource, itemInfo.videoPreviewFormat, true);

    if (alistRes.code === 200) {
      r.warn(`redirect to: ${alistRes.data}`);
      return r.return(302, alistRes.data);
    }
  }

  r.warn(`fail to fetch alist resource: not found, use origin stream`);
  return r.return(307, util.getEmbyOriginRequestUrl(r));
}

// 拦截 PlaybackInfo 请求，防止客户端转码（转容器）
async function transferPlaybackInfo(r) {
  const proxyUri = util.proxyUri(r.uri);
  const videoPreviewCfg = config.videoPreviewCfg;

  const msInfo = resolveMediaSourceId(r.args['MediaSourceId']);
  r.warn(`MediaSourceId resolve result: ${JSON.stringify(msInfo)}`);
  msInfo.errorMsg && r.error(msInfo.errorMsg);
  const useTranscode = !msInfo.empty && msInfo.transcode;
  const copyRequest = JSON.parse(JSON.stringify({ args: r.args }));
  if (useTranscode) {
    // client request the transcode resource
    copyRequest.args['MediaSourceId'] = msInfo.originId;
  }

  // send subrequest to origin emby server
  const query = util.generateUrl(copyRequest, "", "").substring(1);
  const response = await r.subrequest(proxyUri, {
    method: r.method,
    args: query
  });
  const body = JSON.parse(response.responseText);
  if (response.status !== 200) {
    r.warn('Playbackinfo subrequest failed');
    return r.return(307, util.getEmbyOriginRequestUrl(r));
  }
  r.warn(`Playbackinfo subrequest success`);

  // empty media source found
  const mediaSourcesLen = body.MediaSources ? body.MediaSources.length : 0;
  if (mediaSourcesLen < 1) {
    r.warn('No media source found');
    r.headersOut["Content-Type"] = "application/json;charset=utf-8";
    return r.return(200, JSON.stringify(body));
  }

  r.warn(`MediaSourcesLen: ${mediaSourcesLen}`);
  for (let i = 0; i < mediaSourcesLen; i++) {
    const source = body.MediaSources[i];
    if (source.IsRemote) {
      // live streams are not blocked
      return r.return(200, response.responseText);
    }

    source.SupportsDirectPlay = true;
    source.SupportsDirectStream = true;
    source.DirectStreamUrl = util.addDefaultApiKey(
      r,
      util.generateUrl(copyRequest, "", r.uri)
          .replace("/emby/Items", "/videos")
          .replace("PlaybackInfo", "stream")
    );
    source.DirectStreamUrl = util.appendUrlArg(source.DirectStreamUrl, "MediaSourceId", source.Id);
    source.DirectStreamUrl = util.appendUrlArg(source.DirectStreamUrl, "Static", "true");
    r.warn(`Change direct play url to: ${source.DirectStreamUrl}`);

    const name = findMediaSourceName(source)
    if (name) {
      source.Name = name;
    }

    if (useTranscode) {
      // client request specific transcode media source
      source.Name = `(${msInfo.sourceNamePrefix}) ${source.Name}`;
      source.DirectStreamUrl = util.appendUrlArg(source.DirectStreamUrl, "video_preview_format", msInfo.templateId);
      source.SupportsTranscoding = true;
      source.TranscodingUrl = source.DirectStreamUrl;
      source.TranscodingSubProtocol = 'hls';
      source.TranscodingContainer = 'ts';
      delete source.DirectStreamUrl;
      source.SupportsDirectPlay = false;
      source.SupportsDirectStream = false;
      r.warn(`Append 'video_preview_format' arg [${msInfo.templateId}] to direct stream url`);
      continue;
    }

    // remove transcode info to direct play
    source.SupportsTranscoding = false;
    if (source.TranscodingUrl) {
      delete source.TranscodingUrl;
      delete source.TranscodingSubProtocol;
      delete source.TranscodingContainer;
      r.warn(`Delete transcoding info`);
    }

    // add video preview info
    if (!msInfo.empty || !videoPreviewCfg.enable || !videoPreviewCfg.containers[source.Container]) {
      continue;
    }
    const previewInfos = await findVideoPreviewInfos(source);
    if (previewInfos && previewInfos.length && previewInfos.length > 0) {
      r.warn(`${previewInfos.length} video preview info(s) found`);
      body.MediaSources = body.MediaSources.concat(previewInfos);
    }

    source.Name = `(原画) ${source.Name}`;
    r.warn(`Modify source's name to: ${source.Name}`);
  }

  for (const key in response.headersOut) {
    if (key === "Content-Length") {
      // auto generate content length
      continue;
    }
    r.headersOut[key] = response.headersOut[key];
  }

  const bodyJson = JSON.stringify(body);
  r.headersOut["Content-Type"] = "application/json;charset=utf-8";
  return r.return(200, bodyJson);
}

/**
 * 解析 MediaSourceId 信息, 帮助判断客户端请求的是不是转码资源
 * @param {string} id MediaSourceId
 */
function resolveMediaSourceId(id) {
  const res = {
    empty: true,           // 传递的 id 值是否是个空值
    transcode: false,      // 是否请求转码的资源
    originId: '',          // 原始 MediaSourceId
    templateId: '',        // alist 中转码资源的模板 id
    format: '',            // 转码资源的格式, 比如：1920x1080
    sourceNamePrefix: '',  // 转码资源名称前缀
    errorMsg: ''           // 解析异常信息
  };

  if (id === null || id === undefined || typeof id !== 'string' || id.trim() === '') {
    return res
  }
  res.empty = false;

  if (id.length <= 32) {
    res.originId = id;
    return res;
  }

  const segments = id.split('_');
  if (segments.length !== 3) {
    res.errorMsg = 'Unexpected MediaSourceId format: ' + id;
    res.originId = id;
    return res;
  }

  res.transcode = true;
  res.originId = segments[0];
  res.templateId = segments[1];
  res.format = segments[2];
  res.sourceNamePrefix = `${res.templateId}_${res.format}`;
  return res;
}

/**
 * 查找 MediaSource 的云盘转码 preview info
 * @param {Object} source MediaSource 对象
 * @returns [previewInfo1, previewInfo2...]
 */ 
async function findVideoPreviewInfos(source) {
  if (!source || Object.prototype.toString.call(source) !== '[object Object]') {
    return [];
  }

  let alistPathRes = await embyPath2AlistPath(source.Path);
  let transcodingList = [];
  let firstFetchSuccess = false;
  if (alistPathRes.success) {
    const alistRes = await fetchAlistFsOther(alistPathRes.path);

    if (alistRes.code === 200) {
      firstFetchSuccess = true;
      transcodingList = alistRes.data.video_preview_play_info.live_transcoding_task_list;
    }

    if (alistRes.code === 403) {
      return [];
    }
  }

  if (!firstFetchSuccess) {
    alistPathRes = await alistPathRes.range();
    if (!alistPathRes.success) {
      return [];
    }

    for (let i = 0; i < alistPathRes.paths.length; i++) {
      const path = alistPathRes.paths[i];
      const alistRes = await fetchAlistFsOther(path);

      if (alistRes.code === 200) {
        transcodingList = alistRes.data.video_preview_play_info.live_transcoding_task_list;
        break;
      }
    }
  }

  if (!transcodingList || transcodingList.length === 0) {
    return [];
  }
  return transcodingList.map(transcode => {
    const copySource = JSON.parse(JSON.stringify(source));
    const prefix = `${transcode.template_id}_${transcode.template_width}x${transcode.template_height}`;
    copySource.Name = `(${prefix}) ${source.Name}`
    copySource.DirectStreamUrl = util.appendUrlArg(copySource.DirectStreamUrl, "video_preview_format", transcode.template_id);
    // Important!!! This id must be different from the original id, but be able to deduce the original id
    copySource.Id = `${source.Id}_${prefix}`;

    // mark transcode resource as transcoding container
    copySource.SupportsTranscoding = true;
    copySource.TranscodingContainer = 'ts';
    copySource.TranscodingSubProtocol = 'hls';
    copySource.TranscodingUrl = copySource.DirectStreamUrl;
    copySource.SupportsDirectPlay = false;
    copySource.SupportsDirectStream = false;
    delete copySource.DirectStreamUrl;

    return copySource;
  })
}

// 查找 MediaSource 中的视频名称, 如：'1080p HEVC'
function findMediaSourceName(source) {
  if (!source || Object.prototype.toString.call(source) !== '[object Object]') {
    return source.Name;
  }

  if (!source.MediaStreams || !source.MediaStreams.length) {
    return source.Name;
  }

  const idx = source.MediaStreams.findIndex(stream => stream.Type === 'Video');
  if (idx === -1) {
    return source.Name;
  }
  return source.MediaStreams[idx].DisplayTitle;
}

/**
 * 将资源在 Emby 本地的 path 中映射为 alist 中的 path
 * @param {String} embyPath 当前请求的视频所在 emby 服务器的物理路径
 * @returns 
 */
async function embyPath2AlistPath(embyPath) {
  const embyMountPath = config.embyMountPath;
  const emby2AlistRootMap = config.emby2AlistRootMap;
  // fetch alist direct link
  let alistFilePath = embyPath.replace(embyMountPath, "");
  // emby 路径映射到 alist
  if (emby2AlistRootMap) {
    for (const key in emby2AlistRootMap) {
      if (alistFilePath.startsWith(key)) {
        alistFilePath = alistFilePath.replace(key, emby2AlistRootMap[key]);
        break;
      }
    }
  }

  const rangeFunc = async function() {
    const filePath = alistFilePath.substring(alistFilePath.indexOf("/", 1));
    const foldersRes = await fetchAlistApi('/api/fs/list', 'POST', {
      refresh: true, 
      password: '', 
      path: '/' 
    });

    if (foldersRes.code !== 200) {
      return { success: false, res: foldersRes };
    }

    const paths = foldersRes.data.content
                                  .filter(item => item.is_dir)
                                  .map(item => `/${item.name}${filePath}`);
    return {
      success: true,
      paths
    }
  }

  return {
    success: true,
    path: alistFilePath,
    range: rangeFunc
  }
}

/**
 * 请求 alist 资源
 * @param {string} path alist 资源路径
 * @param {boolean} useTranscode 是否请求转码资源
 * @param {string} format 转码资源格式
 * @param {boolean} useRawIfFallback 如果请求转码资源失败, 是否重新请求原画资源
 */
async function fetchAlistResource(path, useTranscode, format, useRawIfFallback) {
  if (util.isEmpty(path)) {
    return { code: 400, msg: 'empty alist path' };
  }

  if (!useTranscode) {
    // 请求原画资源
    const alistRes = await fetchAlistFsGet(path);
    if (alistRes.code === 200) {
      const link = alistRes.data.raw_url;
      return { code: 200, data: link };
    }
    return { code: alistRes.code, msg: alistRes.msg };
  }

  // 请求转码资源
  const alistRes = await fetchAlistFsOther(path);
  if (alistRes.code !== 200) {
    if (useRawIfFallback) {
      return fetchAlistResource(path, false, null, null);
    }
    return { code: alistRes.code, msg: alistRes.msg };
  }

  const list = alistRes.data.video_preview_play_info.live_transcoding_task_list;
  const idx = list.findIndex(v => v.template_id === format);
  if (idx === -1) {
    const allFormats = JSON.stringify(list.map(v => v.template_id));
    return { code: 400, msg: `No specific transcode format found, all formats: [${allFormats}]` }
  }
  return { code: 200, data: list[idx].url };
}

/**
 * 请求 alist 的原画资源
 * @param {string} path alist 资源路径
 */
async function fetchAlistFsGet(path) {
  if (util.isEmpty(path)) {
    return { code: 400, msg: 'empty alist path' };
  }
  const alistPublicAddr = config.alistPublicAddr;
  const alistRes = await fetchAlistApi('/api/fs/get', 'POST', { 
    refresh: true, 
    password: '', 
    path
  });

  if (alistRes.code === 200) {
    const link = alistRes.data.raw_url.replace('http://172.17.0.1', alistPublicAddr);
    alistRes.data.raw_url = link;
    return { code: 200, data: alistRes.data };
  }

  return { code: alistRes.code, msg: alistRes.msg };
}

/**
 * 请求 alist 转码资源
 * @param {string} path alist 资源路径
 */
async function fetchAlistFsOther(path) {
  if (util.isEmpty(path)) {
    return { code: 400, msg: 'empty alist path' };
  }
  const alistPublicAddr = config.alistPublicAddr;
  const alistRes = await fetchAlistApi('/api/fs/other', 'POST', { 
    method: "video_preview",
    password: '', 
    path
  });

  if (alistRes.code === 200) {
    const list = alistRes.data.video_preview_play_info.live_transcoding_task_list;
    list.forEach(v => {
      if (util.isEmpty(v.url)) {
        return;
      }
      v.url = v.url.replace('http://172.17.0.1', alistPublicAddr);
    });
    return { code: 200, data: alistRes.data };
  }

  return { code: alistRes.code, msg: alistRes.msg };
}

/**
 * 请求 alist 接口
 * @param {string} route 请求地址
 * @param {object} requestBody 请求体
 * @param {string} method 请求方法
 * @returns Promise<[request result object]>
 */
async function fetchAlistApi(route, method, requestBody) {
  const host = config.alistAddr;
  const token = config.alistToken;
  try {
    const res = await ngx.fetch(`${host}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Authorization: token,
      },
      max_response_body_size: 65535,
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      return { code: 400, msg: `fetch alist api failed, route: ${route}, requestBody: ${requestBody}, host: ${host}, token: ${token}` }
    }

    const result = await res.json();
    if (result === null || result === undefined) {
      return { code: 400, msg: `fetch alist api get empty result` };
    }

    if (result.code !== 200) {
      return { code: result.code, msg: result.message };
    }
    
    return { code: 200, data: result.data };
  } catch (error) {
    return { code: 400, msg: `fetch alist api failed: ${error}` }
  }
}

async function fetchEmbyFilePath(itemInfoUri, Etag) {
  try {
    const res = await ngx.fetch(itemInfoUri, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "Content-Length": 0,
      },
      max_response_body_size: 65535,
    });

    if (!res.ok) {
      return { code: 400, msg: "Fetch emby item info api failed" }
    }

    const result = await res.json();
    if (result === null || result === undefined) {
      return { code: 400, msg: "Fetch emby api get empty item info response" };
    }

    if (Etag) {
      const mediaSource = result.MediaSources.find((m) => m.ETag == Etag);
      if (mediaSource && mediaSource.Path) {
        return { code: 200, data: mediaSource.Path }
      }
    }

    return { code: 200, data: result.MediaSources[0].Path };
  } catch (error) {
    return { code: 400, msg: `Fetch emby item info api failed: ${error}` }
  }
}

export default { redirect2Pan, fetchEmbyFilePath, transferPlaybackInfo };
