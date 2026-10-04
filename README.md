---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 5035900202c792eec3eaa16b083401f8_4b949543bed711f197eb525400393706
    ReservedCode1: 6vj7SkTM+kF9nT4T1UQ9sWFxueBuil/lYg/7DOOKAGgczyxU80yzvNAZURTHDljZB9+ruVagip+d1FrcCdhm8iRo7GGkIfy7SquHz4ZNhJv+cb0KeNR2NeHM4UqtoyJymAvi8rw2PwyZb/llYhmhqB5Thjzoe3IOQkyeaZL8sQnfKSfOFvUk3lBj4Oo=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 5035900202c792eec3eaa16b083401f8_4b949543bed711f197eb525400393706
    ReservedCode2: 6vj7SkTM+kF9nT4T1UQ9sWFxueBuil/lYg/7DOOKAGgczyxU80yzvNAZURTHDljZB9+ruVagip+d1FrcCdhm8iRo7GGkIfy7SquHz4ZNhJv+cb0KeNR2NeHM4UqtoyJymAvi8rw2PwyZb/llYhmhqB5Thjzoe3IOQkyeaZL8sQnfKSfOFvUk3lBj4Oo=
---

# 网页小游戏合集

一个**纯静态**的网页小游戏门户：手机、平板、电脑浏览器直接打开就能玩，无需安装、无需服务器（联机游戏均基于 WebRTC 设备直连，游戏数据只在设备之间点对点传输）。

首页是游戏门户，点卡片即可进入对应游戏；每个游戏都有自己的独立网址，可以直接分享给朋友打开。

数字炸弹、心口难开都支持 2 人以上实时联机、6 位房号或邀请链接加入；**房主掉线（直接关闭页面 / 断网）时，在场玩家会自动接管房间**，对局不中断。真心话大冒险既能**单独打开直接玩**（不用建房、不用联机），也能作为数字炸弹的**「游戏结束惩罚」**在房间内全员同步进行。

> **主部署文件夹（唯一需要上传的根目录）：`E:\AI\Marvis\作品\数字炸弹`**
> 它就是这个仓库的根目录，门户首页 `index.html`、游戏清单 `games.js`、`.nojekyll` 都在这一层；`number-bomb\`、`xinkou-nankai\`、`truth-dare\` 是它的**子目录**，跟随根目录一起提交即可，**不要**单独上传子目录、也不要在外面再套一层文件夹。
> 「真心话大冒险」的**正式维护目录**是 `E:\AI\Marvis\作品\真心话大冒险`（不在部署目录内），改完后运行根目录的 `sync-truth-dare.bat` 同步到 `truth-dare\` 与 `number-bomb\truth-dare.js`，再提交部署目录。

---

## 一、目录结构

```
数字炸弹\                     ← 本仓库根目录（部署到 GitHub Pages 的就是它）
├─ index.html                 门户首页（游戏卡片列表）
├─ games.js                   游戏清单配置（新增游戏改这里）
├─ README.md                  本说明文档
├─ .nojekyll                  空文件，关闭 GitHub Pages 的 Jekyll 处理
├─ sync-games.bat             同步脚本：把「心口难开」最新静态版复制到 xinkou-nankai\
├─ sync-truth-dare.bat        同步脚本：把「真心话大冒险」最新版复制到 truth-dare\
├─ number-bomb\               游戏一：数字炸弹（已内置真心话大冒险惩罚玩法）
│  ├─ index.html
│  ├─ truth-dare.js           真心话大冒险题库 + 抽题算法（与独立版同一份文件）
│  ├─ vendor\peerjs.min.js
│  └─ README.md               （数字炸弹的详细说明）
├─ xinkou-nankai\             游戏二：心口难开（由 sync-games.bat 同步生成）
│  ├─ index.html
│  ├─ app.js                  界面与交互逻辑
│  ├─ engine.js               纯静态 P2P 引擎（房主权威 + DataChannel 转发）
│  ├─ style.css
│  ├─ data\action.js          词库：动作类
│  ├─ data\word.js            词库：词汇类
│  └─ vendor\peerjs.min.js
└─ truth-dare\                游戏三：真心话大冒险（由 sync-truth-dare.bat 同步生成）
   ├─ index.html              入口：进入前先选模式（男女朋友版 / 情侣升级版）
   └─ truth-dare.js           题库 + 抽题算法（与 number-bomb\truth-dare.js 同一份）
```

> **注意**：`number-bomb\`、`xinkou-nankai\`、`truth-dare\` 里的页面都使用**相对路径**引用自己的资源与 `vendor\`，所以本地预览和线上子目录部署都能正常工作，请勿打乱目录层级。

---

## 二、本地预览

浏览器要求安全上下文（HTTPS 或 localhost）才能使用 WebRTC，请用 HTTP 服务器打开，**不要**直接双击 `index.html`。

```bash
# 在仓库根目录（数字炸弹\）下任选一种
python -m http.server 8080

# 或
npx serve . -l 8080
```

然后访问 `http://localhost:8080`：首页是门户，点卡片进入游戏；子游戏地址分别是 `http://localhost:8080/number-bomb/`、`http://localhost:8080/xinkou-nankai/`、`http://localhost:8080/truth-dare/`。

跨设备联机测试（手机 + 电脑）建议直接部署到 GitHub Pages 后用 HTTPS 测试。

---

## 三、部署到 GitHub Pages

### 上传清单（必传）

| 路径 | 说明 |
| --- | --- |
| `index.html` | 门户首页，必须在仓库根目录 |
| `games.js` | 游戏清单配置 |
| `.nojekyll` | **必传**（点开头的空文件，关闭 Jekyll） |
| `number-bomb\`（整个目录） | 含 `index.html`、`truth-dare.js`、`vendor\peerjs.min.js`、`README.md` |
| `xinkou-nankai\`（整个目录） | 含 `index.html`、`app.js`、`engine.js`、`style.css`、`data\`、`vendor\` |
| `truth-dare\`（整个目录） | 游戏三入口，含 `index.html`、`truth-dare.js` |
| `README.md`、`sync-games.bat`、`sync-truth-dare.bat` | 可选（不影响运行） |

### 步骤

1. 登录 GitHub，右上角 **+ → New repository**，新建仓库（例如 `mini-games`）。
   - **不要**勾选 "Add a README file"，避免与本地文件冲突。
2. 把上面「上传清单」里的文件/目录**原样**提交到仓库：
   - **网页上传**：仓库 → **Add file → Upload files** → 把 `index.html`、`games.js`、`number-bomb`、`xinkou-nankai`、`truth-dare` 等一起拖进去 → Commit。
     - `.nojekyll` 这类点开头的文件在文件选择器里可能不显示，可先压缩成 zip 上传后解压，或用下面的 Git 命令行方式。
   - **Git 命令行**（推荐，能确保 `.nojekyll` 一起提交）：
     ```bash
     cd E:\AI\Marvis\作品\数字炸弹
     git add -A
     git commit -m "网页小游戏合集：数字炸弹 + 心口难开 + 真心话大冒险"
     git push origin main
     ```
3. 仓库 **Settings → Pages**：**Source** 选 `Deploy from a branch`，**Branch** 选 `main`、目录选 `/ (root)`，Save。
4. 等待 1~2 分钟，页面顶部会显示站点地址。

### 访问地址

| 页面 | 地址 |
| --- | --- |
| 门户首页 | `https://<你的用户名>.github.io/<仓库名>/` |
| 数字炸弹 | `https://<你的用户名>.github.io/<仓库名>/number-bomb/` |
| 心口难开 | `https://<你的用户名>.github.io/<仓库名>/xinkou-nankai/` |
| 真心话大冒险 | `https://<你的用户名>.github.io/<仓库名>/truth-dare/` |

把首页网址发给朋友即可；三个子游戏的网址也可以**直接单独分享**，联机游戏打开后创建/加入房间就能玩，真心话大冒险打开就能直接抽题。

### `.nojekyll` 说明

GitHub Pages 默认用 Jekyll 处理站点，会忽略下划线开头的文件/目录。放一个 `.nojekyll`（空文件、以点开头、无扩展名）可彻底关闭 Jekyll，避免静态资源被过滤或构建异常。

若部署后 404，依次检查：① 分支/目录是否选对；② `index.html` 是否在仓库**根目录**（不是套了一层子文件夹）；③ 是否已等待构建完成（Actions 标签页可看进度）。

---

## 四、以后新增游戏

1. 把新游戏的静态目录拷到仓库根目录下（例如 `my-game\`，入口为 `my-game\index.html`）。
2. 打开 `games.js`，在数组里加一项：

   ```js
   {
     id: 'my-game',
     name: '新游戏名',
     icon: '🎲',
     tagline: '一句话简介',
     desc: '详细一点的玩法说明。',
     url: 'my-game/',
     meta: ['2 人以上', '实时联机'],
     accent: '#35d07f'
   }
   ```

3. 刷新页面（无需构建），新卡片即出现在首页；提交到 GitHub 后线上同步生效。

> 新增游戏同样要用**相对路径**引用自己的资源，才能兼容本地预览与线上子目录部署。

---

## 五、维护各子游戏（同步脚本）

### 心口难开

「心口难开」的**正式维护位置**是 `E:\AI\Marvis\作品\心口难开`（该目录保留了可选的 Node 服务端版本 `server.js` / `start.bat`，用于局域网调试），其中的纯静态版位于 `心口难开\web\`。

门户里的 `xinkou-nankai\` 是从该目录**同步**过来的副本。修改心口难开后，双击仓库根目录的 `sync-games.bat` 即可把 `心口难开\web\` 的最新内容覆盖同步到 `xinkou-nankai\`。

### 真心话大冒险

「真心话大冒险」的**正式维护位置**是 `E:\AI\Marvis\作品\真心话大冒险`，其中：

- `truth-dare.js` —— 题库（真心话 103 条、大冒险·男女朋友版 110 条 / 情侣升级版 29 条）+ 抽题算法，**独立版与数字炸弹内嵌版共用同一份文件**；
- `index.html` —— 独立版页面（先选模式 → 真心话 / 大冒险 → 抽题 → 下一题 / 退出）。

同步分两处（由 `sync-truth-dare.bat` 自动完成）：

1. `真心话大冒险\index.html` + `truth-dare.js` → `truth-dare\`（门户里的独立入口）；
2. `真心话大冒险\truth-dare.js` → `number-bomb\truth-dare.js`（数字炸弹内嵌惩罚玩法用的题库）。

所以在维护目录里改完题目或算法后，双击仓库根目录的 `sync-truth-dare.bat`，两处副本都会同步更新。

---

## 六、技术说明

- **网络模型**：每个游戏都有一位「房主」作为星型中枢，其他玩家的消息发给房主，由房主广播最新状态；房主权威校验，避免各端状态不一致。
- **信令**：使用 PeerJS 公共信令服务器（`0.peerjs.com`）完成一次握手；握手完成后游戏数据不再经过任何服务器，只在浏览器之间通过 WebRTC DataChannel 传输。
- **依赖**：`PeerJS 1.5.4` 已在本仓库内附带本地副本（`vendor\peerjs.min.js`），页面优先加载本地文件，加载失败时自动回退到 CDN。除此之外**没有任何外部依赖**，也不需要构建步骤。
- **兼容性**：桌面 Chrome / Edge / Firefox / Safari 近两年版本；移动 iOS Safari 14+、Android Chrome 90+、微信内置浏览器。

---

祝玩得开心。
*（内容由AI生成，仅供参考）*
