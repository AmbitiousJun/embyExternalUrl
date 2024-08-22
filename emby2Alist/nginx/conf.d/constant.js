// export constant allocation
// 根据实际情况修改下面的设置

// 这里默认emby/jellyfin的地址是宿主机,要注意iptables给容器放行端口
const embyHost = "http://172.17.0.1:8096";
// rclone 的挂载目录, 例如将od, gd挂载到/mnt目录下:  /mnt/onedrive  /mnt/gd ,那么这里 就填写 /mnt
const embyMountPath = "/mnt";
// emby 磁盘目录 映射到 alist 根目录, 如果两者是一一对应的, 则不需要配置映射
const emby2AlistRootMap = {
  "/movie": "/电影",
  "/music": "/音乐",
  "/show": "/综艺",
  "/series": "/电视剧",
  "/sport": "/运动",
  "/animation": "/动漫"
};
// alist token, 在alist后台查看
const alistToken = "alsit-123456";
// 访问宿主机上5244端口的alist地址, 要注意iptables给容器放行端口
const alistAddr = "http://172.17.0.1:5244";
// emby/jellyfin api key, 在emby/jellyfin后台设置
const embyApiKey = "f839390f50a648fd92108bc11ca6730a";
// alist公网地址, 用于需要alist server代理流量的情况, 按需填写
const alistPublicAddr = "http://youralist.com:5244";

// 视频预览配置, 即获取视频直链时可以获取到由云盘转码完成的地址进行播放, 不保证所有客户端支持！！！
const videoPreviewCfg = {
  // 是否开启
  enable: true,
  // 对哪些视频容器启用该功能
  containers: { "mp4": true, "mkv": true }
}

export default {
  embyHost,
  embyMountPath,
  emby2AlistRootMap,
  alistToken,
  alistAddr,
  embyApiKey,
  alistPublicAddr,
  videoPreviewCfg
}
