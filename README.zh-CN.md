# One More Thing

两个在浏览器里运行的小游戏。

- **One More Tune（再来一首）**：听几秒音乐，说出它出自哪支 Apple 广告或哪场发布会。每轮十题。
- **One More Take（再来一条）**：你是一部年代戏的道具师，在胶片用完之前，把机器和它们的年份、颜色、名字对上。

## 试玩

```bash
npm start
```

然后打开 `http://localhost:8080/tune/` 或 `http://localhost:8080/take/`。

这个仓库放的是游戏的程序。完整题库和负责出题、判分的服务器不在这里，所以单独打开时，两个游戏各玩 `demo/` 里一份录好的示范：一轮十首、一套十条。进度留在浏览器的本地存储里。

One More Tune 会从 Apple 的公开试听服务播放片段，也可以打开 YouTube 上的视频，这两样都需要联网。

## 构建

```bash
npm run build
```

把宿主页面要嵌入的文件复制到 `dist/`。没有依赖，有 Node 就行。`demo/` 不进构建产物。

## 目录

| 路径 | 内容 |
| --- | --- |
| `tune/` | One More Tune：页面、游戏、转盘控件、样式表 |
| `take/` | One More Take：页面、游戏、样式表 |
| `shared/` | 两者共用：中英文字符串、基础样式、运行时 |
| `demo/` | 录好的示范：精简后的题库和一轮录好的对局 |
| `ais6-bridge.js`、`kit.css`、`app.manifest.json` | 让宿主页面把游戏嵌进框架、代管进度并画出菜单；单独打开时，同样的调用退回本地存储 |

## 许可

MIT，见 [LICENSE](LICENSE)。

English: [README.md](README.md).
