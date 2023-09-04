//author: @bpking  https://github.com/bpking1/embyExternalUrl
//查看日志: "docker logs -f -n 10 emby-nginx 2>&1  | grep js:"
import config from "./constant.js";

async function redirect2Pan(r) {
  const {
    embyHost,
    embyMountPath,
    alistToken,
    alistAddr,
    embyApiKey,
    alistPublicAddr,
  } = config;
  //fetch mount emby/jellyfin file path
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
  r.warn(`itemInfoUri: ${itemInfoUri}`);
  const embyRes = await fetchEmbyFilePath(itemInfoUri, Etag);
  if (embyRes.startsWith("error")) {
    r.error(embyRes);
    r.return(500, embyRes);
    return;
  }
  r.warn(`mount emby file path: ${embyRes}`);

  //fetch alist direct link
  const alistFilePath = embyRes.replace(embyMountPath, "");
  const alistFsGetApiPath = `${alistAddr}/api/fs/get`;
  let alistRes = await fetchAlistPathApi(
    alistFsGetApiPath,
    alistFilePath,
    alistToken
  );
  if (!alistRes.startsWith("error")) {
    alistRes = alistRes.includes("http://172.17.0.1")
      ? alistRes.replace("http://172.17.0.1", alistPublicAddr)
      : alistRes;
    r.warn(`redirect to: ${alistRes}`);
    r.return(302, alistRes);
    return;
  }
  if (alistRes.startsWith("error403")) {
    r.error(alistRes);
    r.return(403, alistRes);
    return;
  }
  if (alistRes.startsWith("error500")) {
    const filePath = alistFilePath.substring(alistFilePath.indexOf("/", 1));
    const alistFsListApiPath = `${alistAddr}/api/fs/list`;
    const foldersRes = await fetchAlistPathApi(
      alistFsListApiPath,
      "/",
      alistToken
    );
    if (foldersRes.startsWith("error")) {
      r.error(foldersRes);
      r.return(500, foldersRes);
      return;
    }
    const folders = foldersRes.split(",").sort();
    for (let i = 0; i < folders.length; i++) {
      r.warn(`try to fetch alist path from /${folders[i]}${filePath}`);
      let driverRes = await fetchAlistPathApi(
        alistFsGetApiPath,
        `/${folders[i]}${filePath}`,
        alistToken
      );
      if (!driverRes.startsWith("error")) {
        driverRes = driverRes.includes("http://172.17.0.1")
          ? driverRes.replace("http://172.17.0.1", alistPublicAddr)
          : driverRes;
        r.warn(`redirect to: ${driverRes}`);
        r.return(302, driverRes);
        return;
      }
    }
    r.error(alistRes);
    r.return(404, alistRes);
    return;
  }
  r.error(alistRes);
  r.return(500, alistRes);
  return;
}

async function fetchAlistPathApi(alistApiPath, alistFilePath, alistToken) {
  const alistRequestBody = {
    path: alistFilePath,
    password: "",
  };
  try {
    const response = await ngx.fetch(alistApiPath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Authorization: alistToken,
      },
      max_response_body_size: 65535,
      body: JSON.stringify(alistRequestBody),
    });
    if (response.ok) {
      const result = await response.json();
      if (result === null || result === undefined) {
        return `error: alist_path_api response is null`;
      }
      if (result.message == "success") {
        if (result.data.raw_url) {
          return result.data.raw_url;
        }
        return result.data.content.map((item) => item.name).join(",");
      }
      if (result.code == 403) {
        return `error403: alist_path_api ${result.message}`;
      }
      return `error500: alist_path_api ${result.code} ${result.message}`;
    } else {
      return `error: alist_path_api ${response.status} ${response.statusText}`;
    }
  } catch (error) {
    return `error: alist_path_api fetchAlistFiled ${error}`;
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
    if (res.ok) {
      const result = await res.json();
      if (result === null || result === undefined) {
        return `error: emby_api itemInfoUri response is null`;
      }
      if (Etag) {
        const mediaSource = result.MediaSources.find((m) => m.ETag == Etag);
        if (mediaSource && mediaSource.Path) {
          return mediaSource.Path;
        }
      }
      return result.MediaSources[0].Path;
    } else {
      return `error: emby_api ${res.status} ${res.statusText}`;
    }
  } catch (error) {
    return `error: emby_api fetch mediaItemInfo failed,  ${error}`;
  }
}

export default { redirect2Pan, fetchEmbyFilePath };
