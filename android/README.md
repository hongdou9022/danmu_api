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

`Android danmaku engine` workflow 在 main push 和 PR 上运行候选构建及测试并上传 artifact。上游同步工作流会在合并有新提交后显式调用此 workflow，并传入本次合并的完整 commit SHA；正式发布调用会运行全量 `npm test` 和 Android 引擎/严格 resolver 测试，通过后用同一份已测试产物签名、创建不可变 Release 并更新 `android-stable`。GitHub 的 `GITHUB_TOKEN` push 不会自动触发另一条 push workflow，所以同步流程通过 `workflow_call` 显式完成构建和发布。Cloudflare 与 Vercel 仍由同步工作流原有的独立部署 job 处理。

上游自动同步的版本号为 `sync-<Actions run id>-<run attempt>-<合并 SHA 前12位>`，确保重试时也生成新版本；只有成功合并新提交才自动发布。无上游更新时，`force_android_release` 手动输入可为当前 main 再运行完整构建、测试和发布；`force_deploy` 仍只强制部署服务器，不会发布 Android 引擎。独立的 `android-*` tag 和手动 `workflow_dispatch` 发布入口继续可用，手动发布需填写新的 `script_version`。`stable` 是保留版本名。

正式发布必须配置仓库 Secret `DANMAKU_SIGNING_PRIVATE_KEY`。workflow 先为目标 commit 构建未签名的最终版本产物，再运行全量项目测试和 Android 专项测试；通过后才将私钥交给独立的 Node 签名步骤，对被测 manifest 签名并立即用派生公钥验签，同时复核引擎哈希。发布 job 只下载并发布这份已测试的同一产物，不会再次构建。自动同步和手动正式发布仅接受 `refs/heads/main` 的可信调用；PR 不得签名发布，`android-*` 标签仍保留单独发布入口。任何构建、测试、签名校验或 artifact 复核失败都会阻止不可变 Release 与 `android-stable` 更新。私钥不能提交到仓库或 APK；APK 仅包含验证签名所需的公钥。

稳定指针的两个 Release 资产由 GitHub 分次上传：先更新签名，再最后更新 manifest。短暂的更新窗口中若 manifest 和签名暂时不一致，客户端验签失败会保留当前脚本，下一次检查时重试。每个版本 Release 的 engine、manifest 和签名不覆盖旧版本；stable 发布 job 使用同一并发组串行执行，避免两个版本同时覆盖稳定指针。
