# 3D Pose Studio｜目标交互与控制系统

## 1. 产品目标

3D Pose Studio 的唯一核心目标：

> **让没有任何 3D 软件经验的美术人员，也能快速摆出自然、可信、适合作画参考的人体姿势。**

它不是动画 Rig 工具，也不是简化版 Blender / Maya。

用户应该主要通过：

**直接拖身体 → 得到姿势 → 少量旋转微调**

完成绝大部分操作。

最终体验标准：

- 不需要理解 Bone
- 不需要理解 IK / FK
- 不需要理解 Pole Vector
- 不需要操作 XYZ 三轴
- 不需要打开骨骼树
- 尽量不需要手动修复异常姿势
- 拖动过程中人体必须连续、稳定，不突然翻转

---

# 2. 核心操作模型

整个系统只保留三种主要行为：

### Drag

用于快速确定人体大形。

例如：

- 拖手 → 手移动过去，整条手臂自然跟随
- 拖脚 → 脚移动过去，整条腿自然跟随
- 拖肘 → 改变手臂弯曲方向
- 拖膝 → 改变腿部弯曲方向
- 拖身体 → 站起、下蹲、移动重心
- 拖胸腰 → 改变身体动态

### Rotate

选中控制点后显示简单 Rotation Ring，用于局部精修：

- 手掌朝向
- 脚掌朝向
- 骨盆旋转
- 胸腔扭转
- 头部朝向

Rotation 是辅助操作，不应该成为主要摆 Pose 方式。

### Pin / Lock

用于告诉系统：

> “这个位置不要动。”

主要用于：

- 左脚锁定
- 右脚锁定
- 双脚锁定
- 未来可支持手部锁定

---

# 3. 用户可见控制点

尽量减少数量，只保留有明确人体意义的控制器。

```text
              ● Head

              ■ Chest

              ■ Waist

              ● Body / COG

       ● Elbow       ● Elbow
          │             │
       ● Wrist       ● Wrist


       ● Knee         ● Knee
          │             │
       ● Ankle       ● Ankle
```

肩、髋、锁骨、具体 Spine Bone 等默认不作为主要控制点显示。

系统内部可以存在复杂 Rig，但用户看到的是人体，而不是骨骼系统。

---

# 4. 四肢控制目标

## Wrist

拖 Wrist：

> “我要把手放到这里。”

系统自动：

- 计算 Shoulder
- 计算 Elbow
- 保持原来的自然弯曲方向
- 自动处理肩膀 / 锁骨参与
- 遵守人体关节限制

拖动过程中肘部绝不能突然翻到另一侧。

选中 Wrist 后：

- Rotation Ring 调整手掌朝向

---

## Elbow

拖 Elbow：

> “我要让肘朝这个方向弯。”

要求：

- Wrist Target 基本不移动
- Shoulder 基本不移动
- 肘部弯曲程度尽量保持
- 主要改变整条手臂的 Bend Plane

Elbow Controller 不应该直接对应一个 Bone。

它代表：

**手臂弯曲方向。**

同一次拖动过程中 Bend Plane 必须连续，不允许 IK 自动切换另一侧。

---

## Ankle

拖 Ankle：

> “我要把脚放到这里。”

系统自动：

- Hip + Knee IK
- 保持腿原来的弯曲方向
- 遵守 Knee / Hip Constraint
- 保持脚掌当前朝向，除非用户主动旋转

---

## Knee

逻辑与 Elbow 相同。

拖 Knee：

> 改变腿向哪里弯。

要求：

- Ankle Target 基本不移动
- Hip 基本不移动
- 不允许突然翻膝
- Bend Plane 连续变化

---

# 5. Body / COG

Body / COG 是整个 Pose 系统最重要的控制器之一。

它控制的是：

**身体位置 + 人体重心。**

### 向下拖

```text
COG ↓
↓
骨盆下降
↓
Hip / Knee 自动弯曲
↓
人物自然下蹲
```

### 向上拖

```text
COG ↑
↓
双腿逐渐伸直
↓
人物自然站起
```

### 左右移动

产生：

- 重心转移
- 一侧腿承重
- 另一侧腿自然放松

### 前后移动

产生：

- 前倾重心
- 后移重心
- 跑步 / 蓄力等动态基础

如果脚当前接触地面，拖动 COG 时应优先临时保持脚的位置。

用户不应该为了简单下蹲，必须先理解并开启 Foot Lock。

---

# 6. Chest / Waist / Spine

不要让用户逐根控制 Spine Bone。

## Chest

控制：

- 上半身前倾 / 后仰
- 左右侧倾
- 胸腔扭转

实际旋转自动分配给多节 Spine。

---

## Waist

用于产生整体脊柱曲线。

例如：

```text
直立        弯腰         S Curve

  │           )             S
  │          )              S
  │         )               S
```

用户移动一个 Waist Controller，内部 Spine 自动形成平滑曲线。

不要出现每节 Spine 都需要手动调整的情况。

---

# 7. Head

Head Controller 只表达：

> “头看这里 / 头转向这里。”

Neck 和 Upper Spine 自动参与。

避免所有旋转集中到单根 Neck Bone。

---

# 8. 肩膀与锁骨

肩部应该以自动行为为主。

例如抬高手腕：

```text
Wrist ↑
↓
Shoulder Elevation
↓
Clavicle 自动逐渐参与
```

低角度动作：

- 锁骨参与较少

高举手臂：

- 锁骨明显抬起
- 肩部自然跟随

用户不应该为了抬高手臂还需要单独操作 Clavicle。

需要精修时，可以点击肩部临时显示 Rotation Controller。

---

# 9. IK 连续性

这是整个系统的硬性要求。

系统必须记住四肢当前的：

- Bend Plane
- Bend Side
- Bend Angle
- Previous Stable State

拖 Wrist / Ankle 时：

**延续当前弯曲状态，而不是每帧重新猜 Pole。**

拖 Elbow / Knee 时：

**显式改变 Bend Plane。**

同一次 Drag Gesture 内禁止系统自行切换到相反的弯曲分支。

---

# 10. Solver 架构目标

最终运行流程应该尽量保持单一：

```text
Pointer Input

↓

Semantic Controller
Wrist / Elbow / Knee / COG / Chest...

↓

Human Pose Solver

↓

Stable Bend State

↓

Joint Constraints

↓

Rig Adapter

↓

Model Bones
```

避免形成：

```text
IK
↓
Clamp
↓
Normalize
↓
发现不对
↓
另一套 Solver 修正
↓
再次 Clamp
```

一个动作应该由一套明确的人体解算逻辑产生最终结果。

---

# 11. Rig Adapter

Pose 系统只认识人体语义：

```text
Shoulder
Elbow
Wrist

Hip
Knee
Ankle

Pelvis
Spine
Chest
Neck
Head
```

模型内部即使存在：

```text
elbowUpper
elbowLower

kneeUpper
kneeLower
```

也应该由独立 `RigAdapter` 负责转换。

例如：

```text
Semantic Elbow Bend = 80°

↓

RigAdapter

↓

elbowUpper = 43°
elbowLower = 37°
```

以后更换人体模型时，不应该需要重新设计 Pose Solver。

---

# 12. Joint Constraint

不同人体关节使用不同约束类型。

### Elbow / Knee

主要采用：

**Hinge Constraint**

只有有限的自然弯曲范围。

### Shoulder / Hip

采用：

**Swing + Twist**

允许球窝运动，同时限制人体不可能的方向。

### Wrist / Ankle / Neck

采用：

**Swing + Twist Limit**

---

约束分两层：

### Soft Limit

接近人体极限时逐渐增加阻力 / 降低拖动响应。

### Hard Limit

真正达到人体极限后停止。

避免用户一拖就突然撞到一个僵硬的 Clamp。

---

# 13. Foot Contact / Foot Lock

系统需要两种状态。

### 自动 Ground Contact

脚明显接触地面时：

- 拖 COG 默认尽量保持脚不移动
- 自然产生下蹲和重心变化

### 显式 Lock

用户可以手动：

- Lock Left Foot
- Lock Right Foot
- Lock Both Feet

显式 Lock 优先级高于自动 Ground Contact。

---

# 14. 深度控制

直接拖 3D 控制器最大的困难之一是：

**屏幕二维移动无法直观看出深度。**

目标体验：

正常情况下只有 Main View。

拖 Wrist / Ankle 等关键控制点时，可以临时显示：

**Side Mini View**

用于判断：

- 手在身体前还是后
- 脚在身体前还是后
- 四肢距离躯干多远

Mini View 只作为辅助，不应该长期占用大量界面。

---

# 15. 控制器视觉

控制器必须尽量安静。

### 默认

- 小型
- 半透明
- 不遮挡人体

### Hover

- 放大
- 提高亮度
- 扩大实际 Picking Area

### Selected

只高亮当前相关 Chain。

例如选择 Wrist：

```text
Shoulder ─ Elbow ─ Wrist
```

其他控制点降低视觉权重。

不要一直显示满屏控制器和 Gizmo。

---

# 16. Hand Pose

第一阶段不要求逐根手指调整。

提供：

- Relaxed
- Open
- Fist
- Point
- Pinch
- Hold

再提供简单的：

**Open ↔ Fist**

连续 Blend。

高级 Finger Editing 后续再做。

---

# 17. Pose 辅助工具

需要：

- Reset Pose
- Reset Limb
- Whole Pose Mirror
- Left → Right Limb Mirror
- Right → Left Limb Mirror
- Left / Right Flip
- Undo / Redo

Pose Preset：

- Standing
- Sitting
- Crouching
- Running
- Jumping
- Combat Ready

Preset 最好支持 Blend Strength：

```text
Current Pose

      ↓ 30%

Combat Ready

      ↓

保留原姿态，只增加部分战斗动作特征
```

---

# 18. 相机交互

保持简单：

- 拖空白 → Orbit
- 滚轮 → Zoom
- 中键 / 指定操作 → Pan

需要基础视角：

- Front
- Back
- Left
- Right
- 3/4
- Top
- Low Angle
- High Angle

支持：

- Perspective
- Orthographic
- Focal Length / FOV

相机工具不能抢占 Pose Controller 操作。

---

# 19. 用户理想工作流

最终用户应该能够：

```text
打开 Pose Studio

↓

选择一个基础姿势

↓

拖 COG
确定站立 / 下蹲 / 重心

↓

拖 Wrist / Ankle
确定四肢大形

↓

拖 Elbow / Knee
调整弯曲方向

↓

调整 Chest / Waist / Head

↓

少量 Rotation Ring 精修

↓

调整相机

↓

完成
```

整个过程中尽量不出现专业 3D Rig 概念。

---

# 20. 第一优先级

## P0：必须先解决

- Wrist / Ankle IK 连续稳定
- Elbow / Knee Bend Plane 控制
- 消除肘膝突然翻面
- 单一稳定的四肢 Solver
- Joint Constraint 重构

## P1：决定人体是否自然

- COG + 自动脚接触
- Chest / Waist / Spine 联动
- Shoulder / Clavicle 联动
- Rotation 微调

## P2：提升美术使用效率

- Side Mini View
- Hand Preset
- Pose Preset Blend
- Limb Mirror
- 控制点视觉优化

---

# 21. 暂时不做

当前阶段不要扩展：

- 动画时间轴
- 骨骼树
- Rig 编辑
- Weight Painting
- 自定义 Bone
- XYZ 数值编辑
- 复杂 Character Editor
- 衣服
- 头发物理
- 布料模拟
- 动力学
- 多角色互动系统

这些都不能帮助当前核心目标：

**快速获得人体动作参考。**

---

# 22. 最终验收标准

这个系统是否成功，不以“支持多少 Bone”衡量。

应该以以下体验判断：

### 1. 快

完全不会 3D 的用户可以很快理解：

**直接拖身体就能摆 Pose。**

### 2. 稳

缓慢拖动 Wrist / Ankle / Elbow / Knee：

**身体不能突然跳动或翻面。**

### 3. 自然

普通站立、下蹲、跑步、伸手、抬手等动作：

**默认结果就应该接近人体自然姿态。**

### 4. 少修

用户不应该频繁：

- 修肩膀
- 修锁骨
- 修膝盖方向
- 修反关节
- 修脚漂移

这些应该由系统主动处理。

### 5. 少控制器

用户看到的是：

**Head / Chest / Waist / Body / Hands / Elbows / Knees / Feet**

而不是复杂 Rig。

---

## 核心原则

> **用户负责表达“人体想去哪里”，系统负责决定“骨骼应该怎么过去”。**

所有技术设计都应该围绕这一原则。