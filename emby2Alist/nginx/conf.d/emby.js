//author: @bpking  https://github.com/bpking1/embyExternalUrl
//查看日志: "docker logs -f -n 10 emby-nginx 2>&1  | grep js:"
import config from "./constant.js";
import util from "./util.js";

async function redirect2Pan(r) {
  const embyMountPath = config.embyMountPath;
  const alistPublicAddr = config.alistPublicAddr;
  const emby2AlistRootMap = config.emby2AlistRootMap;

  // fetch mount emby/jellyfin file path
  const itemInfo = util.getItemInfo(r);
  r.warn(`itemInfoUri: ${itemInfo.itemInfoUri}`);
  const embyRes = await fetchEmbyFilePath(itemInfo.itemInfoUri, itemInfo.Etag);

  if (embyRes.code !== 200) {
    r.error(embyRes.msg);
    return r.return(embyRes.code, embyRes.msg);
  }

  const embyPath = embyRes.data;
  r.warn(`mount emby file path: ${embyPath}`);

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

  const alistRes = await fetchAlistApi('/api/fs/get', 'POST', { 
    refresh: true, 
    password: '', 
    path: alistFilePath 
  });

  if (alistRes.code === 200) {
    const link = alistRes.data.raw_url.replace('http://172.17.0.1', alistPublicAddr);
    r.warn(`redirect to: ${link}`);
    return r.return(302, link);
  }

  if (alistRes.code === 403) {
    r.error(alistRes.msg);
    return r.return(403, alistRes.msg);
  }

  const filePath = alistFilePath.substring(alistFilePath.indexOf("/", 1));
  const foldersRes = await fetchAlistApi('/api/fs/list', 'POST', {
     refresh: true, 
     password: '', 
     path: '/' 
  });

  if (foldersRes.code !== 200) {
    r.error(foldersRes.msg);
    return r.return(foldersRes.code, foldersRes.msg);
  }

  const folders = foldersRes.data.content
                                 .filter(item => item.is_dir)
                                 .map(item => item.name);
  for (let i = 0; i < folders.length; i++) {
    r.warn(`try to fetch alist path from /${folders[i]}${filePath}`);
    const driverRes = await fetchAlistApi('/api/fs/get', 'POST', {
      refresh: true,
      password: '',
      path: `/${folders[i]}${filePath}`
    })

    if (driverRes.code === 200) {
      const link = driverRes.data.raw_url.replace('http://172.17.0.1', alistPublicAddr);
      r.warn(`redirect to: ${link}`);
      return r.return(302, link);
    }
  }

  r.warn(`fail to fetch alist resource: not found, use origin stream`);
  return r.return(307, util.getEmbyOriginRequestUrl(r));
}

// 拦截 PlaybackInfo 请求，防止客户端转码（转容器）
async function transferPlaybackInfo(r) {
  const proxyUri = util.proxyUri(r.uri);
  const query = util.generateUrl(r, "", "").substring(1);
  const response = await r.subrequest(proxyUri, {
    method: r.method,
    args: query
  });
  const body = JSON.parse(response.responseText);

  if (response.status !== 200) {
    r.warn('Playbackinfo subrequest failed');
    return r.return(307, util.getEmbyOriginRequestUrl(r));
  }

  if (!body.MediaSources || body.MediaSources.length === 0) {
    r.warn('No media source found');
    r.headersOut["Content-Type"] = "application/json;charset=utf-8";
    return r.return(200, JSON.stringify(body));
  }

  for (let i = 0; i < body.MediaSources.length; i++) {
    const source = body.MediaSources[i];
    if (source.IsRemote) {
      // live streams are not blocked
      return r.return(200, response.responseText);
    }

    source.SupportsDirectPlay = true;
    source.SupportsDirectStream = true;
    source.DirectStreamUrl = util.addDefaultApiKey(
      r,
      util.generateUrl(r, "", r.uri)
          .replace("/emby/Items", "/videos")
          .replace("PlaybackInfo", "stream")
    );
    source.DirectStreamUrl = util.appendUrlArg(source.DirectStreamUrl, "MediaSourceId", source.Id);
    source.DirectStreamUrl = util.appendUrlArg(source.DirectStreamUrl, "Static", "true");
    r.warn(`Change direct play url to: ${source.DirectStreamUrl}`);

    source.SupportsTranscoding = false;
    if (source.TranscodingUrl) {
      delete source.TranscodingUrl;
      delete source.TranscodingSubProtocol;
      delete source.TranscodingContainer;
      r.warn(`Delete transcoding info`);
    }
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
