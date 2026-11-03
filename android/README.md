# Android 本地弹幕引擎

Android 手机和 TV 共用同一份 QuickJS 引擎。入口是 `engine-entry.js`，宿主适配层是 `host-shim.js`，节目与期号选择规则来自 Box Workers 的严格 resolver。新增规则时同步检查 resolver 源文件和 `strict-resolver.test.mjs` fixtures。

引擎使用 danmu_api 的节目搜索、详情和评论源实现，通过 Android Host 异步请求外部站点。它不启动 Node 服务，不读取 `.env`、系统密钥、Redis、用户本地文件或远程弹幕 API 配置；未知域名不会转发到 `OtherSource` 的第三方弹幕服务器。自动匹配只在季号、日期、期号、特辑和分段证据满足严格规则时返回；不确定时由 Android 现有云端兜底或手动匹配接手。节目 ID 仅在本引擎命名空间内有效，剧集映射可用时才返回原始视频 URL。

## 本地构建与验证

在仓库根目录运行：

```sh
npm install --no-audit --no-fund
npm run build-android-danmaku
npm run test-android-danmaku
```

产物写入 `dist/android/`：`engine.js`、`manifest.json`，以及设置了签名密钥时的 `manifest.sig`。Bundle 使用 ES2019 语法目标，构建遇到 BigInt 字面量会失败。protobuf varint 在 JS 中按十进制字符串精确解码；只在既有接口明确要求 Number 的字段才转换，并对 tag、长度与超过64位的输入拒绝解析。爱奇艺 varint 值保留为精确十进制字符串。

排查 QuickJS 解析错误时，可用 `DANMAKU_MINIFY=false` 生成保留行号的 bundle，并通过 `DANMAKU_ANDROID_OUTDIR=dist/android-debug` 输出到单独目录，避免覆盖正常候选产物。

`manifest.json` 包含 `apiVersion`、`scriptVersion`、`minAppVersion`、`cacheSchema`、脚本字节数、SHA-256 和不可变版本下载 URL。当前宿主 API 为1；改变 Java Host 能力或响应契约时，应提高 API 版本并同步 APK 宿主。

## 候选构建与发布

Android 运行路径按设备约束处理：评论缓存最多保留最近两集的完整条目，单次 HTTP 响应去重缓存为最近16个响应，腾讯分片并发为8；Android 端采用既有20,000条输出上限。腾讯原始条目仅保留格式化会读取的字段，并及时释放中间数组；全部分片与评论仍参与原有处理，不更改选期、时间、颜色和顺序。字符串响应避免重复编码往返。旧 QuickJS 的原生 Base64 会截断 NUL，因此宿主适配层始终使用经过二进制回归的实现。

构建器的 Android 专用变换会检查原入口是否仍符合预期；上游改变入口后应先修适配与回归，再发布候选，不能跳过检查直接更新稳定脚本。

`Android danmaku engine` workflow 在 main push、PR 和上游同步后运行构建与测试并上传候选 artifact；`workflow_call` 仅构建指定 ref，不签名或更新正式版本。自动同步工作流使用这一入口，因为 GitHub 的 `GITHUB_TOKEN` push 不会自动触发另一条 push workflow。

发布使用不可变 tag `android-<scriptVersion>`，或从 Actions 手动运行并填写一个新的 `script_version`。workflow 用仓库 Secret `DANMAKU_SIGNING_PRIVATE_KEY` 签署 manifest，将脚本与签名上传到该版本 Release，并更新 `android-stable` Release 中的 `manifest.json` 和 `manifest.sig` 指针。`stable` 是保留版本名。私钥不能提交到仓库或 APK；APK 仅包含验证签名所需的公钥。

稳定指针的两个 Release 资产由 GitHub 分次上传。短暂的更新窗口中若 manifest 和签名暂时不一致，客户端验签失败会保留当前脚本，下一次检查时重试。每个版本 Release 的 engine、manifest 和签名不覆盖旧版本。
