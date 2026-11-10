# 银曜巨神 ARGENT TITAN

银红相间的光之巨人「银曜」对战怪兽的 3D 格斗游戏。浏览器里直接玩，Three.js 渲染。
特效、音效由代码生成；巨人使用一个绑定好骨骼的人体底模，头盔、纹路和动作是本项目自己的；
怪兽是带骨骼动画的开源模型，招式判定是本项目配的；夜景城市用开源的城市模型包、夜空和
地面贴图搭建（素材来源见文末）。

## 运行

```bash
npm install
npm run dev
```

打开 <http://127.0.0.1:5183>。需要支持 WebGL2 的桌面浏览器和键盘。

```bash
npm run build     # 产物在 dist/
npm run preview   # 本地预览构建结果
```

## 操作

| 按键 | 动作 |
| --- | --- |
| `W A S D` / 方向键 | 移动（相对镜头：左右进退，上下绕步） |
| `J` | 拳。`J J J` 三连，第三下上勾拳击倒 |
| `K` | 踢。`J J K` 高踢击倒，`J K` 接前踢；怪兽倒地时变成追击踩踏 |
| `O` | 投技：抓举后摔出。能破防御，但会被对方的攻击打断 |
| `L`（按住） | 防御。防御槽被打空会「防御崩坏」 |
| `空格` | 闪避冲刺（有无敌帧，不按方向为后撤）。向前冲刺中按 `J`/`K` 出飞踢 |
| `U` | 曜光枪：远程投射，消耗 25 极光 |
| `I`（按住） | 极光炮：按住蓄力，松开发射。Lv1 / Lv2 / Lv3 分别消耗 35 / 65 / 100 极光 |
| `P` / `Esc` | 暂停 |
| `M` | 静音 |
| `Enter` | 开始 / 确认 |

## 战斗系统

- **极光槽**：命中、受击、防御都会积攒。蓄力越久等级越高：Lv1 短促、Lv2 更长更粗、
  Lv3 持续最久并以击倒收尾。蓄力期间只有轻霸体，重击会把蓄力打断。
- **眩晕槽**：连续命中会填满对手的眩晕槽，填满后对手原地眩晕 3 秒、无法防御——这是放
  高等级极光炮的最佳时机（对眩晕目标伤害提高 25%）。巨人自己也有眩晕槽。
- **攻防三角**：攻击打断投技，投技破防御，防御挡住攻击。
- **霸体**：怪兽的重招带霸体，普通拳脚打不断，要靠防御、闪避或击倒技应对。
- **倒地追击**：怪兽倒地时可以用 `K` 踩踏。
- 拳脚连段中可以直接取消接 `U` / `I`。同时按下多个攻击键时只出最「重」的那一个
  （极光炮 > 曜光枪 > 投技 > 踢 > 拳）。

## 关卡

1. **碎岩巨魔 · 格罗姆** — 巨锤横扫、过顶下砸、贴地震波、霸体冲撞
2. **猎牙兽 · 泽鲁加** — 甩头撕咬、立起扑砸、长距离飞扑、甩尾
3. **冥晶龙 · 奥布西昂** — 撕咬、甩尾、俯冲、火球与三连火球（招式时间尚未逐帧校准）

怪兽血量低于 40% 会狂暴化。每过一关回复 40% 体力，极光保留。场地里的楼会被踩塌、
砸塌、炸塌。

## 代码结构

```
src/
  main.js      启动：加载底模、创建巨人、主循环
  game.js      流程状态机、命中判定、投射物/光线/投技结算、镜头、HUD 同步
  fighter.js   角色状态机（巨人与怪兽共用，差异全在 def 里）
  ai.js        怪兽 AI：只通过 intent / queueAttack 驱动角色，和玩家输入同一接口
  hero.js      巨人：底模接入、着色器纹路、头盔、姿势与招式表
  beast.js     怪兽身体：播放模型自带的动画片段，缺的动作用整体位姿叠加
  beasts.js    三只怪兽的数据：片段与状态的对应、判定点、招式表（含 AI 用招权重）
  skin.js      让蒙皮模型跟随代理骨架（重定向、锁骨联动、脊柱分段）
  rig.js       代理骨架：欧拉角姿势 + 自动贴地
  poses.js     姿势插值、带缓动的关键帧、镜像
  arena.js     夜景城市：街区路网、实例化楼群与逐窗亮灯、路灯、可砸塌的楼和可踩扁的车与树、夜空
  fx.js        粒子、冲击环、闪光、光线
  audio.js     WebAudio 合成音效与配乐
  hud.js       DOM 血条与界面
  config.js    关卡数值与 AI 性格
tools/
  extract-body.mjs   从带骨骼的角色 GLB 里提取「身体网格 + 骨架」作为底模
  lab.js             怪兽调试台（仅开发服务器）：逐帧排版查看动作、量判定点和步幅
  pack-city.mjs      把用到的城市模型打成一个 GLB，并标出窗户玻璃和路灯灯头
public/models/
  titan-body.glb     巨人的底模（见下方素材说明）
  troll.glb / predator.glb / dragon.glb   三只怪兽
  city.glb           城市模型包（由 tools/pack-city.mjs 生成）
public/textures/     夜空 HDR、沥青与铺装贴图
```

招式是数据：`hero.js` / `beasts.js` 的招式表里写明每一招的时长、判定窗口、位移、可取消
去向、投射物规格、光线规格和 AI 权重，`fighter.js` 与 `game.js` 只负责解释这些字段。

调姿势时可在控制台冻结到某一帧：`__game.debugPose('hero', 'jab', 0.1)`。给怪兽对动作时间
用调试台：`const lab = await import('/tools/lab.js')`，用法见该文件开头。

## 素材说明

`public/models/titan-body.glb` 是衍生作品：身体网格与骨架取自 Sketchfab 上
RED COMET 0079 的模型 "ULTRAMAN (RIG UPDATED)"
（<https://sketchfab.com/3d-models/ultraman-rig-updated-f941abca56da4a7bbb2acd46dd3131f1>），
许可为 [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)。

本项目所做的修改：只保留身体网格和骨架；头部、面具、眼睛、胸口计时器以及全部材质和贴图
都已移除（`tools/extract-body.mjs --cut-above=0.862`）。游戏里看到的头盔、胸徽、银红
纹路和所有动作都是本项目新做的，成品不是也不代表原模型所描绘的角色。

重新生成底模：

```bash
node tools/extract-body.mjs <下载的源模型.glb> public/models/titan-body.glb --cut-above=0.862
```

### 怪兽模型

三只怪兽的模型原样使用（未改网格与贴图），均来自 Sketchfab，许可为
[CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)：

| 文件 | 作品 | 作者 |
| --- | --- | --- |
| `troll.glb` | [Troll](https://sketchfab.com/3d-models/troll-bceb1cb47186457c8571a23e6aff1b8e) | [SJunior3d](https://sketchfab.com/sjunior3d) |
| `predator.glb` | [Four Legged Predator](https://sketchfab.com/3d-models/four-legged-predator-7f68f9daa698433299092bfecaae4e9e) | [Timsblends](https://sketchfab.com/timsblends) |
| `dragon.glb` | [European Dragon](https://sketchfab.com/3d-models/european-dragon-82f393a2e6c048ad80c171ce3b3a7b87) | [Nonexistent 101](https://sketchfab.com/Nonexistent101) |

游戏里的名字（格罗姆、泽鲁加、奥布西昂）、招式与数值是本项目起的，与原作者无关。

### 城市与环境

全部为 CC0（无需署名，这里仍然列出以示感谢）：

- 建筑、道路、路灯、树、车辆：[Kenney](https://www.kenney.nl) 的 City Kit (Commercial 2.1)、
  City Kit (Industrial 2.0)、City Kit (Suburban 2.0)、City Kit (Roads 2.2)、Car Kit 3.1。
  `public/models/city.glb` 是从中挑出用到的 47 个模型重新打包的：合并了节点、压缩了顶点数据、
  去掉了车轮，并加了一个标记窗户玻璃的顶点属性（游戏据此让窗户一扇一扇亮灯）。
- 夜空：[Poly Haven](https://polyhaven.com) 的 HDRI `kloppenheim_02_puresky`（游戏加载时会
  压暗、偏蓝并限制月亮亮度）。
- 地面：Poly Haven 的 `aerial_asphalt_01`、`large_square_pattern_01`。

重新生成城市模型包：把上面五个 Kenney 包分别解压到 `raw-assets/kenney-<commercial|industrial|
suburban|roads|cars>/files/`（该目录不入库），然后

```bash
node tools/pack-city.mjs raw-assets public/models/city.glb
```

加 `--stats` 可以打印每个模型的尺寸、面数和用到的调色板格子。
